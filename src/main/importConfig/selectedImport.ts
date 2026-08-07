import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  ImportCandidate,
  ImportCommitItemResult,
  ImportCommitResult,
  ImportScope,
} from "../../shared/importDiscovery";
import type { ImportResourceInput, ImportResourceRecord } from "../../shared/importResources";
import type {
  McpServerConfigInput,
  McpServerConfigRecord,
  NativeBridge,
  ProjectMcpServerConfigRecord,
  SystemPromptItemInput,
  SystemPromptItemRecord,
} from "../native/types";
import {
  hashImportPath,
  normalizeLogicalId,
  type ImportCandidateInput,
} from "./discovery";
import { downloadSshSkillSource } from "./importEnvironments";
import { prepareDirectoryCommit } from "./directoryCommit";
import { ImportExecutionPlan } from "./importTransaction";

export type SelectedImportCandidate = ImportCandidate;

export type ResolvedImportAction = {
  candidate: SelectedImportCandidate;
  scope: ImportScope;
  projectId?: string;
  mcpInput?: McpServerConfigInput;
  promptInput?: SystemPromptItemInput;
  skill?: {
    sourceDir: string;
    destinationDir: string;
    /** SSH workspace URL when the skill source lives on a remote host. */
    sshWorkspaceUrl?: string;
  };
};

const candidateMatchesInput = (
  candidate: SelectedImportCandidate,
  input: ImportCandidateInput
): boolean =>
  candidate.provider === input.provider &&
  candidate.type === input.type &&
  candidate.scope === input.scope &&
  candidate.projectId === input.projectId &&
  candidate.logicalId === normalizeLogicalId(input.logicalId) &&
  candidate.contentHash === input.contentHash;

export const selectionForInput = (
  input: ImportCandidateInput,
  selected: SelectedImportCandidate[]
): SelectedImportCandidate | undefined =>
  selected.find((candidate) => candidateMatchesInput(candidate, input));

export const skillDestination = (
  provider: string,
  sourceDir: string,
  scope: ImportScope,
  projectRoot?: string
): string => {
  const skillId = basename(sourceDir)
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.\.+/g, ".") || "imported";
  const root = scope === "project" && projectRoot
    ? join(projectRoot, ".snow", "skills")
    : join(homedir(), ".snow", "skills");
  return join(root, provider, skillId);
};

const mcpRecordsEqual = (
  left: McpServerConfigRecord | ProjectMcpServerConfigRecord,
  right: McpServerConfigInput
): boolean =>
  left.serverId === right.serverId &&
  left.name === right.name &&
  left.transportType === right.transportType &&
  left.url === right.url &&
  left.command === right.command &&
  left.argsJson === right.argsJson &&
  left.envJson === right.envJson &&
  left.headersJson === right.headersJson &&
  left.enabled === right.enabled &&
  (left.timeoutMs ?? undefined) === right.timeoutMs &&
  left.sortOrder === right.sortOrder &&
  left.source === right.source;

const promptRecordsEqual = (
  left: SystemPromptItemRecord,
  right: SystemPromptItemInput
): boolean =>
  left.promptId === right.promptId &&
  left.name === right.name &&
  left.content === right.content &&
  left.isActive === right.isActive &&
  left.sortOrder === right.sortOrder &&
  left.scope === (right.scope ?? "global") &&
  left.projectId === ((right.scope ?? "global") === "project" ? right.projectId : undefined);

const summaryFor = (results: ImportCommitItemResult[]): ImportCommitResult["summary"] => ({
  selected: results.length,
  imported: results.filter((item) => item.status === "imported").length,
  unchanged: results.filter((item) => item.status === "unchanged").length,
  alreadyEffective: results.filter((item) => item.status === "already-effective").length,
  unsupported: results.filter((item) => item.status === "unsupported").length,
  skipped: results.filter((item) => item.status === "skipped").length,
});

const resultFor = (
  action: ResolvedImportAction,
  status: ImportCommitItemResult["status"],
  message?: string
): ImportCommitItemResult => ({
  candidateId: action.candidate.candidateId,
  type: action.candidate.type,
  logicalId: action.candidate.logicalId,
  status,
  ...(message ? { message } : {}),
});

const resultForCandidate = (
  candidate: SelectedImportCandidate,
  status: ImportCommitItemResult["status"],
  message?: string
): ImportCommitItemResult => ({
  candidateId: candidate.candidateId,
  type: candidate.type,
  logicalId: candidate.logicalId,
  status,
  ...(message ? { message } : {}),
});

