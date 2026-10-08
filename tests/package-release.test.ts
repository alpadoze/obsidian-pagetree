import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageRelease } from "../scripts/package-release.mjs";

const temporaryRoots: string[] = [];

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "page-tree-package-"));
	temporaryRoots.push(root);
	const pkg = {
		name: "page-tree", version: "1.2.3", description: "Test plugin", author: "alpadoze", license: "MIT", main: "main.js",
	};
	const lock = {
		name: pkg.name, version: pkg.version,
		packages: { "": { name: pkg.name, version: pkg.version, license: pkg.license } },
	};
	const manifest = {
		id: pkg.name, name: "PageTree", version: pkg.version, minAppVersion: "1.8.7",
		description: pkg.description, author: pkg.author, isDesktopOnly: false,
	};
	await Promise.all([
		writeFile(path.join(root, "package.json"), JSON.stringify(pkg)),
		writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock)),
		writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest)),
		writeFile(path.join(root, "versions.json"), JSON.stringify({ [pkg.version]: manifest.minAppVersion })),
		writeFile(path.join(root, "main.js"), "module.exports = {};\n"),
		writeFile(path.join(root, "styles.css"), ".page-tree {}\n"),
		writeFile(path.join(root, "data.json"), '{"private":"must not ship"}'),
	]);
	return { root, pkg, lock, manifest, output: path.join(root, "dist", pkg.version) };
}

afterEach(async () => {
	// Each path is created by mkdtemp for this test, never a project or user directory.
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release packaging", () => {
	it("packages only the three install files and supports replacing the same release", async () => {
		const { root, output } = await fixture();
		const result = await packageRelease(root);
		expect(result.version).toBe("1.2.3");
		expect(result.outputDirectory).toBe(output);
		expect((await readdir(output)).sort()).toEqual(["main.js", "manifest.json", "styles.css"]);
		await writeFile(path.join(root, "main.js"), "module.exports = { updated: true };\n");
		await packageRelease(root);
		for (const filename of result.files) {
			expect(await readFile(path.join(output, filename))).toEqual(await readFile(path.join(root, filename)));
		}
	});

	it.each(["version", "rootVersion"])("rejects a mismatched package-lock %s before creating dist", async (field) => {
		const { root, lock } = await fixture();
		if (field === "version") lock.version = "1.2.2";
		else lock.packages[""].version = "1.2.2";
		await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
		await expect(packageRelease(root)).rejects.toThrow("package-lock.json");
		await expect(readdir(path.join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects missing required metadata", async () => {
		const { root, manifest } = await fixture();
		manifest.author = "";
		await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
		await expect(packageRelease(root)).rejects.toThrow("manifest.json author");
	});

	it("rejects an incompatible versions.json entry", async () => {
		const { root } = await fixture();
		await writeFile(path.join(root, "versions.json"), JSON.stringify({ "1.2.3": "1.9.0" }));
		await expect(packageRelease(root)).rejects.toThrow("versions.json 1.2.3");
	});

	it.each(["../outside", "1.2.3/extra", "1.2.3-beta", "01.2.3"])("rejects unsafe or unsupported version %s", async (version) => {
		const { root, pkg } = await fixture();
		pkg.version = version;
		await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
		await expect(packageRelease(root)).rejects.toThrow("x.y.z");
		await expect(readdir(path.join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses extra output files without deleting or overwriting anything", async () => {
		const { root, output } = await fixture();
		await mkdir(output, { recursive: true });
		await writeFile(path.join(output, "main.js"), "earlier release");
		await writeFile(path.join(output, "data.json"), "private state");
		await expect(packageRelease(root)).rejects.toThrow("unexpected entries");
		expect(await readFile(path.join(output, "main.js"), "utf8")).toBe("earlier release");
		expect(await readFile(path.join(output, "data.json"), "utf8")).toBe("private state");
	});

	it("refuses a linked output directory", async () => {
		const { root } = await fixture();
		const external = await mkdtemp(path.join(os.tmpdir(), "page-tree-package-linked-"));
		temporaryRoots.push(external);
		await symlink(external, path.join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
		await expect(packageRelease(root)).rejects.toThrow("symbolic link");
		expect(await readdir(external)).toEqual([]);
	});

	it("rejects an empty install file before creating the output", async () => {
		const { root } = await fixture();
		await writeFile(path.join(root, "main.js"), "");
		await expect(packageRelease(root)).rejects.toThrow("Release file is empty: main.js");
		await expect(readdir(path.join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
