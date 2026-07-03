export function getBucket(env: Env, repoName: string): R2Bucket | undefined {
	const repositories = getRepositories(env);
	if (!repositories.includes(repoName)) return undefined;
	return (env as unknown as Record<string, R2Bucket>)[repoName];
}

export function getRepositories(env: Env): string[] {
	return env.REPOSITORIES.split(',').map((s) => s.trim());
}

export const MUTABLE_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=1800, s-maxage=31536000';

export function isMutablePath(path: string): boolean {
	return path.includes('maven-metadata.xml') || path.includes('SNAPSHOT');
}
export function isOverwritesEnabled(env: Env): boolean {
	return (env.ALLOW_OVERWRITES as string) === 'true';
}
export function getCacheControl(path: string, env: Env): string {
	return isMutablePath(path) || isOverwritesEnabled(env) ? MUTABLE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
}
