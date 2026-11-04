import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import barkExtension from "../extensions/bark.ts";
import { parseServerUrl } from "../src/config.ts";

type Command = (args: string, ctx: TestContext) => Promise<void>;
type Handler = (event: unknown, ctx: TestContext) => unknown;
type Tool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

type HarnessOptions = {
	fetch: typeof fetch;
	copy?: (text: string) => Promise<void>;
	sessionName?: string;
	sessionId?: string;
	waitingDelayMs?: number;
};

type TestContext = {
	cwd: string;
	mode: string;
	hasUI: boolean;
	isIdle(): boolean;
	sessionManager: {
		buildContextEntries(): SessionEntry[];
		getSessionId(): string;
	};
	ui: {
		notify(message: string, type?: string): void;
		custom(factory: PanelFactory, options?: unknown): Promise<void>;
	};
};

/** What the extension builds for `ui.custom`; the panel is driven directly in tests. */
type PanelComponent = { handleInput?(data: string): void; render(width: number): string[] };
type PanelFactory = (
	tui: { requestRender(): void; setWidget?: unknown },
	theme: { fg(color: string, text: string): string },
	keybindings: unknown,
	done: (result: void) => void,
) => PanelComponent;

function assistantEntry(text: string, stopReason = "stop"): SessionEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "assistant", content: [{ type: "text", text }], stopReason },
	} as SessionEntry;
}

function subscription(...events: string[]): SessionEntry {
	return {
		type: "custom",
		customType: "pi-bark",
		data: { events },
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
	} as SessionEntry;
}

// Pi resolves config from the agent dir, so every harness owns a temporary directory and never touches real config.
function harness(
	t: { mock: { method(object: object, name: string, implementation: unknown): void }; after(fn: () => void): void },
	options: HarnessOptions,
) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});
	t.mock.method(globalThis, "fetch", options.fetch);
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const entries: SessionEntry[] = [];
	const pi = {
		registerCommand(name: string, command: { handler: Command }) {
			commands.set(name, command.handler);
		},
		on(name: string, handler: Handler) {
			const previous = handlers.get(name);
			handlers.set(
				name,
				previous
					? (event, ctx) => {
							previous(event, ctx);
							handler(event, ctx);
						}
					: handler,
			);
		},
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({
				type: "custom",
				customType,
				data,
				id: crypto.randomUUID(),
				parentId: null,
				timestamp: new Date().toISOString(),
			} as SessionEntry);
		},
		getSessionName: () => options.sessionName,
	} as unknown as ExtensionAPI;
	barkExtension(pi, { copy: options.copy ?? (async () => {}), waitingDelayMs: options.waitingDelayMs });
	const panel: { component?: PanelComponent } = {};
	const custom = async (factory: PanelFactory): Promise<void> =>
		await new Promise<void>((resolve) => {
			panel.component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, () => resolve());
		});
	return { agentDir, commands, handlers, tools, entries, panel, custom };
}

function context(
	agentDir: string,
	overrides: Partial<TestContext> & {
		notify?: (message: string) => void;
		contextEntries?: SessionEntry[];
		custom?: (factory: PanelFactory) => Promise<void>;
	} = {},
): TestContext {
	const { notify, contextEntries, custom, ...rest } = overrides;
	return {
		cwd: join(agentDir, "project"),
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			buildContextEntries: () => contextEntries ?? [],
			getSessionId: () => "abcdef123456",
		},
		ui: { notify: notify ?? (() => {}), custom: custom ?? (async () => {}) },
		...rest,
	};
}

function configPath(agentDir: string): string {
	return join(agentDir, "config", "pi-bark", "config.json");
}

function runKeyGenerator(agentDir: string, ...args: string[]) {
	const script = join(import.meta.dirname, "..", "dist", "scripts", "generate-encryption-key.js");
	return spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
}

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
}

test("server URLs preserve HTTP(S) paths and reject raw query or fragment delimiters", () => {
	assert.equal(parseServerUrl("http://push.example.com/bark/"), "http://push.example.com/bark");
	for (const url of [
		"https://push.example.com/bark?",
		"https://push.example.com/bark#",
		"https://push.example.com/bark?token=value",
		"https://push.example.com/bark#section",
	]) {
		assert.throws(() => parseServerUrl(url), /must not include a query or fragment/);
	}
});

