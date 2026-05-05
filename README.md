# pi-forget

A pi extension for reversible, branch-local context forgetting.

`pi-forget` lets the model omit stale prior turns from future provider requests without deleting or rewriting the JSONL session history.

## Install / run locally

```bash
pi --extension ./src/index.ts
```

Or install this directory as a local pi package:

```bash
pi install /absolute/path/to/pi-forget
```

## Tools

### `list_context`

Lists provider-visible turns with stable targets:

```text
turn:1
  user aaa00001: "old irrelevant turn"
  assistant aaa00002: text
```

### `forget`

Forgets whole turns:

```ts
forget({ targets: ["turn:1"], reason: "obsolete debugging path" })
```

It can also forget any specific provider-visible entry by ID:

```ts
forget({ targets: ["entry:fde92dfa"], reason: "local file listing" })
```

The original session remains unchanged; a `pi-forget` custom entry is appended.

## Slash commands

```text
/forget turn:1 optional reason
/forget entry:fde92dfa optional reason
/forgotten
/unforget forget-001-abcd
```

The `/forget` command is intentionally included for manual/RPC testing and emergency user control. The model-facing `forget` tool uses the same implementation.

## Design invariant

One projection mirrors pi's `buildSessionContext()` and attaches source entry IDs. Every command/tool/filter uses that projection. The extension can omit complete provider-visible turns or specific provider-visible entries.

## Development

```bash
npm run check
npm run test:rpc
```
