import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const CUSTOM_TYPE = "pi-forget";
const PROJECTION_VERSION = 1;
const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 12;
const SNIPPET_CHARS = 180;

interface ContextItem {
	entryId: string;
	entryType: "message" | "custom_message" | "branch_summary" | "compaction";
	message: AgentMessage;
}

interface Turn {
	number: number;
	startEntryId: string;
	entryIds: string[];
	items: ContextItem[];
	forgotten: boolean;
}

interface ProjectedContext {
	branch: SessionEntry[];
	items: ContextItem[];
	prelude: ContextItem[];
	turns: Turn[];
	compactedAwayEntryIds: Set<string>;
	activeCompactionId?: string;
}

interface ForgetEntry {
	kind: "forget";
	directiveId: string;
	targets: string[];
	turnNumbers: number[];
	entryIds: string[];
	reason?: string;
	createdAt: number;
	createdAtLeafId: string | null;
	projectionVersion: number;
}

interface UnforgetEntry {
	kind: "unforget";
	directiveId: string;
	createdAt: number;
	createdAtLeafId: string | null;
}

type PiForgetEntry = ForgetEntry | UnforgetEntry;

interface ActiveDirective extends ForgetEntry {
	entryIdsSet: Set<string>;
}

function isPiForgetEntry(data: unknown): data is PiForgetEntry {
	if (!data || typeof data !== "object") return false;
	const candidate = data as Record<string, unknown>;
	return candidate.kind === "forget" || candidate.kind === "unforget";
}

function textMessage(role: string, text: string, timestamp: number): AgentMessage {
	return { role, content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function projectContext(sessionManager: ExtensionContext["sessionManager"]): ProjectedContext {
	const branch = sessionManager.getBranch();
	const items: ContextItem[] = [];
	const compactedAwayEntryIds = new Set<string>();
	let compaction: Extract<SessionEntry, { type: "compaction" }> | undefined;

	for (const entry of branch) {
		if (entry.type === "compaction") compaction = entry;
	}

	const appendItem = (entry: SessionEntry) => {
		if (entry.type === "message") {
			items.push({ entryId: entry.id, entryType: "message", message: entry.message });
		} else if (entry.type === "custom_message") {
			items.push({
				entryId: entry.id,
				entryType: "custom_message",
				message: {
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					details: entry.details,
					timestamp: new Date(entry.timestamp).getTime(),
				} as AgentMessage,
			});
		} else if (entry.type === "branch_summary" && entry.summary) {
			items.push({
				entryId: entry.id,
				entryType: "branch_summary",
				message: {
					role: "branchSummary",
					summary: entry.summary,
					fromId: entry.fromId,
					timestamp: new Date(entry.timestamp).getTime(),
				} as AgentMessage,
			});
		}
	};

	if (compaction) {
		items.push({
			entryId: compaction.id,
			entryType: "compaction",
			message: {
				role: "compactionSummary",
				summary: compaction.summary,
				tokensBefore: compaction.tokensBefore,
				timestamp: new Date(compaction.timestamp).getTime(),
			} as AgentMessage,
		});

		const compactionIdx = branch.findIndex((entry) => entry.id === compaction?.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = branch[i]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) appendItem(entry);
			else compactedAwayEntryIds.add(entry.id);
		}
		for (let i = compactionIdx + 1; i < branch.length; i++) appendItem(branch[i]!);
	} else {
		for (const entry of branch) appendItem(entry);
	}

	const { prelude, turns } = groupTurns(items);
	return { branch, items, prelude, turns, compactedAwayEntryIds, activeCompactionId: compaction?.id };
}

function groupTurns(items: ContextItem[], forgottenEntryIds = new Set<string>()): Pick<ProjectedContext, "prelude" | "turns"> {
	const prelude: ContextItem[] = [];
	const turns: Turn[] = [];
	let current: Turn | undefined;

	for (const item of items) {
		if (item.message.role === "user") {
			current = {
				number: turns.length + 1,
				startEntryId: item.entryId,
				entryIds: [item.entryId],
				items: [item],
				forgotten: forgottenEntryIds.has(item.entryId),
			};
			turns.push(current);
			continue;
		}

		if (!current) {
			prelude.push(item);
			continue;
		}

		current.items.push(item);
		current.entryIds.push(item.entryId);
		if (forgottenEntryIds.has(item.entryId)) current.forgotten = true;
	}
	return { prelude, turns };
}

function getActiveDirectives(ctx: ExtensionContext): ActiveDirective[] {
	const active = new Map<string, ForgetEntry>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE || !isPiForgetEntry(entry.data)) continue;
		if (entry.data.kind === "forget") {
			active.set(entry.data.directiveId, entry.data);
		} else {
			active.delete(entry.data.directiveId);
		}
	}
	return [...active.values()].map((directive) => ({ ...directive, entryIdsSet: new Set(directive.entryIds) }));
}

function getForgottenEntryIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const directive of getActiveDirectives(ctx)) {
		for (const id of directive.entryIds) ids.add(id);
	}
	return ids;
}

function parseTurnTarget(target: string): number | undefined {
	const match = /^turn:(\d+)$/.exec(target.trim());
	if (!match) return undefined;
	const num = Number(match[1]);
	return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}

function compactText(text: string, limit = SNIPPET_CHARS): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => (block as { text?: string }).text ?? "")
		.join(" ");
}

function summarizeItem(item: ContextItem): string {
	const msg = item.message as any;
	switch (msg.role) {
		case "user":
			return `user ${item.entryId}: "${compactText(contentText(msg.content))}"`;
		case "assistant": {
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			const hasText = blocks.some((block: any) => block.type === "text" && block.text?.trim());
			const calls = blocks.filter((block: any) => block.type === "toolCall").map((block: any) => block.name || "tool");
			const parts = [hasText ? "text" : undefined, calls.length ? `tool calls: ${calls.join(", ")}` : undefined].filter(Boolean);
			return `assistant ${item.entryId}: ${parts.join(" + ") || "(empty)"}`;
		}
		case "toolResult": {
			const text = contentText(msg.content);
			const prefix = msg.toolName ? `${msg.toolName}, ` : "";
			return `tool ${item.entryId}: ${prefix}${text.length} chars${text ? `, "${compactText(text, 90)}"` : ""}`;
		}
		case "custom":
			return `custom ${item.entryId}: ${msg.customType ?? "custom"}, "${compactText(contentText(msg.content), 90)}"`;
		case "branchSummary":
			return `branch-summary ${item.entryId}: "${compactText(msg.summary ?? "", 120)}"`;
		case "compactionSummary":
			return `compaction ${item.entryId}: summary of earlier context (${msg.tokensBefore ?? "?"} tokens before)`;
		default:
			return `${msg.role ?? "message"} ${item.entryId}`;
	}
}

function formatContextIndex(ctx: ExtensionContext, scope: "recent" | "all", limit: number): string {
	const projection = projectContext(ctx.sessionManager);
	const forgotten = getForgottenEntryIds(ctx);
	const { prelude, turns } = groupTurns(projection.items, forgotten);
	const visibleTurns = turns.filter((turn) => !turn.entryIds.every((id) => forgotten.has(id)));
	const selectedTurns = scope === "all" ? visibleTurns.slice(-limit) : visibleTurns.slice(-limit);
	const lines: string[] = ["Current provider-visible context:", ""];

	const visiblePrelude = prelude.filter((item) => !forgotten.has(item.entryId));
	if (visiblePrelude.length) {
		for (const item of visiblePrelude) lines.push(summarizeItem(item));
		lines.push("");
	}
	if (projection.activeCompactionId) {
		lines.push(
			`Active compaction ${projection.activeCompactionId} summarizes earlier history. Entries behind it are not individually forgettable in MVP.`,
		);
		lines.push("");
	}

	if (!selectedTurns.length) {
		lines.push("No visible turns.");
		return lines.join("\n");
	}

	for (const turn of selectedTurns) {
		lines.push(`turn:${turn.number}`);
		for (const item of turn.items) {
			if (!forgotten.has(item.entryId)) lines.push(`  ${summarizeItem(item)}`);
		}
		lines.push("");
	}

	if (visibleTurns.length > selectedTurns.length) {
		lines.push(`Showing ${selectedTurns.length} of ${visibleTurns.length} visible turns. Use scope:"all" or a higher limit for more.`);
	}
	return lines.join("\n").trimEnd();
}

