# `message.part.delta` Semantics

## Conclusion

`message.part.delta` is an **incremental streaming delta**, not a full part snapshot.

## Evidence

### Schema

`packages/opencode/src/session/message-v2.ts` defines:

```ts
BusEvent.define(
  "message.part.delta",
  z.object({
    sessionID,
    messageID,
    partID,
    field: z.string(),
    delta: z.string(),
  }),
)
```

The payload contains only:

- `sessionID`
- `messageID`
- `partID`
- `field`
- `delta`

It does **not** include:

- part `type`
- full `text`
- `time`
- `tokens`
- `cost`
- any other discriminated-union fields from `MessageV2.Part`

So it cannot describe a complete `part` row by itself.

### Producers

`packages/opencode/src/session/index.ts` exposes `updatePartDelta()` as a direct `bus.publish(MessageV2.Event.PartDelta, input)` call.

`packages/opencode/src/session/processor.ts` uses it only in two streaming paths:

1. `reasoning-delta`
2. `text-delta`

Both current call sites publish:

- `field: "text"`
- `delta: value.text`

So the currently observed semantics are: **append streamed text to an already-created text/reasoning part**.

### Lifecycle around the delta

For both text and reasoning streaming:

1. A full `message.part.updated` event is emitted first with a newly created part whose `text` starts as `""`
2. One or more `message.part.delta` events are emitted while text streams in
3. A final full `message.part.updated` event is emitted with the completed part snapshot (trimmed text, final metadata/time)

That makes `message.part.delta` a low-latency incremental signal layered on top of the authoritative `message.part.updated` snapshots.

## Projection impact

### Can `message.part.delta` populate a full Postgres `part` row?

**No.**

It can only update an existing row incrementally.

### Required accumulation strategy

If the plugin wants streaming updates from hooks:

- create/upsert the row from `message.part.updated`
- on `message.part.delta` with `field === "text"`, append `delta` to the existing row's text/data for `partID`
- accept the later `message.part.updated` as the authoritative final snapshot

### Can the plugin ignore `message.part.delta`?

Yes, if it only needs eventual consistency and can wait for the next `message.part.updated` snapshot.

No, if it wants the same live incremental text growth users see during streaming.

## Gating result for delta specifically

`message.part.delta` does **not** block a hooks-based migration for part projection, because the bus still provides `message.part.updated` full snapshots.

The blocking issue is elsewhere: live bus events do not carry sync metadata (`id`, `seq`, `origin`) required to preserve the plugin's current event-log/checkpoint behavior.
