import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type DirectoryCommit = {
  readonly targetPath: string;
  readonly stagingRoot: string;
  commit: (options?: { replaceExisting?: boolean }) => void;
  rollback: () => void;
  cleanup: () => void;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const recoveryError = (
  action: string,
  targetPath: string,
  stagingRoot: string,
  error: unknown
): Error => new Error(
  `${action} for ${targetPath} could not be recovered automatically: ${errorMessage(error)}. ` +
  `Recovery data was kept at ${stagingRoot}`
);

/**
 * Copy a directory into a target-local staging root, then promote it with a
 * same-directory rename. The returned transaction keeps a replaced target
 * available until its caller either rolls back or cleans up.
 */
export const prepareDirectoryCommit = (
  sourcePath: string,
  targetPath: string
): DirectoryCommit => {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new Error(`Directory source does not exist: ${sourcePath}`);
  }

  const targetParent = dirname(targetPath);
  mkdirSync(targetParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(targetParent, `.${basename(targetPath)}.snow-stage-`));
  const stagedPath = join(stagingRoot, "new");
  const backupPath = join(stagingRoot, "previous");
  let committed = false;
  let replacedTarget = false;
  let preserveRecovery = false;

  try {
    cpSync(sourcePath, stagedPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw new Error(`Failed to stage ${sourcePath} for ${targetPath}: ${errorMessage(error)}`);
  }

  const restorePrevious = (): void => {
    if (!replacedTarget || !existsSync(backupPath)) return;
    renameSync(backupPath, targetPath);
  };

  return {
    targetPath,
    stagingRoot,
    commit: ({ replaceExisting = true } = {}): void => {
      if (committed) {
        throw new Error(`Directory transaction has already been committed: ${targetPath}`);
      }
      if (existsSync(targetPath)) {
        if (!replaceExisting) {
          throw new Error(`Target directory appeared during commit: ${targetPath}`);
        }
        try {
          renameSync(targetPath, backupPath);
          replacedTarget = true;
        } catch (error) {
          throw new Error(`Failed to preserve existing target ${targetPath}: ${errorMessage(error)}`);
        }
      }

      try {
        renameSync(stagedPath, targetPath);
        committed = true;
      } catch (error) {
        try {
          restorePrevious();
        } catch (restoreError) {
          preserveRecovery = true;
          throw recoveryError("Directory commit", targetPath, stagingRoot, restoreError);
        }
        throw new Error(`Failed to commit directory ${targetPath}: ${errorMessage(error)}`);
      }
    },
    rollback: (): void => {
      if (!committed) return;
      try {
        rmSync(targetPath, { recursive: true, force: true });
        restorePrevious();
        committed = false;
      } catch (error) {
        preserveRecovery = true;
        throw recoveryError("Directory rollback", targetPath, stagingRoot, error);
      }
    },
    cleanup: (): void => {
      if (!preserveRecovery) {
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    },
  };
};
