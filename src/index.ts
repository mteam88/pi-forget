import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = MAX_LIST_LIMIT;
const SNIPPET_CHARS = 180;
const SUMMARY_SNIPPET_CHARS = 90;
const DEFAULT_SUGGESTION_LIMIT = 8;
const DEFAULT_OUTPUT_LIMIT = 20;
const MAX_OUTPUT_LIMIT = 100;
const LARGE_OUTPUT_HINT_CHARS = 20_000;
const MAX_LARGE_OUTPUT_HINTS_PER_TURN = 3;
const CONTEXT_USAGE_HINT_PERCENT = 80;
const CUSTOM_TYPE = "pi-forget";

type ListContextDetail = "summary" | "entries" | "outputs";
type RewriteKind = "turn" | "entry" | "output";

interface ContextItem {
	entryId: string;
	message: AgentMessage;
	sourceEntryIds: string[];
}

interface ProjectedContext {
	branch: SessionEntry[];
	items: ContextItem[];
}

interface Turn {
	number: number;
	startEntryId: string;
	entryIds: string[];
	items: ContextItem[];
}

interface RewritePlan {
	id: string;
	targets: string[];
	reason?: string;
	replacement?: string;
	replacements?: Record<string, string>;
	originalLeafId: string | null;
	firstChangedIndex: number;
	insertBefore: Map<string, string[]>;
	dropEntryIds: Set<string>;
	replaceEntry: Map<string, string>;
	redactOutput: Map<string, string>;
}

interface TargetResolution {
	item?: ContextItem;
	resolvedId?: string;
	ambiguousIds?: string[];
}

interface ApplyForgetResult {
	text: string;
	details: Record<string, unknown>;
}

interface PendingLargeOutputHint {
	toolCallId: string;
	toolName: string;
	chars: number;
	callDescription?: string;
	outputPreview?: string;
}

interface HintState {
	hintedOutputEntryIds: Set<string>;
	hintsThisTurn: number;
	contextUsageHintedThisTurn: boolean;
	lastContextUsageHintPercent?: number;
}

type MessageRecord = Record<string, unknown> & { role?: string };
type ContentBlock = Record<string, unknown> & { type?: string };
type MutableSessionManager = SessionManager;


function messageRecord(message: AgentMessage): MessageRecord {
	return message as unknown as MessageRecord;
}

function sessionManager(ctx: ExtensionContext): MutableSessionManager {
	return ctx.sessionManager as unknown as MutableSessionManager;
}

function projectEntry(entry: SessionEntry): ContextItem | undefined {
	if (entry.type === "message") {
		return { entryId: entry.id, sourceEntryIds: [entry.id], message: entry.message };
	}
	if (entry.type === "custom_message") {
		return {
			entryId: entry.id,
			sourceEntryIds: [entry.id],
			message: {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
				timestamp: new Date(entry.timestamp).getTime(),
			} as AgentMessage,
		};
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return {
			entryId: entry.id,
			sourceEntryIds: [entry.id],
			message: {
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: new Date(entry.timestamp).getTime(),
			} as AgentMessage,
		};
	}
	if (entry.type === "compaction") {
		return {
			entryId: entry.id,
			sourceEntryIds: [entry.id],
			message: {
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: new Date(entry.timestamp).getTime(),
			} as AgentMessage,
		};
	}
	return undefined;
}

function messageFingerprint(message: AgentMessage): string {
	return JSON.stringify(message);
}

function appendVolatileMessageSuffix(projected: AgentMessage[], current: AgentMessage[]): AgentMessage[] {
	const lastProjected = projected.at(-1);
	if (!lastProjected) return current;
	const lastFingerprint = messageFingerprint(lastProjected);
	for (let i = current.length - 1; i >= 0; i--) {
		if (messageFingerprint(current[i]) === lastFingerprint) {
			return [...projected, ...current.slice(i + 1)];
		}
	}
	return projected;
}

