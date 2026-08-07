import { existsSync } from "node:fs";
import type { NativeBridge } from "../native/types";
import type { ImportDiscovery } from "../../shared/importDiscovery";
import type { ImportResourceRecord } from "../../shared/importResources";
import {
  buildCodexContext,
  discoverCodexImportFromContext,
  type CodexImportContext,
} from "../codex/importer";
import {
  buildClaudeCodeContext,
  discoverClaudeCodeImportFromContext,
  type ClaudeCodeImportContext,
} from "./claudeCodeImporter";
import { buildImportDiscovery } from "./discovery";
import {
  buildOpenCodeContext,
  discoverOpenCodeImportFromContext,
  type OpenCodeImportContext,
} from "./openCodeImporter";
import { discoverPluginImports } from "./pluginManager";

export const existingManagedResourceIds = async (
  native: NativeBridge,
  resources: ImportResourceRecord[]
): Promise<Set<string>> => {
  const [globalMcp, prompts] = await Promise.all([
    native.listMcpServerConfigs(),
    native.listSystemPrompts(),
  ]);
  const globalMcpIds = new Set(globalMcp.map((item) => item.serverId));
  const promptIds = new Set(prompts.map((item) => item.promptId));
  const projectIds = [
    ...new Set(
      resources
        .filter(
          (resource) =>
            resource.resourceType === "mcp" &&
            resource.scope === "project" &&
            resource.projectId
        )
        .map((resource) => resource.projectId as string)
    ),
  ];
  const projectMcpByProject = new Map(
    await Promise.all(
      projectIds.map(
        async (projectId) =>
          [
            projectId,
            await native.listProjectMcpServerConfigs(projectId),
          ] as const
      )
    )
  );

  return new Set(
    resources.flatMap((resource) => {
      if (resource.resourceType === "mcp") {
        const projectId = resource.projectId;
        const exists =
          resource.scope === "project"
            ? projectId !== undefined &&
              Boolean(
                projectMcpByProject
                  .get(projectId)
                  ?.some((item) => item.serverId === resource.targetId)
              )
            : globalMcpIds.has(resource.targetId);
        return exists ? [resource.resourceId] : [];
      }
      if (resource.resourceType === "skill") {
        return resource.targetPath && existsSync(resource.targetPath)
          ? [resource.resourceId]
          : [];
      }
      if (
        resource.resourceType === "prompt" ||
        resource.resourceType === "command" ||
        resource.resourceType === "agent"
      ) {
        return promptIds.has(resource.targetId) ? [resource.resourceId] : [];
      }
      return [resource.resourceId];
    })
  );
};

export type ProviderImportContexts = {
  codex: CodexImportContext;
  claudeCode: ClaudeCodeImportContext;
  openCode: OpenCodeImportContext;
};

// Builds the three provider contexts once and derives the discovery from
// them, so callers can reuse the same contexts for the resolve phase of a
// commit instead of re-scanning every provider directory twice.
export const discoverAllImportContexts = async (
  native: NativeBridge,
  activeDirectoryId?: string
): Promise<{
  discovery: ImportDiscovery;
  contexts: ProviderImportContexts;
}> => {
  const [codex, claudeCode, openCode] = await Promise.all([
    buildCodexContext(native, activeDirectoryId),
    buildClaudeCodeContext(native, activeDirectoryId),
    buildOpenCodeContext(native, activeDirectoryId),
  ]);
  const discoveries = [
    await discoverCodexImportFromContext(codex),
    await discoverClaudeCodeImportFromContext(claudeCode),
    await discoverOpenCodeImportFromContext(openCode),
  ];
  const [managedResources, pluginDefinitions, managedPlugins] =
    await Promise.all([
      native.listImportResources(),
      discoverPluginImports(native),
      native.listPlugins(),
    ]);
  for (const definition of pluginDefinitions) {
    const source = discoveries.find(
      (item) => item.source.provider === definition.input.provider
    );
    if (source) source.candidates.push(definition.candidate);
  }
  const resourceIdsWithExistingTargets = await existingManagedResourceIds(
    native,
    managedResources
  );
  const discovery = buildImportDiscovery(
    discoveries,
    managedResources,
    resourceIdsWithExistingTargets
  );
  for (const candidate of discovery.candidates.filter(
    (item) => item.type === "plugin"
  )) {
    const managed = managedPlugins.find(
      (item) => item.pluginId === candidate.logicalId
    );
    if (!managed) continue;
    candidate.status =
      managed.contentHash === candidate.contentHash
        ? "managed"
        : "update-available";
    candidate.ownership = { owner: "snow", management: "snapshot" };
  }
  return { discovery, contexts: { codex, claudeCode, openCode } };
};

export const discoverAllImportCandidates = async (
  native: NativeBridge,
  activeDirectoryId?: string
): Promise<ImportDiscovery> =>
  (await discoverAllImportContexts(native, activeDirectoryId)).discovery;
