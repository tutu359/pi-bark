import {
	type ConfigLoad,
	createConfigStore,
	field,
	type FieldParser,
	formatConfigIssues,
	parsers,
	required,
} from "./config-store.ts";

export const DEFAULT_SERVER_URL = "https://api.day.app";
export const ENCRYPTION_ALGORITHM = "AES256";
export const ENCRYPTION_MODE = "GCM";
export const ENCRYPTION_PADDING = "noPadding";
export const ENCRYPTION_KEY_BYTES = 32;

export type BarkEncryption = {
	algorithm: typeof ENCRYPTION_ALGORITHM;
	mode: typeof ENCRYPTION_MODE;
	padding: typeof ENCRYPTION_PADDING;
	key: string;
};

/** The `bark` block: how to reach the device. Behavior lives in the session, not here. */
export type BarkConnection = {
	serverUrl: string;
	deviceKey: string;
	encryption: BarkEncryption | null;
};

export type BarkConfig = { bark: BarkConnection };

/** What repair commands write; every connection setting can be absent before the command sets it. */
export type BarkConfigDraft = {
	bark: {
		serverUrl: string | undefined;
		deviceKey: string | null | undefined;
		encryption: BarkEncryption | null | undefined;
	};
};

export type BarkConfigPath = "bark.serverUrl" | "bark.deviceKey" | "bark.encryption";

const REQUIRED_PATHS: readonly BarkConfigPath[] = ["bark.serverUrl", "bark.deviceKey", "bark.encryption"];

export function parseServerUrl(value: string): string {
	const input = value.trim();
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Bark server URL must be a valid HTTP or HTTPS URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Bark server URL must use HTTP or HTTPS.");
	}
	if (input.includes("?") || input.includes("#")) {
		throw new Error("Bark server URL must not include a query or fragment.");
	}
	return url.href.replace(/\/$/, "");
}

const serverUrl: FieldParser<string> = (raw) => {
	if (typeof raw !== "string") throw new Error("must be an HTTP or HTTPS URL");
	return parseServerUrl(raw);
};

const encryption: FieldParser<BarkEncryption> = (raw) => {
	const value = raw as Record<string, unknown>;
	if (
		Object.keys(value).length !== 4
		|| value.algorithm !== ENCRYPTION_ALGORITHM
		|| value.mode !== ENCRYPTION_MODE
		|| value.padding !== ENCRYPTION_PADDING
		|| typeof value.key !== "string"
		|| Buffer.byteLength(value.key, "utf8") !== ENCRYPTION_KEY_BYTES
	) {
		throw new Error(
			`expected ${ENCRYPTION_ALGORITHM}, ${ENCRYPTION_MODE}, ${ENCRYPTION_PADDING}, and a ${ENCRYPTION_KEY_BYTES}-byte UTF-8 key`,
		);
	}
	return value as BarkEncryption;
};

/**
 * Bark cannot send without a Device Key. A default server would receive the Device Key, and a default `null`
 * encryption would send plaintext, so each `bark` key is required and a missing or invalid one disables pi-bark.
 */
export function createBarkConfigStore() {
	return createConfigStore({
		extensionId: "pi-bark",
		fields: {
			bark: required(
				parsers.object({
					serverUrl: required(serverUrl),
					deviceKey: required(parsers.string({ trim: true })),
					encryption: required(parsers.nullable(encryption)),
				}),
			),
		},
	});
}

export type BarkConfigStore = ReturnType<typeof createBarkConfigStore>;

/** Same file; every `bark` key defaults to unset so repair commands can read a disabled config. */
function createBarkDraftStore() {
	return createConfigStore({
		extensionId: "pi-bark",
		fields: {
			bark: field(
				parsers.object({
					serverUrl: field<string | undefined>(serverUrl, undefined),
					deviceKey: field<string | null | undefined>(parsers.nullable(parsers.string({ trim: true })), undefined),
					encryption: field<BarkEncryption | null | undefined>(parsers.nullable(encryption), undefined),
				}),
				{ serverUrl: undefined, deviceKey: undefined, encryption: undefined },
			),
		},
	});
}

function valueAt(value: unknown, path: BarkConfigPath): unknown {
	const [section, key] = path.split(".") as [keyof BarkConfig, keyof BarkConnection];
	const block = (value as Partial<Record<string, Record<string, unknown>>>)[section];
	return block?.[key];
}

/**
 * Write config for a repair command. `report` receives the issues of the current file before any write.
 * A clean file uses a locked update. A file with issues is replaced if it is unchanged under the lock. A missing or invalid
 * server URL, Device Key, or encryption setting blocks the write unless the command sets it (`replaces`), so no required
 * setting is lost or silently unset.
 */
export async function writeBarkConfig(
	replaces: readonly BarkConfigPath[],
	change: (config: BarkConfigDraft) => BarkConfigDraft,
	report: (store: { extensionId: string; path: string }, result: ConfigLoad<unknown>) => void,
): Promise<void> {
	const store = createBarkDraftStore();
	const current = store.loadSync();
	report(store, current);
	// The draft store has no disabling field, so it always loads a value.
	if (current.status !== "ok") throw new Error(formatConfigIssues(current.issues));
	const fileIssues = current.issues.filter(({ key }) => !key);
	const blocking = current.source === "missing"
		? []
		: fileIssues.length
			? fileIssues
			: REQUIRED_PATHS
				.filter((path) => valueAt(current.value, path) === undefined && !replaces.includes(path))
				.map((path) =>
					current.issues.find((issue) => issue.key === path)
					?? { kind: "missing-required" as const, key: path, message: "required" }
				);
	if (blocking.length) throw new Error(`Fix the Bark config at ${store.path} first: ${formatConfigIssues(blocking)}`);
	// A missing file has no settings to keep, so it starts from the defaults with an unset Device Key.
	const draft = (config: BarkConfigDraft): BarkConfigDraft => current.source === "missing"
		? {
			bark: {
				serverUrl: config.bark.serverUrl ?? DEFAULT_SERVER_URL,
				deviceKey: config.bark.deviceKey ?? null,
				encryption: config.bark.encryption ?? null,
			},
		}
		: config;
	if (!current.issues.length) await store.update((config) => change(draft(config)));
	// The change uses the snapshot, so the replacement refuses a file that another session changed meanwhile.
	else await store.replaceIfUnchanged(current, change(draft(current.value)));
}
