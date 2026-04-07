# opencode-postgres-sync

Standalone Postgres sync plugin for OpenCode.

This plugin mirrors local OpenCode session data into Postgres and supports:

- metadata sync across machines
- resumable checkpoints at safe idle points
- on-demand remote session pull into local SQLite shards
- search / analytics queries over replicated data

## Development

```bash
bun install
bun run typecheck
bun test
```

## Runtime

Set `OPENCODE_SHARED_DB` to a Postgres connection string and add this repo path to your OpenCode `plugin` config.
