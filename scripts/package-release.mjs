import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseFiles = ["main.js", "manifest.json", "styles.css"];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function requireText(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string.`);
	}
}

function requireVersion(value, label) {
	if (typeof value !== "string" || !versionPattern.test(value)) {
		throw new Error(`${label} must be a release version in x.y.z format.`);
	}
}

function requireEqual(actual, expected, label) {
	if (actual !== expected) {
		throw new Error(`${label} must equal ${JSON.stringify(expected)}.`);
	}
}

async function statIfPresent(target) {
	try {
		return await lstat(target);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readRegularFile(target) {
	const stat = await lstat(target);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`Expected a regular file without a symbolic link: ${target}`);
	}
	return readFile(target);
}

async function readJson(root, filename) {
	return JSON.parse((await readRegularFile(path.join(root, filename))).toString("utf8"));
}

async function ensureDirectory(target, create = false) {
	const stat = await statIfPresent(target);
	if (stat) {
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Expected a directory without a symbolic link: ${target}`);
		}
	} else if (create) {
		await mkdir(target);
	} else {
		throw new Error(`Directory does not exist: ${target}`);
	}
}

async function checkDestination(target) {
	const stat = await statIfPresent(target);
	if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)) {
		throw new Error(`Refusing to overwrite a linked or non-regular release file: ${target}`);
	}
}

export async function packageRelease(root = projectRoot) {
	root = path.resolve(root);
	await ensureDirectory(root);
	const [pkg, lock, manifest, versions] = await Promise.all([
		readJson(root, "package.json"),
		readJson(root, "package-lock.json"),
		readJson(root, "manifest.json"),
		readJson(root, "versions.json"),
	]);
	for (const field of ["name", "description", "author", "license"]) {
		requireText(pkg[field], `package.json ${field}`);
	}
	requireEqual(pkg.main, "main.js", "package.json main");
	requireVersion(pkg.version, "package.json version");
	for (const field of ["id", "name", "description", "author"]) {
		requireText(manifest[field], `manifest.json ${field}`);
	}
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) {
		throw new Error("manifest.json id must use lowercase letters, digits, and separating hyphens.");
	}
	if (typeof manifest.isDesktopOnly !== "boolean") {
		throw new Error("manifest.json isDesktopOnly must be a boolean.");
	}
	requireVersion(manifest.minAppVersion, "manifest.json minAppVersion");
	requireEqual(manifest.id, pkg.name, "manifest.json id");
	requireEqual(manifest.version, pkg.version, "manifest.json version");
	requireEqual(lock.name, pkg.name, "package-lock.json name");
	requireEqual(lock.version, pkg.version, "package-lock.json version");
	requireEqual(lock.packages?.[""]?.name, pkg.name, "package-lock.json packages[''].name");
	requireEqual(lock.packages?.[""]?.version, pkg.version, "package-lock.json packages[''].version");
	requireEqual(lock.packages?.[""]?.license, pkg.license, "package-lock.json packages[''].license");
	if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
		throw new Error("versions.json must be an object mapping releases to minimum Obsidian versions.");
	}
	for (const [version, minimum] of Object.entries(versions)) {
		requireVersion(version, "versions.json release");
		requireVersion(minimum, `versions.json ${version}`);
	}
	requireEqual(versions[pkg.version], manifest.minAppVersion, `versions.json ${pkg.version}`);

	// Check every source before creating output or replacing an earlier package.
	const sourceBuffers = await Promise.all(releaseFiles.map(async (filename) => {
		const contents = await readRegularFile(path.join(root, filename));
		if (contents.length === 0) throw new Error(`Release file is empty: ${filename}`);
		return contents;
	}));
	const distDirectory = path.join(root, "dist");
	const outputDirectory = path.join(distDirectory, pkg.version);
	await ensureDirectory(distDirectory, true);
	await ensureDirectory(outputDirectory, true);
	const existing = await readdir(outputDirectory);
	const unexpected = existing.filter((filename) => !releaseFiles.includes(filename));
	if (unexpected.length > 0) {
		throw new Error(`Release directory contains unexpected entries; no files were removed: ${unexpected.join(", ")}`);
	}
	await Promise.all(releaseFiles.map((filename) => checkDestination(path.join(outputDirectory, filename))));
	for (const [index, filename] of releaseFiles.entries()) {
		const destination = path.join(outputDirectory, filename);
		await checkDestination(destination);
		await copyFile(path.join(root, filename), destination);
		const copied = await readRegularFile(destination);
		if (!copied.equals(sourceBuffers[index])) {
			throw new Error(`Release file changed during packaging: ${filename}. Rebuild and retry.`);
		}
	}
	return { version: pkg.version, outputDirectory, files: [...releaseFiles] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await packageRelease();
		console.log(`Packaged PageTree ${result.version}: ${result.outputDirectory}`);
		for (const filename of result.files) console.log(`  ${filename}`);
	} catch (error) {
		console.error(`Packaging failed: ${error.message}`);
		process.exitCode = 1;
	}
}
