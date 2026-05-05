import assert from "node:assert/strict";
import { buildSessionContext, SessionManager } from "@mariozechner/pi-coding-agent";
import { __test } from "../src/index.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): any {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistant(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResult(name: string, text: string): any {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function roles(messages: any[]): string[] {
	return messages.map((message) => message.role);
}

{
	const sm = SessionManager.inMemory(process.cwd());
	sm.appendMessage(user("one"));
	sm.appendMessage(assistant("two"));
	sm.appendMessage(user("three"));
	sm.appendMessage(assistant("four"));
	const projected = __test.projectContext(sm as any);
	const canonical = sm.buildSessionContext();
	assert.deepEqual(roles(projected.items.map((item) => item.message)), roles(canonical.messages));
	assert.equal(projected.turns.length, 2);
	assert.deepEqual(projected.turns.map((turn) => turn.number), [1, 2]);
}

{
	const sm = SessionManager.inMemory(process.cwd());
	sm.appendCustomMessageEntry("test-custom", "preface", false);
	sm.appendMessage(user("one"));
	sm.appendMessage(assistant("two"));
	sm.appendMessage(toolResult("read", "file contents"));
	const projected = __test.projectContext(sm as any);
	const canonical = sm.buildSessionContext();
	assert.deepEqual(roles(projected.items.map((item) => item.message)), roles(canonical.messages));
	assert.equal(projected.prelude.length, 1);
	assert.equal(projected.turns.length, 1);
	assert.equal(projected.turns[0]?.entryIds.length, 3);
}

{
	const sm = SessionManager.inMemory(process.cwd());
	const u1 = sm.appendMessage(user("old user"));
	sm.appendMessage(assistant("old assistant"));
	const kept = sm.appendMessage(user("kept user"));
	sm.appendMessage(assistant("kept assistant"));
	sm.appendCompaction("summary", kept, 100);
	sm.appendMessage(user("new user"));
	sm.appendMessage(assistant("new assistant"));
	const projected = __test.projectContext(sm as any);
	const canonical = sm.buildSessionContext();
	assert.deepEqual(roles(projected.items.map((item) => item.message)), roles(canonical.messages));
	assert.equal(projected.items[0]?.entryType, "compaction");
	assert(projected.compactedAwayEntryIds.has(u1));
	assert.equal(projected.turns.length, 2);
}

{
	assert.equal(__test.parseTurnTarget("turn:12"), 12);
	assert.equal(__test.parseTurnTarget("range:a..b"), undefined);
	assert.equal(__test.parseTurnTarget("abc123"), undefined);
	assert.equal(__test.parseEntryTarget("entry:abc12345"), "abc12345");
	assert.equal(__test.parseEntryTarget("abc12345"), "abc12345");
	assert.equal(__test.parseOutputTarget("output:abc12345"), "abc12345");
}

{
	const redacted = __test.redactOutput(toolResult("bash", "secret output"), "abc12345") as any;
	assert.equal(redacted.role, "toolResult");
	assert.equal(redacted.toolName, "bash");
	assert.match(redacted.content[0].text, /output forgotten/);
}

{
	const sm = SessionManager.inMemory(process.cwd());
	const first = sm.appendMessage(user("one"));
	sm.appendMessage(assistant("two"));
	const projected = __test.projectContext(sm as any);
	const extra = user("in-flight");
	const result = __test.filterWithProjection([...projected.items.map((item: any) => item.message), extra], projected.items, new Set([first]));
	assert.equal(result.aligned, false);
	assert.deepEqual(roles(result.messages), ["assistant", "user"]);
}

{
	const sm = SessionManager.inMemory(process.cwd());
	sm.appendMessage(user("run tool"));
	sm.appendMessage(assistant("calling"));
	const toolId = sm.appendMessage(toolResult("bash", "very secret output"));
	const projected = __test.projectContext(sm as any);
	const result = __test.filterWithProjection(projected.items.map((item: any) => item.message), projected.items, new Set(), new Set([toolId]));
	assert.equal(result.aligned, true);
	assert.equal(roles(result.messages).join(","), "user,assistant,toolResult");
	assert.match((result.messages[2] as any).content[0].text, /output forgotten/);
}

console.log("projector tests passed");