function makeDirectiveId(existingCount: number): string {
	const rand = Math.random().toString(16).slice(2, 6);
	return `forget-${String(existingCount + 1).padStart(3, "0")}-${rand}`;
}

function createForgetDirective(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targets: string[],
	reason?: string,
): { text: string; details: Record<string, unknown> | ForgetEntry } {
	const projection = projectContext(ctx.sessionManager);
	const active = getActiveDirectives(ctx);
	const alreadyForgotten = new Set<string>();
	for (const directive of active) for (const id of directive.entryIds) alreadyForgotten.add(id);

	const turnNumbers: number[] = [];
	const entryIds: string[] = [];
	const rejected = targets.filter((target) => parseTurnTarget(target) === undefined);
	if (rejected.length) {
		return {
			text: `MVP forgets whole turns only. Invalid target(s): ${rejected.join(", ")}. Run list_context and target turn:N.`,
			details: { error: "invalid_targets", rejected },
		};
	}

	const latestTurn = projection.turns.at(-1)?.number;
	for (const target of targets) {
		const number = parseTurnTarget(target)!;
		const turn = projection.turns.find((candidate) => candidate.number === number);
		if (!turn) return { text: `Unknown ${target}. Run list_context for current turn numbers.`, details: { error: "unknown_turn", target } };
		if (number === latestTurn) {
			return {
				text: `Refusing to forget ${target}: MVP does not forget the current/latest turn.`,
				details: { error: "latest_turn", target },
			};
		}
		turnNumbers.push(number);
		for (const id of turn.entryIds) if (!entryIds.includes(id)) entryIds.push(id);
	}

	const newEntryIds = entryIds.filter((id) => !alreadyForgotten.has(id));
	if (!newEntryIds.length) return { text: "Those turns are already forgotten on this branch.", details: { alreadyForgotten: true } };

	const visibleTurnCountAfter = projection.turns.filter((turn) =>
		!turn.entryIds.every((id) => alreadyForgotten.has(id) || newEntryIds.includes(id)),
	).length;
	if (visibleTurnCountAfter === 0) {
		return { text: "Refusing to forget all visible turns; keep at least one turn in context.", details: { error: "would_forget_all" } };
	}

	const directive: ForgetEntry = {
		kind: "forget",
		directiveId: makeDirectiveId(active.length),
		targets: [...targets],
		turnNumbers: [...new Set(turnNumbers)],
		entryIds: newEntryIds,
		reason,
		createdAt: Date.now(),
		createdAtLeafId: ctx.sessionManager.getLeafId(),
		projectionVersion: PROJECTION_VERSION,
	};
	pi.appendEntry(CUSTOM_TYPE, directive);
	return {
		text: `Forgot ${directive.targets.join(", ")} (${newEntryIds.length} entries). Original session history is unchanged. Use /unforget ${directive.directiveId} to restore.`,
		details: directive,
	};
}

function formatDirective(directive: ActiveDirective): string {
	const entries = directive.entryIds.length
		? directive.entryIds.length === 1
			? directive.entryIds[0]
			: `${directive.entryIds[0]}..${directive.entryIds[directive.entryIds.length - 1]}`
		: "(none)";
	return [
		directive.directiveId,
		`  targets: ${directive.targets.join(", ")}`,
		`  entries: ${entries}`,
		directive.reason ? `  reason: ${directive.reason}` : undefined,
	].filter(Boolean).join("\n");
}