const resourceForAction = (action: ResolvedImportAction): ImportResourceInput | null => {
  const target = action.skill
    ? {
        targetId: action.skill.destinationDir,
        targetPath: action.skill.destinationDir,
      }
    : action.mcpInput
      ? {
          targetId: action.mcpInput.serverId,
          targetPath: "",
        }
      : action.promptInput
        ? {
            targetId: action.promptInput.promptId,
            targetPath: "",
          }
        : null;
  if (!target) {
    return null;
  }
  const projectId = action.projectId;
  const resourceId = [
    action.candidate.type,
    action.scope,
    projectId ?? "global",
    target.targetId,
  ].join(":");
  return {
    resourceId,
    resourceType: action.candidate.type,
    scope: action.scope,
    ...(projectId ? { projectId } : {}),
    targetId: target.targetId,
    targetPath: target.targetPath,
    management: "snapshot",
    sources: action.candidate.sources.map((source) => ({
      provider: source.provider,
      scope: source.scope,
      originPath: source.originPath,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      contentHash: action.candidate.contentHash,
    })),
  };
};

const isUnmodifiedManagedSkillSnapshot = (
  resource: ImportResourceRecord,
  action: ResolvedImportAction,
  destinationHash: string
): boolean => {
  if (!action.skill ||
      resource.resourceType !== "skill" ||
      resource.management !== "snapshot" ||
      resource.scope !== action.scope ||
      resource.projectId !== action.projectId ||
      resource.targetPath !== action.skill.destinationDir) {
    return false;
  }

  const tracksCandidateSource = resource.sources.some((trackedSource) =>
    action.candidate.sources.some((source) =>
      source.provider === trackedSource.provider &&
      source.scope === trackedSource.scope &&
      source.originPath === trackedSource.originPath &&
      source.projectId === trackedSource.projectId
    )
  );
  return tracksCandidateSource && resource.sources.every(
    (source) => source.importedHash === destinationHash
  );
};