function projectContext(ctx: ExtensionContext): ProjectedContext {
	const branch = ctx.sessionManager.getBranch();
	let compaction: SessionEntry | undefined;
	for (const entry of branch) {
		if (entry.type === "compaction") compaction = entry;
	}

	const projectedEntries: SessionEntry[] = [];
	if (compaction?.type === "compaction") {
		projectedEntries.push(compaction);
		const compactionIndex = branch.findIndex((entry) => entry.id === compaction.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIndex; i++) {
			const entry = branch[i];
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) projectedEntries.push(entry);
		}
		for (let i = compactionIndex + 1; i < branch.length; i++) projectedEntries.push(branch[i]);
	} else {
		projectedEntries.push(...branch);
	}

	return {
		branch,
		items: projectedEntries.map(projectEntry).filter((item): item is ContextItem => item !== undefined),
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

function compactJson(value: unknown, limit = SNIPPET_CHARS): string {
	try {
		return compactText(JSON.stringify(value), limit);
	} catch {
		return compactText(String(value), limit);
	}
}

function approxTokens(chars: number): number {
	return Math.max(1, Math.round(chars / 4));
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

function replaceTextBlocks(content: unknown, text: string): string | Array<Record<string, unknown>> {
	if (typeof content === "string") return text;
	const images = asContentBlocks(content).filter((block) => block.type === "image");
	return [{ type: "text", text }, ...images];
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

function contextChars(item: ContextItem): number {
	const msg = messageRecord(item.message);
	switch (msg.role) {
		case "assistant":
			return asContentBlocks(msg.content).reduce((total, block) => {
				if (block.type === "text" && typeof block.text === "string") return total + block.text.length;
				if (block.type === "thinking" && typeof block.thinking === "string") return total + block.thinking.length;
				if (block.type === "toolCall") return total + compactJson(block.arguments ?? {}).length + stringField(block, "name").length + stringField(block, "id").length;
				return total;
			}, 0);
		case "bashExecution":
			return stringField(msg, "command").length + stringField(msg, "output").length;
		case "branchSummary":
		case "compactionSummary":
			return stringField(msg, "summary").length;
		default:
			return contentText(msg.content).length;
	}
}

function countContextChars(items: ContextItem[]): number {
	return items.reduce((total, item) => total + contextChars(item), 0);
}

function formatTurnSummary(turn: Turn): string {
	const outputChars = countOutputChars(turn.items);
	const totalChars = countContextChars(turn.items);
	const outputSuffix = outputChars > 0 ? `, ${outputChars} output chars (~${approxTokens(outputChars)} tokens)` : "";
	return `turn:${turn.number}  user: "${compactText(firstUserText(turn), SUMMARY_SNIPPET_CHARS)}"  ${turn.items.length} entries, ~${approxTokens(totalChars)} total tokens${outputSuffix}`;
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

function formatOutputCandidate(candidate: { item: ContextItem; output: string }, source?: string): string {
	const msg = messageRecord(candidate.item.message);
	const kind = msg.role === "toolResult" ? `tool ${stringField(msg, "toolName") || "tool"}` : msg.role ?? "message";
	const sourcePrefix = source ? `${source}, ` : "";
	return `output:${candidate.item.entryId}  ${sourcePrefix}${kind}, ${candidate.output.length} chars (~${approxTokens(candidate.output.length)} tokens), "${compactText(candidate.output, SUMMARY_SNIPPET_CHARS)}"`;
}

function sourceLabels(prelude: ContextItem[], turns: Turn[], includePrelude: boolean): Map<string, string> {
	const labels = new Map<string, string>();
	if (includePrelude) {
		for (const item of prelude) labels.set(item.entryId, "prelude");
	}
	for (const turn of turns) {
		for (const item of turn.items) labels.set(item.entryId, `turn:${turn.number}`);
	}
	return labels;
}

function pushGroupedOutputCandidates(
	lines: string[],
	candidates: Array<{ item: ContextItem; output: string }>,
	prelude: ContextItem[],
	turns: Turn[],
	includePrelude: boolean,
): void {
	const byEntryId = new Map(candidates.map((candidate) => [candidate.item.entryId, candidate]));
	if (includePrelude) {
		const preludeCandidates = prelude.map((item) => byEntryId.get(item.entryId)).filter((candidate): candidate is { item: ContextItem; output: string } => candidate !== undefined);
		if (preludeCandidates.length) {
			const preludeOutputChars = countOutputChars(prelude);
			const outputSuffix = preludeOutputChars > 0 ? `, ${preludeOutputChars} output chars (~${approxTokens(preludeOutputChars)} tokens)` : "";
			lines.push(`prelude  ${prelude.length} entries, ~${approxTokens(countContextChars(prelude))} total tokens${outputSuffix}`);
			for (const candidate of preludeCandidates) lines.push(`  ${formatOutputCandidate(candidate)}`);
		}
	}
	for (const turn of turns) {
		const turnCandidates = turn.items.map((item) => byEntryId.get(item.entryId)).filter((candidate): candidate is { item: ContextItem; output: string } => candidate !== undefined);
		if (!turnCandidates.length) continue;
		lines.push(formatTurnSummary(turn));
		for (const candidate of turnCandidates) lines.push(`  ${formatOutputCandidate(candidate)}`);
	}
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

	if (!selectedTurns.length && !(turnNumber === undefined && prelude.length)) {
		lines.push("No visible turns.");
		return lines.join("\n");
	}

	const includePreludeOutputs = turnNumber === undefined;
	const outputTurns = detail === "outputs" && turnNumber === undefined
		? turns.filter((turn) => turn.number <= excludedStart)
		: selectedTurns;
	const outputItems = [...(includePreludeOutputs ? prelude : []), ...outputTurns.flatMap((turn) => turn.items)];
	const labels = sourceLabels(prelude, outputTurns, includePreludeOutputs);

	if (detail === "summary") {
		if (includePreludeOutputs && prelude.length) {
			const preludeOutputChars = countOutputChars(prelude);
			const outputSuffix = preludeOutputChars > 0 ? `, ${preludeOutputChars} output chars (~${approxTokens(preludeOutputChars)} tokens)` : "";
			lines.push(`prelude  ${prelude.length} entries, ~${approxTokens(countContextChars(prelude))} total tokens${outputSuffix}`);
		}
		for (const turn of selectedTurns) lines.push(formatTurnSummary(turn));
		const candidates = getOutputCandidates(outputItems, {
			...outputOptions,
			maxOutputs: Math.min(outputOptions.maxOutputs ?? DEFAULT_SUGGESTION_LIMIT, DEFAULT_SUGGESTION_LIMIT),
		});
		if (candidates.length) {
			lines.push("", "Largest forgettable outputs:");
			for (const candidate of candidates) lines.push(`  ${formatOutputCandidate(candidate, labels.get(candidate.item.entryId))}`);
		}
	} else if (detail === "outputs") {
		const candidates = getOutputCandidates(outputItems, outputOptions);
		if (!candidates.length) {
			lines.push("No output targets found in selected context.");
		} else {
			lines.push("Large output targets, grouped by where they appear in the conversation:", "");
			pushGroupedOutputCandidates(lines, candidates, prelude, outputTurns, includePreludeOutputs);
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
	const { items } = projectContext(ctx);
	const { prelude, turns } = groupTurns(items);
	return formatProjectedContext(prelude, turns, scope, limit, detail, turn, outputOptions, excludeLatestTurns);
}

function makeRewriteId(existingCount: number): string {
	const rand = Math.random().toString(16).slice(2, 6);
	return `forget-${String(existingCount + 1).padStart(3, "0")}-${rand}`;
}

function replacementFor(kind: RewriteKind, label: string, replacement?: string): string {
	if (replacement !== undefined) return replacement;
	switch (kind) {
		case "turn":
			return `[context forgotten by pi-forget: ${label}]`;
		case "entry":
			return `[entry forgotten by pi-forget: ${label}]`;
		case "output":
			return `[output forgotten by pi-forget: ${label}]`;
	}
}

function replacementOverride(replacements: Record<string, string> | undefined, aliases: string[]): string | undefined {
	if (!replacements) return undefined;
	for (const alias of aliases) {
		if (Object.hasOwn(replacements, alias)) return replacements[alias];
	}
	return undefined;
}

function replacementForTarget(
	kind: RewriteKind,
	label: string,
	aliases: string[],
	replacement?: string,
	replacements?: Record<string, string>,
): string {
	return replacementFor(kind, label, replacementOverride(replacements, aliases) ?? replacement);
}

function branchIndexById(branch: SessionEntry[]): Map<string, number> {
	const indexes = new Map<string, number>();
	branch.forEach((entry, index) => indexes.set(entry.id, index));
	return indexes;
}

function sourceEntryIds(item: ContextItem): string[] {
	return item.sourceEntryIds.length ? item.sourceEntryIds : [item.entryId];
}

function existingPiForgetCount(branch: SessionEntry[]): number {
	return branch.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE).length;
}

function aliasTargetsFromBranch(branch: SessionEntry[]): Map<string, Set<string>> {
	const aliases = new Map<string, Set<string>>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE || !entry.data || typeof entry.data !== "object") continue;
		const rawAliases = (entry.data as Record<string, unknown>).aliases;
		if (!rawAliases || typeof rawAliases !== "object" || Array.isArray(rawAliases)) continue;
		for (const [sourceId, clonedId] of Object.entries(rawAliases)) {
			if (typeof clonedId !== "string") continue;
			const targets = aliases.get(sourceId) ?? new Set<string>();
			targets.add(clonedId);
			aliases.set(sourceId, targets);
		}
	}
	return aliases;
}

function findVisibleItem(items: ContextItem[], entryId: string, predicate: (item: ContextItem) => boolean): ContextItem | undefined {
	return items.find((candidate) => (candidate.entryId === entryId || candidate.sourceEntryIds.includes(entryId)) && predicate(candidate));
}

function resolveVisibleItem(
	items: ContextItem[],
	aliasTargets: Map<string, Set<string>>,
	entryId: string,
	predicate: (item: ContextItem) => boolean,
): TargetResolution {
	const direct = findVisibleItem(items, entryId, predicate);
	if (direct) return { item: direct, resolvedId: entryId };

	const aliasedIds = aliasTargets.get(entryId);
	if (!aliasedIds?.size) return {};

	const matches = new Map<string, ContextItem>();
	for (const aliasedId of aliasedIds) {
		const item = findVisibleItem(items, aliasedId, predicate);
		if (item) matches.set(item.entryId, item);
	}
	if (matches.size === 1) {
		const [[resolvedId, item]] = [...matches.entries()];
		return { item, resolvedId };
	}
	if (matches.size > 1) return { ambiguousIds: [...matches.keys()] };
	return {};
}

function aliasesForReplayedEntry(aliasTargets: Map<string, Set<string>>, originalId: string, clonedId: string): Record<string, string> {
	const aliases: Record<string, string> = { [originalId]: clonedId };
	for (const [sourceId, targets] of aliasTargets) {
		if (targets.has(originalId)) aliases[sourceId] = clonedId;
	}
	return aliases;
}

function buildForgetPlan(
	ctx: ExtensionContext,
	targets: string[],
	reason?: string,
	replacement?: string,
	replacements?: Record<string, string>,
): { plan?: RewritePlan; error?: ApplyForgetResult } {
	const projection = projectContext(ctx);
	const { branch, items } = projection;
	const { turns } = groupTurns(items);
	const latestTurn = turns.at(-1)?.number;
	const indexById = branchIndexById(branch);
	const aliasTargets = aliasTargetsFromBranch(branch);
	const plan: RewritePlan = {
		id: makeRewriteId(existingPiForgetCount(branch)),
		targets,
		reason,
		replacement,
		replacements,
		originalLeafId: ctx.sessionManager.getLeafId(),
		firstChangedIndex: Number.POSITIVE_INFINITY,
		insertBefore: new Map(),
		dropEntryIds: new Set(),
		replaceEntry: new Map(),
		redactOutput: new Map(),
	};

	const markChanged = (entryId: string) => {
		const index = indexById.get(entryId);
		if (index !== undefined) plan.firstChangedIndex = Math.min(plan.firstChangedIndex, index);
	};

	const addInsertBefore = (entryId: string, text: string) => {
		const existing = plan.insertBefore.get(entryId) ?? [];
		existing.push(text);
		plan.insertBefore.set(entryId, existing);
		markChanged(entryId);
	};

	for (const target of targets) {
		const turnNumber = parseTurnTarget(target);
		if (turnNumber !== undefined) {
			const canonicalTarget = `turn:${turnNumber}`;
			const turn = turns.find((candidate) => candidate.number === turnNumber);
			if (!turn) return { error: { text: `Unknown ${target}. Run list_context for current turn numbers.`, details: { error: "unknown_turn", target } } };
			if (turnNumber === latestTurn) {
				return { error: { text: `Refusing to forget ${target}: pi-forget does not forget the current/latest turn.`, details: { error: "latest_turn", target } } };
			}
			const ids = turn.items.flatMap(sourceEntryIds);
			const first = ids[0];
			if (!first) return { error: { text: `Could not resolve ${target} to source entries.`, details: { error: "unresolved_turn", target } } };
			addInsertBefore(first, replacementForTarget("turn", canonicalTarget, [target, canonicalTarget], replacement, replacements));
			for (const id of ids) {
				plan.dropEntryIds.add(id);
				markChanged(id);
			}
			continue;
		}

		const outputEntryId = parseOutputTarget(target);
		if (outputEntryId !== undefined) {
			const canonicalTarget = `output:${outputEntryId}`;
			const resolved = resolveVisibleItem(items, aliasTargets, outputEntryId, (item) => outputSurfaceText(item) !== undefined);
			if (resolved.ambiguousIds) {
				return {
					error: {
						text: `Ambiguous output entry ${outputEntryId} after synthetic branch replay. Re-run list_context for current targets.`,
						details: { error: "ambiguous_output", target, matches: resolved.ambiguousIds },
					},
				};
			}
			if (!resolved.item || !resolved.resolvedId) return { error: { text: `Unknown output entry ${outputEntryId}, or entry has no separable output.`, details: { error: "unknown_output", target } } };
			const rewriteEntryId = sourceEntryIds(resolved.item).find((id) => id === resolved.resolvedId) ?? resolved.item.entryId;
			plan.redactOutput.set(
				rewriteEntryId,
				replacementForTarget("output", outputEntryId, [target, canonicalTarget, outputEntryId, `output:${resolved.resolvedId}`, resolved.resolvedId], replacement, replacements),
			);
			markChanged(rewriteEntryId);
			continue;
		}

		const entryId = parseEntryTarget(target);
		if (entryId !== undefined) {
			const canonicalTarget = `entry:${entryId}`;
			const resolved = resolveVisibleItem(items, aliasTargets, entryId, () => true);
			if (resolved.ambiguousIds) {
				return {
					error: {
						text: `Ambiguous entry ${entryId} after synthetic branch replay. Re-run list_context for current targets.`,
						details: { error: "ambiguous_entry", target, matches: resolved.ambiguousIds },
					},
				};
			}
			if (!resolved.item || !resolved.resolvedId) return { error: { text: `Unknown entry ${entryId}. Run list_context for current visible entries.`, details: { error: "unknown_entry", target } } };
			const rewriteEntryId = sourceEntryIds(resolved.item).find((id) => id === resolved.resolvedId) ?? resolved.item.entryId;
			plan.replaceEntry.set(
				rewriteEntryId,
				replacementForTarget("entry", entryId, [target, canonicalTarget, entryId, `entry:${resolved.resolvedId}`, resolved.resolvedId], replacement, replacements),
			);
			markChanged(rewriteEntryId);
			continue;
		}

		return { error: { text: `Invalid target ${target}. Use turn:N, entry:<id>, or output:<id> from list_context.`, details: { error: "invalid_target", target } } };
	}

	if (!Number.isFinite(plan.firstChangedIndex)) {
		return { error: { text: "No changes to apply.", details: { error: "empty_plan" } } };
	}
	return { plan };
}

function cloneMessageWithRedactedOutput(message: AgentMessage, replacement: string): AgentMessage {
	const cloned = structuredClone(message) as AgentMessage;
	const record = cloned as unknown as MessageRecord;
	if (record.role === "bashExecution") {
		record.output = replacement;
		record.truncated = false;
		delete record.fullOutputPath;
	} else if (record.role === "toolResult") {
		record.content = replaceTextBlocks(record.content, replacement);
	}
	return cloned;
}

function appendBranchSummary(sm: MutableSessionManager, original: Extract<SessionEntry, { type: "branch_summary" }>): string {
	return sm.appendCustomMessageEntry(CUSTOM_TYPE, original.summary, false, {
		kind: "cloned_branch_summary",
		fromId: original.fromId,
		details: structuredClone(original.details),
		fromHook: original.fromHook,
	});
}

function appendClonedEntry(sm: MutableSessionManager, original: SessionEntry, replacementOutput?: string): string | null {
	switch (original.type) {
		case "message":
			return sm.appendMessage(
				(replacementOutput === undefined ? structuredClone(original.message) : cloneMessageWithRedactedOutput(original.message, replacementOutput)) as Parameters<
					SessionManager["appendMessage"]
				>[0],
			);
		case "custom_message":
			return sm.appendCustomMessageEntry(original.customType, structuredClone(original.content), original.display, structuredClone(original.details));
		case "model_change":
			return sm.appendModelChange(original.provider, original.modelId);
		case "thinking_level_change":
			return sm.appendThinkingLevelChange(original.thinkingLevel);
		case "compaction":
			return sm.appendCompaction(original.summary, original.firstKeptEntryId, original.tokensBefore, structuredClone(original.details), original.fromHook);
		case "custom":
			return sm.appendCustomEntry(original.customType, structuredClone(original.data));
		case "session_info":
			return sm.appendSessionInfo(original.name ?? "");
		case "branch_summary":
			return appendBranchSummary(sm, original);
		case "label":
			return null;
	}
}

function appendReplacement(sm: MutableSessionManager, text: string, plan: RewritePlan, sourceEntryId: string): string {
	return sm.appendCustomMessageEntry(CUSTOM_TYPE, text, true, {
		kind: "replacement",
		forgetId: plan.id,
		sourceEntryId,
		targets: plan.targets,
		reason: plan.reason,
	});
}

function appendMetadata(sm: MutableSessionManager, plan: RewritePlan, rewrittenFromId: string | null, aliases: Record<string, string>): string {
	return sm.appendCustomEntry(CUSTOM_TYPE, {
		kind: "synthetic_branch",
		forgetId: plan.id,
		targets: plan.targets,
		reason: plan.reason,
		replacement: plan.replacement,
		replacements: plan.replacements,
		aliases,
		originalLeafId: plan.originalLeafId,
		rewrittenFromId,
		createdAt: Date.now(),
	});
}

function submittedReplacementText(plan: RewritePlan): string {
	const sections: string[] = [];
	if (plan.replacement !== undefined) sections.push(`Replacement text:\n${plan.replacement}`);
	if (plan.replacements && Object.keys(plan.replacements).length > 0) {
		const lines = Object.entries(plan.replacements).flatMap(([target, replacement]) => [`${target}:`, replacement]);
		sections.push(`Replacement texts:\n${lines.join("\n")}`);
	}
	return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

function applyForgetPlan(ctx: ExtensionContext, plan: RewritePlan): ApplyForgetResult {
	const sm = sessionManager(ctx);
	const branch = ctx.sessionManager.getBranch();
	const parentId = branch[plan.firstChangedIndex]?.parentId ?? null;
	const aliasTargets = aliasTargetsFromBranch(branch);
	const aliases: Record<string, string> = {};
	if (parentId) sm.branch(parentId);
	else sm.resetLeaf();

	let appended = 0;
	for (let i = plan.firstChangedIndex; i < branch.length; i++) {
		const entry = branch[i];
		const replacements = plan.insertBefore.get(entry.id) ?? [];
		for (const text of replacements) {
			appendReplacement(sm, text, plan, entry.id);
			appended++;
		}
		if (plan.dropEntryIds.has(entry.id)) continue;
		const entryReplacement = plan.replaceEntry.get(entry.id);
		if (entryReplacement !== undefined) {
			appendReplacement(sm, entryReplacement, plan, entry.id);
			appended++;
			continue;
		}
		const cloned = appendClonedEntry(sm, entry, plan.redactOutput.get(entry.id));
		if (cloned) {
			Object.assign(aliases, aliasesForReplayedEntry(aliasTargets, entry.id, cloned));
			appended++;
		}
	}
	const rewrittenContentLeafId = sm.getLeafId();
	const syntheticLeafId = appendMetadata(sm, plan, rewrittenContentLeafId, aliases);

	return {
		text: `Created synthetic pi-forget branch ${plan.id} for ${plan.targets.join(", ")}. Original session history is unchanged. Use /unforget ${plan.id} to return to the original branch.${submittedReplacementText(plan)}`,
		details: { forgetId: plan.id, targets: plan.targets, originalLeafId: plan.originalLeafId, rewrittenLeafId: syntheticLeafId, rewrittenContentLeafId, appended },
	};
}

function applyForget(ctx: ExtensionContext, targets: string[], reason?: string, replacement?: string, replacements?: Record<string, string>): ApplyForgetResult {
	const { plan, error } = buildForgetPlan(ctx, targets, reason, replacement, replacements);
	if (error) return error;
	if (!plan) return { text: "No changes to apply.", details: { error: "empty_plan" } };
	return applyForgetPlan(ctx, plan);
}

function labelSyntheticBranch(pi: ExtensionAPI, ctx: ExtensionContext, result: ApplyForgetResult): void {
	const rewrittenLeafId = typeof result.details.rewrittenLeafId === "string" ? result.details.rewrittenLeafId : undefined;
	const rewrittenContentLeafId = typeof result.details.rewrittenContentLeafId === "string" ? result.details.rewrittenContentLeafId : undefined;
	const forgetId = typeof result.details.forgetId === "string" ? result.details.forgetId : undefined;
	if (!rewrittenLeafId || !forgetId) return;

	const label = `pi-forget ${forgetId}`;
	if (rewrittenContentLeafId && ctx.sessionManager.getEntry(rewrittenContentLeafId)) {
		pi.setLabel(rewrittenContentLeafId, label);
	}
	if (ctx.sessionManager.getEntry(rewrittenLeafId)) {
		pi.setLabel(rewrittenLeafId, label);
	}
	sessionManager(ctx).branch(rewrittenLeafId);
}

function labelVisibleForgetToolResults(pi: ExtensionAPI, ctx: ExtensionContext, forgetIds: Set<string>): void {
	if (forgetIds.size === 0) return;
	const sm = sessionManager(ctx);
	const restoreLeafId = sm.getLeafId();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "forget") continue;
		const details = entry.message.details;
		const forgetId = details && typeof details === "object" && "forgetId" in details && typeof details.forgetId === "string" ? details.forgetId : undefined;
		if (!forgetId || !forgetIds.has(forgetId)) continue;
		pi.setLabel(entry.id, `pi-forget ${forgetId}`);
		forgetIds.delete(forgetId);
	}
	if (restoreLeafId && ctx.sessionManager.getEntry(restoreLeafId)) sm.branch(restoreLeafId);
	else sm.resetLeaf();
}

function getPiForgetMetadata(branch: SessionEntry[]): Array<{ entry: SessionEntry; data: Record<string, unknown> }> {
	return branch
		.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom" && entry.customType === CUSTOM_TYPE && !!entry.data && typeof entry.data === "object")
		.map((entry) => ({ entry, data: entry.data as Record<string, unknown> }))
		.filter(({ data }) => data.kind === "synthetic_branch" && typeof data.forgetId === "string");
}

function formatForgetMetadata(meta: { entry: SessionEntry; data: Record<string, unknown> }): string {
	const targets = Array.isArray(meta.data.targets) ? meta.data.targets.filter((target): target is string => typeof target === "string").join(", ") : "";
	const originalLeafId = typeof meta.data.originalLeafId === "string" ? meta.data.originalLeafId : "none";
	return [
		String(meta.data.forgetId),
		`  targets: ${targets}`,
		`  originalLeafId: ${originalLeafId}`,
		typeof meta.data.reason === "string" ? `  reason: ${meta.data.reason}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

async function refreshSessionContextAtLeaf(ctx: ExtensionCommandContext, leafId: string): Promise<void> {
	const sm = sessionManager(ctx);
	const leaf = sm.getEntry(leafId);
	if (!leaf) throw new Error(`Unknown synthetic leaf ${leafId}`);
	if (leaf.parentId) sm.branch(leaf.parentId);
	else sm.resetLeaf();
	const result = await ctx.navigateTree(leafId, { summarize: false });
	if (result.cancelled) throw new Error("Synthetic branch navigation was cancelled");
}

async function unforget(ctx: ExtensionCommandContext, forgetId: string): Promise<string> {
	const meta = getPiForgetMetadata(ctx.sessionManager.getBranch()).find(({ data }) => data.forgetId === forgetId);
	if (!meta) return `No active pi-forget synthetic branch found for ${forgetId}.`;
	const originalLeafId = meta.data.originalLeafId;
	if (typeof originalLeafId !== "string" || !ctx.sessionManager.getEntry(originalLeafId)) {
		return `Cannot unforget ${forgetId}: original branch leaf is unavailable.`;
	}
	const result = await ctx.navigateTree(originalLeafId, { summarize: false });
	if (result.cancelled) return `Unforget ${forgetId} cancelled.`;
	return `Returned to original branch for ${forgetId}.`;
}

function findToolResultEntry(ctx: ExtensionContext, toolCallId: string): Extract<SessionEntry, { type: "message" }> | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = messageRecord(entry.message);
		if (msg.role === "toolResult" && msg.toolCallId === toolCallId) return entry;
	}
	return undefined;
}

function findToolCallDescription(ctx: ExtensionContext, toolCallId: string): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = messageRecord(entry.message);
		if (msg.role !== "assistant") continue;
		for (const block of asContentBlocks(msg.content)) {
			if (block.type !== "toolCall" || block.id !== toolCallId) continue;
			const name = typeof block.name === "string" && block.name ? block.name : "tool";
			return `${name}(${compactJson(block.arguments ?? {}, 180)})`;
		}
	}
	return undefined;
}

function contextUsagePercent(ctx: ExtensionContext): number | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return undefined;
	return usage.percent <= 1 ? usage.percent * 100 : usage.percent;
}

function sendCleanupHint(pi: ExtensionAPI, content: string, details: Record<string, unknown>): void {
	pi.sendMessage(
		{
			customType: CUSTOM_TYPE,
			content,
			display: true,
			details: { kind: "cleanup_hint", ...details },
		},
		{ deliverAs: "steer" },
	);
}

function maybeSendContextUsageHint(pi: ExtensionAPI, ctx: ExtensionContext, state: HintState): boolean {
	if (state.contextUsageHintedThisTurn) return false;
	const percent = contextUsagePercent(ctx);
	if (percent === undefined || percent < CONTEXT_USAGE_HINT_PERCENT) return false;
	const rounded = Math.round(percent);
	if (state.lastContextUsageHintPercent !== undefined && rounded < state.lastContextUsageHintPercent + 5) return false;
	sendCleanupHint(
		pi,
		`pi-forget hint: Context appears to be about ${rounded}% full. This may be a good opportunity to save tokens by replacing stale large tool outputs with detailed summaries using forget({ targets: ["output:<id>"], replacement: <your detailed summary> }).`,
		{ contextPercent: rounded },
	);
	state.contextUsageHintedThisTurn = true;
	state.lastContextUsageHintPercent = rounded;
	return true;
}

function maybeSendLargeOutputHint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: HintState,
	hint: PendingLargeOutputHint,
): boolean {
	const entry = findToolResultEntry(ctx, hint.toolCallId);
	if (!entry || state.hintedOutputEntryIds.has(entry.id) || state.hintsThisTurn >= MAX_LARGE_OUTPUT_HINTS_PER_TURN) return false;
	const target = `output:${entry.id}`;
	const percent = contextUsagePercent(ctx);
	const contextSentence = percent !== undefined && percent >= CONTEXT_USAGE_HINT_PERCENT
		? ` Context appears to be about ${Math.round(percent)}% full, so summarizing stale large outputs may be especially useful.`
		: "";
	const callSentence = hint.callDescription ? ` It came from: ${hint.callDescription}.` : "";
	const previewSentence = hint.outputPreview ? ` Output starts: "${hint.outputPreview}".` : "";
	sendCleanupHint(
		pi,
		`pi-forget hint: Large ${hint.toolName} output is available as ${target} (${hint.chars} chars, ~${approxTokens(hint.chars)} tokens).${callSentence}${previewSentence} In the future, after using the useful facts, this may be a good opportunity to save tokens by replacing the raw output with a detailed summary using forget({ targets: ["${target}"], replacement: <your detailed summary> }).${contextSentence}`,
		{ outputTarget: target, toolName: hint.toolName, chars: hint.chars, approxTokens: approxTokens(hint.chars), callDescription: hint.callDescription, outputPreview: hint.outputPreview, contextPercent: percent === undefined ? undefined : Math.round(percent) },
	);
	state.hintedOutputEntryIds.add(entry.id);
	state.hintsThisTurn++;
	if (percent !== undefined && percent >= CONTEXT_USAGE_HINT_PERCENT) {
		state.contextUsageHintedThisTurn = true;
		state.lastContextUsageHintPercent = Math.max(state.lastContextUsageHintPercent ?? 0, Math.round(percent));
	}
	return true;
}

export default function piForget(pi: ExtensionAPI) {
	const pendingVisibleLabels = new Set<string>();
	const pendingLargeOutputHints = new Map<string, PendingLargeOutputHint>();
	const hintState = {
		hintedOutputEntryIds: new Set<string>(),
		hintsThisTurn: 0,
		contextUsageHintedThisTurn: false,
	};

	pi.on("context", async (event, ctx) => {
		if (getPiForgetMetadata(ctx.sessionManager.getBranch()).length === 0) return;
		const projected = projectContext(ctx).items.map((item) => item.message);
		return { messages: appendVolatileMessageSuffix(projected, event.messages) };
	});

	pi.on("turn_start", async () => {
		hintState.hintsThisTurn = 0;
		hintState.contextUsageHintedThisTurn = false;
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = messageRecord(event.message);
		if (msg.role !== "toolResult") return;
		const toolCallId = stringField(msg, "toolCallId");
		if (!toolCallId) return;
		const toolName = stringField(msg, "toolName") || "tool";
		const output = contentText(msg.content);
		const chars = output.length;
		if (chars >= LARGE_OUTPUT_HINT_CHARS) {
			const hint = { toolCallId, toolName, chars, callDescription: findToolCallDescription(ctx, toolCallId), outputPreview: compactText(output, 180) };
			if (!maybeSendLargeOutputHint(pi, ctx, hintState, hint)) pendingLargeOutputHints.set(toolCallId, hint);
		} else {
			maybeSendContextUsageHint(pi, ctx, hintState);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		for (const [toolCallId, hint] of pendingLargeOutputHints) {
			if (maybeSendLargeOutputHint(pi, ctx, hintState, hint)) pendingLargeOutputHints.delete(toolCallId);
		}
		maybeSendContextUsageHint(pi, ctx, hintState);
		labelVisibleForgetToolResults(pi, ctx, pendingVisibleLabels);
	});

	pi.registerTool({
		name: "list_context",
		label: "List Context",
		description: "Inspect provider-visible context and find stable turn:N, entry:<id>, and output:<id> targets for forget.",
		promptSnippet: "Inspect visible context and find forget targets",
		promptGuidelines: [
			"Use list_context to discover cleanup targets when stale context or large outputs are making the session harder to work with.",
			"Use list_context with detail:\"outputs\" to find large raw outputs, including prelude outputs left visible by compaction or split turns.",
			"Use list_context with detail:\"entries\" and turn:N when deciding whether a completed turn or phase should be summarized.",
		],
		parameters: Type.Object({
			scope: Type.Optional(Type.Union([Type.Literal("recent"), Type.Literal("all")], { default: "all" })),
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
			const scope = params.scope ?? "all";
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
		description:
			"Create a synthetic branch where selected visible context is omitted or replaced by summaries. Original session history remains unchanged. This is for context-budget cleanup, not secure deletion.",
		promptSnippet: "Omit or summarize stale context using turn:N, entry:<id>, or output:<id> targets",
		promptGuidelines: [
			"Use forget tastefully and considerately: keep recent outputs visible when they are still useful. Avoid needing to re-read relevant info; it is a balance.",
			"Use forget after large logs, file reads, search results, or skill docs have clearly served their purpose and a summary would preserve the important facts more compactly.",
			"Prefer forget with output:<id> when only one raw tool output is bulky; this keeps the surrounding conversation intact.",
			"Use forget with replacements when multiple targets need different summaries in one cleanup pass.",
			"Use forget with turn:N when a whole completed turn or phase can be represented more compactly as a summary.",
			"Keep the current/latest turn visible unless the user explicitly asks otherwise.",
			"Do not use forget as a privacy or secret-removal mechanism; it only moves future work to a cleaned branch.",
		],
		parameters: Type.Object({
			targets: Type.Array(Type.String({ description: "Targets to forget or summarize: turn:N, entry:<id>, or output:<id>." }), {
				minItems: 1,
			}),
			reason: Type.Optional(Type.String({ description: "Why this context should be omitted or summarized." })),
			replacement: Type.Optional(
				Type.String({
					description:
						"Optional replacement/summary text to show in the synthetic branch instead of the default pi-forget placeholder. For multiple targets, the same replacement is applied to each target unless replacements provides a per-target override.",
				}),
			),
			replacements: Type.Optional(
				Type.Record(
					Type.String(),
					Type.String({
						description:
							"Optional per-target replacement summaries. Keys are target strings such as output:abc12345, entry:abc12345, turn:2, or bare entry ids. Values replace only that target and override replacement.",
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyForget(ctx, params.targets, params.reason, params.replacement, params.replacements);
			if (typeof result.details.rewrittenLeafId === "string") {
				labelSyntheticBranch(pi, ctx, result);
				if (typeof result.details.forgetId === "string") pendingVisibleLabels.add(result.details.forgetId);
			}
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerCommand("forget", {
		description: "Create a synthetic branch forgetting stale provider-visible turns, entries, or outputs: /forget turn:N|entry:id|output:id [reason]",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const [target, ...reasonParts] = args.trim().split(/\s+/).filter(Boolean);
			if (!target) {
				ctx.ui.notify("Usage: /forget turn:N|entry:id|output:id [reason]", "warning");
				return;
			}
			const result = applyForget(ctx, [target], reasonParts.join(" ") || undefined);
			const rewrittenLeafId = result.details.rewrittenLeafId;
			if (typeof rewrittenLeafId === "string") {
				labelSyntheticBranch(pi, ctx, result);
				await refreshSessionContextAtLeaf(ctx, rewrittenLeafId);
			}
			ctx.ui.notify(result.text, "info");
		},
	});

	pi.registerCommand("forgotten", {
		description: "Show active pi-forget synthetic branch metadata",
		handler: async (_args, ctx) => {
			const active = getPiForgetMetadata(ctx.sessionManager.getBranch());
			ctx.ui.notify(
				active.length ? `Active pi-forget synthetic branches:\n\n${active.map(formatForgetMetadata).join("\n\n")}` : "No active pi-forget synthetic branches on this branch.",
				"info",
			);
		},
	});

	pi.registerCommand("unforget", {
		description: "Return to the original branch for a pi-forget synthetic branch: /unforget <forget-id>",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const forgetId = args.trim();
			if (!forgetId) {
				ctx.ui.notify("Usage: /unforget <forget-id>", "warning");
				return;
			}
			ctx.ui.notify(await unforget(ctx, forgetId), "info");
		},
	});
}

export const __test = {
	applyForget,
	buildForgetPlan,
	contentText,
	formatContextIndex,
	formatOutputCandidate,
	formatProjectedContext,
	formatTurnSummary,
	groupTurns,
	parseEntryTarget,
	parseOutputTarget,
	parseTurnTarget,
	projectContext,
	renderedItemText,
	summarizeItem,
};
