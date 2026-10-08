# PLAN-A Memo Sync v1

Status: implementation contract; opt-in preview, disabled by default. No production
migration or real Desktop EXE integration is implied. Canonical content remains in
`personal_memos`; snapshots are version history, not a second live memo store.

## Identity and selective connection

* `DAY`: authenticated owner + ISO date, **all main/am/pm sections together**.
* `NEXT_LIST`: authenticated owner + stable list ID. `default` is the existing
  undated Next collection. Named lists use an additive membership relation.
* Server document UUID, device UUID and environment namespace are opaque.
  Existing item IDs never change. New Desktop items provide stable `client_key`.
* Login/device registration never links, uploads or downloads any memo. Explicit
  link applies only to one selected document and its current attachments.
* The server namespace (`MEMO_SYNC_ENVIRONMENT`: local/staging/production) and
  installation ID (`MEMO_SYNC_SERVER_ID`) must be configured explicitly when
  enabling `MEMO_SYNC_ENABLED=true`. Tokens/cursors are bound to both.

## Wire document

`{id,type,key,version,deleted,items,attachments}`. Items contain `id` (null for a
new item), `client_key`, `section` (main/am/pm), `kind` (checklist/text), `content`
(sanitized HTML), `completed`, and `sort_order`. NEXT_LIST uses main only.
Snapshot replacement covers the **whole document**. Omitted current items become
soft-deleted. Item content versions remain separate from document versions.
Pulled items include `item_version` for Web draft reconstruction; Desktop echoes
it unchanged (or omits it for new items). It never substitutes for base_version.
Documents include a display `title` (date or Next List title).
Push limits: 1,000 items, 500,000 characters per item, 2,000,000 UTF-8 content
bytes per document. Image upload uses the existing inline-image format/size
policy. General binary file attachments are outside the current personal memo
model. An oversized existing Web document must be reduced before Desktop push.
Recurrence definitions and Dashboard today picks remain Web-managed metadata.

## Link, movement, deletion and unlink

Web link selects a registered active device (one is selected automatically;
multiple require a choice). Desktop links a selected unit, then pulls its server
snapshot. A non-empty local unit must be pushed with `base_version=0` to produce
a comparison if the server has existing content; it must never be discarded.
No historical local queue/history is uploaded as a side effect of login.

Web movement between units changes both already linked units atomically. Moving
to an unlinked unit removes the item from the linked source snapshot but NEVER
links or downloads the destination. Desktop must retain its source history and
any independently existing local destination. In v1 a Desktop push cannot claim
an item belonging to another unit; explicit Web movement or remove+new local
item is required. Existing destination local content is never overwritten.

Unlink retains both copies and stops pushes. A durable `unlinked` event tells
the device to retain its local copy. Relink starts a new link generation; stale
queued pushes/ACKs from earlier generations are rejected. Document delete is a
tombstone (`deleted=true`, empty items), with restorable history. Delete/edit
is a normal whole-document conflict, never an automatic resurrection.

## Versions, retries, cursor and ACK

Server version is a monotonically increasing integer per document. Desktop local
version is its own SQLite revision, carried for diagnostics only. Never use clocks
to resolve conflicts. Push carries base_version, link generation, request_id and
the entire document. Owner serialization covers version check, memo writes,
history, change delivery and idempotency in one DB transaction. Web changes use
the same serialization and publication path, including checks, ordering, moves,
restore, Dashboard conversion and recurrence materialization.

Request IDs are unique per device for its lifetime. Identical retries return the
original result; reuse with another payload returns 409. Retain request records
while the device exists. Pull uses an opaque environment/device-bound cursor and
returns at most 100 events after it. Cursor persistence and local application
must commit together. Advance only after all events in the page are durably
handled; a conflicted document must not block other documents.

`pending`: no ACK yet; `connected`: an older version has been acknowledged;
`synced`: latest version AND exact required attachment set acknowledged;
`conflict`: unresolved proposal. ACK is an explicit Desktop assertion that SQLite
and verified attachment files are durably committed. HTTP save success alone is
never an ACK. Pull/reconnect is safe after network loss and while Web is offline.

## Conflict and history

Stale pushes preserve their entire proposed snapshot and the Web snapshot.
No HTML merge and no Last Write Wins. Resolve with conflict ID, selected side and
fresh server base_version. A further edit returns 409 without overwriting it.
Both versions stay in history including attachment references; history restore
also requires the current base_version. Other documents continue synchronizing.
If Desktop saves first and a stale Web editor later submits HTML, the server
reconstructs the prior whole document from item-version history and preserves a
Web-origin proposal. `conflicts[].source` identifies the `proposal` origin. Render it as
Web when source=web, and render `server` as the current Desktop side. Resolution
`side` always means the displayed origin (`web`/`desktop`), never arrival time.

