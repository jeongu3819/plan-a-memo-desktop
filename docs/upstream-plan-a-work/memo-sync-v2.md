# Memo Sync v2 — shared management extension

Implementation contract, default OFF. Extends v1 without changing its snapshot,
authentication, DAY/NEXT_LIST, attachment, conflict or cursor DTOs. Actual Desktop
integration requires a new client; Desktop 0.2.3 is v1-only.

## Identity and authorization

Management is keyed by configured namespace + authenticated owner + DAY date.
The canonical item identity is `(namespace, owner, personal_memos.id)`, as returned
by v1 snapshots; `client_key` maps a newly uploaded item to that identity. A
Desktop SQLite ID is never a server item ID. No content/title deduplication.

Native routes live under `/api/memo-sync/native/v2`; browser routes under
`/api/memo-sync/web/v2`. Native uses the exact existing memo-only bearer guard;
Web uses its existing session/CSRF. Native DAY calls require the active v1
`link_id` generation for that date. Server-backed carry sources must also be
linked to that device. Neither read nor management mutation creates a link.
Unlink/revoke disables native management writes including cached retries.

## Reused data and versions

The four Planning tables remain canonical: copies/provenance, prompt dismissal,
rule wall-time/timezone/version and delivery occurrences. Three additive v2
tables provide management revision/selected offsets/monotonic acknowledgements,
per-device change delivery, and durable request results/local-copy identity maps.
No existing table ALTER, memo backfill or duplicate live snapshot is required.

`rule.version`, `management_revision`, v1 document version and item version are
distinct. Rule writes compare the current rule version under the same owner lock
as v1/canonical writes. Mismatch is 409 with current/proposed settings; clients
retain their proposal and require explicit selection, resubmitting against a
fresh version with a new request ID. No timestamp winner.

## Carryover and offline convergence

POST selected source item IDs + source item versions; append new canonical rows
using existing sanitizer/image ownership/Sync publication hooks. The existing
unique owner/source/target provenance key converges concurrent Web/native copies.
Existing copy is returned even if it has since been edited, moved or deleted;
never resurrect it. Source remains unchanged. Results map each provisional
`local_copy_key` to the canonical copied ID/client_key, plus copied/deleted/moved
state. Prompt dismissal and copy history are included in DAY management state.
Manual candidates omit already copied entries even after a prompt was dismissed.

Offline client transaction: create a provisional local copy and a stable
request_id/source server identity/source version/local_copy_key outbox operation
together. On reconnect: upload only selected copy images if needed; send carry
operations **before** queued full snapshots; apply returned identity maps
transactionally; preserve modified provisional content as a draft; pull the
current DAY and combine identity mappings without dropping unrelated rows.
Never replace an old snapshot's base_version with a fresh pull version. Dirty
local content still uses ordinary v1 whole-DAY conflict selection. A recorded
provisional copy key in a later native snapshot is rejected with
`copy_mapping_required` until canonical identity is used. This protects against
accidentally re-creating a copy after replay. Unknown legacy copies cannot be
automatically recognized; they require user review, never title matching.

Local-only source → linked target is a separate explicit selected-copy request.
Only the selected item content is sent. Source identity is scoped to the current
device + stable local source UUID; deterministic server client_key and request
journal prevent retries from creating duplicates. No source document is created
or linked. Copies from unrelated local device identities are not merged. Old
local-only history without a stable source identity requires user mapping; do
not auto-import a complete local history or original DAY.

## Reminder rule and occurrences

One rule per owner/date; offsets 7/2, HH:mm, IANA timezone, enabled derived from
selected offsets. Selected offsets persist independently from delivery status.
Changing settings updates pending schedules, never repeats an already sent or
acknowledged occurrence. Empty offsets stop this date's future reminders.
All checklist items completed/deleted/moved cancels pending deliveries; new work
does not silently re-enable a cancelled reminder—explicit save can rearm it.

An opaque occurrence ID is deterministically bound to namespace/owner/date/offset;
1-week and 2-day occurrences have separate identities. Occurrence DTO separates
scheduled_at, delivery_status, acknowledged_at and effective state
(scheduled/published/acknowledged/cancelled/missed). Acknowledgement is monotonic
and global to the account, not a per-device read flag. Existing NotificationLog
read_at mirrors it. Deleting a channel log must not erase acknowledgement.

Explicit click/confirm/read sends occurrence ID. Opening a DAY does not ACK.
ACK retry is safe. Offline ACK is accepted for a known due occurrence even if
the worker has not yet emitted its Web log; future occurrences cannot be ACKed
early. Confirming offset 7 leaves offset 2 unchanged. Cancel occurrence only
affects that offset; stopping the date uses empty rule offsets.

Before showing a connected local OS reminder, online clients pull occurrence
state and suppress acknowledged/cancelled/missed events. They persist offline
ACKs in their outbox, synchronize ACKs before processing due display jobs, and
remove scheduled or displayed notifications where supported. Unreachable devices
and already displayed OS banners cannot be recalled immediately or guaranteed.
One occurrence may have several delivery channels; that is not several logical
occurrences. The server does not send unsolicited email or browser Push.

## Changes, initial link, compatibility

v2 has a separate opaque namespace/client-bound cursor; never pass it to v1.
Each event identifies DAY, link generation, management revision and kind.
Clients pull the state, durably apply it and the page cursor in one local
transaction. No server delivery ACK replaces an occurrence acknowledgement.
New/relinked DAY emits an initial state event; inactive links reveal no current
state. v1 handles unlink data retention as before.

An explicit occurrence cancel is terminal for that date/offset; saving the rule
does not reissue it. A rule-disabled or all-completed pending schedule can be
rearmed by explicit save. ACK is monotonic and takes precedence in effective
state; cancellation does not create an ACK timestamp.

Initial connection: pull content and management independently. No local changes:
adopt server. Local rule with server version 0: submit with base version 0.
Both exist and differ: keep both until explicit user choice; stale choice still
fails version check. Replay identifiable copy operations first; do not discard
unknown old local provenance or acknowledgements. Only map old local alerts to
a server occurrence after explicit date/offset/schedule verification.

v1-only clients retain content Sync. Their local copy/reminder actions do not
magically become shared: upgrade is required before using shared management on
linked days. An unmodified 0.2.3 binary cannot be remotely prevented from doing
local copies or local alerts; do not advertise full convergence for that binary.
Local-only memo management remains local on every platform.

## Flags and rollout

`MEMO_SYNC_V2_ENABLED=false`, `MEMO_SYNC_V2_SCHEMA_READY=false`,
`VITE_MEMO_SYNC_V2_ENABLED=false` by default. Native v2 also requires enabled v1
and Planning with both migrations verified. Keep v2 SCHEMA_READY and the fixed
namespace after applying its DDL, even when disabling exposure: existing
management changes/ACKs/provenance must remain protected. No runtime DDL.
Order: existing v1 12 tables → Planning 4 → v2 additive metadata → validation →
enable flags → upgraded development/Staging client. Never use production tests.

Use separate databases per environment, as required by v1. The reused canonical
Planning tables are account/date scoped, not a way to multiplex independent
environments in one database. Keep environment/server ID fixed after setup.

Endpoint/DTO examples, error handling and offline ordering are in the
[Desktop handoff](../handoff/MEMO_SYNC_V2_DESKTOP_HANDOFF.md). Deployment review is
in [the implementation report](../MEMO_SYNC_V2_IMPLEMENTATION.md). No Desktop
SQLite/Tauri/Windows scheduler code is changed here.
