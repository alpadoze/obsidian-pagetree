import { pageFolderPath, renamedPagePath } from "./page-path";
import { pageTitleToPath } from "./page-title";
import { canonicalVaultPath } from "./tree-state";
import type { PhysicalPageMoveAdapter } from "./physical-page-mover";

export type PhysicalPageRenameErrorCode =
	| "source-not-file"
	| "invalid-target-title"
	| "target-page-exists"
	| "source-folder-blocked"
	| "target-folder-exists"
	| "physical-rename-failed"
	| "metadata-commit-failed"
	| "rollback-failed";

export class PhysicalPageRenameError extends Error {
	constructor(
		public readonly code: PhysicalPageRenameErrorCode,
		message: string,
		public readonly originalError?: unknown,
		public readonly rollbackError?: unknown,
	) {
		super(message);
		this.name = "PhysicalPageRenameError";
	}
}

export interface PhysicalPageRenamePlan {
	sourcePagePath: string;
	targetPagePath: string;
	sourceFolderPath: string;
	targetFolderPath: string;
	hasSourceFolder: boolean;
}

export interface PhysicalPageRenameResult {
	renamed: boolean;
	plan: PhysicalPageRenamePlan;
}

export class PhysicalPageRenamer {
	constructor(private readonly adapter: PhysicalPageMoveAdapter) {}

	async synchronizeExternalRename(
		sourcePagePath: string,
		targetPagePath: string,
		commitMetadata: (plan: PhysicalPageRenamePlan) => Promise<void>,
	): Promise<PhysicalPageRenameResult> {
		let plan: PhysicalPageRenamePlan;
		try {
			plan = this.createExternalPlan(sourcePagePath, targetPagePath);
		} catch (error) {
			const rollbackError = await this.rollbackExternalPageRename(
				sourcePagePath,
				targetPagePath,
			);
			if (rollbackError !== undefined) {
				throw new PhysicalPageRenameError(
					"rollback-failed",
					"The native page rename could not be accepted or rolled back.",
					error,
					rollbackError,
				);
			}
			throw error;
		}

		let folderMoved = false;
		try {
			if (plan.hasSourceFolder) {
				await this.adapter.move(plan.sourceFolderPath, plan.targetFolderPath);
				folderMoved = true;
			}
		} catch (error) {
			const rollbackError = await this.rollbackExternal(plan, folderMoved);
			if (rollbackError !== undefined) {
				throw new PhysicalPageRenameError(
					"rollback-failed",
					"Synchronizing the paired folder failed and the native rename could not be rolled back.",
					error,
					rollbackError,
				);
			}
			throw new PhysicalPageRenameError(
				"physical-rename-failed",
				"Synchronizing the paired folder failed and the native rename was rolled back.",
				error,
			);
		}

		try {
			await commitMetadata(plan);
		} catch (error) {
			const rollbackError = await this.rollbackExternal(plan, folderMoved);
			if (rollbackError !== undefined) {
				throw new PhysicalPageRenameError(
					"rollback-failed",
					"Metadata persistence failed and the native rename could not be fully rolled back.",
					error,
					rollbackError,
				);
			}
			throw new PhysicalPageRenameError(
				"metadata-commit-failed",
				"Metadata persistence failed and the native rename was rolled back.",
				error,
			);
		}

		return { renamed: true, plan };
	}

	async renamePage(
		sourcePagePath: string,
		targetTitleOrFilename: string,
		commitMetadata: (plan: PhysicalPageRenamePlan) => Promise<void>,
	): Promise<PhysicalPageRenameResult> {
		const titleResult = pageTitleToPath(targetTitleOrFilename);
		if (!titleResult.valid) {
			throw new PhysicalPageRenameError(
				"invalid-target-title",
				"The target page title cannot be used as a Markdown filename.",
			);
		}

		const plan = this.createPlan(sourcePagePath, titleResult.path);
		if (canonicalVaultPath(plan.sourcePagePath) === canonicalVaultPath(plan.targetPagePath)) {
			return { renamed: false, plan };
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
				throw new PhysicalPageRenameError(
					"rollback-failed",
					"The physical page rename failed and could not be fully rolled back.",
					error,
					rollbackError,
				);
			}
			throw new PhysicalPageRenameError(
				"physical-rename-failed",
				"The physical page rename failed and was rolled back.",
				error,
			);
		}

