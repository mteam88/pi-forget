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

	const idlePromptId = send({ type: "prompt", message: "second prompt after forget must stay pruned" });
	const idlePromptResponse = await waitForResponse(idlePromptId);
	assert.equal(idlePromptResponse.success, true);
	await waitFor(() => readProviderLogs(providerLog).length >= 3);
	logs = readProviderLogs(providerLog);
	assert.equal(logs[2].hasMagic, false, "later provider requests on the synthetic branch must stay pruned");
	assert.equal(logs[2].hasReplacement, true, "later provider requests should still use synthetic branch projection");
	assert.equal(logs[2].lastUserText, "second prompt after forget must stay pruned", "provider should answer the latest prompt after synthetic branch navigation");
	assert.equal(logs[2].userTexts.filter((text) => text === "second prompt after forget must stay pruned").length, 1, "latest prompt should not be duplicated after synthetic branch navigation");

	const sessionContent = readFileSync(sessionFile, "utf8");
	const forgetId = sessionContent.match(/"forgetId":"([^"]+)"/)?.[1];
	assert(forgetId, "forget id persisted");

	const unforgetId = send({ type: "prompt", message: `/unforget ${forgetId}` });
	const unforgetResponse = await waitForResponse(unforgetId);
	assert.equal(unforgetResponse.success, true);

	const originalBranchPromptId = send({ type: "prompt", message: "after unforget original branch should expose original output" });
	const originalBranchPromptResponse = await waitForResponse(originalBranchPromptId);
	assert.equal(originalBranchPromptResponse.success, true);
	await waitFor(() => readProviderLogs(providerLog).length >= 4);
	logs = readProviderLogs(providerLog);
	assert.equal(logs[3].hasMagic, true, "unforget/tree navigation back to original branch should expose original context");
	assert.equal(logs[3].lastUserText, "after unforget original branch should expose original output", "provider should answer the latest prompt after unforget tree navigation");

	const commandForgetId = send({ type: "prompt", message: "/forget output:bash12345 command-driven refilter" });
	const commandForgetResponse = await waitForResponse(commandForgetId);
	assert.equal(commandForgetResponse.success, true);

	const refilteredPromptId = send({ type: "prompt", message: "after command forget should be pruned again" });
	const refilteredPromptResponse = await waitForResponse(refilteredPromptId);
	assert.equal(refilteredPromptResponse.success, true);
	await waitFor(() => readProviderLogs(providerLog).length >= 5);
	logs = readProviderLogs(providerLog);
	assert.equal(logs[4].hasMagic, false, "command forget after tree navigation should prune provider context");
	assert.equal(logs[4].hasReplacement, true, "command forget after tree navigation should use synthetic projection");
	assert.equal(logs[4].lastUserText, "after command forget should be pruned again", "provider should answer the latest prompt after command forget navigation");
	assert.equal(logs[4].userTexts.filter((text) => text === "after command forget should be pruned again").length, 1, "latest prompt should not be duplicated after command forget navigation");

	console.log(`rpc provider redaction/tree navigation passed (${sessionFile})`);
} finally {
	child.kill("SIGTERM");
}
