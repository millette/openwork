/**
 * Server-managed provider credentials live in this server's env store; a
 * provider's runtime config only *names* its credential env vars via
 * `env: [...]`. The engine's provider mirror resolves the one credential each
 * provider declares, never the server environment.
 */

function credentialEnvRank(name: string): number | null {
  const normalized = name.trim().toUpperCase();
  if (/(^|_)API_KEY$/.test(normalized)) return 0;
  if (/(^|_)ACCESS_KEY_ID$/.test(normalized)) return 1;
  if (/(^|_)BEARER_TOKEN(_|$)/.test(normalized) || /(^|_)TOKEN$/.test(normalized)) return 2;
  if (/(^|_)KEY$/.test(normalized)) return 3;
  return null;
}

export function selectPrimaryCredentialEnvName(
  envNames: string[],
  availableNames: Iterable<string>,
): string | null {
  const available = new Set([...availableNames].filter((name) => name.trim().length > 0));
  const orderedNames = envNames.filter((name) => available.has(name));
  const ranked = orderedNames
    .map((name, index) => ({ name, index, rank: credentialEnvRank(name) }))
    .filter((entry): entry is { name: string; index: number; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  if (ranked[0]) return ranked[0].name;
  if (envNames.length > 1 && envNames.some((name) => credentialEnvRank(name) !== null)) return null;
  return orderedNames[0] ?? null;
}
