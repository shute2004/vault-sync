export interface MobileMergePlan {
  desiredFiles: Record<string, string>;
  conflicts: string[];
  localApplyPaths: string[];
  remoteChangePaths: string[];
}

/**
 * Build a conservative three-way merge plan from Git blob SHAs.
 *
 * Changes to different paths merge automatically. If both sides changed the
 * same path since the last synchronized snapshot, the path is considered a
 * conflict unless both sides produced the exact same blob.
 */
export function buildMobileMergePlan(
  baseFiles: Record<string, string>,
  localFiles: Record<string, string>,
  remoteFiles: Record<string, string>
): MobileMergePlan {
  const paths = new Set([
    ...Object.keys(baseFiles),
    ...Object.keys(localFiles),
    ...Object.keys(remoteFiles)
  ]);
  const desiredFiles: Record<string, string> = {};
  const conflicts: string[] = [];
  const localApplyPaths: string[] = [];
  const remoteChangePaths: string[] = [];

  for (const path of [...paths].sort()) {
    const base = baseFiles[path];
    const local = localFiles[path];
    const remote = remoteFiles[path];
    const localChanged = local !== base;
    const remoteChanged = remote !== base;

    if (localChanged && remoteChanged && local !== remote) {
      conflicts.push(path);
      continue;
    }

    const desired = localChanged ? local : remote;
    if (desired !== undefined) {
      desiredFiles[path] = desired;
    }

    if (local !== desired) {
      localApplyPaths.push(path);
    }
    if (remote !== desired) {
      remoteChangePaths.push(path);
    }
  }

  return { desiredFiles, conflicts, localApplyPaths, remoteChangePaths };
}
