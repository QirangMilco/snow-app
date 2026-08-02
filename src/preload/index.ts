import { contextBridge } from "electron";
import { apiConfigApi } from "./modules/apiConfigApi";
import { configApi } from "./modules/configApi";
import { conversationApi } from "./modules/conversationApi";
import { workspaceApi } from "./modules/workspaceApi";
import { sshApi } from "./modules/sshApi";
import { gitApi } from "./modules/gitApi";
import { systemApi, ptyApi, windowApi } from "./modules/systemApi";
import { memoApi } from "./modules/memoApi";
import { personalizationApi } from "./modules/personalizationApi";

export type * from "./types";

const api = {
  ...apiConfigApi,
  ...configApi,
  ...conversationApi,
  ...workspaceApi,
  ...sshApi,
  ...gitApi,
  ...systemApi,
  ...ptyApi,
  ...windowApi,
  ...memoApi,
  ...personalizationApi,
};

contextBridge.exposeInMainWorld("snow", api);

export type SnowApi = typeof api;
