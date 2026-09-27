<div align="center">
  <img src="docs/assets/logo.png" alt="Huabu" width="280" />
  <h1>Huabu 画布</h1>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
    <a href="https://github.com/acefun29/huabu-agent/releases"><img src="https://img.shields.io/github/v/release/acefun29/huabu-agent" alt="Release" /></a>
    <a href="https://github.com/acefun29/huabu-agent/releases"><img src="https://img.shields.io/badge/platform-Windows-blue.svg" alt="Platform" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-44-47848f.svg" alt="Electron" /></a>
  </p>
</div>

**画布即工作区的桌面 Agent 应用**：一块工作区公用的无限画布管理素材文件卡片（引用而非副本），
底部对话坞承载与 Agent 的会话（可新建 / 切换 / fork），素材按绝对路径引用进对话。
Agent 基于开源 Coding Agent Harness [Pi](https://github.com/earendil-works/pi)
（`@earendil-works/pi-coding-agent`）以 SDK 方式嵌入主进程，不走子进程、不依赖 CLI。

## 核心特性

- **无限画布**：素材卡片平移/缩放/框选/批量拖拽；卡片是对磁盘文件的**引用**而非副本，
  画布状态与工作区目录一同持久化。
- **对话坞多会话**：会话脱离画布进入底部对话坞，支持新建 / 切换 / fork（原生分支）；
  流式逐字渲染、思维链折叠、工具调用卡片（进行中 → 完成）、中途中止、插话引导（steer）、
  多会话并发互不串字。
- **上下文透明**：上下文水位提示、压缩事件可见、token 分布明细、会话结构化回放，
  Agent 每轮都能看到素材库摘要与画布态势。
- **素材库**：OS 文件拖入画布自动归档 `assets/<分类>/`；命名素材库、标签与笔记、
  `#标签` 搜索、内联重命名 / 删除（标签索引随迁）、在文件管理器中显示、拖拽归档到库。
- **媒体生成**：内置 fal.ai、阿里云百炼（DashScope）、火山引擎（ARK）、OpenAI 兼容
  四类供应商目录，覆盖文生图 / 图生图 / 图生视频；生成卡片自带内联参数控制台，
  变更类操作走「确认闸门」逐条放行，产物自动回喂素材库并广播。
- **Agent 能看图**：`read_media` 工具按路径把图片交给 Agent 看，素材引用契约闭环——
  拖入即参考。
- **聊天模型目录**：内置 Anthropic / DeepSeek / GLM / Kimi / OpenAI / Qwen 模型目录，
  支持隐藏 / 恢复 / 编辑内置模型，支持按协议（OpenAI / Anthropic / Gemini）自建供应商。

## 下载

前往 [Releases](https://github.com/acefun29/huabu-agent/releases) 页面下载最新版本（目前仅提供 Windows x64）：

| 文件 | 说明 |
| --- | --- |
| `huabu-*-setup.exe` | NSIS 安装包（可选安装目录） |
| `huabu-*-portable.exe` | 绿色便携版，双击即用 |

首次启动后选择一个目录作为**工作区**（一个工作区 = 一张画布 + 一个磁盘目录，目录即 Agent 的 cwd），
然后在「设置」里配置模型 Key 即可开始对话与生成。

## API Key 配置

两种方式，任选其一：

1. **设置面板录入**（推荐）：Key 存于工作区存储，任何日志 / IPC / 画布快照中均不出现明文。
2. **环境变量**：未录入时按供应商回退到对应环境变量——

| 用途 | 环境变量 |
| --- | --- |
| fal.ai（媒体） | `FAL_KEY` |
| 阿里云百炼（媒体） | `DASHSCOPE_KEY` |
| 火山引擎（媒体） | `ARK_KEY` |
| OpenAI 兼容（媒体） | `OPENAI_API_KEY` |
| 对话模型 | 走 Pi 的凭据约定，如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等 |

## 从源码构建

### 环境要求

- Node.js >= 22.19（Pi 运行时要求，见 `.nvmrc`）
- pnpm >= 10

```bash
git clone https://github.com/acefun29/huabu-agent.git
cd huabu
pnpm install     # 国内网络建议官方源：pnpm install --registry https://registry.npmjs.org/
pnpm dev         # 开发模式（主进程 + 渲染进程 HMR）
```

### 常用命令

```bash
pnpm lint        # 类型检查（node 侧 + web 侧两套 tsconfig）
pnpm build       # 构建到 out/
pnpm dist        # 构建 + electron-builder 打包到 release/（NSIS + portable）
pnpm selfcheck   # IPC 链路自检：preload → window.huabu → ipcMain.handle
```

诊断与验证工具（纯 Node 自检为主，结果写入 `out/`，不入库）：

```bash
pnpm catalog:check      # 媒体模型内置目录 + 合并层 + 全量浏览目录
pnpm chat-catalog:check # 聊天模型目录与 wire 复刻断言、管理器、覆盖层写入面
pnpm asset-path:check   # 素材引用绝对路径解析（引用契约的回归锁）
pnpm test:scenario      # 全场景自检；pnpm test:full 追加 E2E（需 REMOTE_DEBUGGING_PORT=9222 起 dev）
pnpm bench              # 性能基准
```

> **坑：`electron-vite dev` 不会自动重启主进程。** 渲染端改动有 HMR，但改了
> `src/main/**` 或 `src/preload/**` 后必须手动重启 dev，否则新的 IPC handler 不存在，
> 表现为渲染端全部生效、所有 `chat:*` 调用无人应答。

### 安装注意事项（国内网络）

- `.npmrc` 已将 Electron 二进制指向 npmmirror 镜像（Node 的 `fetch` 不读系统代理，
  直连 GitHub Releases 下载 Electron 常失败）；若二进制缺失，执行
  `node node_modules/electron/install.js` 补下载。
- pnpm 10 默认拦截依赖构建脚本，`package.json` 的 `pnpm.onlyBuiltDependencies`
  已放行 `electron`、`esbuild`、`electron-winstaller`。

## 技术栈

Electron 44 · electron-vite 5 · React 19 · Zustand 5 · Tailwind CSS 4 · TypeScript 5.9 ·
[Pi SDK](https://github.com/earendil-works/pi) 0.85.1（纯 ESM，主进程 `await import()` 加载）

## 目录结构

```
huabu/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── index.ts           # 窗口与生命周期
│   │   ├── ipc.ts             # IPC handler 注册与载荷校验
│   │   ├── agent/             # AgentHost（Pi SDK 运行时）、会话历史、上下文压缩/分布、凭证
│   │   ├── assets/            # 素材域：导入/归档/素材库/重命名/删除/标签索引
│   │   ├── media/             # 媒体生成：供应商适配器、模型目录、缩略图、确认闸门
│   │   ├── models/            # 聊天模型目录、覆盖层、一次性迁移
│   │   └── workspace/         # 工作区存储（一个工作区 = 一张画布 + 一个磁盘目录）
│   ├── preload/               # contextBridge 暴露 window.huabu（事件白名单）
│   ├── renderer/              # 渲染进程（React）：画布、对话坞、素材库面板、设置面板
│   └── shared/                # 主/渲染进程共用契约（IPC 通道名、载荷类型、HuabuApi）
├── scripts/                   # 自检/探针/基准脚本（见 package.json scripts）
├── build/icon.png             # 应用图标
├── docs/assets/               # README 图片资源（logo 等）
├── electron.vite.config.ts
├── electron-builder.yml
└── package.json
```

## 安全基线

- `contextIsolation: true`、`nodeIntegration: false`，渲染进程只能通过 `window.huabu` 访问原生能力；
  事件类 IPC 通道需在 preload 白名单登记后才可订阅。
- **工具白名单** `['ls','read','write']`：不给 `bash` / `edit`，Agent 无法执行命令或改既有文件。
- **`cwd` 越界一律拒绝**（错误码 `cwd_rejected`），不做「悄悄纠正到默认目录」。
- **载荷与日志零密钥**：认证信息只暴露 `{ configured, source, label }`（`label` 是环境变量名，不是值）。
- **渲染端不 import 任何 pi 类型**：主进程对 pi 只用 `import type`，运行时零 `require`
  （pi 是纯 ESM，值导入会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。

## English Summary

Huabu ("canvas" in Chinese) is an Electron desktop app that turns an infinite canvas into your
agent workspace: asset files live on the canvas as reference cards (not copies), and a bottom
chat dock hosts multiple concurrent agent sessions (create / switch / fork) powered by the
open-source [Pi](https://github.com/earendil-works/pi) coding-agent harness embedded as an SDK.
It ships built-in media-generation providers (fal.ai, Alibaba DashScope, Volcengine ARK,
OpenAI-compatible) for text-to-image / image-to-image / image-to-video with a confirmation gate,
a taggable asset library, structured session replay with context-usage transparency, and
built-in chat-model catalogs (Anthropic / DeepSeek / GLM / Kimi / OpenAI / Qwen) plus custom
multi-protocol providers. Windows x64 builds are available on the Releases page. MIT licensed.

## License

[MIT](LICENSE) © 2026 acefun29
