"""Explicit native credential boundary; browser routes retain normal session/CSRF."""
import base64
import hashlib
import hmac
import re
import secrets
from types import SimpleNamespace
from datetime import datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit, urlencode
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import update
from app.models import User, PersonalMemo, PersonalMemoImage
from app.memo_sync_models import (MemoSyncAuthorization, MemoSyncDevice, MemoSyncDocument,
    MemoSyncLink, MemoSyncRevision, MemoSyncChange, MemoSyncConflict, MemoSyncRequest,
    MemoSyncUpload, PersonalMemoList, PersonalMemoListItem)
from app.services import memo_sync as sync, personal_memos as pm

NATIVE_PREFIX = '/api/memo-sync/native/'


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Start(Strict):
    name: str = Field(min_length=1, max_length=80)
    challenge: str = Field(pattern=r'^[A-Za-z0-9_-]{43}$')
    state: str = Field(pattern=r'^[A-Za-z0-9_-]{32,128}$')
    redirect_uri: str = Field(max_length=200)
    device_id: str | None = Field(default=None, max_length=36)


class Consent(Strict):
    authorization_id: str = Field(min_length=32, max_length=64)


class Exchange(Strict):
    code: str = Field(min_length=32, max_length=128)
    verifier: str = Field(pattern=r'^[A-Za-z0-9._~-]{43,128}$')
    redirect_uri: str = Field(max_length=200)


class Link(Strict):
    type: Literal['DAY', 'NEXT_LIST']
    key: str = Field(max_length=36)
    device_id: str | None = None


class Item(Strict):
    id: int | None = Field(default=None, gt=0)
    item_version: int | None = Field(default=None, ge=0)
    client_key: str | None = Field(default=None, min_length=8, max_length=64)
    section: Literal['main', 'am', 'pm'] = 'main'
    kind: Literal['checklist', 'text'] = 'checklist'
    content: str = Field(max_length=500_000)
    completed: bool = False
    sort_order: int = Field(default=0, ge=0, le=1_000_000)


class Document(Strict):
    deleted: bool = False
    items: list[Item] = Field(max_length=1000)


class Push(Document):
    base_version: int = Field(ge=0, le=2147483647)
    local_version: int = Field(ge=0, le=2147483647)
    request_id: str = Field(pattern=r'^[A-Za-z0-9_-]{8,64}$')
    link_id: str


class Ack(Strict):
    version: int = Field(ge=1)
    link_id: str
    attachments: list[str] = Field(max_length=1000)


class Resolve(Strict):
    base_version: int = Field(ge=1)
    side: Literal['web', 'desktop']


class Restore(Strict):
    base_version: int = Field(ge=1)


class ListCreate(Strict):
    title: str = Field(min_length=1, max_length=120)