		try {
			await commitMetadata(plan);
		} catch (error) {
			const rollbackError = await this.rollback(plan, pageMoved, folderMoved);
			if (rollbackError !== undefined) {
				throw new PhysicalPageRenameError(
					"rollback-failed",
					"Metadata persistence failed and the physical rename could not be fully rolled back.",
					error,
					rollbackError,
				);
			}
			throw new PhysicalPageRenameError(
				"metadata-commit-failed",
				"Metadata persistence failed and the physical rename was rolled back.",
				error,
			);
		}

		return { renamed: true, plan };
	}

	private createPlan(sourcePagePath: string, targetFilename: string): PhysicalPageRenamePlan {
		if (this.adapter.getEntryKind(sourcePagePath) !== "file") {
			throw new PhysicalPageRenameError(
				"source-not-file",
				`The source page ${sourcePagePath} is not a file.`,
			);
		}

		const targetPagePath = renamedPagePath(sourcePagePath, targetFilename);
		const sourceFolderPath = pageFolderPath(sourcePagePath);
		const targetFolderPath = pageFolderPath(targetPagePath);
		const plan: PhysicalPageRenamePlan = {
			sourcePagePath,
			targetPagePath,
			sourceFolderPath,
			targetFolderPath,
			hasSourceFolder: this.adapter.getEntryKind(sourceFolderPath) === "folder",
		};

		if (canonicalVaultPath(sourcePagePath) === canonicalVaultPath(targetPagePath)) return plan;
		if (this.adapter.getEntryKind(targetPagePath) !== null) {
			throw new PhysicalPageRenameError(
				"target-page-exists",
				`The target page ${targetPagePath} already exists.`,
			);
		}
		if (this.adapter.getEntryKind(sourceFolderPath) === "file") {
			throw new PhysicalPageRenameError(
				"source-folder-blocked",
				`The paired source folder ${sourceFolderPath} is a file.`,
			);
		}
		if (this.adapter.getEntryKind(targetFolderPath) !== null) {
			throw new PhysicalPageRenameError(
				"target-folder-exists",
				`The paired target folder ${targetFolderPath} already exists.`,
			);
		}

		return plan;
	}

	private createExternalPlan(
		sourcePagePath: string,
		targetPagePath: string,
	): PhysicalPageRenamePlan {
		if (this.adapter.getEntryKind(targetPagePath) !== "file") {
			throw new PhysicalPageRenameError(
				"source-not-file",
				`The natively renamed page ${targetPagePath} is not a file.`,
			);
		}

		const sourceFolderPath = pageFolderPath(sourcePagePath);
		const targetFolderPath = pageFolderPath(targetPagePath);
		const sourceFolderKind = this.adapter.getEntryKind(sourceFolderPath);
		const plan: PhysicalPageRenamePlan = {
			sourcePagePath,
			targetPagePath,
			sourceFolderPath,
			targetFolderPath,
			hasSourceFolder: sourceFolderKind === "folder",
		};
		if (sourceFolderKind === "file") {
			throw new PhysicalPageRenameError(
				"source-folder-blocked",
				`The paired source folder ${sourceFolderPath} is a file.`,
			);
		}
		if (
			canonicalVaultPath(sourceFolderPath) !== canonicalVaultPath(targetFolderPath)
			&& this.adapter.getEntryKind(targetFolderPath) !== null
		) {
			throw new PhysicalPageRenameError(
				"target-folder-exists",
				`The paired target folder ${targetFolderPath} already exists.`,
			);
		}
		return plan;
	}

	private async rollback(
		plan: PhysicalPageRenamePlan,
		pageMoved: boolean,
		folderMoved: boolean,
	): Promise<unknown | undefined> {
		let firstError: unknown | undefined;
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

	private async rollbackExternal(
		plan: PhysicalPageRenamePlan,
		folderMoved: boolean,
	): Promise<unknown | undefined> {
		let firstError: unknown | undefined;
		if (folderMoved) {
			try {
				await this.adapter.move(plan.targetFolderPath, plan.sourceFolderPath);
			} catch (error) {
				firstError = error;
			}
		}
		const pageRollbackError = await this.rollbackExternalPageRename(
			plan.sourcePagePath,
			plan.targetPagePath,
		);
		return firstError ?? pageRollbackError;
	}

	private async rollbackExternalPageRename(
		sourcePagePath: string,
		targetPagePath: string,
	): Promise<unknown | undefined> {
		if (this.adapter.getEntryKind(targetPagePath) !== "file") return undefined;
		try {
			await this.adapter.move(targetPagePath, sourcePagePath);
			return undefined;
		} catch (error) {
			return error;
		}
	}
}
