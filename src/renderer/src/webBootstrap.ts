/**
 * Web 预览引导：在任何应用模块加载前安装 window.huabu。
 *
 * 必须是独立入口且在 main.tsx 之前（index.html 的 script 顺序保证）——
 * 因为 store 模块在**导入时**就求值 BRIDGE_AVAILABLE = isAgentAvailable()，
 * 晚于导入再装就来不及（页面会停在 WorkspaceGate）。
 */
import { installWebHarness } from './webHarness'

installWebHarness()
