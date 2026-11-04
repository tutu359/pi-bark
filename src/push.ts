import type { BarkConnection } from "./config.ts";
import { encryptPushContent } from "./encryption.ts";
import type { BarkEvent } from "./session.ts";

export const REQUEST_TIMEOUT_MS = 15_000;

/** Every field Bark accepts in a push body, besides the Device Key and the encrypted form. */
export type BarkPushContent = Record<string, string>;

const EVENT_TITLES: Record<BarkEvent, string> = {
	needsInput: "needs input",
	finished: "finished",
	failed: "failed",
	compactFailed: "compaction failed",
	waitingTooLong: "waiting for you",
};

/**
 * Status pushes carry no content: the title names the event and the session, the group keeps one
 * session's pushes together, and the body only says which directory the session runs in.
 */
export function eventContent(event: BarkEvent, label: string, cwd: string): BarkPushContent {
	return { title: `Pi · ${label} · ${EVENT_TITLES[event]}`, body: cwd, group: label };
}

export async function sendPush(
	connection: BarkConnection,
	content: BarkPushContent,
	cancelSignal?: AbortSignal,
): Promise<void> {
	const payload = connection.encryption ? encryptPushContent(content, connection.encryption) : content;
	let response: Response;
	try {
		response = await fetch(`${connection.serverUrl}/push`, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({ device_key: connection.deviceKey, ...payload }),
			signal: cancelSignal
				? AbortSignal.any([cancelSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
				: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		if (cancelSignal?.aborted) return;
		throw new Error(`Bark push request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`Bark push request failed with HTTP ${response.status}.`);
}
