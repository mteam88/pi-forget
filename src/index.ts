import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 12;
const SNIPPET_CHARS = 180;
const SUMMARY_SNIPPET_CHARS = 90;
const DEFAULT_SUGGESTION_LIMIT = 8;
const DEFAULT_OUTPUT_LIMIT = 20;
const MAX_OUTPUT_LIMIT = 100;

type ListContextDetail = "summary" | "entries" | "outputs";

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

function selectTurns(turns: Turn[], scope: "recent" | "all", limit: number): Turn[] {
	return scope === "all" ? turns.slice(0, limit) : turns.slice(-limit);
}

function formatSelectionFooter(totalTurns: number, selectedTurns: number, scope: "recent" | "all"): string | undefined {
	if (totalTurns <= selectedTurns) return undefined;
	return scope === "all"
		? `Showing first ${selectedTurns} of ${totalTurns} visible turns. Use a higher limit for more.`
		: `Showing last ${selectedTurns} of ${totalTurns} visible turns. Use scope:"all" or a higher limit for more.`;
}

function firstUserText(turn: Turn): string {
	const firstUser = turn.items.find((item) => item.message.role === "user");
	return firstUser ? contentText(messageRecord(firstUser.message).content) : "";
}

function countOutputChars(items: ContextItem[]): number {
	return items.reduce((total, item) => total + (outputSurfaceText(item)?.length ?? 0), 0);
}

function formatTurnSummary(turn: Turn): string {
	const outputChars = countOutputChars(turn.items);
	const suffix = outputChars > 0 ? `, ${outputChars} output chars` : "";
	return `turn:${turn.number}  user: "${compactText(firstUserText(turn), SUMMARY_SNIPPET_CHARS)}"  ${turn.items.length} entries${suffix}`;
}

interface OutputSearchOptions {
	minChars?: number;
	query?: string;
	maxOutputs?: number;
}

function getOutputCandidates(items: ContextItem[], options: OutputSearchOptions = {}): Array<{ item: ContextItem; output: string }> {
	const minChars = Math.max(0, Math.floor(options.minChars ?? 0));
	const query = options.query?.trim().toLowerCase();
	return items
		.map((item) => ({ item, output: outputSurfaceText(item) }))
		.filter((candidate): candidate is { item: ContextItem; output: string } => candidate.output !== undefined && candidate.output.length > 0)
		.filter((candidate) => candidate.output.length >= minChars)
		.filter((candidate) => {
			if (!query) return true;
			const msg = messageRecord(candidate.item.message);
			const haystack = `${candidate.item.entryId} ${msg.role ?? ""} ${stringField(msg, "toolName")} ${stringField(msg, "command")} ${candidate.output}`.toLowerCase();
			return haystack.includes(query);
		})
		.sort((a, b) => b.output.length - a.output.length)
		.slice(0, Math.max(1, Math.min(MAX_OUTPUT_LIMIT, Math.floor(options.maxOutputs ?? MAX_OUTPUT_LIMIT))));
}

function formatOutputCandidate(candidate: { item: ContextItem; output: string }): string {
	const msg = messageRecord(candidate.item.message);
	const kind = msg.role === "toolResult" ? `tool ${stringField(msg, "toolName") || "tool"}` : msg.role ?? "message";
	return `output:${candidate.item.entryId}  ${kind}, ${candidate.output.length} chars, "${compactText(candidate.output, SUMMARY_SNIPPET_CHARS)}"`;
}

function formatForgetSnippet(candidates: Array<{ item: ContextItem; output: string }>): string | undefined {
	if (!candidates.length) return undefined;
	const targets = candidates.map((candidate) => `"output:${candidate.item.entryId}"`).join(", ");
	return `forget({ targets: [${targets}], reason: "trim stale bulky outputs" })`;
}

