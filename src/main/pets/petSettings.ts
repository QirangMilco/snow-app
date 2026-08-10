/**
 * 桌面宠物设置持久化。
 *
 * 所有设置通过 Rust 后端的 system_settings 表存取（键值对），
 * 主进程负责在宠物窗口与设置界面之间保持一致。
 *
 * 位置不做持久化：每次唤醒宠物都出现在固定的默认位置
 * （主显示器工作区右下角），避免上次拖拽后的坐标导致
 * 宠物出现在屏幕外而"找不到"。
 */
import type { NativeBridge } from "../native/types";

/** 宠物活动状态（驱动精灵图状态行切换）。 */
export type PetActivityState =
  | "idle"
  | "busy"
  | "review"
  | "waiting"
  | "error"
  | "completed";

/** AI 回合类型：普通对话 / 代码审查（review 播放专属动画行）。 */
export type PetTurnKind = "chat" | "review";

/** 桌面宠物设置。 */
export type PetSettings = {
  /** 是否唤醒宠物（显示宠物窗口） */
  enabled: boolean;
  /** 当前激活的宠物 id（null 表示未选择） */
  activePetId: string | null;
  /** 显示缩放（0.5 ~ 2，默认 0.75） */
  scale: number;
};

const SETTING_NAME = "pet";
const CODE_ENABLED = "pet_enabled";
const CODE_ACTIVE_ID = "pet_active_id";
const CODE_SCALE = "pet_scale";

export const PET_SCALE_MIN = 0.5;
export const PET_SCALE_MAX = 2;
export const PET_SCALE_DEFAULT = 0.75;

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: false,
  activePetId: null,
  scale: PET_SCALE_DEFAULT,
};

const parseScale = (raw: string | null): number => {
  const value = raw ? Number.parseFloat(raw) : Number.NaN;
  if (!Number.isFinite(value)) {
    return PET_SCALE_DEFAULT;
  }
  return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, value));
};

/** 读取完整的宠物设置。 */
export const loadPetSettings = async (
  native: NativeBridge
): Promise<PetSettings> => {
  try {
    const [enabledRaw, activeIdRaw, scaleRaw] = await Promise.all([
      native.getSystemSettingValue(CODE_ENABLED),
      native.getSystemSettingValue(CODE_ACTIVE_ID),
      native.getSystemSettingValue(CODE_SCALE),
    ]);

    return {
      enabled: enabledRaw === "1",
      activePetId:
        activeIdRaw && activeIdRaw.trim() ? activeIdRaw.trim() : null,
      scale: parseScale(scaleRaw),
    };
  } catch {
    return { ...DEFAULT_PET_SETTINGS };
  }
};

/** 写入单个宠物设置项。 */
export const savePetSetting = async (
  native: NativeBridge,
  code: string,
  value: string
): Promise<void> => {
  await native.setSystemSetting(SETTING_NAME, code, value);
};

export const petSettingCodes = {
  enabled: CODE_ENABLED,
  activeId: CODE_ACTIVE_ID,
  scale: CODE_SCALE,
};