## Attachments

Upload before push, using a stable request ID. Only selected-unit current images
are uploaded. Server URLs use `/api/personal-memos/images/{name}/download` and
never a Desktop file path, blob URL or data URI. Manifest identifies stored_name,
size and SHA-256 of downloadable bytes. Desktop downloads through authenticated
sync attachment routes, maps names to local paths, verifies bytes, then ACKs the
exact manifest. Missing files prevent ACK. Snapshot/history references pin images
against orphan cleanup. No generic arbitrary-path download exists.

## Native authentication

Use the system browser and existing PLAN-A login. Start registers S256 challenge,
random state and `http://127.0.0.1:<ephemeral-port>/memo-sync/callback` (port
1024–65535, no credentials/query/fragment). Only this loopback literal is allowed.
The Desktop binds the listener before opening the browser and verifies state.
Browser consent issues a PLAN-A-specific 60-second one-use authorization code,
bound to the logged-in account, request and PKCE challenge. Start expires after
5 minutes. Exchange requires code, exact redirect URI and 43–128 character
verifier. Google/Naver codes and Web cookies never leave the browser.

Exchange registers the device and issues a random opaque, hashed-at-rest,
30-day Desktop bearer credential scoped only to sync routes. Expiration requires
browser reconnection. Logout/revoke immediately revokes that device credential;
local memos remain. All routes check active user, device, document/link and image
ownership. Body user_id is rejected. Browser consent retains Web CSRF protection;
native routes accept only their own credential, never a Web cookie.
Reconnection supplies the persisted `device_id` in auth/start. Browser consent
must authenticate that same owner; exchange rotates the credential in place and
preserves existing links/cursors. Explicitly revoked links stay inactive.

Loopback + PKCE follows [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html).
Custom URI was considered; Tauri's Windows deep-link handling requires process
and single-instance handling ([Tauri documentation](https://v2.tauri.app/plugin/deep-linking/)).
Loopback avoids registration/scheme collision in the initial Windows contract.

## Feature gate and integration

Frontend `VITE_MEMO_SYNC_ENABLED=true` and the server flag are both required.
Unmigrated deployments with both server flags off never query new sync tables on
ordinary memo operations.
After an approved future migration, keep `MEMO_SYNC_SCHEMA_READY=true` and the
namespace configured even if disabling the API/UI flag. This retains Web change
tracking and image history pins during a feature rollback. An installation that
has never migrated leaves both server flags unset/false.
Web polls while visible; open/unsaved editor drafts remain untouched. API details,
DDL proposal and executed tests are recorded in `docs/MEMO_SYNC_IMPLEMENTATION.md`.
Real Tauri listener, Windows credential storage, SQLite queue/ACK durability,
download mapping and EXE interoperability require the separate Desktop repository.

## Desktop integration sequence

1. Keep all unlinked SQLite units and their files local. Persist installation
   namespace + account + device ID separately from local-only data.
2. Start the loopback listener, persist state/verifier transiently, then call
   auth/start and open `browser_path` on the configured Web origin. Never accept
   arbitrary server origins from an untrusted deep link.
3. Validate callback state, exchange the PLAN-A code, store the opaque credential
   in Windows credential storage (never localStorage/logs). Keep local editing
   available throughout authentication and expiration.
4. Explicitly select one unit. For a new named Next List, POST native/lists with
   a stable local UUID `id` + title; retries of that UUID are safe. Link DAY/date
   or NEXT_LIST/id. Persist the returned server document and link generation.
5. Pull the server snapshot. If local selected content exists, preserve it and
   show a first-link comparison by pushing it with base_version=0. The server
   does not infer that local empty content authorizes deleting Web content.
6. Upload only images needed by that selected current proposal. Replace local
   image sources with returned server URLs in the transport copy, never in the
   local-only source. Push one entire unit with a persisted request ID and base.
7. On reconnect, query changes after the last durable cursor. Fetch changed
   linked documents, validate/download attachments, then atomically commit local
   document, mappings and cursor. If a local unit has queued edits, do not replace
   those edits with pull output: first push its original base to obtain conflict.
8. ACK exact current version + complete stored-name manifest after local commit.
   An accepted push also requires ACK; receive the resulting server item IDs
   before persisting the local mapping. Retry identical requests after lost replies.
9. A 409 link_inactive or unlinked event stops that generation while preserving
   local content/history. Coalesce earlier events for the same inactive link;
   never retry them by silently creating a new link. A conflicting unit may be
   deferred while processing other events/documents.
10. Display whole-unit comparisons using source labels above. Keep the proposed
    and current snapshots while the user defers. Refresh comparison after stale
    resolution (409); never resubmit the old choice against a new base silently.
