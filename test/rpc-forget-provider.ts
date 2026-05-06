import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
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

const dir = mkdtempSync(join(tmpdir(), "pi-forget-verify-"));
const sessionFile = join(dir, "session.jsonl");
const providerLog = join(dir, "provider-context.json");
const providerExt = join(dir, "debug-provider.ts");

writeFileSync(
	providerExt,
	`import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAssistantMessageEventStream, calculateCost, type AssistantMessage } from "@mariozechner/pi-ai";
import { appendFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("debug-provider", {
		baseUrl: "http://debug.local",
		apiKey: "DEBUG_API_KEY",
		api: "openai-completions",
		models: [{
			id: "debug",
			name: "Debug",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 256,
		}],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				appendFileSync(${JSON.stringify(providerLog)}, JSON.stringify(context, null, 2));
				output.content.push({ type: "text", text: "ok" });
				stream.push({ type: "start", partial: output });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: output });
				output.usage.input = 1;
				output.usage.output = 1;
				output.usage.totalTokens = 2;
				calculateCost(model as any, output.usage);
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			});
			return stream;
		},
	});
}
`,
);

const now = new Date().toISOString();
const entries = [
	{ type: "session", version: 3, id: "018f0000-0000-7000-8000-000000000000", timestamp: now, cwd: process.cwd() },
	{ type: "message", id: "u0000001", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: "before bash" }], timestamp: Date.now() } },
	{ type: "message", id: "a0000001", parentId: "u0000001", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "test", provider: "debug-provider", model: "debug", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } },
	{ type: "message", id: "bash12345", parentId: "a0000001", timestamp: now, message: { role: "bashExecution", command: "python3 - <<'PY' ...", output: "MAGIC_SLOP_".repeat(4000), exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(), excludeFromContext: false } },
];
writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

const child = spawnPi([
	"--mode",
	"rpc",
	"--no-context-files",
	"--no-extensions",
	"--no-builtin-tools",
	"--extension",
	resolve("index.ts"),
	"--extension",
	providerExt,
	"--provider",
	"debug-provider",
	"--model",
	"debug",
	"--session",
	sessionFile,
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

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started <= timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`Timed out. stderr=${stderr.join("")}`);
}

const forgetId = send({ type: "prompt", message: `/forget output:bash12345 manual test` });
const forgetResponse = await waitForResponse(forgetId);
assert.equal(forgetResponse.success, true);

const promptId = send({ type: "prompt", message: "say ok" });
const promptResponse = await waitForResponse(promptId);
assert.equal(promptResponse.success, true);
await waitFor(() => existsSync(providerLog) && readFileSync(providerLog, "utf8").length > 0);

const providerContext = readFileSync(providerLog, "utf8");
const containsMagic = providerContext.includes("MAGIC_SLOP_");
const containsPlaceholder = providerContext.includes("[output forgotten by pi-forget:");
assert.equal(containsMagic, false);
assert.equal(containsPlaceholder, true);

child.kill("SIGTERM");
console.log(`rpc provider redaction passed (${sessionFile})`);
