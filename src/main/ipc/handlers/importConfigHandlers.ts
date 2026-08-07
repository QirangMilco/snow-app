import { ipcMain } from "electron";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { NativeBridge } from "../../native/types";
import type {
  ImportCommitItemResult,
  ImportCommitResult,
  ImportCommitSummary,
  ImportSelection,
} from "../../../shared/importDiscovery";
import type {
  ImportResourceInput,
  ImportResourceRecord,
  ImportResourceReleaseInput,
} from "../../../shared/importResources";
import type { PluginMarketplaceMcpApproval } from "../../../shared/plugins";
import { resolveCodexSelectedImports } from "../../codex/importer";
import {
  importClaudeCode,
  previewClaudeCodeImport,
  resolveClaudeCodeSelectedImports,
} from "../../importConfig/claudeCodeImporter";
import {
  importOpenCode,
  previewOpenCodeImport,
  resolveOpenCodeSelectedImports,
} from "../../importConfig/openCodeImporter";
import { prepareSelectedImport } from "../../importConfig/selectedImport";
import {
  discoverAllImportCandidates,
  discoverAllImportContexts,
} from "../../importConfig/unifiedDiscovery";
import { ensureLegacyImportResourceMigration } from "../../importConfig/legacyImportMigration";
import { clearImportDiscoveryCache } from "../../importConfig/discoveryWorker";
import {
  preparePluginImports,
  addPluginMarketplace,
  ensureLegacyCodexPluginMigration,
  installPluginFromMarketplace,
  listPluginMarketplaces,
  previewPluginMarketplaceInstall,
  refreshManagedPlugins,
  removePluginMarketplace,
  removeManagedPlugin,
  selectedPluginImports,
  setManagedPluginEnabled,
  updatePluginMarketplace,
  updateManagedPlugin,
} from "../../importConfig/pluginManager";
import { ImportExecutionPlan } from "../../importConfig/importTransaction";
import { PluginRuntimeManager } from "../../plugins/pluginRuntimeManager";

const resourceInputForRecord = (
  resource: ImportResourceRecord
): ImportResourceInput => ({
  resourceId: resource.resourceId,
  resourceType: resource.resourceType,
  scope: resource.scope,
  ...(resource.projectId ? { projectId: resource.projectId } : {}),
  targetId: resource.targetId,
  targetPath: resource.targetPath,
  management: resource.management,
  sources: resource.sources.map((source) => ({
    provider: source.provider,
    scope: source.scope,
    originPath: source.originPath,
    ...(source.projectId ? { projectId: source.projectId } : {}),
    contentHash: source.currentHash,
  })),
});

const isWithin = (path: string, root: string): boolean => {
  const target = resolve(path);
  const boundary = resolve(root);
  if (!target.startsWith(`${boundary}${sep}`)) {
    return false;
  }
  return relative(boundary, target).split(sep).filter(Boolean).length >= 2;
};

const deleteManagedResourceTarget = async (
  native: NativeBridge,
  resource: ImportResourceRecord
): Promise<void> => {
  if (resource.resourceType === "skill") {
    const roots = [join(homedir(), ".snow", "skills")];
    if (resource.projectId) {
      const project = (await native.listWorkspaceDirectories()).find(
        (item) =>
          item.directoryId === resource.projectId && item.kind === "local"
      );
      if (project) {
        roots.push(join(project.path, ".snow", "skills"));
      }
    }
    if (
      !resource.targetPath ||
      !roots.some((root) => isWithin(resource.targetPath, root))
    ) {
      throw new Error(
        "Refusing to delete a Skill outside Snow-managed skill directories"
      );
    }
    rmSync(resource.targetPath, { recursive: true, force: true });
    return;
  }
  if (resource.resourceType === "mcp") {
    if (resource.scope === "project") {
      if (!resource.projectId) {
        throw new Error("Imported project MCP is missing its project ID");
      }
      await native.deleteProjectMcpServerConfig(
        resource.projectId,
        resource.targetId
      );
    } else {
      await native.deleteMcpServerConfig(resource.targetId);
    }
    return;
  }
  if (
    resource.resourceType === "prompt" ||
    resource.resourceType === "command" ||
    resource.resourceType === "agent"
  ) {
    await native.deleteSystemPrompt(resource.targetId);
    return;
  }
  throw new Error(
    `Imported ${resource.resourceType} resources cannot be deleted in Phase 3`
  );
};

