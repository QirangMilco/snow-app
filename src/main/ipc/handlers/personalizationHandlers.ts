import { ipcMain } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GLOBAL_ROLE_DIR = join(homedir(), ".snow");
const GLOBAL_ROLE_FILE = join(GLOBAL_ROLE_DIR, "ROLE.md");

/**
 * 个性化/规则设置：全局 ROLE.md 的读写。
 *
 * 与 native 端 `~/.snow/ROLE.md` 的解析约定保持一致（见
 * native/src/prompt/common.rs），保证在设置页保存的全局规则
 * 会被系统提示词构建管线直接读取生效。
 */
export const registerPersonalizationHandlers = (): void => {
  ipcMain.handle("personalization:get-global-role", async () => {
    try {
      const content = await fs.readFile(GLOBAL_ROLE_FILE, "utf8");
      return { filePath: GLOBAL_ROLE_FILE, content };
    } catch {
      // File does not exist yet — return an empty draft.
      return { filePath: GLOBAL_ROLE_FILE, content: "" };
    }
  });

  ipcMain.handle(
    "personalization:save-global-role",
    async (_event, content: unknown) => {
      if (typeof content !== "string") {
        throw new Error("Role content must be a string");
      }

      await fs.mkdir(GLOBAL_ROLE_DIR, { recursive: true });
      await fs.writeFile(GLOBAL_ROLE_FILE, content, "utf8");
    }
  );
};
