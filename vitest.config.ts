import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // 与 electron.vite.config.ts 的 renderer 别名保持一致：渲染端的纯函数模块
    //（如 store/canvas/contextCollector）可以直接被 node 侧单测引用
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
