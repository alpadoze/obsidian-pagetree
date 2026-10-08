import { describe, expect, it } from "vitest";
import { TreeMutationService, type TreeStateWriter } from "../src/core/tree-mutation-service";
import { createEmptyTreeState, type TreeState } from "../src/core/tree-state";
import { TreeStore } from "../src/core/tree-store";

describe("TreeMutationService", () => {
	it("does not rewrite shared data for duplicate events or no-op maintenance", async () => {
		let saves = 0;
		const store = new TreeStore(createEmptyTreeState());
		const mutations = new TreeMutationService(store, { async save() { saves += 1; } });
		await mutations.run(() => undefined);
		await mutations.run((tree) => tree.replaceState(tree.getState()));
		expect(saves).toBe(0);
		expect(store.getState().revision).toBe(0);
	});
	it("serializes mutations so saved revisions cannot overtake each other", async () => {
		const savedRevisions: number[] = [];
		let activeSaves = 0;
		let maximumConcurrentSaves = 0;
		const writer: TreeStateWriter = {
			async save(state: TreeState): Promise<void> {
				activeSaves += 1;
				maximumConcurrentSaves = Math.max(maximumConcurrentSaves, activeSaves);
				await delay(10);
				savedRevisions.push(state.revision);
				activeSaves -= 1;
			},
		};
		const store = new TreeStore(createEmptyTreeState());
		const mutations = new TreeMutationService(store, writer);

		const first = mutations.run((tree) => tree.addNode({ id: "one", path: "One.md" }));
		const second = mutations.run((tree) => tree.addNode({ id: "two", path: "Two.md" }));
		await Promise.all([first, second]);

		expect(savedRevisions).toEqual([1, 2]);
		expect(maximumConcurrentSaves).toBe(1);
		expect(store.getChildren(null).map((node) => node.id)).toEqual(["one", "two"]);
	});

	it("rolls the in-memory tree back when persistence fails", async () => {
		const writer: TreeStateWriter = {
			async save(): Promise<void> {
				throw new Error("disk full");
			},
		};
		const store = new TreeStore(createEmptyTreeState());
		const mutations = new TreeMutationService(store, writer);

		await expect(
			mutations.run((tree) => tree.addNode({ id: "one", path: "One.md" })),
		).rejects.toThrow("disk full");
		expect(store.getState()).toEqual(createEmptyTreeState());
	});
});

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
