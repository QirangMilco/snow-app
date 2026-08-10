/**
 * Codex 桌面宠物系统类型（渲染进程可见）。
 */

/** 宠物清单元数据（pet.json + 安装位置）。 */
export type PetManifest = {
  /** 宠物唯一标识 */
  id: string;
  /** 展示名称 */
  displayName: string;
  /** 宠物描述 */
  description: string;
  /** 精灵图文件名（相对宠物目录） */
  spritesheetFile: string;
  /** 宠物目录绝对路径 */
  dirPath: string;
  /** 精灵图绝对路径 */
  spritesheetPath: string;
  /** 来源："snow"（Snow App 安装）| "codex"（Codex App）| "petdex"（Petdex） */
  source: string;
  /** 精灵图版本：1 = 9 行标准网格，2 = 11 行（Hatch Pet v2） */
  version: number;
  /** 精灵图列数（标准为 8） */
  columns: number;
  /** 精灵图行数 */
  rows: number;
};

/** 桌面宠物设置。 */
export type PetSettings = {
  /** 是否唤醒宠物（显示宠物窗口） */
  enabled: boolean;
  /** 当前激活的宠物 id（null 表示未选择） */
  activePetId: string | null;
  /** 显示缩放（0.5 ~ 2） */
  scale: number;
};

/** 宠物活动状态（与 Codex 宠物状态语义一致）。 */
export type PetActivityState =
  | "idle"
  | "busy"
  | "review"
  | "waiting"
  | "error"
  | "completed";

/** AI 回合类型：普通对话 / 代码审查（review 播放专属动画行）。 */
export type PetTurnKind = "chat" | "review";

/** 宠物窗口启动配置。 */
export type PetWindowConfig = {
  settings: PetSettings;
  manifest: PetManifest | null;
};
