import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 12;
const SNIPPET_CHARS = 180;

interface ContextItem {
	entryId: string;
	message: AgentMessage;
	sourceEntryIds: string[];
	rewriteId?: string;
}

interface CoreContextRewriteInput {
	rewriteId?: string;
	target:
		| { kind: "range"; fromEntryId: string; toEntryId: string }
		| { kind: "surface"; entryId: string; surface: "text" | "output" | "summary" | "rendered" }
		| { kind: "insert"; afterEntryId: string | null };
	before?: string;
	beforeHash?: string;
	after: string;
	reason?: string;
	details?: unknown;
	fromHook?: boolean;
}

interface CoreContextRewriteEntry extends CoreContextRewriteInput {
	type: "context_rewrite";
	id: string;
	parentId: string | null;
	timestamp: string;
}

interface CoreProjectionItem {
	entryId: string;
	sourceEntryIds: string[];
	rewriteId?: string;
	message: AgentMessage;
}

interface CoreSessionProjection {
	items: CoreProjectionItem[];
	activeRewrites: CoreContextRewriteEntry[];
}

type CoreExtensionAPI = ExtensionAPI & {
	appendContextRewrite: (rewrite: CoreContextRewriteInput) => string;
	undoContextRewrite: (rewriteId: string) => string;
};

type CoreSessionManager = ExtensionContext["sessionManager"] & {
	buildSessionProjection?: () => CoreSessionProjection;
};

interface Turn {
	number: number;
	startEntryId: string;
	entryIds: string[];
	items: ContextItem[];
}

type MessageRecord = Record<string, unknown> & { role?: string };
type ContentBlock = Record<string, unknown> & { type?: string };

function messageRecord(message: AgentMessage): MessageRecord {
	return message as unknown as MessageRecord;
}

function hashContextText(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function getCoreProjection(ctx: ExtensionContext): CoreSessionProjection {
	const buildSessionProjection = (ctx.sessionManager as CoreSessionManager).buildSessionProjection;
	if (!buildSessionProjection) {
		throw new Error("pi-forget requires a pi build with core context rewrites (buildSessionProjection). Run the rebased pi from source or install that build.");
	}
	return buildSessionProjection.call(ctx.sessionManager as CoreSessionManager);
}

function getCorePi(pi: ExtensionAPI): CoreExtensionAPI {
	const candidate = pi as Partial<CoreExtensionAPI>;
	if (!candidate.appendContextRewrite || !candidate.undoContextRewrite) {
		throw new Error("pi-forget requires a pi build with pi.appendContextRewrite() and pi.undoContextRewrite().");
	}
	return pi as CoreExtensionAPI;
}

function itemFromCore(item: CoreProjectionItem): ContextItem {
	return {
		entryId: item.entryId,
		message: item.message,
		sourceEntryIds: item.sourceEntryIds,
		rewriteId: item.rewriteId,
	};
}

function groupTurns(items: ContextItem[]): { prelude: ContextItem[]; turns: Turn[] } {
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
	}
	return { prelude, turns };
}

function parseTurnTarget(target: string): number | undefined {
	const match = /^turn:(\d+)$/.exec(target.trim());
	if (!match) return undefined;
	const num = Number(match[1]);
	return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}

function parseEntryTarget(target: string): string | undefined {
	const trimmed = target.trim();
	const entryMatch = /^entry:([a-zA-Z0-9_-]+)$/.exec(trimmed);
	if (entryMatch) return entryMatch[1];
	return /^[a-zA-Z0-9_-]{8,}$/.test(trimmed) ? trimmed : undefined;
}

function parseOutputTarget(target: string): string | undefined {
	const match = /^output:([a-zA-Z0-9_-]+)$/.exec(target.trim());
	return match?.[1];
}

function compactText(text: string, limit = SNIPPET_CHARS): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function asContentBlocks(content: unknown): ContentBlock[] {
	return Array.isArray(content) ? content.filter((block): block is ContentBlock => !!block && typeof block === "object") : [];
}

