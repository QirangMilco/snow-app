/// <reference types="vite/client" />

import type { SnowApi } from '../preload'
import type { PetBridge } from '../preload/petPreload'

declare global {
  interface Window {
    snow: SnowApi
    /** 桌面宠物窗口专用桥（仅宠物窗口页面存在） */
    petBridge?: PetBridge
  }
}
