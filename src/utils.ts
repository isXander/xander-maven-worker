export function getBucket(env: Env, repoName: string): R2Bucket | undefined {
	const repositories = getRepositories(env);
	if (!repositories.includes(repoName)) return undefined;
	return (env as unknown as Record<string, R2Bucket>)[repoName];
}

export function getRepositories(env: Env): string[] {
	return env.REPOSITORIES.split(',').map((s) => s.trim());
}

export const MUTABLE_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=1800, s-maxage=31536000, immutable';

/**
 * Returns whether a given absolute path could potentially be a valid Maven object path.
 * Used for short-circuiting invalid requests to avoid unnecessary R2 bucket lookups.
 * Input should not include the repository name prefix.
 */
export function isPotentialMavenObjectPath(path: string): boolean {
	if (path.startsWith('/')) {
		path = path.slice(1);
	}

	if (path.includes('\\') || path.includes('%')) {
		return false;
	}

	const pathSegments = path.split('/');

	// prevent attempts at path traversal -- they're always invalid anyway
	if (pathSegments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		return false;
	}

	const fileName = pathSegments.at(-1)!;

	// Group-, artifact-, and version-level metadata (and hashes)
	if (fileName.startsWith('maven-metadata.xml')) {
		return pathSegments.length >= 2;
	}

	// <group...>/<artifactId>/<version>/<fileName>
	if (pathSegments.length < 4) {
		return false;
	}

	const artifactId = pathSegments.at(-3)!;
	const version = pathSegments.at(-2)!;

	if (fileName.startsWith(`${artifactId}-${version}.`) || fileName.startsWith(`${artifactId}-${version}-`)) {
		return true;
	}

	// Snapshots do not fit <artifactId>-<version> naming convention
	if (!version.endsWith('-SNAPSHOT')) {
		return false;
	}

	return true;
}
export function isMutablePath(path: string): boolean {
	return path.includes('maven-metadata.xml') || path.includes('SNAPSHOT');
}
export function isOverwritesEnabled(env: Env): boolean {
	return (env.ALLOW_OVERWRITES as string) === 'true';
}
export function getCacheControl(path: string, env: Env): string {
	return isMutablePath(path) || isOverwritesEnabled(env) ? MUTABLE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
}
export function isValidatePathsEnabled(env: Env): boolean {
	return (env.VALIDATE_PATHS as string) === 'true';
}
