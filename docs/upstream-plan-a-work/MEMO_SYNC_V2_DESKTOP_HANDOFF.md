# Memo Sync v2 — Native client implementation handoff

2026-10-11. Server code and synthetic-client validation only. Desktop 0.2.3 has
not been changed or tested here. This contract also applies to future mobile
clients; Windows scheduling is one delivery channel.

Read [v2 contract](../contracts/memo-sync-v2.md) and retain all
[v1](../contracts/memo-sync-v1.md) authentication, attachment, link-generation,
full-document conflict and content ACK rules. No extra fields enter v1 snapshots.

## 1. Routes and authentication

Base **N** = `/api/memo-sync/native/v2`, **W** = `/api/memo-sync/web/v2`.
Native sends the existing memo bearer credential, never a browser cookie or
body user ID. W uses current Web session + CSRF + trusted Origin. Unknown body
fields are rejected. Owner/client/namespace come from authentication/config.

All DAY GETs on N require `?link_id=<current-active-v1-generation>`; carry
candidate GET additionally requires `source_link_id` for target minus 7 days.
All N mutations require body `link_id`. W omits these link requirements: its
canonical Web dates need not be linked. Neither API creates a link.

| Method / suffix (N and W unless noted) | Request / result |
|---|---|
| GET `/capabilities` | version=2, namespace, features=[carryover,reminder_rules,occurrences,shared_ack], content_sync=1, management_sync=2, local_only_upload=false |
| GET `/days/{day}/state` | full current management state, described below |
| GET `/days/{day}/carry` | optional timezone IANA (default Asia/Seoul); source_date, target_date, dismissed, auto_prompt, items using existing PersonalMemo DTO |
| POST `/days/{day}/carry` | command + source_link_id (N) + items; canonical mappings + refresh_required=true |
| POST `/days/{day}/carry/local-source` (N only) | command + selected local-source UUID/content; canonical mappings, no source upload/link |
| POST `/days/{day}/carry/dismiss` | command; `{dismissed:true}` |
| GET `/days/{day}/operations` | most recent 50 accepted/conflicting commands for the date, across clients; request_id, origin_client, kind, created_at, status_code, result |
| GET `/days/{day}/reminder` | rule DTO |
| PUT `/days/{day}/reminder` | command + `rule`; saved rule or 409 current/proposed |
| GET `/days/{day}/occurrences` | `{occurrences:[...]}` |
| POST `/days/{day}/occurrences/{id}/ack` | command; `{acknowledged:true,occurrence_id}` |
| POST `/days/{day}/occurrences/{id}/cancel` | command; `{cancelled:true,occurrence_id}` |
| GET `/changes?cursor=...` | events (max100), cursor, has_more; initial cursor omitted |

`day` is an actual YYYY-MM-DD, not UTC conversion of a date label. Command:
`{request_id,link_id}`; request ID is 8–64 ASCII alphanumerics/underscore/hyphen.
Use UUIDs and persist them with the local operation. Exact retries return the
stored HTTP status/result, including rule conflicts. Different payload/day/kind
with the same request ID returns 409 `request_id_reused`. Scope is namespace +
owner + authenticated client. Authorization/link checks precede cached results.
Atomic validation failures are rolled back, not recorded as successful work.

Common errors: 401 invalid/expired/revoked/wrong namespace credential; 403 Web
CSRF/Origin; 404 feature unavailable or inaccessible resource; 409 stale link,
version, source, request or identity; 422 invalid DTO/date/timezone/offsets.
Use existing v1 attachment and content-limit handling; do not interpret any
non-2xx response as success or advance a durable cursor on failure.

## 2. Carryover identity, response, and offline mapping

Source identity is server item ID within namespace/account, **not local SQLite
ID**. Obtain it from v1 source DAY pull. Item `version` is the item revision,
not DAY version or management revision. Both source and destination must be
linked to the requesting native device for the server-backed route.

```json
{
  "request_id": "8ae854ed-1265-4bab-82ed-684034c31fd0",
  "link_id": "<target-generation>",
  "source_link_id": "<previous-week-generation>",
  "items": [{"id": 101, "version": 4, "local_copy_key": "<stable-provisional-key>"}]
}
```

