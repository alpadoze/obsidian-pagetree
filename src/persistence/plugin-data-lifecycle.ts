import type { PluginDataStorage } from "./tree-repository";

interface PersistenceScope {
	owner: symbol;
	pending: Promise<void>;
}

// Symbol.for survives unloading/requiring a plugin bundle in the same host window.
const scopesKey = Symbol.for("page-tree:data-persistence-scopes");
const host = globalThis as typeof globalThis & { [scopesKey]?: WeakMap<object, PersistenceScope> };
const scopes = host[scopesKey] ??= new WeakMap<object, PersistenceScope>();

/** A reloaded plugin waits for a started save and cancels stale, not-yet-started writes. */
export function guardPluginDataStorage(
	context: object,
	storage: PluginDataStorage,
	isActive: () => boolean,
): PluginDataStorage {
	const owner = Symbol("page-tree-instance");
	const scope = scopes.get(context) ?? { owner, pending: Promise.resolve() };
	scope.owner = owner;
	scopes.set(context, scope);
	const assertActive = (): void => {
		if (!isActive() || scope.owner !== owner) throw new Error("PageTree storage instance is no longer active.");
	};
	return {
		async loadData(): Promise<unknown> {
			await scope.pending;
			assertActive();
			const data = await storage.loadData();
			assertActive();
			return data;
		},
		saveData(data: unknown): Promise<void> {
			const write = scope.pending.then(async () => {
				assertActive();
				await storage.saveData(data);
			});
			scope.pending = write.then(() => undefined, () => undefined);
			return write;
		},
	};
}