function formatProjectedContext(
	prelude: ContextItem[],
	turns: Turn[],
	scope: "recent" | "all",
	limit: number,
	detail: ListContextDetail,
	turnNumber?: number,
	outputOptions: OutputSearchOptions = {},
	excludeLatestTurns = 0,
): string {
	const baseTurns = turnNumber !== undefined ? turns.filter((turn) => turn.number === turnNumber) : selectTurns(turns, scope, limit);
	const excludedStart = Math.max(0, turns.length - Math.max(0, Math.floor(excludeLatestTurns)));
	const selectedTurns = turnNumber === undefined && excludeLatestTurns > 0 ? baseTurns.filter((turn) => turn.number <= excludedStart) : baseTurns;
	const lines: string[] = ["Current provider-visible context:", ""];

	if (turnNumber !== undefined && selectedTurns.length === 0) {
		lines.push(`Unknown turn:${turnNumber}.`);
		return lines.join("\n");
	}

	if (prelude.length && detail === "entries") {
		for (const item of prelude) lines.push(summarizeItem(item));
		lines.push("");
	}

	if (!selectedTurns.length) {
		lines.push("No visible turns.");
		return lines.join("\n");
	}

	if (detail === "summary") {
		for (const turn of selectedTurns) lines.push(formatTurnSummary(turn));
		const candidates = getOutputCandidates(selectedTurns.flatMap((turn) => turn.items), {
			...outputOptions,
			maxOutputs: Math.min(outputOptions.maxOutputs ?? DEFAULT_SUGGESTION_LIMIT, DEFAULT_SUGGESTION_LIMIT),
		});
		if (candidates.length) {
			lines.push("", "Largest forgettable outputs:");
			for (const candidate of candidates) lines.push(`  ${formatOutputCandidate(candidate)}`);
		}
	} else if (detail === "outputs") {
		const candidates = getOutputCandidates(selectedTurns.flatMap((turn) => turn.items), outputOptions);
		if (!candidates.length) {
			lines.push("No forgettable outputs in selected turns.");
		} else {
			for (const candidate of candidates) lines.push(formatOutputCandidate(candidate));
			const snippet = formatForgetSnippet(candidates);
			if (snippet) lines.push("", "Apply with:", snippet);
		}
	} else {
		for (const turn of selectedTurns) {
			lines.push(`turn:${turn.number}`);
			for (const item of turn.items) lines.push(`  ${summarizeItem(item)}`);
			lines.push("");
		}
	}

	const footer = turnNumber === undefined ? formatSelectionFooter(turns.length, selectedTurns.length, scope) : undefined;
	if (footer) lines.push("", footer);
	if (excludeLatestTurns > 0 && turnNumber === undefined) lines.push("", `Excluded latest ${excludeLatestTurns} turn(s).`);
	if (detail === "summary") lines.push("", `Use detail:"entries" with turn:N to expand a turn, or detail:"outputs" to list only output targets.`);
	return lines.join("\n").trimEnd();
}

function formatContextIndex(
	ctx: ExtensionContext,
	scope: "recent" | "all",
	limit: number,
	detail: ListContextDetail,
	turn?: number,
	outputOptions?: OutputSearchOptions,
	excludeLatestTurns?: number,
): string {
	const items = getCoreProjection(ctx).items.map(itemFromCore);
	const { prelude, turns } = groupTurns(items);
	return formatProjectedContext(prelude, turns, scope, limit, detail, turn, outputOptions, excludeLatestTurns);
}

function makeRewriteId(existingCount: number): string {
	const rand = Math.random().toString(16).slice(2, 6);
	return `forget-${String(existingCount + 1).padStart(3, "0")}-${rand}`;
}

function isPiForgetRewrite(rewrite: CoreContextRewriteEntry): boolean {
	return !!rewrite.details && typeof rewrite.details === "object" && "piForget" in rewrite.details;
}

function replacementFor(kind: "context" | "entry" | "output", label: string, replacement?: string): string {
	if (replacement !== undefined) return replacement;
	switch (kind) {
		case "context":
			return `[context forgotten by pi-forget: ${label}]`;
		case "entry":
			return `[entry forgotten by pi-forget: ${label}]`;
		case "output":
			return `[output forgotten by pi-forget: ${label}]`;
	}
}