test("built key generator stores, protects, replaces, and disables Bark push encryption", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bark-key-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const path = configPath(agentDir);

	const generated = runKeyGenerator(agentDir);
	assert.equal(generated.status, 0, generated.stderr);
	const firstKey = generated.stdout.match(/^Key: (.+)$/m)?.[1];
	assert.equal(firstKey?.length, 32);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		bark: {
			serverUrl: "https://api.day.app",
			deviceKey: null,
			encryption: { algorithm: "AES256", mode: "GCM", padding: "noPadding", key: firstKey },
		},
	});

	const protectedRun = runKeyGenerator(agentDir);
	assert.equal(protectedRun.status, 1);
	assert.match(protectedRun.stderr, /already exists/);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).bark.encryption.key, firstKey);

	const replaced = runKeyGenerator(agentDir, "--force");
	assert.equal(replaced.status, 0, replaced.stderr);
	const replacementKey = replaced.stdout.match(/^Key: (.+)$/m)?.[1];
	assert.equal(replacementKey?.length, 32);
	assert.notEqual(replacementKey, firstKey);

	const disabled = runKeyGenerator(agentDir, "--disable");
	assert.equal(disabled.status, 0, disabled.stderr);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).bark.encryption, null);

	const invalid = `${JSON.stringify({ bark: { serverUrl: "https://api.day.app", deviceKey: "device-key", encryption: { key: "short" } } })}\n`;
	writeFileSync(path, invalid);
	const blocked = runKeyGenerator(agentDir);
	assert.equal(blocked.status, 1);
	assert.match(blocked.stderr, /encryption: expected AES256/);
	assert.equal(readFileSync(path, "utf8"), invalid);

	// A missing Device Key is reported and never silently written as null.
	const noDeviceKey = `${JSON.stringify({ bark: { serverUrl: "https://api.day.app", encryption: null } })}\n`;
	writeFileSync(path, noDeviceKey);
	const keptDeviceKey = runKeyGenerator(agentDir, "--force");
	assert.equal(keptDeviceKey.status, 1);
	assert.match(keptDeviceKey.stderr, /Fix the Bark config at .* first: bark\.deviceKey: required/);
	assert.equal(readFileSync(path, "utf8"), noDeviceKey);

	// A write never drops a missing safety setting that the command does not set.
	const noServer = `${JSON.stringify({ bark: { deviceKey: "device-key", encryption: null } })}\n`;
	writeFileSync(path, noServer);
	const keptServer = runKeyGenerator(agentDir, "--disable");
	assert.equal(keptServer.status, 1);
	assert.match(keptServer.stderr, /bark\.serverUrl: required/);
	assert.equal(readFileSync(path, "utf8"), noServer);

	writeFileSync(path, invalid);
	const repaired = runKeyGenerator(agentDir, "--force");
	assert.equal(repaired.status, 0, repaired.stderr);
	const repairedConfig = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(repairedConfig.bark.deviceKey, "device-key");
	assert.equal(repairedConfig.bark.encryption.key, repaired.stdout.match(/^Key: (.+)$/m)?.[1]);
});

test("/set-bark writes the bark block and /copyb copies then posts the exact text", async (t) => {
	const events: string[] = [];
	let request: { url: string; init?: RequestInit } | undefined;
	const { agentDir, commands } = harness(t, {
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			events.push("fetch");
			request = { url: String(input), init };
			return new Response('{"code":200,"message":"success"}', { status: 200 });
		}) as typeof fetch,
		copy: async (text) => {
			events.push(`copy:${text}`);
		},
	});
	const notices: string[] = [];
	const text = "# Done\n\n- kept exactly\n- including `format`";
	const ctx = context(agentDir, {
		notify: (message) => notices.push(message),
		contextEntries: [assistantEntry("  # Done\n\n- kept exactly\n- including `format`  ")],
	});

	await commands.get("set-bark")!("device-key", ctx);
	assert.deepEqual(JSON.parse(readFileSync(configPath(agentDir), "utf8")), {
		bark: { serverUrl: "https://api.day.app", deviceKey: "device-key", encryption: null },
	});

	await commands.get("copyb")!("", ctx);
	assert.deepEqual(events, [`copy:${text}`, "fetch"]);
	assert.equal(request?.url, "https://api.day.app/push");
	assert.equal(request?.init?.method, "POST");
	assert.equal(request?.init?.body, JSON.stringify({ device_key: "device-key", body: text }));
	assert.deepEqual(request?.init?.headers, { "Content-Type": "application/json; charset=utf-8" });
	assert.deepEqual(notices, [
		"Saved the Bark Device Key and server URL.",
		"Copied the last agent message and sent a Bark push notification.",
	]);
});

test("events stay silent until this session subscribes", async (t) => {
	const pushes: Array<Record<string, string>> = [];
	const { agentDir, commands, handlers, entries } = harness(t, {
		fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			pushes.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		sessionName: "Deploy API",
	});
	const ctx = context(agentDir, { contextEntries: entries });
	await commands.get("set-bark")!("device-key", ctx);

	await handlers.get("ui_prompt_start")!({}, ctx);
	await settle();
	assert.deepEqual(pushes, [], "a session with no subscription pushes nothing");

	entries.push(subscription("needsInput"));
	await handlers.get("ui_prompt_start")!({}, ctx);
	await settle();
	assert.deepEqual(pushes, [
		{ device_key: "device-key", title: "Deploy API · needs input", body: ctx.cwd, group: "Deploy API" },
	]);
});

