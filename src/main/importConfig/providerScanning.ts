import type {
  ImportConfigPath,
  ImportSource,
  ImportSourceEnvironment,
  ImportProvider,
} from "../../shared/importDiscovery";
import type { NativeBridge } from "../native/types";
import {
  closeImportEnvironments,
  openImportEnvironments,
  type ImportEnvironment,
} from "./importEnvironments";
import type {
  ImportedMcp,
  UnsupportedImportedMcp,
} from "./utils";
import type { SystemPromptItemInput } from "../native/types";

/** Result of scanning one environment for one provider. */
export type ProviderScannerResult = {
  environment: ImportEnvironment;
  /** Provider home in this environment (e.g. `/home/user/.codex`). */
  home: string;
  found: boolean;
  configPaths: ImportConfigPath[];
  instructionPaths: ImportConfigPath[];
  projectConfigCount: number;
  mcpServers: ImportedMcp[];
  unsupportedMcpServers: UnsupportedImportedMcp[];
  prompts: SystemPromptItemInput[];
  skills: EnvironmentDiscoveredSkill[];
};

export type EnvironmentDiscoveredSkill = {
  sourceDir: string;
  scope: "global" | "project";
  projectId?: string;
  projectRoot?: string;
  environmentId: string;
  environmentLabel: string;
  contentHash: string;
  sshWorkspaceUrl?: string;
};

export type ProviderScanFn = (
  environment: ImportEnvironment,
  warnings: string[]
) => Promise<ProviderScannerResult>;

/**
 * Walk a directory tree for `SKILL.md` files using the environment's fs
 * facade. Mirrors the local `collectSkillDirectories` but works for WSL UNC
 * paths and SSH SFTP paths too.
 */
export const collectSkillDirectoriesForEnvironment = async (
  environment: ImportEnvironment,
  root: string
): Promise<string[]> => {
  const files = await environment.fs.walkFiles(root);
  const sep = environment.fs.sep;
  const suffix = `${sep}SKILL.md`;
  return files
    .filter((file) => file.endsWith(suffix))
    .map((file) => environment.fs.dirname(file));
};

/**
 * Hash a skill directory. Local and WSL use the discovery worker (UNC paths
 * work natively with node:fs). SSH uses the SFTP-based hash.
 */
export const hashSkillForEnvironment = (
  environment: ImportEnvironment,
  sourceDir: string
): Promise<string> => environment.fs.hashPath(sourceDir);

/**
 * Scan every open environment with the given per-provider scan function.
 * Environments that fail to scan are surfaced as warnings, not fatal errors.
 */
export const scanProviderEnvironments = async (
  environments: ImportEnvironment[],
  scanFn: ProviderScanFn
): Promise<{ scans: ProviderScannerResult[]; warnings: string[] }> => {
  const warnings: string[] = [];
  const results = await Promise.all(
    environments.map(async (environment) => {
      try {
        return await scanFn(environment, warnings);
      } catch (error) {
        warnings.push(
          `Failed to scan ${environment.label}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return null;
      }
    })
  );
  return {
    scans: results.filter(
      (result): result is ProviderScannerResult => result !== null
    ),
    warnings,
  };
};

/**
 * Build the shared `ImportSource` shape from per-environment scans. The local
 * environment's home is used as `sourceHome` for backward compatibility; the
 * `environments` array carries per-environment details for the UI.
 */
export const buildProviderSource = (
  scans: ProviderScannerResult[],
  provider: ImportProvider,
  warnings: string[]
): ImportSource => {
  const localScan = scans.find((scan) => scan.environment.kind === "local");
  const sourceHome = localScan?.home ?? scans[0]?.home ?? "";
  const sourceFound = scans.some((scan) => scan.found);
  const configPaths = scans.flatMap((scan) =>
    scan.configPaths.map((configPath) => ({
      label: `${configPath.label} (${scan.environment.label})`,
      path: configPath.path,
      found: configPath.found,
    }))
  );
  const instructionPaths = scans.flatMap((scan) =>
    scan.instructionPaths.map((instructionPath) => ({
      label: `${instructionPath.label} (${scan.environment.label})`,
      path: instructionPath.path,
      found: instructionPath.found,
    }))
  );
  const projectConfigCount = scans.reduce(
    (total, scan) => total + scan.projectConfigCount,
    0
  );
  const environments: ImportSourceEnvironment[] = scans.map((scan) => ({
    environmentId: scan.environment.id,
    label: scan.environment.label,
    kind: scan.environment.kind,
    home: scan.environment.displayHome,
    found: scan.found,
    configPaths: scan.configPaths,
    instructionPaths: scan.instructionPaths,
    projectConfigCount: scan.projectConfigCount,
  }));
  return {
    provider,
    sourceHome,
    sourceFound,
    configPaths,
    instructionPaths,
    projectConfigCount,
    warnings,
    environments,
  };
};

/**
 * Convenience wrapper for standalone provider scans (not going through the
 * unified discovery path): opens environments, scans, and closes them.
 */
export const scanProviderStandalone = async (
  native: NativeBridge,
  scanFn: ProviderScanFn,
  activeDirectoryId?: string
): Promise<{ scans: ProviderScannerResult[]; warnings: string[] }> => {
  const { environments, warnings } = await openImportEnvironments(native, activeDirectoryId);
  try {
    const result = await scanProviderEnvironments(environments, scanFn);
    return {
      scans: result.scans,
      warnings: [...warnings, ...result.warnings],
    };
  } finally {
    closeImportEnvironments(environments);
  }
};