class NativeListCreate(ListCreate):
    id: str = Field(pattern=r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


def validate_redirect(value):
    try:
        p = urlsplit(value)
        valid = (p.scheme == 'http' and p.hostname == '127.0.0.1' and p.port and
                 1024 <= p.port <= 65535 and p.path == '/memo-sync/callback' and
                 not (p.username or p.password or p.query or p.fragment) and
                 value == f'http://127.0.0.1:{p.port}/memo-sync/callback')
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(422, 'Invalid native redirect URI')


def register(app, policy):
    native = APIRouter(prefix='/api/memo-sync/native', dependencies=[Depends(sync.namespace)])
    web = APIRouter(prefix='/api/memo-sync/web', dependencies=[Depends(sync.namespace)])

    def browser(request: Request, db=Depends(policy.get_db), user=Depends(policy.get_active_user)):
        sync.namespace()
        sync.lock_owner(db, user.id)
        current = db.query(User).filter_by(id=user.id).populate_existing().with_for_update().first()
        if not current or not current.is_active or current.deletion_state:
            raise HTTPException(401, 'Account unavailable')
        return current

    def device(request: Request, db=Depends(policy.get_db)):
        ns = sync.namespace()
        token = request.headers.get('authorization', '')
        if not token.startswith('Bearer pms_') or len(token) > 150:
            raise HTTPException(401, 'Desktop credential required')
        row = db.query(MemoSyncDevice).filter_by(token_hash=hashed(token[7:]), namespace=ns).first()
        if not row:
            raise HTTPException(401, 'Invalid Desktop credential')
        owner = row.owner_user_id
        # The lookup is not authorization. End its read snapshot, then acquire
        # the owner lock first and revalidate the credential using current reads.
        # This avoids both MySQL REPEATABLE READ revocation races and a reverse
        # device/owner lock order relative to browser revocation.
        db.rollback()
        sync.lock_owner(db, owner)
        row = db.query(MemoSyncDevice).filter_by(token_hash=hashed(token[7:]), namespace=ns).populate_existing().with_for_update().first()
        if not row:
            raise HTTPException(401, 'Invalid Desktop credential')
        user = db.query(User).filter_by(id=owner).populate_existing().with_for_update().first()
        if row.revoked_at or row.expires_at <= datetime.utcnow() or not user or not user.is_active or user.deletion_state:
            raise HTTPException(401, 'Desktop credential expired or revoked')
        return row

    def throttle(request, operation):
        from app.services.auth_rate_limit import reserve_many
        # Existing DB-backed, cross-worker admission. Do not trust forwarded IPs.
        ip = request.client.host if request.client else 'unknown'
        reserve_many('memo-sync:' + operation, [(ip, 60, 30)], code='MEMO_SYNC_RATE_LIMITED')

    @native.post('/auth/start')
    def start(body: Start, request: Request, db=Depends(policy.get_db)):
        throttle(request, 'start')
        validate_redirect(body.redirect_uri)
        row = MemoSyncAuthorization(id=secrets.token_urlsafe(32), namespace=sync.namespace(),
            name=body.name, challenge=body.challenge, state=body.state, redirect_uri=body.redirect_uri,
            expires_at=datetime.utcnow() + timedelta(minutes=5))
        if body.device_id:
            existing = db.query(MemoSyncDevice).filter_by(id=body.device_id, namespace=sync.namespace()).first()
            if not existing:
                raise HTTPException(404, 'Device not found')
            row.device_id = body.device_id
        db.add(row)
        db.commit()
        return {'authorization_id': row.id, 'browser_path': '/memo-desktop/authorize?' + urlencode({'request': row.id}),
                'namespace': row.namespace, 'expires_in': 300}

    @web.get('/auth/request/{authorization_id}')
    def auth_request(authorization_id: str, db=Depends(policy.get_db), user=Depends(browser)):
        row = db.get(MemoSyncAuthorization, authorization_id)
        if not row or row.namespace != sync.namespace() or row.expires_at <= datetime.utcnow() or row.code_hash:
            raise HTTPException(404, 'Authorization request expired')
        return {'name': row.name, 'redirect_uri': row.redirect_uri}

    @web.post('/auth/authorize')
    def authorize(body: Consent, db=Depends(policy.get_db), user=Depends(browser)):
        row = db.get(MemoSyncAuthorization, body.authorization_id)
        if not row or row.namespace != sync.namespace() or row.expires_at <= datetime.utcnow():
            raise HTTPException(404, 'Authorization request expired')
        if row.device_id:
            existing = db.query(MemoSyncDevice).filter_by(id=row.device_id, owner_user_id=user.id).populate_existing().with_for_update().first()
            if not existing:
                raise HTTPException(403, 'Device belongs to another account')
            if existing.revoked_at:
                raise HTTPException(409, {'code': 'device_revoked'})
        code = secrets.token_urlsafe(32)
        result = db.execute(update(MemoSyncAuthorization).where(MemoSyncAuthorization.id == row.id,
            MemoSyncAuthorization.code_hash.is_(None)).values(code_hash=hashed(code), owner_user_id=user.id,
                expires_at=datetime.utcnow() + timedelta(seconds=60)))
        if result.rowcount != 1:
            raise HTTPException(409, 'Authorization already issued')
        callback = row.redirect_uri + '?' + urlencode({'code': code, 'state': row.state})
        db.commit()
        return {'callback': callback}

    @native.post('/auth/exchange')
    def exchange(body: Exchange, request: Request, db=Depends(policy.get_db)):
        throttle(request, 'exchange')
        row = db.query(MemoSyncAuthorization).filter_by(code_hash=hashed(body.code), namespace=sync.namespace()).first()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(body.verifier.encode()).digest()).decode().rstrip('=')
        if not row or not row.owner_user_id or not hmac.compare_digest(row.challenge, challenge) or body.redirect_uri != row.redirect_uri:
            raise HTTPException(401, 'Invalid authorization code or verifier')
        owner, authorization_id = row.owner_user_id, row.id
        # End the unauthenticated lookup's MySQL read snapshot before locking.
        # Revoke and exchange serialize on the same owner, then use current reads.
        db.rollback()
        sync.lock_owner(db, owner)
        row = db.query(MemoSyncAuthorization).filter_by(id=authorization_id,
            code_hash=hashed(body.code), namespace=sync.namespace()).populate_existing().with_for_update().first()
        if not row or row.owner_user_id != owner or not hmac.compare_digest(row.challenge, challenge) or body.redirect_uri != row.redirect_uri:
            raise HTTPException(401, 'Invalid authorization code or verifier')
        user = db.query(User).filter_by(id=owner).populate_existing().with_for_update().first()
        if not user or not user.is_active or user.deletion_state:
            raise HTTPException(401, 'Account unavailable')
        result = db.execute(update(MemoSyncAuthorization).where(MemoSyncAuthorization.id == row.id,
            MemoSyncAuthorization.consumed_at.is_(None), MemoSyncAuthorization.expires_at > datetime.utcnow()
        ).values(consumed_at=datetime.utcnow()))
        if result.rowcount != 1:
            raise HTTPException(401, 'Authorization code expired or consumed')
        token = 'pms_' + secrets.token_urlsafe(48)
        desktop = db.query(MemoSyncDevice).filter_by(id=row.device_id).populate_existing().with_for_update().first() if row.device_id else None
        if row.device_id and desktop is None:
            raise HTTPException(404, 'Device not found')
        if desktop and (desktop.owner_user_id != row.owner_user_id or desktop.namespace != sync.namespace()):
            raise HTTPException(403, 'Device mismatch')
        if desktop and desktop.revoked_at:
            raise HTTPException(409, {'code': 'device_revoked'})
        if desktop is None:
            desktop = MemoSyncDevice(id=sync.uid(), owner_user_id=row.owner_user_id, namespace=sync.namespace(), name=row.name)
            db.add(desktop)
        desktop.token_hash, desktop.expires_at = hashed(token), datetime.utcnow() + timedelta(days=30)
        desktop.revoked_at = None
        db.commit()
        return {'access_token': token, 'token_type': 'Bearer', 'expires_in': 2592000,
                'device_id': desktop.id, 'user_id': desktop.owner_user_id, 'namespace': desktop.namespace}

    @web.get('/devices')
    def devices(db=Depends(policy.get_db), user=Depends(browser)):
        return [{'id': d.id, 'name': d.name} for d in db.query(MemoSyncDevice).filter(
            MemoSyncDevice.owner_user_id == user.id, MemoSyncDevice.namespace == sync.namespace(),
            MemoSyncDevice.revoked_at.is_(None), MemoSyncDevice.expires_at > datetime.utcnow()).all()]

    def revoke_device(db, desktop):
        desktop.revoked_at = datetime.utcnow()
        for link in db.query(MemoSyncLink).filter_by(device_id=desktop.id, active=True).all():
            link.active = False
        db.commit()
        return {'revoked': True}

    @web.delete('/devices/{device_id}')
    def revoke(device_id: str, db=Depends(policy.get_db), user=Depends(browser)):
        desktop = db.query(MemoSyncDevice).filter_by(id=device_id, owner_user_id=user.id, namespace=sync.namespace()).first()
        if not desktop:
            raise HTTPException(404, 'Device not found')
        return revoke_device(db, desktop)

    @native.post('/logout')
    def logout(db=Depends(policy.get_db), desktop=Depends(device)):
        return revoke_device(db, desktop)

    def create_link(db, owner, desktop, body):
        sync.validate_unit(db, owner, body.type, body.key)
        doc = db.query(MemoSyncDocument).filter_by(owner_user_id=owner, namespace=sync.namespace(), type=body.type, key=body.key).first()
        if not doc:
            doc = MemoSyncDocument(id=sync.uid(), owner_user_id=owner, namespace=sync.namespace(),
                                   type=body.type, key=body.key, version=1, deleted=False)
            db.add(doc)
            db.flush()
            sync.publish(db, doc, increment=False)
        link = db.query(MemoSyncLink).filter_by(document_id=doc.id, device_id=desktop.id, active=True).first()
        if not link:
            link = MemoSyncLink(id=sync.uid(), document_id=doc.id, device_id=desktop.id, active=True, ack_version=0)
            db.add(link)
            db.flush()
            sync.emit(db, doc, 'linked', [link])
        db.commit()
        return {'document_id': doc.id, 'link_id': link.id, 'version': doc.version, 'status': sync.status(db, doc, link)}

    @web.post('/links')
    def web_link(body: Link, db=Depends(policy.get_db), user=Depends(browser)):
        desktop = db.query(MemoSyncDevice).filter_by(id=body.device_id, owner_user_id=user.id,
            namespace=sync.namespace(), revoked_at=None).first()
        if not desktop or desktop.expires_at <= datetime.utcnow():
            raise HTTPException(404, 'Device not found')
        return create_link(db, user.id, desktop, body)

    @native.post('/links')
    def native_link(body: Link, db=Depends(policy.get_db), desktop=Depends(device)):
        if body.device_id and body.device_id != desktop.id:
            raise HTTPException(403, 'Device mismatch')
        return create_link(db, desktop.owner_user_id, desktop, body)

    @web.get('/links')
    def web_links(db=Depends(policy.get_db), user=Depends(browser)):
        result = []
        for doc, link, desktop in db.query(MemoSyncDocument, MemoSyncLink, MemoSyncDevice).join(
            MemoSyncLink, MemoSyncLink.document_id == MemoSyncDocument.id).join(
            MemoSyncDevice, MemoSyncDevice.id == MemoSyncLink.device_id).filter(
                MemoSyncDocument.owner_user_id == user.id, MemoSyncDocument.namespace == sync.namespace(),
                MemoSyncLink.active.is_(True)).all():
            result.append({'document_id': doc.id, 'type': doc.type, 'key': doc.key, 'version': doc.version,
                'link_id': link.id, 'device_id': desktop.id, 'device_name': desktop.name,
                'status': sync.status(db, doc, link)})
        return result

    def unlink(db, owner, link_id, device_id=None):
        link = db.get(MemoSyncLink, link_id)
        if not link or (device_id and link.device_id != device_id):
            raise HTTPException(404, 'Link not found')
        doc = sync.doc_owned(db, owner, link.document_id)
        if link.active:
            link.active = False
            sync.emit(db, doc, 'unlinked', [link])
        db.commit()
        return {'unlinked': True}

    @web.delete('/links/{link_id}')
    def web_unlink(link_id: str, db=Depends(policy.get_db), user=Depends(browser)):
        return unlink(db, user.id, link_id)

    @native.delete('/links/{link_id}')
    def native_unlink(link_id: str, db=Depends(policy.get_db), desktop=Depends(device)):
        return unlink(db, desktop.owner_user_id, link_id, desktop.id)

    @native.get('/changes')
    def changes(cursor: str | None = Query(None, max_length=200), db=Depends(policy.get_db), desktop=Depends(device)):
        prefix = hashed(desktop.namespace + ':' + desktop.id)[:32] + ':'
        if cursor and (not cursor.startswith(prefix) or not cursor[len(prefix):].isdigit()):
            raise HTTPException(409, {'code': 'cursor_namespace_mismatch'})
        after = int(cursor[len(prefix):]) if cursor else 0
        if after > 9223372036854775807:
            raise HTTPException(422, 'Cursor out of range')
        events = db.query(MemoSyncChange).filter(MemoSyncChange.device_id == desktop.id,
            MemoSyncChange.id > after).order_by(MemoSyncChange.id).limit(101).all()
        return {'events': [{'cursor': prefix + str(e.id), 'document_id': e.document_id,
                'link_id': e.link_id, 'version': e.version, 'kind': e.kind} for e in events[:100]],
                'cursor': prefix + str(events[min(len(events), 100)-1].id if events else after), 'has_more': len(events) > 100}

    @native.get('/documents/{document_id}')
    def pull(document_id: str, db=Depends(policy.get_db), desktop=Depends(device)):
        doc = sync.doc_owned(db, desktop.owner_user_id, document_id)
        link = sync.link_owned(db, desktop, doc)
        value = sync.snapshot(db, doc)
        value['attachments'] = sync.attachments(db, doc.owner_user_id, value['items'], policy.UPLOAD_DIR)
        return {**value, 'link_id': link.id, 'status': sync.status(db, doc, link)}

    @native.post('/documents/{document_id}/push')
    def push(document_id: str, body: Push, db=Depends(policy.get_db), desktop=Depends(device)):
        doc = sync.doc_owned(db, desktop.owner_user_id, document_id)
        sync.link_owned(db, desktop, doc, body.link_id)
        fingerprint = sync.digest({'document_id': doc.id, **body.model_dump()})
        previous = db.get(MemoSyncRequest, (desktop.id, body.request_id))
        if previous:
            if previous.digest != fingerprint:
                raise HTTPException(409, {'code': 'request_id_reused'})
            return previous.result
        value = sync.normalize(db, doc, body.model_dump(include={'items', 'deleted'}))
        # Resolve an existing conflict before changing this same unit again.
        pending = db.query(MemoSyncConflict).filter_by(document_id=doc.id, resolved_version=None).first()
        if body.base_version != doc.version or pending:
            conflict = MemoSyncConflict(id=sync.uid(), document_id=doc.id, device_id=desktop.id, source='desktop',
                base_version=body.base_version, local_version=body.local_version,
                proposed=value, server_snapshot=sync.snapshot(db, doc))
            db.add(conflict)
            sync.pin(db, doc, value)
            sync.emit(db, doc, 'conflict')
            result = {'status': 'conflict', 'conflict_id': conflict.id, 'version': doc.version}
        else:
            db.info['memo_sync_manual'] = True
            sync.replace(db, doc, value)
            result = {'status': 'accepted', 'document': sync.publish(db, doc)}
        db.add(MemoSyncRequest(device_id=desktop.id, request_id=body.request_id, digest=fingerprint, result=result))
        db.commit()
        return result

    @native.post('/documents/{document_id}/ack')
    def ack(document_id: str, body: Ack, db=Depends(policy.get_db), desktop=Depends(device)):
        doc = sync.doc_owned(db, desktop.owner_user_id, document_id)
        link = sync.link_owned(db, desktop, doc, body.link_id)
        if body.version != doc.version:
            raise HTTPException(409, {'code': 'ack_version_stale'})
        value = sync.snapshot(db, doc)
        manifest = sync.attachments(db, doc.owner_user_id, value['items'], policy.UPLOAD_DIR)
        if sorted(body.attachments) != sorted(a['name'] for a in manifest):
            raise HTTPException(409, {'code': 'attachments_incomplete'})
        link.ack_version = body.version
        db.commit()
        return {'status': sync.status(db, doc, link)}

    @web.get('/documents/{document_id}/conflicts')
    def conflicts(document_id: str, db=Depends(policy.get_db), user=Depends(browser)):
        doc = sync.doc_owned(db, user.id, document_id)
        return {'server': sync.snapshot(db, doc), 'conflicts': [
            {'id': c.id, 'proposal': c.proposed, 'source': c.source, 'created_at': c.created_at.isoformat()}
            for c in db.query(MemoSyncConflict).filter_by(document_id=doc.id, resolved_version=None).all()]}

    @web.post('/documents/{document_id}/conflicts/{conflict_id}/resolve')
    def resolve(document_id: str, conflict_id: str, body: Resolve, db=Depends(policy.get_db), user=Depends(browser)):
        doc = sync.doc_owned(db, user.id, document_id)
        c = db.query(MemoSyncConflict).filter_by(id=conflict_id, document_id=doc.id, resolved_version=None).first()
        if not c:
            raise HTTPException(404, 'Conflict not found')
        if body.base_version != doc.version:
            raise HTTPException(409, {'code': 'resolution_stale'})
        db.info['memo_sync_manual'] = True
        if body.side == c.source:
            sync.replace(db, doc, c.proposed)
        value = sync.publish(db, doc)
        c.resolved_version = doc.version
        db.commit()
        return value

    @web.get('/documents/{document_id}/history')
    def history(document_id: str, before: int = Query(2147483647, ge=1), db=Depends(policy.get_db), user=Depends(browser)):
        doc = sync.doc_owned(db, user.id, document_id)
        return [r.snapshot for r in db.query(MemoSyncRevision).filter(MemoSyncRevision.document_id == doc.id,
                MemoSyncRevision.version < before).order_by(MemoSyncRevision.version.desc()).limit(50).all()]

    @web.get('/documents/{document_id}/conflict-history')
    def conflict_history(document_id: str, before: str | None = None, db=Depends(policy.get_db), user=Depends(browser)):
        doc = sync.doc_owned(db, user.id, document_id)
        q = db.query(MemoSyncConflict).filter_by(document_id=doc.id).filter(MemoSyncConflict.resolved_version.isnot(None))
        if before:
            q = q.filter(MemoSyncConflict.id < before)
        return [{'id': c.id, 'desktop': c.proposed if c.source == 'desktop' else c.server_snapshot,
                 'web': c.proposed if c.source == 'web' else c.server_snapshot, 'resolved_version': c.resolved_version}
                for c in q.order_by(MemoSyncConflict.id.desc()).limit(50)]

    @web.post('/documents/{document_id}/conflict-history/{conflict_id}/restore')
    def restore_conflict(document_id: str, conflict_id: str, body: Resolve, db=Depends(policy.get_db), user=Depends(browser)):
        doc = sync.doc_owned(db, user.id, document_id)
        if body.base_version != doc.version:
            raise HTTPException(409, {'code': 'resolution_stale'})
        c = db.query(MemoSyncConflict).filter_by(id=conflict_id, document_id=doc.id).first()
        if not c or c.resolved_version is None:
            raise HTTPException(404, 'Conflict history not found')
        db.info['memo_sync_manual'] = True
        sync.replace(db, doc, c.proposed if body.side == c.source else c.server_snapshot)
        value = sync.publish(db, doc)
        db.commit()
        return value

    @native.get('/documents/{document_id}/conflicts')
    def native_conflicts(document_id: str, db=Depends(policy.get_db), desktop=Depends(device)):
        sync.link_owned(db, desktop, sync.doc_owned(db, desktop.owner_user_id, document_id))
        return conflicts(document_id, db, SimpleNamespace(id=desktop.owner_user_id))

    @native.post('/documents/{document_id}/conflicts/{conflict_id}/resolve')
    def native_resolve(document_id: str, conflict_id: str, body: Resolve, db=Depends(policy.get_db), desktop=Depends(device)):
        sync.link_owned(db, desktop, sync.doc_owned(db, desktop.owner_user_id, document_id))
        return resolve(document_id, conflict_id, body, db, SimpleNamespace(id=desktop.owner_user_id))

    @web.post('/documents/{document_id}/history/{version}/restore')
    def restore(document_id: str, version: int, body: Restore, db=Depends(policy.get_db), user=Depends(browser)):
        doc = sync.doc_owned(db, user.id, document_id)
        if body.base_version != doc.version:
            raise HTTPException(409, {'code': 'resolution_stale'})
        revision = db.query(MemoSyncRevision).filter_by(document_id=doc.id, version=version).first()
        if not revision:
            raise HTTPException(404, 'Revision not found')
        db.info['memo_sync_manual'] = True
        sync.replace(db, doc, revision.snapshot)
        value = sync.publish(db, doc)
        db.commit()
        return value

    @native.post('/attachments/{request_id}')
    def upload(request_id: str, file: UploadFile = File(...), db=Depends(policy.get_db), desktop=Depends(device)):
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', request_id):
            raise HTTPException(422, 'Invalid request ID')
        data = file.file.read(pm.INLINE_IMAGE_POLICY.max_file_bytes + 1)
        fingerprint = hashlib.sha256(data).hexdigest()
        old = db.get(MemoSyncUpload, (desktop.id, request_id))
        if old:
            if old.digest != fingerprint:
                raise HTTPException(409, 'Request ID reused')
            row = db.get(PersonalMemoImage, old.image_id)
            return {'name': row.stored_name, 'url': pm.image_url(row.stored_name), 'size': row.size}
        try:
            pm.INLINE_IMAGE_POLICY.validate(filename=file.filename, size_bytes=len(data), content_type=file.content_type or '')
            processed = pm.process_task_inline_image(data)
        except pm.UploadValidationError as error:
            raise HTTPException(413, str(error))
        except pm.TaskInlineImageError as error:
            raise HTTPException(error.status_code, error.detail)
        name = sync.uid().replace('-', '') + processed.extension
        stored = pm._write_copy_bytes(processed.data, filename=name, stored_name=name, context_type='personal_memo',
            context_id=desktop.owner_user_id, local_dir=pm._image_local_dir(policy.UPLOAD_DIR, desktop.owner_user_id))
        try:
            row = PersonalMemoImage(owner_user_id=desktop.owner_user_id, stored_name=name, filename=name,
                content_type=processed.mime_type, size=len(processed.data), s3_key=stored.s3_key, orphan_expires_at=None)
            db.add(row)
            db.flush()
            db.add(MemoSyncUpload(device_id=desktop.id, request_id=request_id, digest=fingerprint, image_id=row.id))
            db.commit()
        except Exception:
            db.rollback()
            pm._rollback_writes([stored])
            raise
        return {'name': name, 'url': pm.image_url(name), 'size': row.size}

    @native.get('/attachments/{name}/download')
    def download(name: str, db=Depends(policy.get_db), desktop=Depends(device)):
        from app.memo_sync_models import MemoSyncImagePin
        image = db.query(PersonalMemoImage).filter_by(owner_user_id=desktop.owner_user_id, stored_name=name).first()
        linked = image and db.query(MemoSyncImagePin).join(MemoSyncLink,
            MemoSyncLink.document_id == MemoSyncImagePin.document_id).filter(
                MemoSyncImagePin.image_id == image.id, MemoSyncLink.device_id == desktop.id, MemoSyncLink.active.is_(True)).first()
        uploaded = image and db.query(MemoSyncUpload).filter_by(device_id=desktop.id, image_id=image.id).first()
        data = pm.read_image(policy.UPLOAD_DIR, image) if linked or uploaded else None
        if data is None:
            raise HTTPException(404, 'Attachment not found')
        return Response(data, media_type=image.content_type, headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

    @web.get('/lists')
    def lists(db=Depends(policy.get_db), user=Depends(browser)):
        return [{'id': 'default', 'title': 'Next', 'memo_ids': [m.id for m in db.query(PersonalMemo).filter(
            PersonalMemo.owner_user_id == user.id, PersonalMemo.memo_date.is_(None),
            PersonalMemo.id.notin_(db.query(PersonalMemoListItem.memo_id))).all()]}] + [
            {'id': row.id, 'title': row.title, 'memo_ids': [x.memo_id for x in db.query(PersonalMemoListItem).filter_by(list_id=row.id)]}
            for row in db.query(PersonalMemoList).filter_by(owner_user_id=user.id).all()]

    @web.post('/lists')
    def create_list(body: ListCreate, db=Depends(policy.get_db), user=Depends(browser)):
        row = PersonalMemoList(id=sync.uid(), owner_user_id=user.id, title=body.title)
        db.add(row)
        db.commit()
        return {'id': row.id, 'title': row.title, 'memo_ids': []}

    @native.post('/lists')
    def native_create_list(body: NativeListCreate, db=Depends(policy.get_db), desktop=Depends(device)):
        row = db.get(PersonalMemoList, body.id)
        if row and (row.owner_user_id != desktop.owner_user_id or row.title != body.title):
            raise HTTPException(409, 'List ID already in use')
        if not row:
            row = PersonalMemoList(id=body.id, owner_user_id=desktop.owner_user_id, title=body.title)
            db.add(row)
            db.commit()
        return {'id': row.id, 'title': row.title}

    @web.put('/lists/{list_id}/items/{memo_id}')
    def assign(list_id: str, memo_id: int, db=Depends(policy.get_db), user=Depends(browser)):
        sync.validate_unit(db, user.id, 'NEXT_LIST', list_id)
        memo = pm._owned(db, user.id, memo_id)
        kind, key = sync.unit(db, memo)
        sync.mark(db, user.id, kind, key)
        old = db.get(PersonalMemoListItem, memo.id)
        if old:
            db.delete(old)
            db.flush()
        memo.memo_date, memo.section = None, 'main'
        memo.user_modified = True
        db.flush()
        if list_id != 'default':
            db.add(PersonalMemoListItem(memo_id=memo.id, list_id=list_id))
        sync.mark(db, user.id, 'NEXT_LIST', list_id)
        db.commit()
        return {'assigned': True}

    app.include_router(native)
    app.include_router(web)
