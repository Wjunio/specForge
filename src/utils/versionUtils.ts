export function normalizeVersion(version?: string): string | undefined {
  return version?.trim().replace(/^[~^<>=\s]+/, '') || undefined;
}
