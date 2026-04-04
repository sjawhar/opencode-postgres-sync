# Bus Event Contract Map

Bus events that plugins receive via `hooks.event()` are unversioned `{ type, properties }` payloads from `bus.subscribeAll()`.
Sync/SSE events are versioned `{ id, seq, aggregateID, type, data, origin }` payloads.

## SSE → Bus Event Mapping

| SSE Type                 | Bus Type               | Properties Shape                                                                                                                                                                                                                                                                                                                             | Projector Function          | Can Populate All Columns? | Notes                                                                                                                                                                                            |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.created.1`      | `session.created`      | `{ sessionID, info }` where `info` is `Session.Info` = `{ id, slug, projectID, workspaceID?, directory, parentID?, summary?: { additions, deletions, files, diffs? }, share?: { url }, title, version, time: { created, updated, compacting?, archived? }, permission?, originMachine?, revert?: { messageID, partID?, snapshot?, diff? } }` | `replaySession()`           | **NO**                    | Bus has the full session snapshot needed for session row fields, but not sync `origin`. Current projector sets `origin_machine` from `evt.origin.machine`, which the bus payload does not carry. |
| `session.updated.1`      | `session.updated`      | `{ sessionID, info }` where `info` is **full `Session.Info` snapshot on the bus**, not the patch schema used in sync storage                                                                                                                                                                                                                 | `updateSession()`           | **NO**                    | `server/projectors.ts` converts sync patch events into a full row snapshot before publish. This is enough for all mutable session fields, but `evt.origin.machine` is still missing.             |
| `session.deleted.1`      | `session.deleted`      | `{ sessionID, info }` where `info` is `Session.Info`                                                                                                                                                                                                                                                                                         | inline delete in `replay()` | **YES**                   | Delete only needs `sessionID` (or `info.id` fallback). Bus provides both.                                                                                                                        |
| `message.updated.1`      | `message.updated`      | `{ sessionID, info }` where `info` is `MessageV2.Info` = user or assistant message snapshot                                                                                                                                                                                                                                                  | `upsertMessage()`           | **YES**                   | Bus carries the same top-level fields the projector reads from `info` (`id`, `sessionID`, `role`, `agent`, time/model data).                                                                     |
| `message.removed.1`      | `message.removed`      | `{ sessionID, messageID }`                                                                                                                                                                                                                                                                                                                   | inline delete in `replay()` | **YES**                   | Exact bus equivalent exists.                                                                                                                                                                     |
| `message.part.updated.1` | `message.part.updated` | `{ sessionID, part, time }` where `part` is full `MessageV2.Part` discriminated union                                                                                                                                                                                                                                                        | `upsertPart()`              | **YES**                   | Bus carries the same full part snapshot plus `time` used for `time_created`/`time_updated`.                                                                                                      |
| `message.part.removed.1` | `message.part.removed` | `{ sessionID, messageID, partID }`                                                                                                                                                                                                                                                                                                           | inline delete in `replay()` | **YES**                   | Exact bus equivalent exists.                                                                                                                                                                     |

## Current plugin SSE field access

From `opencode-postgres-sync/src/projectors.ts`:

- `session.created.1` → reads `data.info`, `origin.machine`
- `session.updated.1` → reads `data.info`, `data.sessionID`, `origin.machine`
- `session.deleted.1` → reads `data.sessionID`, fallback `data.info.id`
- `message.updated.1` → reads `data.info`
- `message.removed.1` → reads `data.messageID`
- `message.part.updated.1` → reads `data.part`, `data.time`
- `message.part.removed.1` → reads `data.partID`

## Additional bus-only event relevant to hooks migration

| Bus Type             | Properties Shape                                 | Why it matters                                                                                                                                                       |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.part.delta` | `{ sessionID, messageID, partID, field, delta }` | This has **no SSE equivalent** in the plugin's current `replay()` switch. It is an incremental streaming helper event, not a replacement for `message.part.updated`. |

## Sync → Bus bridge details

- `SyncEvent.init()` registers the latest sync definitions on the bus as unversioned types.
- `SyncEvent.run()` / `SyncEvent.replay(..., { republish: true })` publish `ProjectBus` events with `type: def.type` (for example `session.created`, not `session.created.1`).
- `server/projectors.ts` installs `convertEvent()`, and the only special-case conversion is `session.updated`, which becomes a **full `Session.Info` snapshot** before bus publication.
- Plugins receive the bus payload through `packages/opencode/src/plugin/index.ts` `bus.subscribeAll()` → `hook["event"]?.({ event: input })`.

## Missing fields on bus events

- `seq`: **not available** on the bus payload
- `id`: **not available** on the bus payload
- `aggregateID`: **not available as a field**; for all seven required events it is derivable from `properties.sessionID`
- `origin`: **not available** on the bus payload

## Consequences for the plugin

### What is possible from bus events alone

- Rebuild `session`, `message`, `part`, and delete projections for the seven required SSE event types
- Handle streaming UX separately with `message.part.delta`

### What is not possible from bus events alone

- Reproduce the current `event` table rows exactly (`id`, `aggregate_id`, `seq`, `type`, `data`, `origin`)
- Update `replication_state.last_event_id/last_seq` from live hooks the way the SSE consumer currently does
- Populate `session.origin_machine` the same way `replaySession()` / `updateSession()` do today, because the bus strips `origin`

## STOP GATE Decision

**STOP** — every required SSE business event does have a bus equivalent for `hooks.event()`, and `message.part.delta` is available as an extra bus-only streaming signal, **but** the bus contract omits sync metadata (`id`, `seq`, `origin`, explicit `aggregateID`) that the plugin currently persists into `event`, `replication_state`, and `session.origin_machine`. Preserving the current projection contract exactly is impossible without core OpenCode exposing more metadata on plugin-visible bus events, or the plugin being redesigned to stop depending on that metadata.
