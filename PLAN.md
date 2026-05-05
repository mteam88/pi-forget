# pi-forget MVP Plan

## Goal

Build a pi extension that lets the model remove selected prior context from future provider requests, without deleting or rewriting the underlying JSONL session history.

MVP principle:

> Forget provider-visible **turns**, not arbitrary message fragments.

This makes the extension safe, reversible, branch-aware, and much simpler than trying to surgically remove individual tool calls/results.

## Source Findings

Relevant pi internals:

- Normal conversation messages are persisted on `message_end` through `sessionManager.appendMessage(...)`.
- `pi.appendEntry(customType, data)` appends a `custom` session entry that **does not participate in LLM context**.
- Provider context flows through:

  ```text
  agent.state.messages
    -> Agent.transformContext
    -> ExtensionRunner.emitContext(event.messages)
    -> convertToLlm(...)
    -> provider payload
  ```

- Extension `context` handlers receive `AgentMessage[]`, not session entry IDs.
- On resume/tree navigation, pi restores `agent.state.messages` from `sessionManager.buildSessionContext()`.
- `buildSessionContext()` walks the current branch and emits provider-visible messages. It handles:
  - `message` entries
  - `custom_message` entries
  - `branch_summary` entries
  - latest `compaction` summary + kept messages

Key implication:

> The extension should not infer IDs from message text. It should mirror pi's context projection and attach provenance metadata.

## The Elegant Core

Implement one internal primitive:

```ts
function projectContext(sessionManager): ProjectedContext
```

It mirrors pi's `buildSessionContext()` but preserves the source entry ID for each provider-visible message.

```ts
type ContextItem = {
  entryId: string;
  entryType: "message" | "custom_message" | "branch_summary" | "compaction";
  message: AgentMessage;
};

type Turn = {
  number: number;
  startEntryId: string;
  entryIds: string[];
  items: ContextItem[];
};

type ProjectedContext = {
  branch: SessionEntry[];
  items: ContextItem[];
  turns: Turn[];
  compactedAwayEntryIds: Set<string>;
  activeCompactionId?: string;
};
```

Everything uses this one projection:

- `list_context`
- `forget`
- `/forgotten`
- `/unforget`
- `context` filtering

No duplicate branch parsing. No content matching. No special-case filtering logic spread through the code.

## MVP Scope

### Include

- `list_context` model-callable tool
- `forget` model-callable tool
- `/forgotten` slash command
- `/unforget <directive-id>` slash command
- Turn-level omission from future provider requests
- Branch-local, append-only persistence

### Deliberately exclude from MVP

- Arbitrary `range:A..B`
- Per-entry surgical omission
- Semantic search forgetting
- Summary rewriting
- Compaction regeneration
- TUI history browser

These are useful later, but cutting them makes v1 dramatically safer.

## User-Facing Model

The model sees a compact list of provider-visible turns:

```text
Current provider-visible context:

turn:12
  user a1b2c3d4: "Can you inspect auth flow?"
  assistant b2c3d4e5: text + tool calls: read, bash
  tool c3d4e5f6: read src/auth.ts, 4200 chars

turn:13
  user d4e5f6a7: "Ignore that approach"
  assistant e5f6a7b8: text
```

The model forgets whole turns:

```ts
forget({ targets: ["turn:12"], reason: "obsolete auth debugging path" })
```

Result:

```text
Forgot turn:12 (3 entries). Original session history is unchanged. Use /unforget forget-003 to restore.
```

## Tool Design

### `list_context`

Purpose: show a stable, compact index of provider-visible context.

Parameters:

```ts
{
  scope?: "recent" | "all";
  limit?: number;
}
```

Defaults:

- `scope: "recent"`
- `limit: 12`
- hard max: `50`
- max snippet per item: ~180 chars

Output should only show turns that are currently provider-visible after active forget directives are applied.

If a compaction summary is active, show it as a special prelude, not as a normal forget target in MVP:

```text
Active compaction f00dbabe summarizes earlier history. Entries before that compaction are no longer individually forgettable in MVP.
```

### `forget`

Purpose: mark turns as omitted from future provider requests.

Parameters:

```ts
{
  targets: string[]; // MVP: only "turn:N"
  reason?: string;
}
```

MVP only accepts:

```text
turn:12
turn:13
```

Reject raw entry IDs and ranges with a helpful message:

```text
MVP forgets whole turns only. Run list_context and target turn:N.
```

Why: whole-turn-only forgetting avoids dangling assistant tool calls, orphaned tool results, and invalid provider context.

## Persistence Model

Use append-only custom entries:

