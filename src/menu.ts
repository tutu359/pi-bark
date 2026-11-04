import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type BarkEvent, EVENT_NAMES } from "./session.ts";

const DONE = "完成保存";

/** Short next to the event name: the checkbox carries the state, this carries the meaning. */
const EVENT_HINTS: Record<BarkEvent, string> = {
	needsInput: "等你确认",
	finished: "跑完",
	failed: "出错",
	compactFailed: "压缩失败",
	waitingTooLong: "停住 10 分钟",
};

const NAME_WIDTH = Math.max(...EVENT_NAMES.map((name) => name.length));

function optionLabel(name: BarkEvent, selected: boolean): string {
	const box = selected ? "[x]" : "[ ]";
	return `${box} ${name.padEnd(NAME_WIDTH)}  ${EVENT_HINTS[name]}`;
}

/** `[x] finished  跑完` → `finished`; DONE and anything malformed has no event. */
function toggledEvent(choice: string): BarkEvent | undefined {
	if (!/^\[[ x]\] /.test(choice)) return undefined;
	const head = choice.slice(4).split(/\s+/)[0];
	return EVENT_NAMES.find((name) => name === head);
}

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
		const options = [...EVENT_NAMES.map((name) => optionLabel(name, selected.has(name))), DONE];
		const choice = await ui.select(title, options);
		if (choice === undefined) return undefined;
		if (choice === DONE) return EVENT_NAMES.filter((name) => selected.has(name));
		const toggled = toggledEvent(choice);
		if (!toggled) return undefined;
		if (selected.has(toggled)) selected.delete(toggled);
		else selected.add(toggled);
	}
}
