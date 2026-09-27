import type { HuabuApi } from '../shared/api'

declare global {
  interface Window {
    /** 渲染进程唯一的原生能力入口，实现见 src/preload/index.ts */
    huabu: HuabuApi
  }
}

export {}
