import { ipcMain } from "electron";
import type {
  ApiModelsConfig,
  NativeBridge,
  ResponsesApiStreamChunk,
} from "../../native/types";
import {
  normalizeApiConfigInput,
  toApiConfigInput,
} from "../../settings/apiConfigs";
import { readSnowCliCodebaseSettings } from "../../settings/codebaseSettings";
import { readSnowCliProxyConfig } from "../../settings/proxyBrowserSettings";
import { readSnowCliProfiles } from "../../snowCli/profiles";
import { safeSend } from "../../utils/safeSend";

export const registerApiConfigHandlers = (native: NativeBridge): void => {
  ipcMain.handle("api-configs:list", () => native.listApiConfigs());
  ipcMain.handle("api-configs:upsert", async (_event, config: unknown) => {
    await native.upsertApiConfig(normalizeApiConfigInput(config));
    return native.listApiConfigs();
  });

  // ===== Built-in Services Global Switch =====
  ipcMain.handle("builtin-services:get-status", () =>
    native.getBuiltinServicesStatus()
  );
  ipcMain.handle(
    "builtin-services:set-status",
    async (_event, statuses: unknown) => {
      if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
        throw new Error("Built-in services status must be an object");
      }
      const raw = statuses as Record<string, unknown>;
      const normalized: Record<string, boolean> = {};
      for (const [serviceId, enabled] of Object.entries(raw)) {
        if (!serviceId.trim()) {
          continue;
        }
        if (typeof enabled !== "boolean") {
          throw new Error(
            `Built-in service enabled state must be a boolean: ${serviceId}`
          );
        }
        normalized[serviceId.trim()] = enabled;
      }
      await native.setBuiltinServicesStatus(normalized);
      return native.getBuiltinServicesStatus();
    }
  );
  ipcMain.handle("api-configs:delete", async (_event, profileName: unknown) => {
    if (typeof profileName !== "string" || !profileName.trim()) {
      throw new Error("Profile name is required");
    }

    await native.deleteApiConfig(profileName.trim());
    return native.listApiConfigs();
  });
  ipcMain.handle("api-configs:import-snow-cli", async () => {
    const profiles = readSnowCliProfiles();
    const existingConfigs = await native.listApiConfigs();
    const isFirstSync = !existingConfigs.some(
      (config) => config.source === "snow-cli"
    );

    if (isFirstSync) {
      // 首次同步：沿用 Snow CLI 的激活状态
      for (const profile of profiles) {
        await native.upsertApiConfig(toApiConfigInput(profile));
      }
    } else {
      // 增量同步：仅同步配置数据，保留应用内当前激活的 profile
      const activeProfileName =
        existingConfigs.find((config) => config.isActive)?.profileName ?? null;

      for (const profile of profiles) {
        const input = toApiConfigInput(profile);
        await native.upsertApiConfig({
          ...input,
          isActive: profile.name === activeProfileName,
        });
      }
    }

    return {
      importedCount: profiles.length,
      configs: await native.listApiConfigs(),
    };
  });
  ipcMain.handle("api-models:fetch", async () => {
    try {
      const models = await native.fetchAvailableModels();
      return models;
    } catch (error) {
      throw error;
    }
  });
  ipcMain.handle(
    "api-models:fetch-for-config",
    async (_event, config: unknown) => {
      if (
        typeof config !== "object" ||
        config === null ||
        Array.isArray(config)
      ) {
        throw new Error("API model config is required");
      }

      const source = config as Partial<Record<keyof ApiModelsConfig, unknown>>;
      const normalizedConfig: ApiModelsConfig = {
        baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "",
        baseUrlMode:
          typeof source.baseUrlMode === "string" ? source.baseUrlMode : "auto",
        apiKey: typeof source.apiKey === "string" ? source.apiKey : "",
        requestMethod:
          typeof source.requestMethod === "string"
            ? source.requestMethod
            : "chat",
        customHeaderSchemeId:
          typeof source.customHeaderSchemeId === "string"
            ? source.customHeaderSchemeId
            : "",
      };

      return native.fetchAvailableModelsForConfig(normalizedConfig);
    }
  );

  ipcMain.handle("proxy-browser-settings:import-snow-cli", () =>
    readSnowCliProxyConfig(native)
  );

  ipcMain.handle("codebase-settings:import-snow-cli", () =>
    readSnowCliCodebaseSettings(native)
  );

  // ===== AI theme palette generation =====
  ipcMain.handle(
    "theme:generate-palette",
    async (
      event,
      imagePath: unknown,
      profileName: unknown,
      streamId: unknown
    ) => {
      if (typeof imagePath !== "string" || !imagePath.trim()) {
        throw new Error("Image path is required");
      }
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Stream ID is required");
      }

      const normalizedStreamId = streamId.trim();
      const normalizedProfileName =
        typeof profileName === "string" ? profileName.trim() : "";

      return await native.generateThemePalette(
        imagePath.trim(),
        normalizedProfileName,
        (chunk: ResponsesApiStreamChunk) => {
          safeSend(event.sender, "theme:generate-palette:chunk", {
            streamId: normalizedStreamId,
            chunk,
          });
        },
        normalizedStreamId
      );
    }
  );
};
