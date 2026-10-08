import {
	CURRENT_TREE_SCHEMA_VERSION,
	cloneTreeState,
	createEmptyTreeState,
	type TreeState,
} from "../core/tree-state";
import {
	decodeTreeState,
	validateTreeState,
	type TreeValidationIssue,
} from "../core/tree-validator";
import { TreeValidationError } from "../core/tree-store";

export const PAGE_TREE_DATA_FORMAT = "page-tree-v3";
// Read pre-rename data, but all new writes use the PageTree namespace.
export const LEGACY_TREE_DATA_FORMATS = ["page-arbor-tree-v2", "page-arbor-tree-v3"] as const;

export interface PluginDataStorage {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

export type TreeLoadSource = "empty" | "current" | "backup" | "legacy" | "degraded";

export interface TreeLoadResult {
	state: TreeState;
	source: TreeLoadSource;
	issues: TreeValidationIssue[];
}

interface PersistedTreeDocument {
	format: typeof PAGE_TREE_DATA_FORMAT | (typeof LEGACY_TREE_DATA_FORMATS)[number];
	state: TreeState;
	lastValidState: TreeState | null;
}

export class TreeRepository {
	constructor(private readonly storage: PluginDataStorage) {}

	async load(): Promise<TreeLoadResult> {
		const rawData = await this.storage.loadData();
		if (rawData === null || rawData === undefined) {
			return { state: createEmptyTreeState(), source: "empty", issues: [] };
		}

		if (isPersistedTreeDocument(rawData)) {
			const current = decodeTreeState(rawData.state);
			if (current.state) {
				return { state: current.state, source: "current", issues: [] };
			}

			const backup = decodeTreeState(rawData.lastValidState);
			if (backup.state) {
				return {
					state: backup.state,
					source: "backup",
					issues: current.issues,
				};
			}

			return {
				state: createEmptyTreeState(),
				source: "degraded",
				issues: [...current.issues, ...backup.issues],
			};
		}

		const legacy = decodeTreeState(rawData);
		if (legacy.state) {
			return { state: legacy.state, source: "legacy", issues: [] };
		}

		return {
			state: createEmptyTreeState(),
			source: "degraded",
			issues: legacy.issues,
		};
	}

	async save(state: TreeState): Promise<void> {
		const validation = validateTreeState(state);
		if (!validation.valid) throw new TreeValidationError(validation.issues);

		const rawData = await this.storage.loadData();
		assertSupportedStoredTreeData(rawData);
		const lastValidState = findPreviousValidState(rawData);
		const document: PersistedTreeDocument = {
			format: PAGE_TREE_DATA_FORMAT,
			state: cloneTreeState(state),
			lastValidState,
		};

		await this.storage.saveData(document);
	}
}

function findPreviousValidState(rawData: unknown): TreeState | null {
	if (rawData === null || rawData === undefined) return null;

	if (isPersistedTreeDocument(rawData)) {
		const current = decodeTreeState(rawData.state);
		if (current.state) return cloneTreeState(current.state);

		const backup = decodeTreeState(rawData.lastValidState);
		return backup.state ? cloneTreeState(backup.state) : null;
	}

	const legacy = decodeTreeState(rawData);
	return legacy.state ? cloneTreeState(legacy.state) : null;
}

function isPersistedTreeDocument(value: unknown): value is PersistedTreeDocument {
	return isRecord(value)
		&& isSupportedDataFormat(value.format)
		&& "state" in value && "lastValidState" in value;
}

function isSupportedDataFormat(value: unknown): value is PersistedTreeDocument["format"] {
	return value === PAGE_TREE_DATA_FORMAT || LEGACY_TREE_DATA_FORMATS.some((format) => value === format);
}

export function assertSupportedStoredTreeData(value: unknown): void {
	if (!isRecord(value)) return;
	const unsupportedFormat = typeof value.format === "string"
		&& !isSupportedDataFormat(value.format);
	const candidates = "format" in value ? [value.state, value.lastValidState] : [value];
	const futureState = candidates.some((state) => isRecord(state)
		&& typeof state.schemaVersion === "number" && state.schemaVersion > CURRENT_TREE_SCHEMA_VERSION);
	if (unsupportedFormat || futureState) {
		throw new TreeValidationError([{
			code: "unsupported-schema-version",
			message: "Stored tree data uses an unsupported version and will not be overwritten.",
		}]);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
