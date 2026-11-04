import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Every event pi-bark can push. Nothing is subscribed until the session asks for it. */
export const EVENT_NAMES = ["needsInput", "finished", "failed", "compactFailed", "waitingTooLong"] as const;

export type BarkEvent = (typeof EVENT_NAMES)[number];

/** Session entry type that carries this session's subscription. Lives in the session file, not in config. */
export const SESSION_STATE_TYPE = "pi-bark";

function isEvent(value: unknown): value is BarkEvent {
	return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

type SessionRead = Pick<ExtensionContext, "sessionManager">;

/**
 * This session's subscription: the newest pi-bark entry on the current branch, so `/tree` navigation
 * and resume read the state that belongs to the branch in use.
 */
export function readSubscription(ctx: SessionRead): BarkEvent[] {
	const entries = ctx.sessionManager.buildContextEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== SESSION_STATE_TYPE) continue;
		const data = entry.data as { events?: unknown } | undefined;
		const events = Array.isArray(data?.events) ? data.events.filter(isEvent) : [];
		return [...new Set(events)];
	}
	return [];
}

export function sameEvents(left: readonly BarkEvent[], right: readonly BarkEvent[]): boolean {
	return left.length === right.length && left.every((event) => right.includes(event));
}

/** Session identity shown in the notification title and used as the Bark group. */
export function sessionLabel(ctx: SessionRead, name: string | undefined): string {
	const trimmed = name?.trim();
	if (trimmed) return trimmed;
	return ctx.sessionManager.getSessionId().slice(0, 6);
}