const parseReleaseInput = (value: unknown): ImportResourceReleaseInput => {
  if (!value || typeof value !== "object") {
    throw new Error("Import resource release details are required");
  }
  const input = value as Partial<ImportResourceReleaseInput>;
  if (
    typeof input.resourceId !== "string" ||
    !input.resourceId.trim() ||
    typeof input.sourceId !== "string" ||
    !input.sourceId.trim() ||
    (input.disposition !== "delete" && input.disposition !== "adopt")
  ) {
    throw new Error("Import resource release details are invalid");
  }
  return {
    resourceId: input.resourceId,
    sourceId: input.sourceId,
    disposition: input.disposition,
  };
};

const pluginIdFrom = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Plugin ID is required");
  return value;
};

const marketplaceMcpApprovalsFrom = (
  value: unknown
): PluginMarketplaceMcpApproval[] => {
  if (!Array.isArray(value))
    throw new Error("Marketplace MCP approvals are required");
  const approvals = value.map((item) => {
    if (!item || typeof item !== "object")
      throw new Error("Marketplace MCP approval is invalid");
    const approval = item as Partial<PluginMarketplaceMcpApproval>;
    if (
      typeof approval.componentId !== "string" ||
      !approval.componentId.trim() ||
      typeof approval.approvalHash !== "string" ||
      !approval.approvalHash.trim()
    ) {
      throw new Error("Marketplace MCP approval is invalid");
    }
    return {
      componentId: approval.componentId,
      approvalHash: approval.approvalHash,
    };
  });
  if (
    new Set(approvals.map((approval) => approval.componentId)).size !==
    approvals.length
  ) {
    throw new Error(
      "Marketplace MCP approvals must not contain duplicate components"
    );
  }
  return approvals;
};

const pluginStateSummary = (
  items: ImportCommitSummary,
  pluginItems: ImportCommitItemResult[]
) => ({
  selected: items.selected + pluginItems.length,
  imported:
    items.imported +
    pluginItems.filter((item) => item.status === "imported").length,
  unchanged:
    items.unchanged +
    pluginItems.filter((item) => item.status === "unchanged").length,
  alreadyEffective:
    items.alreadyEffective +
    pluginItems.filter((item) => item.status === "already-effective").length,
  unsupported:
    items.unsupported +
    pluginItems.filter((item) => item.status === "unsupported").length,
  skipped:
    items.skipped +
    pluginItems.filter((item) => item.status === "skipped").length,
});

