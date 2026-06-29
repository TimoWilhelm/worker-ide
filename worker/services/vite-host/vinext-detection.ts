/**
 * Detect whether a project is a vinext (Next.js-compatible) app.
 *
 * Detection is driven by the project's manifest and tree rather than runtime
 * probing: a project is a vinext app when it depends on the `vinext` package and
 * exposes an App Router (`app/`) or Pages Router (`pages/`) directory. This is
 * the same signal vinext itself uses to pick a router at config time, so the
 * host's decision matches the framework's.
 */

interface PackageManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/** Whether the manifest declares a dependency on `vinext`. */
function dependsOnVinext(manifest: PackageManifest): boolean {
	return manifest.dependencies?.vinext !== undefined || manifest.devDependencies?.vinext !== undefined;
}

/** Whether the snapshot contains any file under the given top-level directory. */
function hasFilesUnder(files: Record<string, string>, directory: string): boolean {
	const prefix = `${directory}/`;
	return Object.keys(files).some((path) => {
		const normalized = path.replace(/^\/+/, '');
		return normalized === directory || normalized.startsWith(prefix);
	});
}

/**
 * Determine whether the project tree is a vinext app. `files` is a project
 * snapshot keyed by path (leading slash optional); contents are file text.
 */
export function isVinextProject(files: Record<string, string>): boolean {
	const manifestText = files['/package.json'] ?? files['package.json'];
	if (manifestText === undefined) {
		return false;
	}
	let manifest: PackageManifest;
	try {
		manifest = JSON.parse(manifestText);
	} catch {
		return false;
	}
	if (!dependsOnVinext(manifest)) {
		return false;
	}
	return hasFilesUnder(files, 'app') || hasFilesUnder(files, 'pages');
}