test("two sessions in one directory notify independently", async (t) => {
	const pushes: Array<Record<string, string>> = [];
	const { agentDir, commands, handlers } = harness(t, {
		fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			pushes.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		sessionName: "Shared",
	});
	const silent = context(agentDir, { contextEntries: [] });
	const subscribed = context(agentDir, { contextEntries: [subscription("finished")] });
	await commands.get("set-bark")!("device-key", silent);

	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, silent);
	await settle();
	assert.deepEqual(pushes, [], "the session without a subscription stays silent");

	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, subscribed);
	await settle();
	assert.deepEqual(pushes, [
		{ device_key: "device-key", title: "Shared · finished", body: subscribed.cwd, group: "Shared" },
	]);
});

test("/bark toggles on space, saves at once, and closes on escape", async (t) => {
	const { agentDir, commands, entries, panel, custom } = harness(t, {
		fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
		sessionName: "Deploy API",
	});
	const notices: string[] = [];
	const ctx = context(agentDir, { notify: (message) => notices.push(message), custom });
	await commands.get("set-bark")!("device-key", ctx);

	const opening = commands.get("bark")!("", ctx);
	await settle();
	const component = panel.component;
	assert.ok(component, "the command opens the panel");
	const before = component.render(60).join("\n");
	assert.match(before, /\[ \] needsInput\s+等你确认/);
	assert.match(before, /已开启 0 项/);
	assert.match(before, /空格 切换并保存/);

	component.handleInput?.(" ");
	await settle();
	const stored = entries.at(-1) as { data?: { events: string[] } } | undefined;
	assert.deepEqual(stored?.data?.events, ["needsInput"], "space saves immediately");
	const after = component.render(60).join("\n");
	assert.match(after, /\[x\] needsInput/);
	assert.match(after, /已开启 1 项/);

	component.handleInput?.("\u001b");
	await opening;
	assert.deepEqual(notices.at(-1), "Bark events for this session: needsInput");
});

test("/bark closes on escape without writing when nothing changed", async (t) => {
	const { agentDir, commands, entries, panel, custom } = harness(t, {
		fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
		sessionName: "Deploy API",
	});
	const ctx = context(agentDir, { custom });
	await commands.get("set-bark")!("device-key", ctx);
	const writes = entries.length;

	const opening = commands.get("bark")!("", ctx);
	await settle();
	panel.component?.handleInput?.("\u001b");
	await opening;
	assert.equal(entries.length, writes, "escape alone writes no session entry");
});

test("a settled run reports failure and survives a queued continuation", async (t) => {
	const pushes: Array<Record<string, string>> = [];
	let idle = true;
	const { agentDir, commands, handlers } = harness(t, {
		fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			pushes.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		sessionName: "Deploy API",
	});
	const ctx = context(agentDir, { contextEntries: [subscription("finished", "failed")], isIdle: () => idle });
	await commands.get("set-bark")!("device-key", ctx);

	await handlers.get("message_end")!({ type: "message_end", message: { role: "assistant", stopReason: "error" } }, ctx);
	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
	await settle();
	assert.equal(pushes[0]?.title, "Deploy API · failed");

	// A handler after agent_settled can queue a continuation; the deferred idle check must suppress the push.
	idle = false;
	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
	await settle();
	assert.equal(pushes.length, 1);

	idle = true;
	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: true }, ctx);
	await settle();
	assert.equal(pushes.length, 1, "a cancelled run sends no push");
});

