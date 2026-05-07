# pi-forget

A pi extension for reversible, branch-local context forgetting.

`pi-forget` lets the model omit stale prior turns from future provider requests without deleting or rewriting JSONL session history. It is a context-budget cleanup tool, not a security/privacy tool: it does not erase session history, logs, or other copies of leaked secrets/tokens.

It requires a pi build with native `context_rewrite` support. Rewrites are append-only and branch-local, so provider requests, compaction, reloads, and context accounting share the same effective context.

## Install

```bash
pi install https://github.com/mteam88/pi-forget
```

Until native context rewrites land upstream, use a pi build from:

```text
https://github.com/mteam88/pi-mono/tree/context-rewrites-for-pi-forget
```

## Tools

### `list_context`

Lists provider-visible turns with stable targets. Default output is compact:

```text
turn:1  user: "old irrelevant turn"  2 entries, 0 output chars

Largest forgettable outputs:
  output:fde92dfa  bashExecution, 12000 chars, "..."
```

Use `detail:"entries"` with `turn:N` to expand one turn, or `detail:"outputs"` to search output redaction targets. Output search supports `minChars`, `maxOutputs`, `query`, and `excludeLatestTurns`, and prints a ready-to-run `forget({ targets: [...] })` snippet.

### `forget`

Forget a whole visible turn:

```ts
forget({ targets: ["turn:1"], reason: "obsolete debugging path" })
```

Or replace it with a short summary:

```ts
forget({
  targets: ["turn:1"],
  reason: "collapse completed setup work",
  replacement: "[summary: rebased pi-mono fork, pushed branch, installed pi-forget from GitHub]"
})
```

Forget a specific visible entry:

```ts
forget({ targets: ["entry:fde92dfa"], reason: "local file listing" })
```

Redact only a tool output while preserving the surrounding tool context:

```ts
forget({ targets: ["output:fde92dfa"], reason: "huge command output" })
```

`output:<id>` applies to `toolResult` and `bashExecution` entries. `replacement` is optional for any target and is useful when collapsing a turn into a concise summary. The original session entries remain unchanged; `pi-forget` appends `context_rewrite` entries.

Do not use `forget` to handle sensitive tokens, credentials, or secrets. Rotate/revoke secrets and clean the underlying storage/logs instead.

## Slash commands

```text
/forget turn:1 optional reason
/forget entry:fde92dfa optional reason
/forget output:fde92dfa optional reason
/forgotten
/unforget forget-001-abcd
```

The model-facing `forget` tool and manual `/forget` command use the same implementation.

## Development

```bash
npm run check
npm run test:rpc
```

The RPC tests default to `pi-mono` source when present. Set `PI_BIN=/path/to/pi` to test another pi binary.