function createForgetDirective(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targets: string[],
	reason?: string,
	replacement?: string,
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
	const sharedReplacement = replacement !== undefined && targets.length > 1;

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
			const after = replacementFor("context", target, replacement);
			rewriteInputs.push({
				rewriteId: rewriteInputs.length === 0 ? baseRewriteId : `${baseRewriteId}-${rewriteInputs.length + 1}`,
				target: { kind: "range", fromEntryId: first, toEntryId: last },
				beforeHash: hashContextText(before),
				after,
				reason,
				details: { piForget: { targets, reason, replacement: replacement ?? undefined } },
			});
			targetLabels.push(target);
			continue;
		}

		const outputEntryId = parseOutputTarget(target);
		if (outputEntryId !== undefined) {
			const matches = items.filter((candidate) => candidate.entryId === outputEntryId || candidate.sourceEntryIds.includes(outputEntryId));
			if (!matches.length) return { text: `Unknown output entry ${outputEntryId}. Run list_context for current visible entries.`, details: { error: "unknown_output", target } };
			const item = matches.find((candidate) => outputSurfaceText(candidate) !== undefined);
			if (!item) return { text: `Entry ${outputEntryId} has no separable output to forget.`, details: { error: "not_redactable", target } };
			const output = outputSurfaceText(item) ?? "";
			const rewriteEntryId = item.entryId === outputEntryId ? outputEntryId : (item.sourceEntryIds.find((id) => id === outputEntryId) ?? item.entryId);
			const after = replacementFor("output", outputEntryId, replacement);
			rewriteInputs.push({
				rewriteId: rewriteInputs.length === 0 ? baseRewriteId : `${baseRewriteId}-${rewriteInputs.length + 1}`,
				target: { kind: "surface", entryId: rewriteEntryId, surface: "output" },
				beforeHash: hashContextText(output),
				after,
				reason,
				details: { piForget: { targets, reason, replacement: replacement ?? undefined } },
			});
			targetLabels.push(target);
			continue;
		}

		const entryId = parseEntryTarget(target);
		if (entryId !== undefined) {
			const item = items.find((candidate) => candidate.entryId === entryId || candidate.sourceEntryIds.includes(entryId));
			if (!item) return { text: `Unknown entry ${entryId}. Run list_context for current visible entries.`, details: { error: "unknown_entry", target } };
			const before = renderedItemText(item);
			const after = replacementFor("entry", entryId, replacement);
			rewriteInputs.push({
				rewriteId: rewriteInputs.length === 0 ? baseRewriteId : `${baseRewriteId}-${rewriteInputs.length + 1}`,
				target: { kind: "surface", entryId, surface: "rendered" },
				beforeHash: hashContextText(before),
				after,
				reason,
				details: { piForget: { targets, reason, replacement: replacement ?? undefined } },
			});
			targetLabels.push(target);
			continue;
		}

		return { text: `Invalid target ${target}. Use turn:N, entry:<id>, or output:<id> from list_context.`, details: { error: "invalid_target", target } };
	}

	const entryIds = rewriteInputs.map((rewrite) => corePi.appendContextRewrite(rewrite));
	return {
		text: `Applied context rewrite${entryIds.length === 1 ? "" : "s"} ${rewriteInputs.map((rewrite) => rewrite.rewriteId).join(", ")} for ${targetLabels.join(", ")}${replacement !== undefined ? ` using ${sharedReplacement ? "the same replacement" : "custom replacement text"}` : ""}. Original session history is unchanged. Use /unforget <rewrite-id> to restore.`,
		details: { rewriteIds: rewriteInputs.map((rewrite) => rewrite.rewriteId), entryIds, targets: targetLabels, replacementApplied: replacement !== undefined },
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
			detail: Type.Optional(
				Type.Union([Type.Literal("summary"), Type.Literal("entries"), Type.Literal("outputs")], { default: "summary" }),
			),
			turn: Type.Optional(Type.Number({ minimum: 1, description: "Specific turn number to inspect." })),
			minChars: Type.Optional(Type.Number({ minimum: 0, description: "Only show output targets with at least this many characters." })),
			maxOutputs: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_OUTPUT_LIMIT, default: DEFAULT_OUTPUT_LIMIT })),
			query: Type.Optional(Type.String({ description: "Filter output targets by entry id, role, tool name, command, or output text." })),
			excludeLatestTurns: Type.Optional(Type.Number({ minimum: 0, description: "Exclude the latest N turns from output search results." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "recent";
			const detail = params.detail ?? "summary";
			const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_LIST_LIMIT)));
			const turn = params.turn === undefined ? undefined : Math.max(1, Math.floor(params.turn));
			const outputOptions = {
				minChars: params.minChars,
				maxOutputs: params.maxOutputs ?? (detail === "outputs" ? DEFAULT_OUTPUT_LIMIT : DEFAULT_SUGGESTION_LIMIT),
				query: params.query,
			};
			const excludeLatestTurns = Math.max(0, Math.floor(params.excludeLatestTurns ?? 0));
			return {
				content: [{ type: "text", text: formatContextIndex(ctx, scope, limit, detail, turn, outputOptions, excludeLatestTurns) }],
				details: {},
			};
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
			replacement: Type.Optional(
				Type.String({
					description:
						"Optional replacement/summary text to show in future context instead of the default pi-forget placeholder. For multiple targets, the same replacement is applied to each target.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = createForgetDirective(pi, ctx, params.targets, params.reason, params.replacement);
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
	formatOutputCandidate,
	formatProjectedContext,
	formatTurnSummary,
	groupTurns,
	hashContextText,
	parseEntryTarget,
	parseOutputTarget,
	parseTurnTarget,
	renderedItemText,
	summarizeItem,
};
