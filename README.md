# pi-forget

A pi extension for reversible, branch-local context forgetting.

`pi-forget` lets the model move future work onto a cleaned synthetic branch, omitting stale prior turns or redacting large outputs without deleting or rewriting JSONL session history. It is a context-budget cleanup tool, not a security/privacy tool: it does not erase session history, logs, or other copies of leaked secrets/tokens.

The original branch remains intact. A forget operation creates a sibling branch from the earliest affected entry, replays kept history, inserts replacement summaries/placeholders, and records metadata so `/unforget` can jump back to the original branch. Replayed entries get new session ids, but pi-forget records aliases so older `turn:<id>`, `entry:<id>`, and `output:<id>` targets usually continue to resolve after additional cleanup passes.

## Install

```bash
pi install https://github.com/mteam88/pi-forget
```

## Tools

### `list_context`

Lists provider-visible turns with stable targets. Default output is compact:

```text
turn:abc12345  user: "old irrelevant turn"  2 entries, ~120 total tokens

Largest forgettable outputs:
  output:fde92dfa  bashExecution, 12000 chars, "..."
```

For routine cleanup, start with the default summary. If output chars are high, search explicit output targets:

```ts
list_context({ detail: "outputs", minChars: 2000, maxOutputs: 12, excludeLatestTurns: 1 })
```

Use `detail:"entries"` with a `turn:<id>` target to expand one turn, or `detail:"outputs"` to search output redaction targets. Output search supports `minChars`, `maxOutputs`, `query`, and `excludeLatestTurns`, and includes prelude outputs left visible by compaction/split turns.

When a tool result is large, pi-forget may also inject a small provider-visible hint with the exact `output:<id>` target so the model can summarize it without first calling `list_context`.

### `forget`

Prefer `output:<id>` for bulky tool/read/bash/list_context output so the surrounding conversation stays visible. Prefer `turn:<id>` with `replacement` for completed stale work that can be collapsed into a summary. Do not forget the current/latest turn.

Forget a whole visible turn:

```ts
forget({ targets: ["turn:abc12345"], reason: "obsolete debugging path" })
```

Or replace it with a short summary:

```ts
forget({
  targets: ["turn:abc12345"],
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

`output:<id>` applies to `toolResult` and `bashExecution` entries. `replacement` is optional for any target and is useful when replacing a large raw output with a detailed summary. For multiple targets, use `replacements` for per-target summaries:

```ts
forget({
  targets: ["output:aaaa1111", "output:bbbb2222"],
  replacements: {
    "output:aaaa1111": "Summary of first large output...",
    "output:bbbb2222": "Summary of second large output..."
  }
})
```

The original session entries remain unchanged; `pi-forget` creates a synthetic branch containing cloned kept entries plus `pi-forget` replacement/metadata entries.

Do not use `forget` to handle sensitive tokens, credentials, or secrets. Rotate/revoke secrets and clean the underlying storage/logs instead.

## Slash commands

```text
/forget turn:abc12345 optional reason
/forget entry:fde92dfa optional reason
/forget output:fde92dfa optional reason
/forgotten
/unforget forget-001-abcd
```

The model-facing `forget` tool and manual `/forget` command use the same synthetic-branch implementation. `/unforget` returns to the original branch recorded by the selected forget operation.

## Development

```bash
npm run check
npm run test:rpc
```

The RPC tests default to `pi-mono` source when present. Set `PI_BIN=/path/to/pi` to test another pi binary.
