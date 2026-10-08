import { assertSupportedStoredTreeData, TreeRepository, type PluginDataStorage } from "./tree-repository";

interface MigrationFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
}

export class LegacyPluginEnabledError extends Error {
	constructor() {
		super("Disable the previous plugin before enabling PageTree.");
	}
}

/** One-time local import. Never alters the old installation or an existing new record. */
export async function migrateLegacyPluginData(
	storage: PluginDataStorage,
	files: MigrationFileAdapter,
	configDir: string,
): Promise<"imported" | "existing" | "absent"> {
	const directory = configDir.replace(/\/+$/, "");
	const enabledPath = `${directory}/community-plugins.json`;
	if (await files.exists(enabledPath)) {
		const enabled: unknown = JSON.parse(await files.read(enabledPath));
		if (!Array.isArray(enabled) || !enabled.every((id) => typeof id === "string")) {
			throw new Error("Could not verify that the previous plugin is disabled.");
		}
		if (enabled.includes("page-arbor")) throw new LegacyPluginEnabledError();
	}
	if (await storage.loadData() != null) return "existing";
	const legacyPath = `${directory}/plugins/page-arbor/data.json`;
	if (!await files.exists(legacyPath)) return "absent";
	const raw: unknown = JSON.parse(await files.read(legacyPath));
	assertSupportedStoredTreeData(raw);
	const loaded = await new TreeRepository({
		loadData: async () => raw,
		saveData: async () => { throw new Error("Legacy source is read-only."); },
	}).load();
	if (loaded.source === "empty" || loaded.source === "degraded") {
		throw new Error("The previous plugin data is not valid; it has not been imported.");
	}
	// Recheck after file I/O so a newly received new-ID record takes precedence.
	if (await storage.loadData() != null) return "existing";
	await storage.saveData(raw);
	return "imported";
}
