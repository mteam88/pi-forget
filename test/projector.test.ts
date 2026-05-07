import assert from "node:assert/strict";
import { __test } from "../src/index.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp = Date.now()): any {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp = Date.now()): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function bash(command: string, output: string, timestamp = Date.now()): any {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp,
	};
}

function makeCtx(items: any[], activeRewrites: any[] = []): any {
	return {
		sessionManager: {
			buildSessionProjection: () => ({ items, activeRewrites }),
		},
	};
}

function makePi(): any {
	const rewrites: any[] = [];
	const undos: string[] = [];
	return {
		rewrites,
		undos,
		appendContextRewrite(rewrite: any) {
			rewrites.push(rewrite);
			return `entry-${rewrites.length}`;
		},
		undoContextRewrite(rewriteId: string) {
			undos.push(rewriteId);
			return `undo-${undos.length}`;
		},
	};
}

{
	assert.equal(__test.parseTurnTarget("turn:12"), 12);
	assert.equal(__test.parseTurnTarget("range:a..b"), undefined);
	assert.equal(__test.parseEntryTarget("entry:abc12345"), "abc12345");
	assert.equal(__test.parseEntryTarget("abc12345"), "abc12345");
	assert.equal(__test.parseOutputTarget("output:abc12345"), "abc12345");
	assert.match(__test.hashContextText("hello"), /^sha256:[a-f0-9]{64}$/);
}

{
	const items = [
		{ entryId: "u1", sourceEntryIds: ["u1"], message: user("old") },
		{ entryId: "a1", sourceEntryIds: ["a1"], message: assistant("old answer") },
		{ entryId: "u2", sourceEntryIds: ["u2"], message: user("current") },
	];
	const { prelude, turns } = __test.groupTurns(items as any);
	assert.equal(prelude.length, 0);
	assert.deepEqual(turns.map((turn: any) => turn.number), [1, 2]);
	assert.equal(turns[0].entryIds.join(","), "u1,a1");
}

{
	const ctx = makeCtx([
		{ entryId: "u1", sourceEntryIds: ["u1"], message: user("old") },
		{ entryId: "a1", sourceEntryIds: ["a1"], message: assistant("old answer") },
		{ entryId: "bash12345", sourceEntryIds: ["bash12345"], message: bash("printf secret", "SECRET OUTPUT") },
		{ entryId: "u2", sourceEntryIds: ["u2"], message: user("current") },
	]);

	const summary = __test.formatContextIndex(ctx, "recent", 12, "summary");
	assert.match(summary, /turn:1  user: "old"  3 entries, 13 output chars/);
	assert.match(summary, /Largest forgettable outputs:/);
	assert.match(summary, /output:bash12345/);
	assert.doesNotMatch(summary, /assistant a1:/);

	const entries = __test.formatContextIndex(ctx, "recent", 12, "entries", 1);
	assert.match(entries, /assistant a1: text/);
	assert.match(entries, /bashExecution bash12345:/);

	const outputs = __test.formatContextIndex(ctx, "recent", 12, "outputs", 1);
	assert.match(outputs, /output:bash12345/);
	assert.match(outputs, /Apply with:/);
	assert.match(outputs, /forget\(\{ targets: \["output:bash12345"\]/);
	assert.doesNotMatch(outputs, /turn:1  user/);

	const filtered = __test.formatContextIndex(ctx, "recent", 12, "outputs", undefined, { minChars: 20 });
	assert.match(filtered, /No forgettable outputs/);
}

{
	const pi = makePi();
	const ctx = makeCtx([
		{ entryId: "u1", sourceEntryIds: ["u1"], message: user("old") },
		{ entryId: "a1", sourceEntryIds: ["a1"], message: assistant("old answer") },
		{ entryId: "u2", sourceEntryIds: ["u2"], message: user("current") },
	]);
	const result = __test.createForgetDirective(pi, ctx, ["turn:1"], "obsolete", "[summary: old work completed]");
	assert.match(result.text, /Applied context rewrite/);
	assert.equal(pi.rewrites.length, 1);
	assert.deepEqual(pi.rewrites[0].target, { kind: "range", fromEntryId: "u1", toEntryId: "a1" });
	assert.equal(pi.rewrites[0].after, "[summary: old work completed]");
	assert.equal(pi.rewrites[0].reason, "obsolete");
	assert.match(pi.rewrites[0].beforeHash, /^sha256:/);
}

{
	const pi = makePi();
	const ctx = makeCtx([
		{ entryId: "u1", sourceEntryIds: ["u1"], message: user("current") },
	]);
	const result = __test.createForgetDirective(pi, ctx, ["turn:1"]);
	assert.match(result.text, /Refusing to forget/);
	assert.equal(pi.rewrites.length, 0);
}

{
	const pi = makePi();
	const ctx = makeCtx([
		{ entryId: "u1", sourceEntryIds: ["u1"], message: user("run command") },
		{ entryId: "bash12345", sourceEntryIds: ["bash12345"], message: bash("printf secret", "SECRET OUTPUT") },
		{ entryId: "u2", sourceEntryIds: ["u2"], message: user("current") },
	]);
	const result = __test.createForgetDirective(pi, ctx, ["output:bash12345"], "large");
	assert.match(result.text, /output:bash12345/);
	assert.equal(pi.rewrites.length, 1);
	assert.deepEqual(pi.rewrites[0].target, { kind: "surface", entryId: "bash12345", surface: "output" });
	assert.equal(pi.rewrites[0].after, "[output forgotten by pi-forget: bash12345]");
	assert.equal(pi.rewrites[0].beforeHash, __test.hashContextText("SECRET OUTPUT"));
}

{
	const pi = makePi();
	const ctx = makeCtx([
		{ entryId: "u1", sourceEntryIds: ["u1"], message: user("secret context") },
		{ entryId: "u2", sourceEntryIds: ["u2"], message: user("current") },
	]);
	const result = __test.createForgetDirective(pi, ctx, ["entry:u1"]);
	assert.match(result.text, /entry:u1/);
	assert.equal(pi.rewrites.length, 1);
	assert.deepEqual(pi.rewrites[0].target, { kind: "surface", entryId: "u1", surface: "rendered" });
	assert.equal(pi.rewrites[0].after, "[entry forgotten by pi-forget: u1]");
}

console.log("pi-forget core rewrite tests passed");