```json
{
  "mappings": [{
    "source_identity": "server:101", "local_copy_key": "<stable-provisional-key>",
    "copied_item_id": 208, "client_key": "carry-<server-key>",
    "deleted": false, "moved": false
  }],
  "refresh_required": true
}
```

1–100 unique selected IDs per request; source must be the immediately preceding
same weekday, incomplete checklist, undeleted, with expected item version. A
previously completed copy returns its existing identity even if source changed
or copy moved/deleted. It does not resurrect or replace it. New copies append
to the same section, preserve HTML/images and begin incomplete. A completed
copy does not complete the source. `carry_source_changed` requires re-query and
user selection. `copy_identity_reused` rejects one provisional key used for
different provenance or an unrelated existing item.

**Offline outbox ordering is mandatory:**

1. Atomically create provisional local copy + operation UUID + stable source
   identity/version + provisional key in the local DB/outbox.
2. Reconnect/authenticate; verify account, namespace and link generations.
3. Send copy commands before any full target DAY snapshot containing these copies.
4. Apply canonical copied ID/client_key mapping transactionally. If another
   client already copied it, both operations map to the same canonical row.
5. Preserve any edits to the provisional copy as a local draft. Pull latest DAY,
   retain all unrelated rows, compare draft with canonical copy; show existing
   whole-DAY conflict if changes cannot be safely resolved. Do not discard edits
   just because an identity was mapped.
6. Never stamp a stale snapshot with a fresh base_version. Existing v1 stale
   push produces a conflict, preserving both snapshots. A known provisional
   key in push returns `copy_mapping_required` until canonical ID/key is used.
7. Keep original request and retry it after response loss. Refresh state after
   replay; a cached response may predate a later move/delete/setting change.

No content-based deduplication. Unmapped historical copies from 0.2.3 require
user review; do not upload a guessed full snapshot. `state.copies` exposes all
server-source provenance for the date; `state.local_source_copies` lists unique
local-source provenance. `/operations` is a bounded recent command audit, not
the complete source of truth for copy history.

### Local-only source → selected shared copy

Use N `/days/{target}/carry/local-source`, with:

```json
{
  "request_id": "<uuid>", "link_id": "<target-generation>",
  "source_date": "2026-10-03", "local_source_id": "<lowercase-local-source-uuid>",
  "local_copy_key": "<stable-provisional-key>",
  "item": {"content": "<p>Only selected copy</p>", "section": "am"}
}
```

Target in this example is 2026-10-10. Upload only selected-copy attachments via
v1, then use owned server image references. No file paths/base64 inline images.
Only the selected content is uploaded, never the original DAY/history. Source
identity is `local:<authenticated-device-id>:<local_source_id>`; same identity
and target yield one deterministic canonical client_key. Keep the UUID stable
across offline retries. Across distinct devices, unknown local originals cannot
be proven identical; do not merge them. Account/device changes or legacy UUID
absence require explicit mapping/review. Changed local draft on a repeated
operation is preserved by the client and resolved after canonical pull.

## 3. Rule synchronization and first link

Rule DTO: `version`, `timezone` (IANA, null only when absent), `local_time`
(HH:mm), `days_before` (unique subset [7,2]), `enabled` (derived), `deliveries`.
PUT sends only writable fields **inside** `rule`:

```json
{
  "request_id": "<uuid>", "link_id": "<generation>",
  "rule": {"version": 3, "timezone": "Asia/Seoul", "local_time": "09:00", "days_before": [7, 2]}
}
```

Do not echo `enabled` or `deliveries` into the strict request. To stop remaining
date reminders PUT `days_before:[]` with the current version; no DELETE tombstone
is needed. POST occurrence cancel is only one occurrence. Rule version is
independent of content and management revisions. Conflict response:
`409 {detail:{code:"reminder_changed",current:<rule>,proposed:<submitted-rule>}}`.
Preserve both; user selects current or retries proposal with current version and
**new** request ID. Another intervening update causes another 409. The journal
retains the rejected proposal, including after dialog closure.

First link: pull management separately from content. Adopt server if no local
settings. With absent server rule use version0. Existing differing server/local
settings require a choice before push; do not discard local settings. Same
settings can be adopted without a write. Unknown legacy occurrence IDs/read
states require date/offset/schedule verification before mapping.

