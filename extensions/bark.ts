import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createBarkConfigStore, DEFAULT_SERVER_URL, parseServerUrl, writeBarkConfig } from "../src/config.ts";
import { formatConfigIssues, registerConfigReporting } from "../src/config-store.ts";
import { chooseEvents } from "../src/menu.ts";
import { eventContent, sendPush } from "../src/push.ts";
import { registerBarkPushTool } from "../src/push-tool.ts";
import { type BarkEvent, readSubscription, SESSION_STATE_TYPE, sameEvents, sessionLabel } from "../src/session.ts";

/** How long a settled session waits in silence before saying it is still waiting. */
const WAITING_DELAY_MS = 10 * 60_000;

type BarkExtensionOptions = {
	copy?: (text: string) => Promise<void>;
	waitingDelayMs?: number;
};

function lastAssistantText(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (text) return text;
	}
	return undefined;
}

export default function barkExtension(pi: ExtensionAPI, options: BarkExtensionOptions = {}): void {
	const configStore = createBarkConfigStore();
	const configReporter = registerConfigReporting(pi, [configStore]);
	const copy = options.copy ?? copyToClipboard;
	const waitingDelayMs = options.waitingDelayMs ?? WAITING_DELAY_MS;

	let statusPushQueue = Promise.resolve();
	let pendingSettledPush: AbortController | undefined;
	// Mirrors Pi's ProgramStatusReporter: the latest assistant message or active-run compaction failure decides the outcome.
	let runActive = false;
	let runOutcome: "finished" | "failed" | "aborted" = "finished";
	let waitingTimer: ReturnType<typeof setTimeout> | undefined;

	const notifyWarning =
		(ctx: ExtensionContext) =>
		(error: unknown): void => {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		};

	const clearWaiting = (): void => {
		if (waitingTimer === undefined) return;
		clearTimeout(waitingTimer);
		waitingTimer = undefined;
	};

	/**
	 * Queue one event push. A disabled config or an unsubscribed event sends nothing: the session
	 * opt-in lives in the session file, so a new session is silent until /bark enables events.
	 */
	const queueEventPush = (
		event: BarkEvent,
		ctx: ExtensionContext,
		shouldSend?: Promise<boolean>,
		cancelSignal?: AbortSignal,
	): Promise<void> => {
		const loaded = configStore.loadSync();
		configReporter.report(ctx, configStore, loaded);
		if (loaded.status === "disabled") return Promise.resolve();
		if (!readSubscription(ctx).includes(event)) return Promise.resolve();
		const connection = loaded.value.bark;
		const content = eventContent(event, sessionLabel(ctx, pi.getSessionName()), resolve(ctx.cwd));
		const send = async (): Promise<void> => {
			if (shouldSend && !(await shouldSend)) return;
			await sendPush(connection, content, cancelSignal);
		};
		statusPushQueue = statusPushQueue.then(send, send);
		return statusPushQueue;
	};

	/** After a settled run, say once that the session is still waiting, then stay quiet until the next run. */
	const scheduleWaiting = (ctx: ExtensionContext): void => {
		clearWaiting();
		if (!readSubscription(ctx).includes("waitingTooLong")) return;
		waitingTimer = setTimeout(() => {
			waitingTimer = undefined;
			if (!ctx.isIdle()) return;
			void queueEventPush("waitingTooLong", ctx).catch(notifyWarning(ctx));
		}, waitingDelayMs);
		waitingTimer.unref?.();
	};

	const tool = registerBarkPushTool(
		pi,
		() => configStore.loadSync(),
		() => pi.getSessionName(),
		configReporter,
		configStore,
	);

	pi.on("ui_prompt_start", (_event, ctx) => {
		clearWaiting();
		void queueEventPush("needsInput", ctx).catch(notifyWarning(ctx));
	});

	pi.on("agent_start", () => {
		runActive = true;
		runOutcome = "finished";
		pendingSettledPush?.abort();
		clearWaiting();
		tool.reset();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		runOutcome = event.message.stopReason === "error" ? "failed" : "finished";
	});

	pi.on("session_compact_failed", (event, ctx) => {
		if (event.aborted) {
			if (runActive) runOutcome = "aborted";
			return;
		}
		if (runActive && event.errorMessage) runOutcome = "failed";
		if (event.errorMessage) void queueEventPush("compactFailed", ctx).catch(notifyWarning(ctx));
	});

	pi.on("agent_settled", (event, ctx) => {
		runActive = false;
		if (event.aborted || runOutcome === "aborted" || !ctx.isIdle()) return;
		const controller = new AbortController();
		pendingSettledPush?.abort();
		pendingSettledPush = controller;
		const shouldSend = new Promise<boolean>((done) => {
			setImmediate(() => done(ctx.isIdle()));
		});
		void queueEventPush(runOutcome === "failed" ? "failed" : "finished", ctx, shouldSend, controller.signal).catch(
			notifyWarning(ctx),
		);
		scheduleWaiting(ctx);
	});

	pi.on("input", () => clearWaiting());
	pi.on("session_shutdown", () => clearWaiting());

	pi.registerCommand("bark", {
		description: "Choose which events notify this session",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /bark");
			const loaded = configStore.loadSync();
			configReporter.report(ctx, configStore, loaded);
			if (loaded.status === "disabled") {
				throw new Error(
					`Bark is not configured (${formatConfigIssues(loaded.issues)}). Run /set-bark <device-key> or fix ${configStore.path} first.`,
				);
			}
			const current = readSubscription(ctx);
			const cwd = resolve(ctx.cwd);
			const home = homedir();
			const title = `Bark · ${sessionLabel(ctx, pi.getSessionName())} · ${cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd}`;
			if (!ctx.hasUI) {
				ctx.ui.notify(`${title}\nEvents: ${current.length ? current.join(", ") : "none (silent)"}`, "info");
				return;
			}
			const next = await chooseEvents(ctx.ui, title, current);
			if (!next) return;
			if (sameEvents(next, current)) {
				ctx.ui.notify("Bark events unchanged.", "info");
				return;
			}
			pi.appendEntry(SESSION_STATE_TYPE, { events: next });
			ctx.ui.notify(
				next.length
					? `Bark events for this session: ${next.join(", ")}`
					: "Bark events for this session: none (silent)",
				"info",
			);
		},
	});

	pi.registerCommand("copyb", {
		description: "Copy the last agent message and send a Bark push notification",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /copyb");
			const loaded = configStore.loadSync();
			configReporter.report(ctx, configStore, loaded);
			if (loaded.status === "disabled") {
				throw new Error(
					`Bark is not configured (${formatConfigIssues(loaded.issues)}). Run /set-bark <device-key> or fix ${configStore.path}.`,
				);
			}
			const text = lastAssistantText(ctx.sessionManager.buildContextEntries());
			if (!text) throw new Error("No agent messages to copy yet.");
			await copy(text);
			await sendPush(loaded.value.bark, { body: text });
			ctx.ui.notify("Copied the last agent message and sent a Bark push notification.", "info");
		},
	});

	pi.registerCommand("set-bark", {
		description: "Set the Bark Device Key and optional server URL",
		handler: async (args, ctx) => {
			const [deviceKey, serverUrl = DEFAULT_SERVER_URL, extra] = args.trim().split(/\s+/);
			if (!deviceKey || extra) throw new Error("Usage: /set-bark <device-key> [server-url]");
			const url = parseServerUrl(serverUrl);
			await writeBarkConfig(
				["bark.serverUrl", "bark.deviceKey"],
				(config) => ({
					bark: { ...config.bark, serverUrl: url, deviceKey },
				}),
				(store, result) => configReporter.report(ctx, store, result),
			);
			ctx.ui.notify("Saved the Bark Device Key and server URL.", "info");
		},
	});
}
