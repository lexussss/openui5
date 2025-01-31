const path = require("path");
const {promisify} = require("util");
const fs = require("fs");
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const exists = promisify(fs.exists);
const rimraf = promisify(require("rimraf"));
const glob = promisify(require("glob"));

const configs = require("./config.js");

// See https://github.com/SAP/theming-base-content
const npmPackageName = "@sap-theming/theming-base-content";

const openui5RootDir = path.join(__dirname, "..", "..");

const tmpDir = path.join(openui5RootDir, "tmp", "update-theming-base-content");

function relativePath(p) {
	return path.relative(process.cwd(), p);
}

function makeArray(v) {
	return Array.isArray(v) ? v : [v];
}

async function downloadZip(url) {
	const download = require("download");
	const targetDir = path.join(tmpDir, "zip");

	console.log(`Extracting ${url} to ${relativePath(targetDir)}...\n`);

	await download(url, targetDir, { extract: true });

	// Handle different variations of zip files
	if (await exists(path.join(targetDir, "content"))) {
		return path.join(targetDir, "content");
	} else {
		return targetDir;
	}
}

async function extractNpmPackage(version) {
	const pacote = require("pacote");
	const npmSpec = `${npmPackageName}@${version}`;
	const targetDir = path.join(tmpDir, "npm-package");

	console.log(`Extracting ${npmSpec} to ${relativePath(targetDir)}...\n`);

	await pacote.extract(npmSpec, targetDir);

	return path.join(targetDir, "content");
}

async function main({versionOrUrl}) {
	if (!versionOrUrl) {
		throw new Error("Missing required argument: version or url");
	}

	console.log(`Cleaning tmp folder...\n`);
	await rimraf(tmpDir);

	let baseDir;
	if (/^https?:\/\//.test(versionOrUrl)) {
		baseDir = await downloadZip(versionOrUrl);
	} else {
		baseDir = await extractNpmPackage(versionOrUrl);
	}

	console.log(`\nCopying files...\n`);

	for (const entry of configs) {
		await processConfigEntry(entry);
	}

	async function globFiles({patterns, cwd}) {
		const globResults = await Promise.all(
			patterns.map((pattern) => glob(pattern, {cwd}))
		);
		return Array.prototype.concat.apply([], globResults);
	}

	async function processConfigEntry({src, target, append, processContent, encoding}) {
		target = makeArray(target);
		encoding = encoding || "utf-8";

		const srcFiles = await globFiles({
			patterns: makeArray(src),
			cwd: baseDir
		});

		if (!srcFiles.length) {
			console.log(`[ERROR] Pattern(s) did not match any file: ${src}`);
		}

		async function copyFiles({srcFiles, targetDir}) {
			await Promise.all(srcFiles.map(async (srcFile) => {
				const srcFilePath = path.join(baseDir, srcFile);
				const targetFilePath = path.join(openui5RootDir, targetDir, path.basename(srcFile));
				let content = await readFile(srcFilePath, {encoding});
				if (typeof processContent === "function") {
					content = processContent(content);
				} else if (Array.isArray(processContent)) {
					content = processContent.reduce((content, fn) => {
						return fn(content);
					}, content);
				}
				if (append === true) {
					content = await readFile(targetFilePath, {encoding}) + content;
				}
				console.log(`Copying from ${relativePath(srcFilePath)} to ${relativePath(targetFilePath)}`);
				await writeFile(targetFilePath, content, {encoding});
			}));
		}

		for (const targetDir of target) {
			await copyFiles({srcFiles, targetDir});
		}

	}
}

main({
	versionOrUrl: process.argv[2]
}).catch((err) => {
	console.error(err);
	process.exit(1);
});

