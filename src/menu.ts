import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type BarkEvent, EVENT_LABELS, EVENT_NAMES } from "./session.ts";

const DONE = "Done";

/**
 * Toggle this session's events. Every event shows its current state, so nothing has to be remembered,
 * and cancelling the selector leaves the subscription untouched.
 */
export async function chooseEvents(
	ui: Pick<ExtensionUIContext, "select">,
	title: string,
	current: readonly BarkEvent[],
): Promise<BarkEvent[] | undefined> {
	const selected = new Set(current);
	for (;;) {
		const options = [
			...EVENT_NAMES.map((name) => `${selected.has(name) ? "✓" : "✗"} ${name} — ${EVENT_LABELS[name]}`),
			DONE,
		];
		const choice = await ui.select(title, options);
		if (choice === undefined) return undefined;
		if (choice === DONE) return EVENT_NAMES.filter((name) => selected.has(name));
		const toggled = EVENT_NAMES.find((name) => choice.includes(` ${name} — `));
		if (!toggled) return undefined;
		if (selected.has(toggled)) selected.delete(toggled);
		else selected.add(toggled);
	}
}
