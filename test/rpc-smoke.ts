import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

function spawnPi(args: string[]) {
	if (process.env.PI_BIN) {
		return spawn(process.env.PI_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
	}

	const sourceCli = resolve("pi-mono/packages/coding-agent/src/cli.ts");
	const tsxBin = resolve("pi-mono/node_modules/.bin/tsx");
	if (existsSync(sourceCli) && existsSync(tsxBin)) {
		return spawn(tsxBin, ["packages/coding-agent/src/cli.ts", ...args], {
			cwd: resolve("pi-mono"),
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	return spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"] });
}

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

const child = spawnPi([
	"--mode", "rpc",
	"--offline",
	"--no-context-files",
	"--no-builtin-tools",
	"--no-extensions",
	"--extension", resolve("index.ts"),
	"--session", sessionFile,
]);

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

const forgetRequestId = send({ type: "prompt", message: "/forget turn:1 obsolete" });
const forgetResponse = await waitForResponse(forgetRequestId);
assert.equal(forgetResponse.success, true);

await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
let content = readFileSync(sessionFile, "utf8");
assert.doesNotMatch(content, /"type":"context_rewrite"/);
assert.match(content, /"type":"custom_message"/);
assert.match(content, /"customType":"pi-forget"/);
assert.match(content, /"content":"\[context forgotten by pi-forget: turn:1\]"/);
assert.match(content, /"kind":"synthetic_branch"/);
const forgetId = content.match(/"forgetId":"([^"]+)"/)?.[1];
assert(forgetId, "forget id persisted");

const forgottenId = send({ type: "prompt", message: "/forgotten" });
const forgottenResponse = await waitForResponse(forgottenId);
assert.equal(forgottenResponse.success, true);

const unforgetRequestId = send({ type: "prompt", message: `/unforget ${forgetId}` });
const unforgetResponse = await waitForResponse(unforgetRequestId);
assert.equal(unforgetResponse.success, true);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
content = readFileSync(sessionFile, "utf8");
assert.doesNotMatch(content, /"type":"context_rewrite_undo"/);

child.kill("SIGTERM");
console.log(`rpc smoke passed (${sessionFile})`);