```ts
type ForgetEntry = {
  kind: "forget";
  directiveId: string;
  targets: string[];       // e.g. ["turn:12"]
  turnNumbers: number[];   // resolved at creation time for display
  entryIds: string[];      // final expanded source entry IDs
  reason?: string;
  createdAt: number;
  createdAtLeafId: string | null;
  projectionVersion: 1;
};

type UnforgetEntry = {
  kind: "unforget";
  directiveId: string;
  createdAt: number;
  createdAtLeafId: string | null;
};
```

Persist with:

```ts
pi.appendEntry("pi-forget", data)
```

The original session remains intact. Forgetting is just another branch-local custom entry.

## Branch-Local Active State

Compute active directives on demand from the current branch:

```ts
function getActiveDirectives(ctx): ActiveDirective[] {
  const branch = ctx.sessionManager.getBranch();
  // scan only custom entries on this branch
  // apply forget entries in order
  // apply unforget entries by directiveId
}
```

Do **not** scan `getEntries()` for active state. That would leak forget directives from abandoned branches.

Do **not** rely only on `session_start` caching. Branch navigation can change active directives.

## Context Filtering

Register:

```ts
pi.on("context", async (event, ctx) => { ... })
```

Algorithm:

1. Build `projection = projectContext(ctx.sessionManager)`.
2. Build active directive set from current branch.
3. Build `forgottenEntryIds` from directive `entryIds`.
4. Align `event.messages` with `projection.items` by index.
5. If lengths match, filter items whose `entryId` is forgotten.
6. If lengths do not match, fail open: return nothing and notify once.

Normal case should match because pi restores agent state from `buildSessionContext()`, and the projector mirrors that function.

Fail-open is intentional: sending too much context is safer than corrupting the provider message sequence.

## Compaction Semantics

MVP does not attempt to edit or target compaction summaries.

If a turn is no longer visible because it is behind an active compaction, `list_context` will not show it, and `forget` cannot target it.

Documented limitation:

> If a fact has already been absorbed into a compaction summary, MVP cannot selectively remove that fact. Start a new branch before compaction, or use future summary-regeneration support.

This keeps v1 small and honest.

## Slash Commands

### `/forgotten`

Shows active directives on the current branch:

```text
Active forget directives:

forget-003
  targets: turn:12
  entries: a1b2c3d4..c3d4e5f6
  reason: obsolete auth debugging path
```

### `/unforget <directive-id>`

Appends an unforget entry:

```ts
{
  kind: "unforget",
  directiveId: "forget-003",
  createdAt: Date.now(),
  createdAtLeafId: ctx.sessionManager.getLeafId(),
}
```

## Safety Rules

- MVP accepts only `turn:N` targets.
- Turns are provider-visible turns from `list_context`, not raw session indices.
- Do not forget the current in-progress turn.
- Reconstruct active state from current branch only.
- Never mutate or delete existing session entries.
- If projection/context alignment fails, do not filter.
- If all visible context would be forgotten, keep the latest user turn or reject the operation.

## Implementation Steps

1. Create extension skeleton in `src/index.ts`.
2. Add `package.json` with pi package metadata.
3. Implement `projectContext(sessionManager)` by mirroring pi's `buildSessionContext()` with provenance.
4. Add projector parity tests against `sessionManager.buildSessionContext()`.
5. Implement `groupTurns(items)`.
6. Implement active directive reconstruction from current branch custom entries.
7. Implement `list_context`.
8. Implement `forget` for `turn:N` only.
9. Implement `context` filtering.
10. Implement `/forgotten`.
11. Implement `/unforget <directive-id>`.
12. Manual test with messages, assistant tool calls, tool results, branch navigation, reload, and compaction.

## Testing Checklist

- Projector messages exactly match `sessionManager.buildSessionContext().messages`.
- `list_context` shows recent provider-visible turns with stable source IDs.
- `forget turn:N` persists a custom directive.
- Forgotten turns disappear from subsequent provider requests.
- Tool-call/tool-result structure remains valid because whole turns are omitted.
- Original session history remains unchanged except for custom pi-forget entries.
- `/forgotten` shows active directives only on current branch.
- `/unforget` restores omitted turns.
- Reload preserves active directives.
- Branching away from a directive makes it inactive.
- Alignment mismatch fails open.

## Future Extensions

Add only after MVP is stable:

- raw entry ID targets that still expand to containing turn
- safe ranges that expand touched turns
- compaction summary omission or regeneration
- `mode: "summarize"`
- semantic target selection
- TUI context browser
- per-tool-output forgetting with provider-valid repair
- user confirmation for large omissions

## Why This Is the 6/5 Version

The previous plan tried to support IDs, ranges, and compaction targets immediately. That was powerful but too much surface area.

This version keeps one strong invariant:

> A forget directive removes complete provider-visible turns resolved from one projector.

That invariant makes the MVP easy to reason about, hard to corrupt, and still genuinely useful.