function contentText(content: unknown, separator = " "): string {
	if (typeof content === "string") return content;
	return asContentBlocks(content)
		.filter((block) => block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join(separator);
}

function stringField(record: MessageRecord, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

function summarizeItem(item: ContextItem): string {
	const msg = messageRecord(item.message);
	switch (msg.role) {
		case "user":
			return `user ${item.entryId}: "${compactText(contentText(msg.content))}"`;
		case "assistant": {
			const blocks = asContentBlocks(msg.content);
			const hasText = blocks.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
			const calls = blocks
				.filter((block) => block.type === "toolCall")
				.map((block) => (typeof block.name === "string" && block.name.length > 0 ? block.name : "tool"));
			const parts = [hasText ? "text" : undefined, calls.length ? `tool calls: ${calls.join(", ")}` : undefined].filter(Boolean);
			return `assistant ${item.entryId}: ${parts.join(" + ") || "(empty)"}`;
		}
		case "toolResult": {
			const text = contentText(msg.content);
			const toolName = stringField(msg, "toolName");
			const prefix = toolName ? `${toolName}, ` : "";
			return `tool ${item.entryId}: ${prefix}${text.length} chars${text ? `, "${compactText(text, 90)}"` : ""}`;
		}
		case "custom": {
			const customType = stringField(msg, "customType") || "custom";
			return `custom ${item.entryId}: ${customType}, "${compactText(contentText(msg.content), 90)}"`;
		}
		case "branchSummary":
			return `branch-summary ${item.entryId}: "${compactText(stringField(msg, "summary"), 120)}"`;
		case "compactionSummary":
			return `compaction ${item.entryId}: summary of earlier context (${msg.tokensBefore ?? "?"} tokens before)`;
		case "bashExecution": {
			const command = stringField(msg, "command");
			const output = stringField(msg, "output");
			return `bashExecution ${item.entryId}: ${command ? `\`${compactText(command, 80)}\`, ` : ""}${output.length} chars${output ? `, "${compactText(output, 90)}"` : ""}`;
		}
		case "contextRewrite":
			return `context-rewrite ${item.rewriteId ?? item.entryId}: "${compactText(stringField(msg, "text"), 120)}"`;
		default:
			return `${msg.role ?? "message"} ${item.entryId}`;
	}
}

function renderedItemText(item: ContextItem): string {
	const msg = messageRecord(item.message);
	switch (msg.role) {
		case "user":
		case "toolResult":
		case "custom":
			return contentText(msg.content);
		case "assistant":
			return contentText(msg.content, "\n");
		case "bashExecution":
			return stringField(msg, "output");
		case "branchSummary":
		case "compactionSummary":
			return stringField(msg, "summary");
		case "contextRewrite":
			return stringField(msg, "text");
		default:
			return "";
	}
}

function outputSurfaceText(item: ContextItem): string | undefined {
	const msg = messageRecord(item.message);
	if (msg.role === "bashExecution") return stringField(msg, "output");
	if (msg.role === "toolResult") return contentText(msg.content);
	return undefined;
}

function formatProjectedContext(prelude: ContextItem[], turns: Turn[], scope: "recent" | "all", limit: number): string {
	const selectedTurns = scope === "all" ? turns.slice(0, limit) : turns.slice(-limit);
	const lines: string[] = ["Current provider-visible context:", ""];

	if (prelude.length) {
		for (const item of prelude) lines.push(summarizeItem(item));
		lines.push("");
	}

	if (!selectedTurns.length) {
		lines.push("No visible turns.");
		return lines.join("\n");
	}

	for (const turn of selectedTurns) {
		lines.push(`turn:${turn.number}`);
		for (const item of turn.items) lines.push(`  ${summarizeItem(item)}`);
		lines.push("");
	}

	if (turns.length > selectedTurns.length) {
		lines.push(
			scope === "all"
				? `Showing first ${selectedTurns.length} of ${turns.length} visible turns. Use a higher limit for more.`
				: `Showing last ${selectedTurns.length} of ${turns.length} visible turns. Use scope:"all" or a higher limit for more.`,
		);
	}
	return lines.join("\n").trimEnd();
}

function formatContextIndex(ctx: ExtensionContext, scope: "recent" | "all", limit: number): string {
	const items = getCoreProjection(ctx).items.map(itemFromCore);
	const { prelude, turns } = groupTurns(items);
	return formatProjectedContext(prelude, turns, scope, limit);
}

function makeRewriteId(existingCount: number): string {
	const rand = Math.random().toString(16).slice(2, 6);
	return `forget-${String(existingCount + 1).padStart(3, "0")}-${rand}`;
}

function isPiForgetRewrite(rewrite: CoreContextRewriteEntry): boolean {
	return !!rewrite.details && typeof rewrite.details === "object" && "piForget" in rewrite.details;
}

function createForgetDirective(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targets: string[],
	reason?: string,
): { text: string; details: Record<string, unknown> } {
	const projection = getCoreProjection(ctx);
	const corePi = getCorePi(pi);
	const items = projection.items.map(itemFromCore);
	const { turns } = groupTurns(items);
	const latestTurn = turns.at(-1)?.number;
	const activePiForgetCount = projection.activeRewrites.filter(isPiForgetRewrite).length;
	const baseRewriteId = makeRewriteId(activePiForgetCount);
	const rewriteInputs: CoreContextRewriteInput[] = [];
	const targetLabels: string[] = [];

	for (const target of targets) {
		const turnNumber = parseTurnTarget(target);
		if (turnNumber !== undefined) {
			const turn = turns.find((candidate) => candidate.number === turnNumber);
			if (!turn) return { text: `Unknown ${target}. Run list_context for current turn numbers.`, details: { error: "unknown_turn", target } };
			if (turnNumber === latestTurn) {
				return { text: `Refusing to forget ${target}: pi-forget does not forget the current/latest turn.`, details: { error: "latest_turn", target } };
			}
			const first = turn.items[0]?.sourceEntryIds[0] ?? turn.items[0]?.entryId;
			const lastItem = turn.items.at(-1);
			const last = lastItem?.sourceEntryIds.at(-1) ?? lastItem?.entryId;
			if (!first || !last) return { text: `Could not resolve ${target} to source entries.`, details: { error: "unresolved_turn", target } };
			const before = turn.items.map(renderedItemText).join("\n");
			rewriteInputs.push({
				rewriteId: rewriteInputs.length === 0 ? baseRewriteId : `${baseRewriteId}-${rewriteInputs.length + 1}`,
				target: { kind: "range", fromEntryId: first, toEntryId: last },
				beforeHash: hashContextText(before),
				after: `[context forgotten by pi-forget: ${target}]`,
				reason,
				details: { piForget: { targets, reason } },
			});
			targetLabels.push(target);
			continue;
		}

		const outputEntryId = parseOutputTarget(target);
		if (outputEntryId !== undefined) {
			const item = items.find((candidate) => candidate.entryId === outputEntryId || candidate.sourceEntryIds.includes(outputEntryId));
			if (!item) return { text: `Unknown output entry ${outputEntryId}. Run list_context for current visible entries.`, details: { error: "unknown_output", target } };
			const output = outputSurfaceText(item);
			if (output === undefined) return { text: `Entry ${outputEntryId} has no separable output to forget.`, details: { error: "not_redactable", target } };
			rewriteInputs.push({
				rewriteId: rewriteInputs.length === 0 ? baseRewriteId : `${baseRewriteId}-${rewriteInputs.length + 1}`,
				target: { kind: "surface", entryId: outputEntryId, surface: "output" },
				beforeHash: hashContextText(output),
				after: `[output forgotten by pi-forget: ${outputEntryId}]`,
				reason,
				details: { piForget: { targets, reason } },
			});
			targetLabels.push(target);
			continue;
		}

		const entryId = parseEntryTarget(target);
		if (entryId !== undefined) {
			const item = items.find((candidate) => candidate.entryId === entryId || candidate.sourceEntryIds.includes(entryId));
			if (!item) return { text: `Unknown entry ${entryId}. Run list_context for current visible entries.`, details: { error: "unknown_entry", target } };
			const before = renderedItemText(item);
			rewriteInputs.push({
				rewriteId: rewriteInputs.length === 0 ? baseRewriteId : `${baseRewriteId}-${rewriteInputs.length + 1}`,
				target: { kind: "surface", entryId, surface: "rendered" },
				beforeHash: hashContextText(before),
				after: `[entry forgotten by pi-forget: ${entryId}]`,
				reason,
				details: { piForget: { targets, reason } },
			});
			targetLabels.push(target);
			continue;
		}

		return { text: `Invalid target ${target}. Use turn:N, entry:<id>, or output:<id> from list_context.`, details: { error: "invalid_target", target } };
	}

	const entryIds = rewriteInputs.map((rewrite) => corePi.appendContextRewrite(rewrite));
	return {
		text: `Applied context rewrite${entryIds.length === 1 ? "" : "s"} ${rewriteInputs.map((rewrite) => rewrite.rewriteId).join(", ")} for ${targetLabels.join(", ")}. Original session history is unchanged. Use /unforget <rewrite-id> to restore.`,
		details: { rewriteIds: rewriteInputs.map((rewrite) => rewrite.rewriteId), entryIds, targets: targetLabels },
	};
}

function formatCoreRewrite(rewrite: CoreContextRewriteEntry): string {
	return [
		rewrite.rewriteId ?? rewrite.id,
		`  target: ${JSON.stringify(rewrite.target)}`,
		`  replacement: "${compactText(rewrite.after, 120)}"`,
		rewrite.reason ? `  reason: ${rewrite.reason}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

export default function piForget(pi: ExtensionAPI) {
	getCorePi(pi);

	pi.registerTool({
		name: "list_context",
		label: "List Context",
		description: "List provider-visible context turns with stable turn numbers for the forget tool.",
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
		description: "Omit provider-visible turns/specific entries, or redact tool output while preserving the tool call, from future provider requests.",
		promptSnippet: "Forget stale context by turn:N, entry:<id>, or output:<id> from list_context",
		promptGuidelines: [
			"Use forget with turn:N, entry:<id>, or output:<id> targets from list_context. Use output:<id> when only a tool result's output should be hidden while preserving the tool call.",
		],
		parameters: Type.Object({
			targets: Type.Array(Type.String({ description: "Targets to forget: turn:N, entry:<id>, or output:<id>." }), {
				minItems: 1,
			}),
			reason: Type.Optional(Type.String({ description: "Why this context should be omitted." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = createForgetDirective(pi, ctx, params.targets, params.reason);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerCommand("forget", {
		description: "Forget provider-visible turns, entries, or outputs: /forget turn:N|entry:id|output:id [reason]",
		handler: async (args, ctx) => {
			const [target, ...reasonParts] = args.trim().split(/\s+/).filter(Boolean);
			if (!target) {
				ctx.ui.notify("Usage: /forget turn:N|entry:id|output:id [reason]", "warning");
				return;
			}
			const result = createForgetDirective(pi, ctx, [target], reasonParts.join(" ") || undefined);
			ctx.ui.notify(result.text, "info");
		},
	});

	pi.registerCommand("forgotten", {
		description: "Show active pi-forget context rewrites on the current branch",
		handler: async (_args, ctx) => {
			const rewrites = getCoreProjection(ctx).activeRewrites.filter(isPiForgetRewrite);
			ctx.ui.notify(
				rewrites.length ? `Active context rewrites:\n\n${rewrites.map(formatCoreRewrite).join("\n\n")}` : "No active pi-forget context rewrites on this branch.",
				"info",
			);
		},
	});

	pi.registerCommand("unforget", {
		description: "Restore context hidden by a pi-forget rewrite: /unforget <rewrite-id>",
		handler: async (args, ctx) => {
			const rewriteId = args.trim();
			if (!rewriteId) {
				ctx.ui.notify("Usage: /unforget <rewrite-id>", "warning");
				return;
			}

			const projection = getCoreProjection(ctx);
			if (!projection.activeRewrites.some((rewrite) => (rewrite.rewriteId ?? rewrite.id) === rewriteId)) {
				ctx.ui.notify(`No active context rewrite found for ${rewriteId}.`, "warning");
				return;
			}
			getCorePi(pi).undoContextRewrite(rewriteId);
			ctx.ui.notify(`Restored context for ${rewriteId}.`, "info");
		},
	});
}

export const __test = {
	contentText,
	createForgetDirective,
	formatContextIndex,
	formatProjectedContext,
	groupTurns,
	hashContextText,
	parseEntryTarget,
	parseOutputTarget,
	parseTurnTarget,
	renderedItemText,
	summarizeItem,
};