## 4. Occurrence identity and account-wide acknowledgement

```json
{
  "id": "<opaque-64-character-id>", "days_before": 7,
  "scheduled_at": "2026-10-17T00:00:00Z", "state": "acknowledged",
  "delivery_status": "sent", "acknowledged_at": "2026-10-17T00:01:00Z",
  "notification_id": 99
}
```

Never use Web notification_id or an OS toast ID as logical identity. Logical ID
is stable for namespace/account/date/offset, even if an unsent scheduled time
changes. States: scheduled, published, acknowledged, cancelled, missed. Each
offset has one occurrence. Confirming 7-day does not confirm 2-day.

ACK is monotonic. Explicit click/navigation from an alert, confirm button, or
read command queues ACK. Merely opening DAY never does. Persist offline ACK and
its request ID before dismissing the local UI. Server accepts a known due
occurrence (also if the Web worker has not dispatched yet); future ACK gets409
`occurrence_not_due`. Duplicate ACK is safe. ACK wins the effective read state
even if a later channel cancellation occurs. Cancel is not ACK, and does not
invent a read timestamp. Explicitly cancelled occurrence cannot be reissued by
resaving the date rule. Settings-disabled/all-completed cancellations may be
rearmed by explicit rule save before due time; sent/acknowledged occurrences
never repeat. Past schedule is marked missed rather than retroactively sent.

Connected Windows scheduling must use these occurrence IDs. After rule pull,
replace pending OS jobs; after ACK/cancel pull, cancel queued jobs and attempt
to remove displayed app notifications using available platform facilities.
Before displaying while online, query current occurrence state; suppress
acknowledged/cancelled/missed. On reconnect send queued ACKs before showing due
jobs, then pull changes. Local-only schedules continue independently. Offline
devices and already shown OS banners cannot be recalled instantly or perfectly.

## 5. Changes and durable cursors

```json
{
  "events": [{"cursor":"<opaque>","day":"2026-10-24","document_id":"<id>",
    "link_id":"<generation>","management_revision":4,"kind":"changed"}],
  "cursor":"<page-cursor>","has_more":false
}
```

Keep a separate v2 cursor per namespace/account/device. Never send it to v1.
For changed events, GET full state: namespace, day, management_revision,
updated_at, updated_by_client, prompt{source_date,dismissed,copied_count}, copies,
local_source_copies, rule, occurrences. Apply management state and page cursor
in one local transaction, then drain next page if has_more. Content remains on
v1 cursor/pull/attachment ACK. Management has no delivery-ACK endpoint; cursor
persistence is not user acknowledgement.

Initial link emits a state event, including preexisting Web settings. Unlink
event kind is `unlinked`; stop shared jobs/outbox for that generation and retain
local/Web data. Old-generation mutations/replays are rejected after unlink or
relink. Revoke rejects all subsequent v2 access. On reauthentication after mere
credential expiry the existing device identity is retained by v1 policy;
explicitly revoked devices are not restored. Never reuse another account's queue.

## 6. Compatibility and rollout acceptance

Capabilities404: shared management unavailable; content v1 continues. Do not
silently upload pending management actions as ordinary duplicate snapshot items.
Upgraded clients must disable shared-management editing on connected DAYs until
capability is available, preserving pending work and explaining upgrade/server
availability. Unlinked local-only features remain available.

Unmodified 0.2.3 cannot be made to share read/copy state by server changes alone.
Mixed-client full convergence is unsupported: use upgraded development/Staging
builds for acceptance, and avoid simultaneous legacy local carryover/reminder
management on linked dates. Do not claim support without actual client work.

Acceptance: native↔Web simultaneous carry, offline copy/online same copy,
provisional draft preservation, distinct sources, rule conflict/stale choice,
ACK before worker/two offsets, offline ACK, revoke/unlink/generation changes,
wrong user/namespace, local-only selected upload, image download/ACK, app restart
with persisted mappings/cursors/outbox. Verify Web inbox and Windows scheduled
jobs with real logs; a mocked test or skipped real-server stage is not PASS.
Use disposable allowlisted MySQL first, then separately approved Staging with
development Desktop build. No test traffic to production.
