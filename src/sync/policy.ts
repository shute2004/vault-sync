/**
 * Device-local state must never propagate between devices.
 *
 * In particular, a mobile vault with zero installed community plugins must not
 * erase or replace the desktop vault's plugin installation state. Obsidian's
 * local trash is also excluded so a user deletion remains a Git deletion rather
 * than being synchronized as a move into `.trash`.
 */
export function defaultLocalOnlyPaths(configDir: string): string[] {
  return [
    ".git/",
    ".trash/",
    `${configDir}/plugins/`,
    `${configDir}/community-plugins.json`,
    `${configDir}/workspace.json`,
    `${configDir}/workspace-mobile.json`
  ];
}

export function isLocalOnlyPath(path: string, configDir: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return defaultLocalOnlyPaths(configDir).some((entry) => {
    const normalizedEntry = entry.replaceAll("\\", "/");
    return normalizedEntry.endsWith("/")
      ? normalized.startsWith(normalizedEntry)
      : normalized === normalizedEntry;
  });
}
