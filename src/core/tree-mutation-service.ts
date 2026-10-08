import type { TreeState } from "./tree-state";
import type { TreeStore } from "./tree-store";

export interface TreeStateWriter {
	save(state: TreeState): Promise<void>;
}

export class TreeMutationService {
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: TreeStore,
		private readonly writer: TreeStateWriter,
	) {}

	run<Result>(mutation: (store: TreeStore) => Result): Promise<Result> {
		const result = this.pending.then(async () => {
			const previousState = this.store.getState();
			try {
				const mutationResult = mutation(this.store);
				const nextState = this.store.getState();
				if (JSON.stringify(nextState) !== JSON.stringify(previousState)) await this.writer.save(nextState);
				return mutationResult;
			} catch (error) {
				this.store.replaceState(previousState);
				throw error;
			}
		});

		this.pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async whenIdle(): Promise<void> {
		await this.pending;
	}
}
