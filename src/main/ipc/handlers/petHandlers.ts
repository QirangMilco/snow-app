/**
 * 桌面宠物系统 IPC 处理器。
 *
 * 主窗口设置界面：安装（zip 文件对话框）/ 列表 / 卸载 / 启用 / 选择 / 缩放。
 * 宠物窗口：拉取配置、拖拽位置、右键收起。
 */
import { dialog, ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";
import {
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  loadPetSettings,
  petSettingCodes,
  savePetSetting,
  type PetTurnKind,
} from "../../pets/petSettings";
import {
  getCurrentPetActivity,
  getCurrentPetConfig,
  refreshPetWindow,
  reportPetTurnEnded,
  reportPetTurnStarted,
} from "../../pets/petWindow";

/** 解析渲染层的回合事件载荷，非法载荷返回 null 直接丢弃。 */
const parsePetTurnPayload = (
  payload: unknown
): { turnId: string; kind: PetTurnKind; failed: boolean } | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.turnId !== "string" || !record.turnId.trim()) {
    return null;
  }
  return {
    turnId: record.turnId.trim(),
    kind: record.kind === "review" ? "review" : "chat",
    failed: record.failed === true,
  };
};

export const registerPetHandlers = (native: NativeBridge): void => {
  // ── 主窗口设置界面 ─────────────────────────────────────────────────

  ipcMain.handle("pets:install-zip", async () => {
    const selection = await dialog.showOpenDialog({
      title: "Install Codex Pet Package",
      buttonLabel: "Install",
      filters: [
        { name: "Codex Pet Package", extensions: ["zip"] },
      ],
      properties: ["openFile"],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }

    const zipPath = selection.filePaths[0];
    const manifest = await native.installPetFromZip(zipPath);

    // 若尚未选择宠物，新安装的宠物自动设为激活。
    const settings = await loadPetSettings(native);
    if (!settings.activePetId) {
      await savePetSetting(native, petSettingCodes.activeId, manifest.id);
    }

    await refreshPetWindow(native);
    return manifest;
  });

  ipcMain.handle("pets:list", () => native.listInstalledPets());

  ipcMain.handle("pets:uninstall", async (_event, petId: unknown) => {
    if (typeof petId !== "string" || !petId.trim()) {
      throw new Error("Pet id is required");
    }

    await native.uninstallPet(petId.trim());

    // 卸载的是当前激活宠物时清空激活项并收起窗口。
    const settings = await loadPetSettings(native);
    if (settings.activePetId === petId.trim()) {
      await savePetSetting(native, petSettingCodes.activeId, "");
    }

    // 所有宠物都被删除时自动关闭启停开关（无宠物时不允许唤醒）。
    const remaining = await native.listInstalledPets();
    if (remaining.length === 0) {
      await savePetSetting(native, petSettingCodes.enabled, "0");
    }

    await refreshPetWindow(native);
  });

  ipcMain.handle("pets:get-settings", () => loadPetSettings(native));

  ipcMain.handle("pets:set-enabled", async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error("Enabled flag must be a boolean");
    }
    await savePetSetting(native, petSettingCodes.enabled, enabled ? "1" : "0");
    await refreshPetWindow(native);
    return loadPetSettings(native);
  });

  ipcMain.handle("pets:set-active", async (_event, petId: unknown) => {
    if (typeof petId !== "string") {
      throw new Error("Pet id must be a string");
    }
    await savePetSetting(native, petSettingCodes.activeId, petId.trim());
    await refreshPetWindow(native);
    return loadPetSettings(native);
  });

  ipcMain.handle("pets:set-scale", async (_event, scale: unknown) => {
    const value = typeof scale === "number" ? scale : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new Error("Scale must be a number");
    }
    const clamped = Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, value));
    await savePetSetting(native, petSettingCodes.scale, String(clamped));
    await refreshPetWindow(native);
    return loadPetSettings(native);
  });

  // ── 宠物窗口 ───────────────────────────────────────────────────────

  ipcMain.handle("pets:get-config", () => getCurrentPetConfig());
  // 宠物页面挂载后主动拉取当前活动状态：先启动会话再唤醒宠物时，
  // 窗口创建时刻的状态广播尚未被页面接收，需由页面自行补齐。
  ipcMain.handle("pets:get-activity", () => getCurrentPetActivity());

  // AI 回合级联动：整条 agent loop 开始/彻底结束时由渲染层通知，
  // 使宠物在回合期间保持 running、仅在真正完成时 waving。
  // 载荷携带渲染层生成的 turnId：多会话并行时按 id 精确核销，
  // 中止 / 顶替 / 渲染层销毁等异常路径都不会污染计数。
  ipcMain.on("pets:turn-start", (event, payload: unknown) => {
    const parsed = parsePetTurnPayload(payload);
    if (!parsed) {
      return;
    }
    reportPetTurnStarted(event.sender, parsed.turnId, parsed.kind);
  });
  ipcMain.on("pets:turn-end", (_event, payload: unknown) => {
    const parsed = parsePetTurnPayload(payload);
    if (!parsed) {
      return;
    }
    reportPetTurnEnded(parsed.turnId, parsed.failed);
  });
};
