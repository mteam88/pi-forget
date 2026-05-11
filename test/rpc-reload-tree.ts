import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

function spawnPi(args: string[]) {
	if (process.env.PI_BIN) return spawn(process.env.PI_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });

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

type RpcHarness = {
	child: ChildProcessWithoutNullStreams;
	events: any[];
	stderr: string[];
	send(command: Record<string, unknown>): string;
	waitForResponse(id: string, timeoutMs?: number): Promise<any>;
	waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
	stop(): void;
};

function startRpc(sessionFile: string, providerExt: string, providerLog: string): RpcHarness {
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
		"reload-debug-provider",
		"--model",
		"debug",
		"--session",
		sessionFile,
	]);

	const events: any[] = [];
	const stderr: string[] = [];
	let buffer = "";
	let nextId = 1;
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

	return {
		child,
		events,
		stderr,
		send(command: Record<string, unknown>): string {
			const id = `req-${nextId++}`;
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			return id;
		},
		waitForResponse(id: string, timeoutMs = 12000): Promise<any> {
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
		},
		async waitFor(predicate: () => boolean, timeoutMs = 12000): Promise<void> {
			const started = Date.now();
			while (Date.now() - started <= timeoutMs) {
				if (predicate()) return;
				await new Promise((r) => setTimeout(r, 25));
			}
			throw new Error(`Timed out. stderr=${stderr.join("")}; events=${JSON.stringify(events.slice(-5))}; providerLog=${existsSync(providerLog) ? readFileSync(providerLog, "utf8") : ""}`);
		},
		stop() {
			child.kill("SIGTERM");
		},
	};
}

type ProviderLog = { hasMagic: boolean; hasReplacement: boolean; messageCount: number };
function readProviderLogs(path: string): ProviderLog[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProviderLog);
}

const dir = mkdtempSync(join(tmpdir(), "pi-forget-reload-tree-"));
const sessionFile = join(dir, "session.jsonl");
const providerExt = join(dir, "reload-debug-provider.ts");
const providerLog = join(dir, "provider.jsonl");

writeFileSync(
	providerExt,
	`import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAssistantMessageEventStream, calculateCost, type AssistantMessage } from "@mariozechner/pi-ai";
import { appendFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("reload-debug-provider", {
		baseUrl: "http://debug.local",
		apiKey: "DEBUG_API_KEY",
		api: "openai-completions",
		models: [{ id: "debug", name: "Debug", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 256 }],
		streamSimple(model, context) {
			appendFileSync(${JSON.stringify(providerLog)}, JSON.stringify({
				hasMagic: JSON.stringify(context).includes("MAGIC_RELOAD_SLOP_"),
				hasReplacement: JSON.stringify(context).includes("reload replacement") || JSON.stringify(context).includes("[output forgotten by pi-forget:"),
				messageCount: context.messages.length,
			}) + "\\n");
			const stream = createAssistantMessageEventStream();
			const output: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: output });
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
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const entries = [
	{ type: "session", version: 3, id: "018f0000-0000-7000-8000-000000000001", timestamp: now, cwd: process.cwd() },
	{ type: "message", id: "user0001", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: "seed" }], timestamp: Date.now() } },
	{ type: "message", id: "asst0001", parentId: "user0001", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "seeded" }], api: "test", provider: "reload-debug-provider", model: "debug", usage, stopReason: "stop", timestamp: Date.now() } },
	{ type: "message", id: "bashreload", parentId: "asst0001", timestamp: now, message: { role: "bashExecution", command: "head -c50000 /dev/urandom", output: "MAGIC_RELOAD_SLOP_".repeat(4000), exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(), excludeFromContext: false } },
];
writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

let rpc = startRpc(sessionFile, providerExt, providerLog);
try {
	let id = rpc.send({ type: "prompt", message: "/forget output:bashreload reload replacement" });
	let response = await rpc.waitForResponse(id);
	assert.equal(response.success, true);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
} finally {
	rpc.stop();
}

let content = readFileSync(sessionFile, "utf8");
const firstForgetId = content.match(/"forgetId":"([^"]+)"/)?.[1];
assert(firstForgetId, "forget id should persist before restart");
assert.match(content, /"type":"label"/, "command forget should have appended labels before restart");

rpc = startRpc(sessionFile, providerExt, providerLog);
try {
	let id = rpc.send({ type: "prompt", message: "after restart synthetic branch must remain pruned" });
	let response = await rpc.waitForResponse(id);
	assert.equal(response.success, true);
	await rpc.waitFor(() => readProviderLogs(providerLog).length >= 1);
	let logs = readProviderLogs(providerLog);
	assert.equal(logs.at(-1)?.hasMagic, false, "restart on a labeled synthetic branch should not reintroduce bulky output");
	assert.equal(logs.at(-1)?.hasReplacement, true, "restart should preserve synthetic replacement in provider context");

	id = rpc.send({ type: "prompt", message: `/unforget ${firstForgetId}` });
	response = await rpc.waitForResponse(id);
	assert.equal(response.success, true);

	id = rpc.send({ type: "prompt", message: "after unforget original branch should be visible" });
	response = await rpc.waitForResponse(id);
	assert.equal(response.success, true);
	await rpc.waitFor(() => readProviderLogs(providerLog).length >= 2);
	logs = readProviderLogs(providerLog);
	assert.equal(logs.at(-1)?.hasMagic, true, "unforget after restart should navigate back to the original branch");

	id = rpc.send({ type: "prompt", message: "/forget output:bashreload reload replacement" });
	response = await rpc.waitForResponse(id);
	assert.equal(response.success, true);

	id = rpc.send({ type: "prompt", message: "second synthetic branch after unforget should be pruned" });
	response = await rpc.waitForResponse(id);
	assert.equal(response.success, true);
	await rpc.waitFor(() => readProviderLogs(providerLog).length >= 3);
	logs = readProviderLogs(providerLog);
	assert.equal(logs.at(-1)?.hasMagic, false, "second forget after tree navigation should prune provider context");
	assert.equal(logs.at(-1)?.hasReplacement, true, "second forget after tree navigation should preserve replacement");
} finally {
	rpc.stop();
}

console.log(`rpc reload/tree navigation passed (${sessionFile})`);
