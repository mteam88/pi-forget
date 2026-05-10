# pi-forget Synthetic Branch Plan

## Current Direction

`pi-forget` no longer depends on native `context_rewrite` entries or a forked Pi build. It now uses Pi's append-only session tree directly:

1. Resolve `turn:N`, `entry:<id>`, and `output:<id>` targets from the current provider-visible branch projection.
2. Find the earliest affected source entry.
3. Branch to that entry's parent.
4. Replay later branch entries into a new synthetic branch:
   - kept entries are cloned through public `SessionManager.append*` APIs
   - forgotten turns/entries become `pi-forget` custom-message placeholders or user-provided summaries
   - redacted tool/bash outputs are cloned with only their output text replaced
5. Append a hidden `pi-forget` custom metadata entry with the original leaf id.
6. `/unforget <forget-id>` navigates back to the original leaf.

The original branch remains intact. The JSONL file remains append-only.

## Safety Model

- This is context-budget cleanup, not secure erasure.
- Original entries and logs remain in the session file.
- Current/latest turn forgetting is refused for turn targets.
- `/forget` refreshes Pi's active session context by navigating to the synthetic branch leaf after replay.
- The model-facing `forget` tool can create the branch immediately; subsequent prompts use the cleaned branch.

## Known Limitations

- Tool-time forgets may not affect an already-built provider request until the next turn/prompt.
- Entry-level replacement can still be structurally dangerous if used on one side of an assistant tool-call/tool-result pair; prefer whole turns or output redaction.
- Branch-summary entries are replayed as hidden `pi-forget` custom messages because Pi does not expose a public append-branch-summary API.
