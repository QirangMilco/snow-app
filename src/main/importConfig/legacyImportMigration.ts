import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ImportResourceInput } from "../../shared/importResources";
import type { NativeBridge, WorkspaceDirectoryRecord } from "../native/types";
import { discoverCodexImport } from "../codex/importer";
import { discoverClaudeCodeImport } from "./claudeCodeImporter";
import { hashImportPath, normalizeLogicalId, type ImportCandidateInput } from "./discovery";
import { listImportDirectoriesInWorker } from "./discoveryWorker";
import { discoverOpenCodeImport } from "./openCodeImporter";

const MIGRATION_SETTING = "import-resource-migration-v2";
const LEGACY_PROVIDERS = ["codex", "claude-code", "opencode"] as const;

const isLegacySnapshotPath = (path: string, roots: string[]): boolean =>
  roots.some((root) => {
    const provider = relative(resolve(root), resolve(path)).split(sep)[0];
    return LEGACY_PROVIDERS.includes(provider as typeof LEGACY_PROVIDERS[number]);
  });

const collectSkillSnapshots = async (
  root: string,
  scope: "global" | "project",
  candidates: ImportCandidateInput[],
  projectId?: string
): Promise<ImportResourceInput[]> => {
  const resources: ImportResourceInput[] = [];
  for (const provider of LEGACY_PROVIDERS) {
    const providerRoot = join(root, provider);
    for (const targetPath of await listImportDirectoriesInWorker(providerRoot)) {
      try {
        const contentHash = await hashImportPath(targetPath);
        const logicalId = normalizeLogicalId(basename(targetPath));
        const matchingSources = candidates.filter((candidate) =>
          candidate.type === "skill" &&
          candidate.provider === provider &&
          candidate.scope === scope &&
          candidate.projectId === projectId &&
          normalizeLogicalId(candidate.logicalId) === logicalId
        );
        if (matchingSources.length === 0) continue;
        resources.push({
          resourceId: ["skill", scope, projectId ?? "global", targetPath].join(":"),
          resourceType: "skill",
          scope,
          ...(projectId ? { projectId } : {}),
          targetId: targetPath,
          targetPath,
          management: "snapshot",
          sources: matchingSources.map((source) => ({
            provider: source.provider,
            scope: source.scope,
            originPath: source.originPath,
            ...(source.projectId ? { projectId: source.projectId } : {}),
            contentHash,
          })),
        });
      } catch {
        // Leave unreadable legacy copies untouched; a later import can register them safely.
      }
    }
  }
  return resources;
};

const projectSkillSnapshots = async (
  projects: WorkspaceDirectoryRecord[],
  candidates: ImportCandidateInput[]
): Promise<ImportResourceInput[]> =>
  (await Promise.all(projects
    .filter((project) => project.kind === "local")
    .map((project) =>
      collectSkillSnapshots(join(project.path, ".snow", "skills"), "project", candidates, project.directoryId)
    ))).flat();

export const ensureLegacyImportResourceMigration = async (native: NativeBridge): Promise<void> => {
  if (await native.getSystemSettingValue(MIGRATION_SETTING)) {
    return;
  }
  const [projects, codex, claudeCode, openCode, existing] = await Promise.all([
    native.listWorkspaceDirectories(),
    discoverCodexImport(native),
    discoverClaudeCodeImport(native),
    discoverOpenCodeImport(native),
    native.listImportResources(),
  ]);
  const candidates = [
    ...codex.candidates,
    ...claudeCode.candidates,
    ...openCode.candidates,
  ];
  const legacyRoots = [
    join(homedir(), ".snow", "skills"),
    ...projects.filter((project) => project.kind === "local").map((project) => join(project.path, ".snow", "skills")),
  ];
  for (const resource of existing) {
    if (resource.resourceType !== "skill" || resource.management !== "snapshot" || !isLegacySnapshotPath(resource.targetPath, legacyRoots)) {
      continue;
    }
    for (const source of resource.sources.filter((item) => item.provider === "snow" && item.originPath === resource.targetPath)) {
      await native.releaseImportResource({
        resourceId: resource.resourceId,
        sourceId: source.sourceId,
        disposition: "delete",
      });
    }
  }
  const resources = [
    ...await collectSkillSnapshots(join(homedir(), ".snow", "skills"), "global", candidates),
    ...await projectSkillSnapshots(projects, candidates),
  ];
  if (resources.length > 0) {
    await native.upsertImportResources(resources);
  }
  await native.setSystemSetting(
    "Import resource migration version",
    MIGRATION_SETTING,
    "1"
  );
};
