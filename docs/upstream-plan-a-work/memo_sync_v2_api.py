"""v2 management routes reuse v1 authentication and Planning mutation services."""
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import Field
from app.models import PersonalMemo
from app.memo_sync_models import MemoSyncDocument, MemoSyncLink
from app.memo_planning_models import MemoCarryNotice, MemoDayReminder
from app.memo_management_models import MemoManagementOperation as Operation, MemoManagementChange as Change
from app.services import memo_sync as sync, memo_planning as planning, memo_management as management


class Command(planning.Strict):
    request_id: str = Field(pattern=r'^[A-Za-z0-9_-]{8,64}$')
    link_id: str | None = Field(default=None, max_length=36)


class CopySelection(planning.Selection):
    local_copy_key: str = Field(pattern=r'^[A-Za-z0-9_-]{8,64}$')


class Carry(Command):
    source_link_id: str | None = Field(default=None, max_length=36)
    items: list[CopySelection] = Field(min_length=1, max_length=100)


class Rule(Command):
    rule: planning.Reminder


class LocalItem(planning.Strict):
    content: str = Field(max_length=500000)
    section: Literal['main', 'am', 'pm'] = 'main'


class LocalCopy(Command):
    local_source_id: str = Field(pattern=r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    source_date: str = Field(max_length=10)
    local_copy_key: str = Field(pattern=r'^[A-Za-z0-9_-]{8,64}$')
    item: LocalItem


def run(db, owner, client, day, kind, body, action):
    ns = sync.configured_namespace()
    payload = body.model_dump()
    fingerprint = sync.digest([day, kind, payload])
    previous = db.get(Operation, (ns, owner, client, body.request_id))
    if previous:
        if previous.digest != fingerprint:
            raise HTTPException(409, {'code': 'request_id_reused'})
        return JSONResponse(previous.result, status_code=previous.status_code)
    db.info['memo_v2_transaction'] = True
    db.info['memo_v2_client'] = client
    result, status = action()
    db.add(Operation(namespace=ns, owner_user_id=owner, client_id=client, request_id=body.request_id,
        memo_date=day, kind=kind, digest=fingerprint, payload=payload, result=result, status_code=status))
    db.commit()
    return JSONResponse(result, status_code=status)


def validate_aliases(db, owner, day, mappings):
    if len({m['local_copy_key'] for m in mappings}) != len(mappings):
        raise HTTPException(422, 'Duplicate local copy key')
    old = {}
    for op in db.query(Operation).filter_by(namespace=sync.configured_namespace(), owner_user_id=owner,
            memo_date=day, status_code=200).all():
        for m in op.result.get('mappings', []):
            old[m['local_copy_key']] = m
    for m in mappings:
        previous = old.get(m['local_copy_key'])
        collision = db.query(PersonalMemo).filter_by(owner_user_id=owner, client_key=m['local_copy_key']).first()
        if (previous and previous['source_identity'] != m['source_identity']) or (collision and collision.id != m['copied_item_id']):
            raise HTTPException(409, {'code': 'copy_identity_reused'})


def mapping(memo, key, source, day):
    return {'local_copy_key': key, 'source_identity': source, 'copied_item_id': memo.id,
        'client_key': memo.client_key, 'deleted': memo.deleted_at is not None, 'moved': memo.memo_date != day}


def register(app, policy, browser, device):
    def feature():
        if not management.enabled():
            raise HTTPException(404, 'Memo management v2 unavailable')

    def router(native):
        auth = device if native else browser
        prefix = '/api/memo-sync/' + ('native' if native else 'web') + '/v2'
        api = APIRouter(prefix=prefix, dependencies=[Depends(feature)])

        def identity(actor):
            return (actor.owner_user_id, actor.id) if native else (actor.id, 'web')

        def access(db, actor, day, link_id=None):
            planning.pm.require_day(day)
            owner, client = identity(actor)
            db.info['memo_v2_client'] = client
            if native:
                if not link_id:
                    raise HTTPException(409, {'code': 'link_generation_required'})
                doc = db.query(MemoSyncDocument).filter_by(owner_user_id=owner, namespace=sync.namespace(),
                    type='DAY', key=day).populate_existing().with_for_update().first()
                if not doc:
                    raise HTTPException(404, 'Linked DAY not found')
                sync.link_owned(db, actor, doc, link_id)
            return owner, client

        @api.get('/capabilities')
        def capabilities(actor=Depends(auth)):
            return {'version': 2, 'namespace': sync.namespace(), 'features': ['carryover', 'reminder_rules', 'occurrences', 'shared_ack'],
                'content_sync': 1, 'management_sync': 2, 'local_only_upload': False}

        @api.get('/days/{day}/state')
        def state(day: str, link_id: str | None = None, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, _ = access(db, actor, day, link_id)
            return management.state(db, owner, day)

        @api.get('/days/{day}/carry')
        def candidates(day: str, link_id: str | None = None, source_link_id: str | None = None,
                       timezone: str = 'Asia/Seoul', db=Depends(policy.get_db), actor=Depends(auth)):
            owner, _ = access(db, actor, day, link_id)
            if native:
                access(db, actor, planning.source_day(day), source_link_id)
            return planning.carry_candidates(db, owner, day, timezone)

        @api.get('/days/{day}/operations')
        def operations(day: str, link_id: str | None = None, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, _ = access(db, actor, day, link_id)
            rows = db.query(Operation).filter_by(namespace=sync.namespace(), owner_user_id=owner, memo_date=day).order_by(Operation.created_at.desc()).limit(50).all()
            return {'operations': [{'request_id': r.request_id, 'origin_client': r.client_id, 'kind': r.kind,
                'created_at': r.created_at.isoformat() + 'Z', 'status_code': r.status_code, 'result': r.result} for r in rows]}

        @api.post('/days/{day}/carry')
        def carry(day: str, body: Carry, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, client = access(db, actor, day, body.link_id)
            if native:
                access(db, actor, planning.source_day(day), body.source_link_id)
            def action():
                result = planning.copy_items(db, owner, day, planning.Carry(items=[planning.Selection(id=i.id, version=i.version) for i in body.items]))
                mappings = [mapping(db.get(PersonalMemo, memo['id']), selected.local_copy_key, 'server:' + str(selected.id), day)
                    for selected, memo in zip(body.items, result['items'])]
                validate_aliases(db, owner, day, mappings)
                management.touch(db, owner, day)
                return {'mappings': mappings, 'refresh_required': True}, 200
            return run(db, owner, client, day, 'carry', body, action)

        @api.post('/days/{day}/carry/dismiss')
        def dismiss(day: str, body: Command, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, client = access(db, actor, day, body.link_id)
            def action():
                previous = planning.source_day(day)
                if not db.get(MemoCarryNotice, (owner, day, previous)):
                    db.add(MemoCarryNotice(owner_user_id=owner, target_date=day, source_date=previous))
                return {'dismissed': True}, 200
            return run(db, owner, client, day, 'dismiss', body, action)

        @api.get('/days/{day}/reminder')
        def reminder(day: str, link_id: str | None = None, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, _ = access(db, actor, day, link_id)
            return management.rule(db, owner, day)

        @api.put('/days/{day}/reminder')
        def save(day: str, body: Rule, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, client = access(db, actor, day, body.link_id)
            def action():
                current = management.rule(db, owner, day)
                if current['version'] != body.rule.version:
                    return {'detail': {'code': 'reminder_changed', 'current': current, 'proposed': body.rule.model_dump()}}, 409
                planning.save_rule(db, owner, day, body.rule)
                return management.rule(db, owner, day), 200
            return run(db, owner, client, day, 'rule', body, action)

        @api.get('/days/{day}/occurrences')
        def occurrences(day: str, link_id: str | None = None, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, _ = access(db, actor, day, link_id)
            return {'occurrences': management.occurrences(db, owner, day)}

        @api.post('/days/{day}/occurrences/{occurrence_id}/ack')
        def ack(day: str, occurrence_id: str, body: Command, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, client = access(db, actor, day, body.link_id)
            def action():
                management.ack(db, owner, day, occurrence_id)
                return {'acknowledged': True, 'occurrence_id': occurrence_id}, 200
            return run(db, owner, client, day, 'ack:' + occurrence_id, body, action)

        @api.post('/days/{day}/occurrences/{occurrence_id}/cancel')
        def cancel(day: str, occurrence_id: str, body: Command, db=Depends(policy.get_db), actor=Depends(auth)):
            owner, client = access(db, actor, day, body.link_id)
            def action():
                management.cancel(db, owner, day, occurrence_id)
                return {'cancelled': True, 'occurrence_id': occurrence_id}, 200
            return run(db, owner, client, day, 'cancel:' + occurrence_id, body, action)

        @api.get('/changes')
        def changes(cursor: str | None = Query(None, max_length=200), db=Depends(policy.get_db), actor=Depends(auth)):
            owner, client = identity(actor)
            ns = sync.namespace()
            prefix = sync.digest(['management-v2', ns, owner, client])[:32] + ':'
            if cursor and (not cursor.startswith(prefix) or not cursor[len(prefix):].isdigit()):
                raise HTTPException(409, {'code': 'cursor_namespace_mismatch'})
            after = int(cursor[len(prefix):]) if cursor else 0
            if after > 9223372036854775807:
                raise HTTPException(422, 'Cursor out of range')
            rows = db.query(Change).filter_by(namespace=ns, owner_user_id=owner, device_id=actor.id if native else None).filter(
                Change.id > after).order_by(Change.id).limit(101).all()
            events = []
            for row in rows[:100]:
                link = db.get(MemoSyncLink, row.link_id) if row.link_id else None
                events.append({'cursor': prefix + str(row.id), 'day': row.memo_date,
                    'document_id': link.document_id if link else None, 'link_id': row.link_id,
                    'management_revision': row.revision, 'kind': 'unlinked' if link and not link.active else row.kind})
            return {'events': events, 'cursor': prefix + str(rows[min(len(rows), 100)-1].id if rows else after), 'has_more': len(rows) > 100}

        if native:
            @api.post('/days/{day}/carry/local-source')
            def local_copy(day: str, body: LocalCopy, db=Depends(policy.get_db), actor=Depends(auth)):
                owner, client = access(db, actor, day, body.link_id)
                if body.source_date != planning.source_day(day):
                    raise HTTPException(422, 'Source must be previous same weekday')
                def action():
                    identity = 'local:' + client + ':' + body.local_source_id
                    key = sync.digest(['local-copy-v2', sync.namespace(), owner, identity, day])
                    copied = db.query(PersonalMemo).filter_by(owner_user_id=owner, client_key=key).first()
                    if not copied:
                        doc = db.query(MemoSyncDocument).filter_by(owner_user_id=owner, namespace=sync.namespace(), type='DAY', key=day).one()
                        item = {'client_key': key, 'content': body.item.content, 'section': body.item.section,
                            'kind': 'checklist', 'completed': False, 'sort_order': 0}
                        content = sync.normalize(db, doc, {'items': [item], 'deleted': False})['items'][0]['content']
                        tail = db.query(PersonalMemo.sort_order).filter_by(owner_user_id=owner, memo_date=day,
                            section=body.item.section, deleted_at=None).with_for_update().all()
                        content, snippet = planning.pm.prepare_content(db, owner, content)
                        copied = PersonalMemo(owner_user_id=owner, memo_date=day, section=body.item.section,
                            kind='checklist', completed=False, content=content, snippet=snippet, client_key=key,
                            sort_order=max((r[0] or 0 for r in tail), default=-1)+1, version=1, user_modified=True)
                        db.add(copied)
                        db.flush()
                        planning.pm.track_image_references(db, owner, '', content)
                    mappings = [mapping(copied, body.local_copy_key, identity, day)]
                    validate_aliases(db, owner, day, mappings)
                    management.touch(db, owner, day)
                    return {'mappings': mappings, 'refresh_required': True}, 200
                return run(db, owner, client, day, 'local-copy', body, action)
        return api

    app.include_router(router(True))
    app.include_router(router(False))