export default function piForget(pi: ExtensionAPI) {
	let warnedAboutAlignment = false;

	pi.registerTool({
		name: "list_context",
		label: "List Context",
		description: "List provider-visible conversation turns with stable turn numbers for the forget tool.",
		promptSnippet: "List provider-visible context turns that can be forgotten by turn:N",
		promptGuidelines: [
			"Use list_context before forget when you need to identify stale or irrelevant prior turns.",
			"Use forget only with turn:N targets returned by list_context.",
		],
		parameters: Type.Object({
			scope: Type.Optional(Type.Union([Type.Literal("recent"), Type.Literal("all")], { default: "recent" })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "recent";
			const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT)));
			return { content: [{ type: "text", text: formatContextIndex(ctx, scope, limit) }], details: {} };
		},
	});

	pi.registerTool({
		name: "forget",
		label: "Forget",
		description: "Omit whole provider-visible turns from future provider requests without deleting session history.",
		promptSnippet: "Forget stale provider-visible context by turn:N from list_context",
		promptGuidelines: ["Use forget with turn:N targets from list_context; pi-forget MVP does not accept raw entry IDs or ranges."],
		parameters: Type.Object({
			targets: Type.Array(Type.String({ description: "Targets to forget. MVP accepts only turn:N, e.g. turn:12." }), {
				minItems: 1,
			}),
			reason: Type.Optional(Type.String({ description: "Why this context should be omitted." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = createForgetDirective(pi, ctx, params.targets, params.reason);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.on("context", async (event, ctx) => {
		const forgotten = getForgottenEntryIds(ctx);
		if (!forgotten.size) return;
		const projection = projectContext(ctx.sessionManager);
		if (event.messages.length !== projection.items.length) {
			if (!warnedAboutAlignment) {
				warnedAboutAlignment = true;
				ctx.ui.notify(
					`pi-forget: context alignment mismatch (${event.messages.length} messages vs ${projection.items.length} projected); not filtering.`,
					"warning",
				);
			}
			return;
		}
		return { messages: event.messages.filter((_message, index) => !forgotten.has(projection.items[index]!.entryId)) };
	});

	pi.registerCommand("forget", {
		description: "Forget provider-visible turns: /forget turn:N [reason]",
		handler: async (args, ctx) => {
			const [target, ...reasonParts] = args.trim().split(/\s+/).filter(Boolean);
			if (!target) {
				ctx.ui.notify("Usage: /forget turn:N [reason]", "warning");
				return;
			}
			const result = createForgetDirective(pi, ctx, [target], reasonParts.join(" ") || undefined);
			ctx.ui.notify(result.text, "info");
		},
	});

	pi.registerCommand("forgotten", {
		description: "Show active pi-forget directives on the current branch",
		handler: async (_args, ctx) => {
			const directives = getActiveDirectives(ctx);
			ctx.ui.notify(
				directives.length ? `Active forget directives:\n\n${directives.map(formatDirective).join("\n\n")}` : "No active forget directives on this branch.",
				"info",
			);
		},
	});

	pi.registerCommand("unforget", {
		description: "Restore context hidden by a pi-forget directive: /unforget <directive-id>",
		handler: async (args, ctx) => {
			const directiveId = args.trim();
			if (!directiveId) {
				ctx.ui.notify("Usage: /unforget <directive-id>", "warning");
				return;
			}
			const directives = getActiveDirectives(ctx);
			if (!directives.some((directive) => directive.directiveId === directiveId)) {
				ctx.ui.notify(`No active forget directive found for ${directiveId}.`, "warning");
				return;
			}
			const entry: UnforgetEntry = { kind: "unforget", directiveId, createdAt: Date.now(), createdAtLeafId: ctx.sessionManager.getLeafId() };
			pi.appendEntry(CUSTOM_TYPE, entry);
			ctx.ui.notify(`Restored context for ${directiveId}.`, "info");
		},
	});
}

export const __test = { projectContext, groupTurns, getActiveDirectives, parseTurnTarget, formatContextIndex };
