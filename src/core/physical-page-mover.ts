import {
	canonicalVaultPath,
} from "./tree-state";
import {
	isPageInsideSubtree,
	movedPagePath,
	pageFolderPath,
} from "./page-path";

export type PhysicalEntryKind = "file" | "folder";

export interface PhysicalPageMoveAdapter {
	getEntryKind(path: string): PhysicalEntryKind | null;
	createFolder(path: string): Promise<void>;
	move(sourcePath: string, targetPath: string): Promise<void>;
}

export type PhysicalPageMoveErrorCode =
	| "source-not-file"
	| "target-parent-not-file"
	| "would-create-cycle"
	| "target-container-blocked"
	| "target-page-exists"
	| "source-folder-blocked"
	| "target-folder-exists"
	| "physical-move-failed"
	| "metadata-commit-failed"
	| "rollback-failed";

export class PhysicalPageMoveError extends Error {
	constructor(
		public readonly code: PhysicalPageMoveErrorCode,
		message: string,
		public readonly originalError?: unknown,
		public readonly rollbackError?: unknown,
	) {
		super(message);
		this.name = "PhysicalPageMoveError";
	}
}

export interface PhysicalPageMovePlan {
	sourcePagePath: string;
	targetParentPagePath: string | null;
	targetPagePath: string;
	sourceFolderPath: string;
	targetFolderPath: string;
	targetContainerPath: string | null;
	hasSourceFolder: boolean;
}

export interface PhysicalPageMoveResult {
	moved: boolean;
	plan: PhysicalPageMovePlan;
}

export class PhysicalPageMover {
	constructor(private readonly adapter: PhysicalPageMoveAdapter) {}

	async movePage(
		sourcePagePath: string,
		targetParentPagePath: string | null,
		commitMetadata: (plan: PhysicalPageMovePlan) => Promise<void>,
	): Promise<PhysicalPageMoveResult> {
		const plan = this.createPlan(sourcePagePath, targetParentPagePath);
		if (canonicalVaultPath(plan.sourcePagePath) === canonicalVaultPath(plan.targetPagePath)) {
			return { moved: false, plan };
		}

		if (
			plan.targetContainerPath !== null
			&& this.adapter.getEntryKind(plan.targetContainerPath) === null
		) {
			await this.adapter.createFolder(plan.targetContainerPath);
		}

		let folderMoved = false;
		let pageMoved = false;
		try {
			if (plan.hasSourceFolder) {
				await this.adapter.move(plan.sourceFolderPath, plan.targetFolderPath);
				folderMoved = true;
			}
			await this.adapter.move(plan.sourcePagePath, plan.targetPagePath);
			pageMoved = true;
		} catch (error) {
			const rollbackError = await this.rollback(plan, pageMoved, folderMoved);
			if (rollbackError !== undefined) {
				throw new PhysicalPageMoveError(
					"rollback-failed",
					"The physical page move failed and could not be fully rolled back.",
					error,
					rollbackError,
				);
			}
			throw new PhysicalPageMoveError(
				"physical-move-failed",
				"The physical page move failed and was rolled back.",
				error,
			);
		}

		try {
			await commitMetadata(plan);
		} catch (error) {
			const rollbackError = await this.rollback(plan, pageMoved, folderMoved);
			if (rollbackError !== undefined) {
				throw new PhysicalPageMoveError(
					"rollback-failed",
					"Metadata persistence failed and the physical move could not be fully rolled back.",
					error,
					rollbackError,
				);
			}
			throw new PhysicalPageMoveError(
				"metadata-commit-failed",
				"Metadata persistence failed and the physical move was rolled back.",
				error,
			);
		}

		return { moved: true, plan };
	}

	private createPlan(
		sourcePagePath: string,
		targetParentPagePath: string | null,
	): PhysicalPageMovePlan {
		if (this.adapter.getEntryKind(sourcePagePath) !== "file") {
			throw new PhysicalPageMoveError(
				"source-not-file",
				`The source page ${sourcePagePath} is not a file.`,
			);
		}

		if (targetParentPagePath !== null) {
			if (
				canonicalVaultPath(targetParentPagePath) === canonicalVaultPath(sourcePagePath)
				|| isPageInsideSubtree(targetParentPagePath, sourcePagePath)
			) {
				throw new PhysicalPageMoveError(
					"would-create-cycle",
					"A page cannot be moved below itself or one of its descendants.",
				);
			}
			if (this.adapter.getEntryKind(targetParentPagePath) !== "file") {
				throw new PhysicalPageMoveError(
					"target-parent-not-file",
					`The target parent ${targetParentPagePath} is not a file.`,
				);
			}
		}

		const targetPagePath = movedPagePath(sourcePagePath, targetParentPagePath);
		const sourceFolderPath = pageFolderPath(sourcePagePath);
		const targetFolderPath = pageFolderPath(targetPagePath);
		const targetContainerPath = targetParentPagePath === null
			? null
			: pageFolderPath(targetParentPagePath);
		const plan: PhysicalPageMovePlan = {
			sourcePagePath,
			targetParentPagePath,
			targetPagePath,
			sourceFolderPath,
			targetFolderPath,
			targetContainerPath,
			hasSourceFolder: this.adapter.getEntryKind(sourceFolderPath) === "folder",
		};

		if (canonicalVaultPath(sourcePagePath) === canonicalVaultPath(targetPagePath)) return plan;

		if (
			targetContainerPath !== null
			&& this.adapter.getEntryKind(targetContainerPath) === "file"
		) {
			throw new PhysicalPageMoveError(
				"target-container-blocked",
				`The target container ${targetContainerPath} is a file.`,
			);
		}
		if (this.adapter.getEntryKind(targetPagePath) !== null) {
			throw new PhysicalPageMoveError(
				"target-page-exists",
				`The target page ${targetPagePath} already exists.`,
			);
		}
		if (this.adapter.getEntryKind(sourceFolderPath) === "file") {
			throw new PhysicalPageMoveError(
				"source-folder-blocked",
				`The paired source folder ${sourceFolderPath} is a file.`,
			);
		}
		if (this.adapter.getEntryKind(targetFolderPath) !== null) {
			throw new PhysicalPageMoveError(
				"target-folder-exists",
				`The paired target folder ${targetFolderPath} already exists.`,
			);
		}

		return plan;
	}

	private async rollback(
		plan: PhysicalPageMovePlan,
		pageMoved: boolean,
		folderMoved: boolean,
	): Promise<unknown> {
		let firstError: unknown;
		if (pageMoved) {
			try {
				await this.adapter.move(plan.targetPagePath, plan.sourcePagePath);
			} catch (error) {
				firstError = error;
			}
		}
		if (folderMoved) {
			try {
				await this.adapter.move(plan.targetFolderPath, plan.sourceFolderPath);
			} catch (error) {
				firstError ??= error;
			}
		}
		return firstError;
	}
}
