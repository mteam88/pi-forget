import assert from "node:assert/strict";
import { SessionManager } from "@mariozechner/pi-coding-agent";
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

function makeSession(): SessionManager {
	return SessionManager.inMemory(process.cwd());
}

function makeCtx(sm: SessionManager): any {
	return { sessionManager: sm };
}

{
	assert.equal(__test.parseTurnTarget("turn:12"), 12);
	assert.equal(__test.parseTurnTarget("range:a..b"), undefined);
	assert.equal(__test.parseEntryTarget("entry:abc12345"), "abc12345");
	assert.equal(__test.parseEntryTarget("abc12345"), "abc12345");
	assert.equal(__test.parseOutputTarget("output:abc12345"), "abc12345");
}

{
	const sm = makeSession();
	const u1 = sm.appendMessage(user("old"));
	const a1 = sm.appendMessage(assistant("old answer"));
	sm.appendMessage(user("current"));
	const items = __test.projectContext(makeCtx(sm)).items;
	const { prelude, turns } = __test.groupTurns(items as any);
	assert.equal(prelude.length, 0);
	assert.deepEqual(turns.map((turn: any) => turn.number), [1, 2]);
	assert.equal(turns[0].entryIds.join(","), `${u1},${a1}`);
}

{
	const sm = makeSession();
	sm.appendMessage(user("old"));
	sm.appendMessage(assistant("old answer"));
	const bashId = sm.appendMessage(bash("printf secret", "SECRET OUTPUT"));
	sm.appendMessage(user("current"));
	const ctx = makeCtx(sm);

	const summary = __test.formatContextIndex(ctx, "recent", 12, "summary");
	assert.match(summary, /turn:1  user: "old"  3 entries, 13 output chars/);
	assert.match(summary, /Largest forgettable outputs:/);
	assert.match(summary, new RegExp(`output:${bashId}`));
	assert.doesNotMatch(summary, /assistant .*old answer/);

	const entries = __test.formatContextIndex(ctx, "recent", 12, "entries", 1);
	assert.match(entries, /assistant .*: text/);
	assert.match(entries, /bashExecution .*:/);

	const outputs = __test.formatContextIndex(ctx, "recent", 12, "outputs", 1);
	assert.match(outputs, /Large output targets, grouped by where they appear in the conversation:/);
	assert.match(outputs, new RegExp(`output:${bashId}`));
	assert.match(outputs, /turn:1  user/);

	const filtered = __test.formatContextIndex(ctx, "recent", 12, "outputs", undefined, { minChars: 20 });
	assert.match(filtered, /No output targets found/);
}

{
	const sm = makeSession();
	sm.appendMessage(user("old"));
	const bashId = sm.appendMessage(bash("printf big", "PRELUDE OUTPUT"));
	sm.appendMessage(user("kept turn"));
	sm.appendMessage(assistant("kept answer"));
	sm.appendCompaction("summary", bashId, 1000);
	const ctx = makeCtx(sm);

	const summary = __test.formatContextIndex(ctx, "recent", 12, "summary");
	assert.match(summary, /prelude  2 entries, 14 output chars/);
	assert.match(summary, new RegExp(`output:${bashId}  prelude, bashExecution`));

	const outputs = __test.formatContextIndex(ctx, "recent", 12, "outputs");
	assert.match(outputs, /prelude  2 entries, 14 output chars/);
	assert.match(outputs, new RegExp(`output:${bashId}  bashExecution`));
}

{
	const sm = makeSession();
	sm.appendMessage(user("old"));
	sm.appendMessage(assistant("old answer"));
	sm.appendMessage(user("current"));
	const result = __test.applyForget(makeCtx(sm), ["turn:1"], "obsolete", "[summary: old work completed]");
	assert.match(result.text, /Created synthetic pi-forget branch/);
	const context = sm.buildSessionContext();
	const serialized = JSON.stringify(context.messages);
	assert.doesNotMatch(serialized, /old answer/);
	assert.match(serialized, /\[summary: old work completed\]/);
	assert.match(JSON.stringify(sm.getBranch()), /"customType":"pi-forget"/);
}

{
	const sm = makeSession();
	sm.appendMessage(user("current"));
	const result = __test.applyForget(makeCtx(sm), ["turn:1"]);
	assert.match(result.text, /Refusing to forget/);
	assert.equal(sm.getBranch().length, 1);
}

{
	const sm = makeSession();
	sm.appendMessage(user("run command"));
	const bashId = sm.appendMessage(bash("printf secret", "SECRET OUTPUT"));
	sm.appendMessage(user("current"));
	const result = __test.applyForget(makeCtx(sm), [`output:${bashId}`], "large");
	assert.match(result.text, new RegExp(`output:${bashId}`));
	const serialized = JSON.stringify(sm.buildSessionContext().messages);
	assert.doesNotMatch(serialized, /SECRET OUTPUT/);
	assert.match(serialized, new RegExp(`\\[output forgotten by pi-forget: ${bashId}\\]`));
}

{
	const sm = makeSession();
	sm.appendMessage(user("run commands"));
	const first = sm.appendMessage(bash("printf first", "FIRST RAW"));
	const second = sm.appendMessage(bash("printf second", "SECOND RAW"));
	sm.appendMessage(user("current"));
	const result = __test.applyForget(makeCtx(sm), [`output:${first}`, `output:${second}`], "large", undefined, {
		[`output:${first}`]: "First output summary",
		[second]: "Second output summary",
	});
	assert.match(result.text, new RegExp(`output:${first}`));
	const serialized = JSON.stringify(sm.buildSessionContext().messages);
	assert.doesNotMatch(serialized, /FIRST RAW/);
	assert.doesNotMatch(serialized, /SECOND RAW/);
	assert.match(serialized, /First output summary/);
	assert.match(serialized, /Second output summary/);
}

{
	const sm = makeSession();
	sm.appendMessage(user("run commands"));
	const first = sm.appendMessage(bash("printf first", "FIRST RAW"));
	const second = sm.appendMessage(bash("printf second", "SECOND RAW"));
	sm.appendMessage(user("current"));
	__test.applyForget(makeCtx(sm), [`output:${first}`], "large", "First output summary");
	const result = __test.applyForget(makeCtx(sm), [`output:${second}`], "large", "Second output summary");
	assert.match(result.text, new RegExp(`output:${second}`));
	const serialized = JSON.stringify(sm.buildSessionContext().messages);
	assert.doesNotMatch(serialized, /FIRST RAW/);
	assert.doesNotMatch(serialized, /SECOND RAW/);
	assert.match(serialized, /First output summary/);
	assert.match(serialized, /Second output summary/);
}

{
	const sm = makeSession();
	const u1 = sm.appendMessage(user("secret context"));
	sm.appendMessage(user("current"));
	const result = __test.applyForget(makeCtx(sm), [`entry:${u1}`]);
	assert.match(result.text, new RegExp(`entry:${u1}`));
	const serialized = JSON.stringify(sm.buildSessionContext().messages);
	assert.doesNotMatch(serialized, /secret context/);
	assert.match(serialized, new RegExp(`\\[entry forgotten by pi-forget: ${u1}\\]`));
}

console.log("pi-forget synthetic branch tests passed");
