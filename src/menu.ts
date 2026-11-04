import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { type BarkEvent, EVENT_NAMES } from "./session.ts";

/** Short next to the event name: the checkbox carries the state, this carries the meaning. */
const EVENT_HINTS: Record<BarkEvent, string> = {
	needsInput: "等你确认",
	finished: "跑完",
	failed: "出错",
	compactFailed: "压缩失败",
	waitingTooLong: "停住 10 分钟",
};

const NAME_WIDTH = Math.max(...EVENT_NAMES.map((name) => name.length));

type PanelUI = Pick<ExtensionUIContext, "custom">;

/**
 * Checkbox panel for this session's events. Space toggles and saves at once, so there is no confirm
 * row; Escape closes it. Every change is reported through `onChange` as it happens.
 */
export async function openEventPanel(
	ui: PanelUI,
	header: string,
	current: readonly BarkEvent[],
	onChange: (events: BarkEvent[]) => void,
): Promise<void> {
	await ui.custom<void>((tui, theme, _keybindings, done) => {
		const selected = new Set(current);
		let cursor = 0;
		let cached: string[] | undefined;

		const refresh = (): void => {
			cached = undefined;
			tui.requestRender();
		};

		const commit = (): void => {
			onChange(EVENT_NAMES.filter((name) => selected.has(name)));
		};

		return {
			render(width: number): string[] {
				if (cached) return cached;
				const rule = theme.fg("dim", "─".repeat(Math.max(1, width)));
				const lines = [
					rule,
					`${theme.fg("text", header)}`,
					theme.fg("muted", "空格 切换并保存 · ↑↓ 移动 · Esc 退出"),
					"",
				];
				for (const [index, name] of EVENT_NAMES.entries()) {
					const active = index === cursor;
					const box = selected.has(name) ? "[x]" : "[ ]";
					const label = `${box} ${name.padEnd(NAME_WIDTH)}  ${EVENT_HINTS[name]}`;
					lines.push(`${active ? theme.fg("accent", ">") : " "} ${theme.fg(active ? "accent" : "text", label)}`);
				}
				lines.push("", theme.fg("dim", `已开启 ${selected.size} 项`), rule);
				cached = lines;
				return lines;
			},
			invalidate(): void {
				cached = undefined;
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.up)) {
					cursor = Math.max(0, cursor - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					cursor = Math.min(EVENT_NAMES.length - 1, cursor + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
					const name = EVENT_NAMES[cursor];
					if (!name) return;
					if (selected.has(name)) selected.delete(name);
					else selected.add(name);
					commit();
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape)) done();
			},
		};
	});
}