export const prepareSelectedImport = async (
  native: NativeBridge,
  candidates: SelectedImportCandidate[],
  actions: ResolvedImportAction[],
  plan: ImportExecutionPlan,
  warnings: string[] = []
): Promise<ImportCommitResult> => {
  const results = new Map<string, ImportCommitItemResult>();
  for (const candidate of candidates) {
    if (candidate.status === "already-effective") {
      results.set(candidate.candidateId, resultForCandidate(
        candidate,
        "already-effective",
        "Snow already scans this Skill path"
      ));
    } else if (candidate.status === "unsupported") {
      results.set(candidate.candidateId, resultForCandidate(
        candidate,
        "unsupported",
        candidate.unsupportedReason ?? "This resource is not supported"
      ));
    } else if (candidate.type === "plugin") {
      results.set(candidate.candidateId, resultForCandidate(
        candidate,
        "unsupported",
        "Plugin management is scheduled for Phase 4"
      ));
    }
  }

  const selectedIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const actionable = actions.filter((action) =>
    selectedIds.has(action.candidate.candidateId) &&
    !results.has(action.candidate.candidateId)
  );
  const globalMcp = await native.listMcpServerConfigs();
  const managedResources = await native.listImportResources();
  const projectIds = [...new Set(actionable
    .filter((action) => action.projectId && action.mcpInput)
    .map((action) => action.projectId as string))];
  const projectMcp = new Map<string, ProjectMcpServerConfigRecord[]>();
  for (const projectId of projectIds) {
    projectMcp.set(projectId, await native.listProjectMcpServerConfigs(projectId));
  }
  const prompts = await native.listSystemPrompts();

  try {
    for (const action of actionable) {
      if (action.mcpInput) {
        const input = action.mcpInput;
        if (action.scope === "project" && action.projectId) {
          const existing = projectMcp.get(action.projectId)?.find((item) => item.serverId === input.serverId);
          if (existing && mcpRecordsEqual(existing, input)) {
            results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
            continue;
          }
          plan.addProjectMcpServer(action.projectId, input);
        } else {
          const existing = globalMcp.find((item) => item.serverId === input.serverId);
          if (existing && mcpRecordsEqual(existing, input)) {
            results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
            continue;
          }
          plan.addMcpServer(input);
        }
        results.set(action.candidate.candidateId, resultFor(action, "imported"));
      } else if (action.promptInput) {
        const input = action.promptInput;
        const existing = prompts.find((item) => item.promptId === input.promptId);
        if (existing && promptRecordsEqual(existing, input)) {
          results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
          continue;
        }
        plan.addSystemPrompt(input);
        results.set(action.candidate.candidateId, resultFor(action, "imported"));
      } else if (action.skill) {
        if (action.skill.sshWorkspaceUrl) {
          // The skill source lives on an SSH host; download it into a local
          // staging directory first, then commit it through the regular
          // directory machinery.
          let staged;
          try {
            staged = await downloadSshSkillSource(
              action.skill.sshWorkspaceUrl,
              action.skill.sourceDir
            );
          } catch (error) {
            results.set(action.candidate.candidateId, resultFor(
              action,
              "unsupported",
              `Failed to download remote skill: ${
                error instanceof Error ? error.message : String(error)
              }`
            ));
            continue;
          }
          try {
            if (existsSync(action.skill.destinationDir)) {
              const destinationHash = await hashImportPath(action.skill.destinationDir);
              if (destinationHash === action.candidate.contentHash) {
                results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
              } else {
                const managedSnapshot = managedResources.find((resource) =>
                  isUnmodifiedManagedSkillSnapshot(resource, action, destinationHash)
                );
                if (!managedSnapshot) {
                  results.set(action.candidate.candidateId, resultFor(
                    action,
                    "skipped",
                    "Snow destination already exists with different content"
                  ));
                  continue;
                }
                plan.addDirectory(
                  prepareDirectoryCommit(staged.localDir, action.skill.destinationDir),
                  true
                );
                results.set(action.candidate.candidateId, resultFor(action, "imported"));
              }
              continue;
            }
            plan.addDirectory(
              prepareDirectoryCommit(staged.localDir, action.skill.destinationDir),
              false
            );
            results.set(action.candidate.candidateId, resultFor(action, "imported"));
          } finally {
            staged.cleanup();
          }
          continue;
        }
        if (!existsSync(action.skill.sourceDir)) {
          results.set(resultFor(action, "unsupported").candidateId, resultFor(
            action,
            "unsupported",
            "Skill source no longer exists"
          ));
          continue;
        }
        if (existsSync(action.skill.destinationDir)) {
          const destinationHash = await hashImportPath(action.skill.destinationDir);
          if (destinationHash === action.candidate.contentHash) {
            results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
          } else {
            const managedSnapshot = managedResources.find((resource) =>
              isUnmodifiedManagedSkillSnapshot(resource, action, destinationHash)
            );
            if (!managedSnapshot) {
              results.set(action.candidate.candidateId, resultFor(
                action,
                "skipped",
                "Snow destination already exists with different content"
              ));
              continue;
            }
            plan.addDirectory(
              prepareDirectoryCommit(action.skill.sourceDir, action.skill.destinationDir),
              true
            );
            results.set(action.candidate.candidateId, resultFor(action, "imported"));
          }
          continue;
        }
        plan.addDirectory(
          prepareDirectoryCommit(action.skill.sourceDir, action.skill.destinationDir),
          false
        );
        results.set(action.candidate.candidateId, resultFor(action, "imported"));
      } else {
        results.set(action.candidate.candidateId, resultFor(
          action,
          "unsupported",
          "No import handler is available for this resource"
        ));
      }
    }

    const resources = actionable
      .filter((action) => {
        const status = results.get(action.candidate.candidateId)?.status;
        return status === "imported" || status === "unchanged";
      })
      .map(resourceForAction)
      .filter((resource): resource is ImportResourceInput => Boolean(resource));
    if (resources.length > 0) {
      plan.addImportResources(resources);
    }
  } catch (error) {
    plan.discard();
    throw error;
  }

  for (const action of actionable) {
    if (!results.has(action.candidate.candidateId)) {
      results.set(action.candidate.candidateId, resultFor(
        action,
        "skipped",
        "Resource was not changed"
      ));
    }
  }

  const itemResults = candidates.map((candidate) => results.get(candidate.candidateId) ?? resultForCandidate(
    candidate,
    "unsupported",
    "Selected resource could not be resolved from the current source"
  ));
  return {
    applied: true,
    itemResults,
    summary: summaryFor(itemResults),
    warnings,
  };
};

export const commitSelectedImport = async (
  native: NativeBridge,
  candidates: SelectedImportCandidate[],
  actions: ResolvedImportAction[],
  warnings: string[] = []
): Promise<ImportCommitResult> => {
  const plan = new ImportExecutionPlan();
  try {
    const result = await prepareSelectedImport(native, candidates, actions, plan, warnings);
    await plan.commit(native);
    return result;
  } catch (error) {
    plan.discard();
    throw new Error(
      "Selected import was rolled back: " +
        (error instanceof Error ? error.message : String(error))
    );
  }
};
