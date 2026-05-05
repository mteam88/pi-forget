import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const dir = mkdtempSync(join(tmpdir(), "pi-forget-rpc-"));
const sessionFile = join(dir, "session.jsonl");
const now = new Date().toISOString();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const entries = [
	{ type: "session", version: 3, id: "018f0000-0000-7000-8000-000000000000", timestamp: now, cwd: process.cwd() },
	{ type: "message", id: "aaa00001", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: "old irrelevant turn" }], timestamp: Date.now() } },
	{ type: "message", id: "aaa00002", parentId: "aaa00001", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "old answer" }], api: "test", provider: "google", model: "gemini-2.5-flash", usage, stopReason: "stop", timestamp: Date.now() } },
	{ type: "message", id: "aaa00003", parentId: "aaa00002", timestamp: now, message: { role: "user", content: [{ type: "text", text: "current useful turn" }], timestamp: Date.now() } },
	{ type: "message", id: "aaa00004", parentId: "aaa00003", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "current answer" }], api: "test", provider: "google", model: "gemini-2.5-flash", usage, stopReason: "stop", timestamp: Date.now() } },
];
writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

const child = spawn("pi", [
	"--mode", "rpc",
	"--offline",
	"--no-context-files",
	"--no-builtin-tools",
	"--extension", resolve("src/index.ts"),
	"--session", sessionFile,
], { stdio: ["pipe", "pipe", "pipe"] });

const events: any[] = [];
const stderr: string[] = [];
let buffer = "";
const decoder = new StringDecoder("utf8");
child.stdout.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const idx = buffer.indexOf("\n");
		if (idx === -1) break;
		const line = buffer.slice(0, idx).replace(/\r$/, "");
		buffer = buffer.slice(idx + 1);
		if (line.trim()) events.push(JSON.parse(line));
	}
});
child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

let nextId = 1;
function send(command: Record<string, unknown>): string {
	const id = `req-${nextId++}`;
	child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
	return id;
}

function waitForResponse(id: string, timeoutMs = 8000): Promise<any> {
	return new Promise((resolvePromise, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			const response = events.find((event) => event.type === "response" && event.id === id);
			if (response) {
				clearInterval(timer);
				resolvePromise(response);
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`Timed out waiting for ${id}. stderr=${stderr.join("")}; events=${JSON.stringify(events.slice(-5))}`));
			}
		}, 25);
	});
}

const stateId = send({ type: "get_state" });
const state = await waitForResponse(stateId);
assert.equal(state.success, true);

const forgetId = send({ type: "prompt", message: "/forget turn:1 obsolete" });
const forgetResponse = await waitForResponse(forgetId);
assert.equal(forgetResponse.success, true);

await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
let content = readFileSync(sessionFile, "utf8");
assert.match(content, /"customType":"pi-forget"/);
assert.match(content, /"kind":"forget"/);
assert.match(content, /"aaa00001"/);
assert.match(content, /"aaa00002"/);
const directiveId = content.match(/"directiveId":"([^"]+)"/)?.[1];
assert(directiveId, "directive id persisted");

const forgottenId = send({ type: "prompt", message: "/forgotten" });
const forgottenResponse = await waitForResponse(forgottenId);
assert.equal(forgottenResponse.success, true);

const unforgetId = send({ type: "prompt", message: `/unforget ${directiveId}` });
const unforgetResponse = await waitForResponse(unforgetId);
assert.equal(unforgetResponse.success, true);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
content = readFileSync(sessionFile, "utf8");
assert.match(content, /"kind":"unforget"/);

child.kill("SIGTERM");
console.log(`rpc smoke passed (${sessionFile})`);
