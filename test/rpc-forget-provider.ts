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

type ProviderLog = {
	call: number;
	hasMagic: boolean;
	hasReplacement: boolean;
	roles: string[];
	userTexts: string[];
	lastUserText: string | undefined;
};

function readProviderLogs(path: string): ProviderLog[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProviderLog);
}

const dir = mkdtempSync(join(tmpdir(), "pi-forget-verify-"));
const sessionFile = join(dir, "session.jsonl");
const providerLog = join(dir, "provider-context.jsonl");
const providerExt = join(dir, "debug-provider.ts");

writeFileSync(
	providerExt,
	`import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAssistantMessageEventStream, calculateCost, type AssistantMessage } from "@mariozechner/pi-ai";
import { appendFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	let call = 0;
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
			call++;
			const userTexts = context.messages
				.filter((message: any) => message.role === "user")
				.map((message: any) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("") : String(message.content ?? ""));
			appendFileSync(${JSON.stringify(providerLog)}, JSON.stringify({
				call,
				hasMagic: JSON.stringify(context).includes("MAGIC_SLOP_"),
				hasReplacement: JSON.stringify(context).includes("provider test replacement") || JSON.stringify(context).includes("[output forgotten by pi-forget:"),
				roles: context.messages.map((message: any) => message.role),
				userTexts,
				lastUserText: userTexts.at(-1),
			}) + "\\n");

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
				stopReason: call === 1 ? "toolUse" : "stop",
				timestamp: Date.now(),
			};

			queueMicrotask(() => {
				if (call === 1) {
					const toolCall = {
						type: "toolCall" as const,
						id: "forget-call-1",
						name: "forget",
						arguments: {
							targets: ["output:bash12345"],
							reason: "provider-driven forget test",
							replacement: "provider test replacement",
						},
					};
					output.content.push(toolCall);
					stream.push({ type: "start", partial: output });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
					output.usage.input = 1;
					output.usage.output = 1;
					output.usage.totalTokens = 2;
					calculateCost(model as any, output.usage);
					stream.push({ type: "done", reason: "toolUse", message: output });
					stream.end();
					return;
				}

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
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const entries = [
	{ type: "session", version: 3, id: "018f0000-0000-7000-8000-000000000000", timestamp: now, cwd: process.cwd() },
	{ type: "message", id: "u0000001", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: "before bash" }], timestamp: Date.now() } },
	{ type: "message", id: "a0000001", parentId: "u0000001", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "test", provider: "debug-provider", model: "debug", usage, stopReason: "stop", timestamp: Date.now() } },
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

function waitForResponse(id: string, timeoutMs = 12000): Promise<any> {
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

async function waitFor(predicate: () => boolean, timeoutMs = 12000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started <= timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`Timed out. stderr=${stderr.join("")}; events=${JSON.stringify(events.slice(-5))}`);
}

async function promptAndAssertLatest(message: string, expectedLogCount: number, options: { pruned: boolean; replacement: boolean }) {
	const promptId = send({ type: "prompt", message });
	const response = await waitForResponse(promptId);
	assert.equal(response.success, true);
	await waitFor(() => readProviderLogs(providerLog).length >= expectedLogCount);
	const log = readProviderLogs(providerLog).at(-1);
	assert(log, `missing provider log for ${message}`);
	assert.equal(log.lastUserText, message, `provider should answer latest prompt: ${message}`);
	assert.equal(log.userTexts.filter((text) => text === message).length, 1, `latest prompt should appear exactly once: ${message}`);
	assert.equal(log.hasMagic, !options.pruned, `magic output visibility mismatch for ${message}`);
	assert.equal(log.hasReplacement, options.replacement, `replacement visibility mismatch for ${message}`);
	return log;
}

try {
	const firstPromptId = send({ type: "prompt", message: "trigger tool-driven forget" });
	const firstPromptResponse = await waitForResponse(firstPromptId);
	assert.equal(firstPromptResponse.success, true);
	await waitFor(() => readProviderLogs(providerLog).length >= 2);

	let logs = readProviderLogs(providerLog);
	assert.equal(logs[0].hasMagic, true, "initial provider request should see original bulky output before forget");
	assert.equal(logs[0].lastUserText, "trigger tool-driven forget", "initial provider request should answer the submitted prompt");
	assert.equal(logs[1].hasMagic, false, "provider request immediately after forget tool result should be pruned");
	assert.equal(logs[1].hasReplacement, true, "provider request immediately after forget should contain replacement text");
	assert.equal(logs[1].lastUserText, "trigger tool-driven forget", "post-tool provider request should still be grounded in the same user prompt");

	await promptAndAssertLatest("second prompt after forget must stay pruned", 3, { pruned: true, replacement: true });

	const sessionContent = readFileSync(sessionFile, "utf8");
	const forgetId = sessionContent.match(/"forgetId":"([^"]+)"/)?.[1];
	assert(forgetId, "forget id persisted");

	const unforgetId = send({ type: "prompt", message: `/unforget ${forgetId}` });
	const unforgetResponse = await waitForResponse(unforgetId);
	assert.equal(unforgetResponse.success, true);

	await promptAndAssertLatest("after unforget original branch should expose original output", 4, { pruned: false, replacement: true });

	const commandForgetId = send({ type: "prompt", message: "/forget output:bash12345 command-driven refilter" });
	const commandForgetResponse = await waitForResponse(commandForgetId);
	assert.equal(commandForgetResponse.success, true);

	await promptAndAssertLatest("after command forget should be pruned again", 5, { pruned: true, replacement: true });
	await promptAndAssertLatest("rapid follow-up one on synthetic branch", 6, { pruned: true, replacement: true });
	await promptAndAssertLatest("rapid follow-up two on synthetic branch", 7, { pruned: true, replacement: true });

	const forgottenId = send({ type: "prompt", message: "/forgotten" });
	const forgottenResponse = await waitForResponse(forgottenId);
	assert.equal(forgottenResponse.success, true);
	assert.equal(readProviderLogs(providerLog).length, 7, "/forgotten should not trigger a provider request or disturb message ordering");

	await promptAndAssertLatest("after metadata-only command latest prompt still wins", 8, { pruned: true, replacement: true });

	console.log(`rpc provider redaction/tree navigation passed (${sessionFile})`);
} finally {
	child.kill("SIGTERM");
}
