import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ConfigLoad } from "./config-store.ts";
import type { BarkConfig } from "./config.ts";
import { type BarkPushContent, sendPush } from "./push.ts";
import { sessionLabel } from "./session.ts";

const MAX_BODY_CHARS = 2000;

type ConfigStoreLike = {
	extensionId: string;
	path: string;
	loadSync(): ConfigLoad<BarkConfig>;
};

type Reporter = {
	report(
		ctx: Pick<ExtensionContext, "hasUI" | "ui">,
		store: Pick<ConfigStoreLike, "extensionId" | "path">,
		result: ConfigLoad<unknown>,
	): void;
};

const PARAMETERS = Type.Object({
	title: Type.Optional(Type.String({ description: "通知首行；缺省用会话名" })),
	subtitle: Type.Optional(Type.String({ description: "标题下方的小字，放来源或状态" })),
	body: Type.Optional(Type.String({ description: "通知正文" })),
	markdown: Type.Optional(Type.String({ description: "Markdown 正文，传了就忽略 body" })),
	group: Type.Optional(Type.String({ description: "消息分组，缺省为会话名" })),
	icon: Type.Optional(Type.String({ description: "通知图标 URL（iOS 15+）" })),
	image: Type.Optional(Type.String({ description: "展开通知时显示的大图 URL" })),
	badge: Type.Optional(Type.Integer({ description: "角标数字，0 清除角标与通知" })),
	level: Type.Optional(
		Type.Union([Type.Literal("active"), Type.Literal("timeSensitive"), Type.Literal("passive"), Type.Literal("critical")], {
			description: "推送级别，默认 active",
		}),
	),
	volume: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: "critical 时的音量 0-10" })),
	call: Type.Optional(Type.Boolean({ description: "true 则铃声循环 30 秒" })),
	sound: Type.Optional(Type.String({ description: "铃声名，例如 minuet" })),
	copy: Type.Optional(Type.String({ description: "手动复制推送时复制的文本" })),
	url: Type.Optional(Type.String({ description: "点击通知跳转的 URL" })),
	action: Type.Optional(
		Type.Union([Type.Literal("alert"), Type.Literal("none")], { description: "alert 弹操作框 / none 仅打开 App" }),
	),
	isArchive: Type.Optional(Type.Boolean({ description: "false 则不保存到历史记录" })),
	ttl: Type.Optional(Type.Integer({ minimum: 0, description: "历史记录存活秒数" })),
	id: Type.Optional(Type.String({ description: "通知 id，须字符串；同 id 覆盖原通知" })),
	delete: Type.Optional(Type.Boolean({ description: "true 删除 id 指定的通知" })),
});

type PushParams = Static<typeof PARAMETERS>;

class PushInputError extends Error {}

function text(description: string): { content: Array<{ type: "text"; text: string }>; details: { sent: boolean }; isError?: true } {
	return { content: [{ type: "text", text: description }], details: { sent: false }, isError: true };
}

function flag(value: boolean | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value ? "1" : "0";
}

function number(value: number | undefined): string | undefined {
	return value === undefined ? undefined : String(value);
}

/** Bark wants every field as a string; a boolean parameter becomes the `"1"`/`"0"` that Bark expects. */
function buildContent(params: PushParams, label: string): BarkPushContent {
	if (!params.body && !params.markdown) throw new PushInputError("bark_push needs body or markdown.");
	for (const [name, value] of [["body", params.body], ["markdown", params.markdown]] as const) {
		if (value !== undefined && value.length > MAX_BODY_CHARS) {
			throw new PushInputError(`bark_push ${name} is ${value.length} characters; the limit is ${MAX_BODY_CHARS}.`);
		}
	}
	if (params.delete && !params.id) throw new PushInputError("bark_push delete needs id, the notification to remove.");
	const content: BarkPushContent = {};
	const put = (key: string, value: string | undefined): void => {
		if (value !== undefined) content[key] = value;
	};
	put("title", params.title ?? label);
	put("subtitle", params.subtitle);
	put("body", params.body);
	put("markdown", params.markdown);
	put("group", params.group ?? label);
	put("icon", params.icon);
	put("image", params.image);
	put("badge", number(params.badge));
	put("level", params.level);
	put("volume", number(params.volume));
	put("call", flag(params.call));
	put("sound", params.sound);
	put("copy", params.copy);
	put("url", params.url);
	put("action", params.action);
	put("isArchive", flag(params.isArchive));
	put("ttl", number(params.ttl));
	put("id", params.id);
	put("delete", flag(params.delete));
	return content;
}

export type BarkPushTool = { reset(): void };

/**
 * Register `bark_push`. It is always available: the Device Key authorizes pushes, and the model decides
 * when a business message is worth one. Identical payloads in the same run are dropped once, so a loop
 * cannot flood the device.
 */
export function registerBarkPushTool(
	pi: Pick<ExtensionAPI, "registerTool">,
	load: () => ConfigLoad<BarkConfig>,
	getSessionName: () => string | undefined,
	reporter: Reporter,
	store: ConfigStoreLike,
	write: typeof sendPush = sendPush,
): BarkPushTool {
	const sent = new Set<string>();
	pi.registerTool({
		name: "bark_push",
		label: "Bark Push",
		description: [
			"Send a push notification to the user's iPhone through Bark.",
			"Provide body or markdown; markdown wins when both are set.",
			"delete removes the notification named by id instead of posting a new one.",
			"volume only applies when level is critical.",
			"title and group default to the session name.",
			`body and markdown are limited to ${MAX_BODY_CHARS} characters.`,
		].join(" "),
		promptSnippet: "Send an iPhone push notification with a title and body",
		promptGuidelines: [
			"Use bark_push when the user asks to be notified by phone, or when a long task produces a result worth reporting while they are away.",
			"Do not use bark_push for routine progress or to repeat what the terminal already shows; one push per meaningful outcome.",
			"Keep bark_push bodies short: the user reads them on a lock screen.",
		],
		parameters: PARAMETERS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const loaded = load();
			reporter.report(ctx, store, loaded);
			if (loaded.status === "disabled") {
				return text(
					"Bark is not configured. Ask the user to run /set-bark <device-key>, then retry.",
				);
			}
			const label = sessionLabel(ctx, getSessionName());
			let content: BarkPushContent;
			try {
				content = buildContent(params, label);
			} catch (error) {
				if (error instanceof PushInputError) return text(error.message);
				throw error;
			}
			const fingerprint = JSON.stringify(content);
			if (sent.has(fingerprint)) {
				return text("Skipped: bark_push already sent exactly this notification in this run.");
			}
			sent.add(fingerprint);
			try {
				await write(loaded.value.bark, content, signal);
			} catch (error) {
				sent.delete(fingerprint);
				return text(error instanceof Error ? error.message : String(error));
			}
			// An aborted push is not a delivered one, so do not report success for it.
			if (signal?.aborted) {
				sent.delete(fingerprint);
				return text("Bark push cancelled before it was sent.");
			}
			return {
				content: [{ type: "text" as const, text: `Sent a Bark push: "${content.title ?? label}".` }],
				details: { sent: true, group: content.group ?? label },
			};
		},
	});
	return {
		reset() {
			sent.clear();
		},
	};
}
