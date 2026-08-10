import { ipcRenderer } from "electron";
import type {
  PetManifest,
  PetSettings,
  PetTurnKind,
} from "../types/pets";

/**
 * 主窗口设置界面使用的宠物系统 API。
 * 设置变更后主进程会广播 "pets:changed"，界面据此刷新。
 */
export const petApi = {
  /** 打开文件对话框选择宠物包 zip 并安装；取消返回 null */
  installPetFromZip: (): Promise<PetManifest | null> =>
    ipcRenderer.invoke("pets:install-zip"),
  /** 列出所有可用宠物（Snow App + Codex App / Petdex 生态） */
  listInstalledPets: (): Promise<PetManifest[]> =>
    ipcRenderer.invoke("pets:list"),
  /** 卸载 Snow App 安装的宠物 */
  uninstallPet: (petId: string): Promise<void> =>
    ipcRenderer.invoke("pets:uninstall", petId),
  /** 读取宠物设置 */
  getPetSettings: (): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:get-settings"),
  /** 唤醒 / 收起宠物 */
  setPetEnabled: (enabled: boolean): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-enabled", enabled),
  /** 选择激活宠物（传空字符串取消选择） */
  setActivePet: (petId: string): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-active", petId),
  /** 设置显示缩放 */
  setPetScale: (scale: number): Promise<PetSettings> =>
    ipcRenderer.invoke("pets:set-scale", scale),
  /** 订阅宠物列表 / 设置变化（安装、卸载、宠物窗口收起等） */
  onPetsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("pets:changed", handler);
    return () => {
      ipcRenderer.removeListener("pets:changed", handler);
    };
  },
  /** 通知宠物：一个 AI 回合（整条 agent loop）开始。
   *  turnId 由渲染层生成并持有，结束时原样回传以精确核销。 */
  notifyPetTurnStarted: (turnId: string, kind: PetTurnKind): void => {
    ipcRenderer.send("pets:turn-start", { turnId, kind });
  },
  /** 通知宠物：一个 AI 回合彻底结束（failed=true 播放失败动画） */
  notifyPetTurnEnded: (turnId: string, failed: boolean): void => {
    ipcRenderer.send("pets:turn-end", { turnId, failed });
  },
};