test("waitingTooLong fires once after the session sits idle", async (t) => {
	const pushes: Array<Record<string, string>> = [];
	const { agentDir, commands, handlers } = harness(t, {
		fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			pushes.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		sessionName: "Deploy API",
		waitingDelayMs: 10,
	});
	const ctx = context(agentDir, { contextEntries: [subscription("waitingTooLong")] });
	await commands.get("set-bark")!("device-key", ctx);

	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(pushes, [
		{ device_key: "device-key", title: "Deploy API · waiting for you", body: ctx.cwd, group: "Deploy API" },
	]);

	// Typing cancels the pending notice.
	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
	handlers.get("input")!({ type: "input", text: "hello" }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(pushes.length, 1);
});

test("compaction failure pushes on its own and marks the run failed", async (t) => {
	const pushes: Array<Record<string, string>> = [];
	const { agentDir, commands, handlers } = harness(t, {
		fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			pushes.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		sessionName: "Deploy API",
	});
	const ctx = context(agentDir, { contextEntries: [subscription("compactFailed", "failed")] });
	await commands.get("set-bark")!("device-key", ctx);

	handlers.get("agent_start")!({}, ctx);
	await handlers.get("session_compact_failed")!(
		{ type: "session_compact_failed", aborted: false, errorMessage: "boom" },
		ctx,
	);
	await settle();
	assert.equal(pushes[0]?.title, "Deploy API · compaction failed");

	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
	await settle();
	assert.equal(pushes[1]?.title, "Deploy API · failed");
});

test("push encryption wraps every field in AES256-GCM", async (t) => {
	const bodies: Array<Record<string, string>> = [];
	const key = "0123456789abcdef0123456789abcdef";
	const { agentDir, handlers } = harness(t, {
		fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		sessionName: "Deploy API",
	});
	mkdirSync(join(agentDir, "config", "pi-bark"), { recursive: true });
	writeFileSync(
		configPath(agentDir),
		`${JSON.stringify({ bark: { serverUrl: "https://api.day.app", deviceKey: "device-key", encryption: { algorithm: "AES256", mode: "GCM", padding: "noPadding", key } } })}\n`,
	);
	const ctx = context(agentDir, { contextEntries: [subscription("finished")] });

	await handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
	await settle();
	assert.equal(bodies[0]?.device_key, "device-key");
	assert.equal(bodies[0]?.title, undefined);
	const encrypted = bodies[0];
	assert.ok(encrypted?.ciphertext && encrypted.iv);
	const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(encrypted.iv, "utf8"));
	const raw = Buffer.from(encrypted.ciphertext, "base64");
	decipher.setAuthTag(raw.subarray(raw.length - 16));
	const plaintext = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
	assert.deepEqual(JSON.parse(plaintext.toString("utf8")), {
		title: "Deploy API · finished",
		body: ctx.cwd,
		group: "Deploy API",
	});
});

test("bark_push sends Bark fields, converts flags, and drops an identical repeat", async (t) => {
	const bodies: Array<Record<string, string>> = [];
	const { agentDir, commands, tools } = harness(t, {
		fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, string>);
			return new Response(null, { status: 200 });
		}) as typeof fetch,
		sessionName: "Deploy API",
	});
	const ctx = context(agentDir);
	await commands.get("set-bark")!("device-key", ctx);
	const tool = tools.get("bark_push");
	assert.ok(tool);

	const params = { body: "deploy done", level: "timeSensitive", sound: "minuet", call: true, badge: 3, ttl: 600 };
	const first = await tool.execute("call-1", params, undefined, undefined, ctx);
	assert.equal(first.isError, undefined);
	assert.deepEqual(bodies[0], {
		device_key: "device-key",
		title: "Deploy API",
		group: "Deploy API",
		body: "deploy done",
		level: "timeSensitive",
		sound: "minuet",
		call: "1",
		badge: "3",
		ttl: "600",
	});

	const repeat = await tool.execute("call-2", params, undefined, undefined, ctx);
	assert.equal(repeat.isError, true);
	assert.match(repeat.content[0].text, /already sent exactly this notification/);
	assert.equal(bodies.length, 1, "a repeated payload is dropped");

	const missingBody = await tool.execute("call-3", { title: "only a title" }, undefined, undefined, ctx);
	assert.equal(missingBody.isError, true);
	assert.match(missingBody.content[0].text, /needs body or markdown/);

	const tooLong = await tool.execute("call-4", { body: "x".repeat(2001) }, undefined, undefined, ctx);
	assert.equal(tooLong.isError, true);
	assert.match(tooLong.content[0].text, /limit is 2000/);

	const orphanDelete = await tool.execute("call-5", { body: "x", delete: true }, undefined, undefined, ctx);
	assert.equal(orphanDelete.isError, true);
	assert.match(orphanDelete.content[0].text, /delete needs id/);

	// The sound list is a hint: it reaches the model, but an imported sound is passed through unchanged.
	assert.match(tool.description, /Bark sounds: alarm, anticipate, bell/);
	const imported = await tool.execute("call-6", { body: "x", sound: "my-own-ring" }, undefined, undefined, ctx);
	assert.equal(imported.isError, undefined);
	assert.equal(bodies.at(-1)?.sound, "my-own-ring");
});

test("bark_push explains an unconfigured device instead of throwing", async (t) => {
	const { agentDir, tools } = harness(t, { fetch: (async () => new Response(null, { status: 200 })) as typeof fetch });
	const ctx = context(agentDir);
	const result = await tools.get("bark_push")!.execute("call-1", { body: "hi" }, undefined, undefined, ctx);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Bark is not configured/);
});