export const registerImportConfigHandlers = (
  native: NativeBridge,
  pluginRuntime: PluginRuntimeManager
): void => {
  const listPlugins = async () =>
    (await native.listPlugins()).map((plugin) => ({
      ...plugin,
      runtimeStatus: pluginRuntime.getStatus(plugin),
    }));
  const getPlugin = async (pluginId: string) => {
    const plugin = (await native.listPlugins()).find(
      (item) => item.pluginId === pluginId
    );
    if (!plugin) throw new Error("Plugin not found");
    return plugin;
  };
  ipcMain.handle("import-config:discover", async (_event, activeDirectoryId?: unknown) => {
    await clearImportDiscoveryCache();
    await ensureLegacyImportResourceMigration(native);
    const directoryId =
      typeof activeDirectoryId === "string" && activeDirectoryId.trim()
        ? activeDirectoryId.trim()
        : undefined;
    return discoverAllImportCandidates(native, directoryId);
  });
  ipcMain.handle("import-config:list-managed-resources", async () => {
    await ensureLegacyImportResourceMigration(native);
    return native.listImportResources();
  });
  ipcMain.handle("plugins:list", async () => {
    await ensureLegacyCodexPluginMigration(native);
    return listPlugins();
  });
  ipcMain.handle("plugins:rescan", async () => {
    await ensureLegacyCodexPluginMigration(native);
    await clearImportDiscoveryCache();
    const plugins = await refreshManagedPlugins(native);
    for (const plugin of plugins) {
      if (plugin.state !== "enabled")
        pluginRuntime.stopForLifecycleChange(plugin.pluginId);
    }
    return plugins.map((plugin) => ({
      ...plugin,
      runtimeStatus: pluginRuntime.getStatus(plugin),
    }));
  });
  ipcMain.handle(
    "plugins:set-enabled",
    async (_event, pluginId: unknown, enabled: unknown) => {
      await ensureLegacyCodexPluginMigration(native);
      if (typeof enabled !== "boolean")
        throw new Error("Plugin enabled state is required");
      const id = pluginIdFrom(pluginId);
      const plugin = await getPlugin(id);
      if (!enabled) await pluginRuntime.stop(plugin);
      await setManagedPluginEnabled(native, id, enabled);
    }
  );
  ipcMain.handle(
    "plugins:start-runtime",
    async (_event, pluginId: unknown, permissions: unknown) => {
      await ensureLegacyCodexPluginMigration(native);
      return pluginRuntime.start(
        await getPlugin(pluginIdFrom(pluginId)),
        permissions
      );
    }
  );
  ipcMain.handle("plugins:stop-runtime", async (_event, pluginId: unknown) => {
    await ensureLegacyCodexPluginMigration(native);
    return pluginRuntime.stop(await getPlugin(pluginIdFrom(pluginId)));
  });
  ipcMain.handle("plugins:update", async (_event, pluginId: unknown) => {
    await ensureLegacyCodexPluginMigration(native);
    const id = pluginIdFrom(pluginId);
    await pluginRuntime.stop(await getPlugin(id));
    await updateManagedPlugin(native, id);
  });
  ipcMain.handle("plugins:remove", async (_event, pluginId: unknown) => {
    await ensureLegacyCodexPluginMigration(native);
    const id = pluginIdFrom(pluginId);
    await pluginRuntime.stop(await getPlugin(id));
    await removeManagedPlugin(native, id);
  });
  ipcMain.handle("plugins:marketplaces:list", async () => {
    await ensureLegacyCodexPluginMigration(native);
    return listPluginMarketplaces(native);
  });
  ipcMain.handle(
    "plugins:marketplaces:add",
    async (_event, source: unknown) => {
      if (typeof source !== "string" || !source.trim())
        throw new Error("Marketplace source is required");
      return addPluginMarketplace(native, source);
    }
  );
  ipcMain.handle(
    "plugins:marketplaces:update",
    async (_event, marketplaceId: unknown) => {
      if (typeof marketplaceId !== "string" || !marketplaceId.trim())
        throw new Error("Marketplace ID is required");
      return updatePluginMarketplace(native, marketplaceId);
    }
  );
  ipcMain.handle(
    "plugins:marketplaces:remove",
    async (_event, marketplaceId: unknown) => {
      if (typeof marketplaceId !== "string" || !marketplaceId.trim())
        throw new Error("Marketplace ID is required");
      return removePluginMarketplace(native, marketplaceId);
    }
  );
  ipcMain.handle(
    "plugins:marketplaces:preview-install",
    async (_event, marketplaceId: unknown, pluginName: unknown) => {
      if (typeof marketplaceId !== "string" || !marketplaceId.trim())
        throw new Error("Marketplace ID is required");
      if (typeof pluginName !== "string" || !pluginName.trim())
        throw new Error("Plugin name is required");
      return previewPluginMarketplaceInstall(native, marketplaceId, pluginName);
    }
  );
  ipcMain.handle(
    "plugins:marketplaces:install",
    async (
      _event,
      marketplaceId: unknown,
      pluginName: unknown,
      approvals: unknown
    ) => {
      if (typeof marketplaceId !== "string" || !marketplaceId.trim())
        throw new Error("Marketplace ID is required");
      if (typeof pluginName !== "string" || !pluginName.trim())
        throw new Error("Plugin name is required");
      await installPluginFromMarketplace(
        native,
        marketplaceId,
        pluginName,
        marketplaceMcpApprovalsFrom(approvals)
      );
    }
  );
  ipcMain.handle(
    "import-config:release-managed-resource",
    async (_event, value: unknown) => {
      const input = parseReleaseInput(value);
      const release = await native.releaseImportResource(input);
      if (!release.cleanupTarget) {
        return release;
      }
      try {
        await deleteManagedResourceTarget(native, release.resource);
        return release;
      } catch (error) {
        await native.upsertImportResources([
          resourceInputForRecord(release.resource),
        ]);
        throw error;
      }
    }
  );
  ipcMain.handle("import-config:commit", async (_event, value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray((value as Partial<ImportSelection>).candidateIds)
    ) {
      throw new Error("Import candidate selection is required");
    }
    const candidateIds = [
      ...new Set(
        (value as Partial<ImportSelection>).candidateIds?.filter(
          (candidateId): candidateId is string =>
            typeof candidateId === "string" && candidateId.trim().length > 0
        ) ?? []
      ),
    ];
    if (candidateIds.length === 0) {
      throw new Error("Select at least one import candidate");
    }

    await clearImportDiscoveryCache();
    await Promise.all([
      ensureLegacyImportResourceMigration(native),
      ensureLegacyCodexPluginMigration(native),
    ]);
    // Build the provider contexts once and reuse them for the resolve phase
    // below; previously each resolve*SelectedImports call re-scanned every
    // provider directory from scratch, doubling the scan cost of a commit.
    const activeDirectoryId =
      typeof (value as Partial<ImportSelection>).activeDirectoryId === "string"
        ? ((value as Partial<ImportSelection>).activeDirectoryId as string).trim() || undefined
        : undefined;
    const { discovery, contexts } = await discoverAllImportContexts(native, activeDirectoryId);
    const candidates = candidateIds.map((candidateId) =>
      discovery.candidates.find(
        (candidate) => candidate.candidateId === candidateId
      )
    );
    if (candidates.some((candidate) => !candidate)) {
      throw new Error(
        "Import discovery changed; refresh before committing the selection"
      );
    }
    const selected = candidates.filter(
      (candidate): candidate is NonNullable<typeof candidate> =>
        Boolean(candidate)
    );
    const logicalResources = new Map<string, string>();
    for (const candidate of selected) {
      const resourceKey = [
        candidate.provider,
        candidate.type,
        candidate.scope,
        candidate.projectId ?? "",
        candidate.logicalId,
      ].join(":");
      const previousHash = logicalResources.get(resourceKey);
      if (previousHash && previousHash !== candidate.contentHash) {
        throw new Error(
          `Select only one content variant for ${candidate.logicalId}`
        );
      }
      logicalResources.set(resourceKey, candidate.contentHash);
    }

    const regularCandidates = selected.filter(
      (candidate) => candidate.type !== "plugin"
    );
    const [codex, claudeCode, openCode, plugins] = await Promise.all([
      resolveCodexSelectedImports(native, regularCandidates, contexts.codex),
      resolveClaudeCodeSelectedImports(
        native,
        regularCandidates,
        contexts.claudeCode
      ),
      resolveOpenCodeSelectedImports(
        native,
        regularCandidates,
        contexts.openCode
      ),
      selectedPluginImports(native, selected),
    ]);
    const plan = new ImportExecutionPlan();
    let regularResult: ImportCommitResult;
    let pluginResult: ReturnType<typeof preparePluginImports>;
    try {
      regularResult = await prepareSelectedImport(
        native,
        regularCandidates,
        [...codex.actions, ...claudeCode.actions, ...openCode.actions],
        plan,
        [
          ...discovery.warnings,
          ...codex.warnings,
          ...claudeCode.warnings,
          ...openCode.warnings,
        ]
      );
      pluginResult = preparePluginImports(native, plugins, plan);
      await plan.commit(native);
      await clearImportDiscoveryCache();
    } catch (error) {
      plan.discard();
      throw new Error(
        "Selected import was rolled back: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
    const itemResults = [
      ...regularResult.itemResults,
      ...pluginResult.itemResults.map((item) => ({
        ...item,
        candidateId:
          selected.find(
            (candidate) =>
              candidate.type === "plugin" &&
              candidate.logicalId === item.logicalId
          )?.candidateId ?? item.candidateId,
      })),
    ];
    return {
      ...regularResult,
      itemResults,
      summary: pluginStateSummary(
        regularResult.summary,
        pluginResult.itemResults
      ),
      warnings: [...regularResult.warnings, ...pluginResult.warnings],
    };
  });
  ipcMain.handle("import-config:preview-claude-code", () =>
    previewClaudeCodeImport(native)
  );
  ipcMain.handle("import-config:claude-code", () => importClaudeCode(native));
  ipcMain.handle("import-config:preview-opencode", () =>
    previewOpenCodeImport(native)
  );
  ipcMain.handle("import-config:opencode", () => importOpenCode(native));
};
