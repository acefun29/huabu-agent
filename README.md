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
右侧栏承载与 Agent 的会话（可新建 / 切换 / fork）与素材库，素材按绝对路径引用进对话。
Agent 以 SDK 方式嵌入主进程（不走子进程、不依赖 CLI），内置 Pi 与 Mastra 两套运行时，
按工作区切换。

## 核心特性

- **无限画布**：素材卡片平移/缩放/框选/批量拖拽；卡片是对磁盘文件的**引用**而非副本，
  画布状态与工作区目录一同持久化。画布占满整个工作区，右侧面板是以覆盖层浮在其上的。
- **右侧栏双页面**：对话与素材库是同一块右侧空间的互斥页面，图标栏切换；
  再点当前页图标即收起、画布恢复全宽。面板左边缘可拖拽调宽（340–720px），
  调宽与切页都不改变画布视口，卡片位置不会漂。
- **对话多会话**：会话支持新建 / 切换 / fork（原生分支），会话名即下拉入口；
  流式逐字渲染、思维链折叠、工具调用卡片（进行中 → 完成）、中途中止、插话引导（steer）、
  多会话并发互不串字。
- **上下文透明**：上下文水位提示、压缩事件可见、token 分布明细、会话结构化回放，
  Agent 每轮都能看到素材库摘要与画布态势。
- **素材库**：OS 文件拖入画布自动归档 `assets/<分类>/`；命名素材库、标签与笔记、
  `#标签` 搜索、内联重命名 / 删除（标签索引随迁）、在文件管理器中显示、拖拽归档到库。
- **素材分级（位置坐标）**：给素材标一个从粗到细的位置（如「第03集 / 第2场 / 第12镜」），
  单值有序、与标签（扁平多值）分开存放，支持逐层筛选下钻与批量设置。
  **层级定义本身是工作区数据而非产品内置方案**——由你在界面上新建一套（层名任取），
  或直接让 Agent 按对话定义；已有分级各自带结构 id，切换结构不影响其语义。
- **专家团协作（SuperAgent）**：主 Agent 用 `delegate_tasks` 把批量产出派给专家并发执行，
  每个任务带写区白名单（lane）与机器可判定的验收标准；事实源是 `.huabu/journal.jsonl`
  （append-only），任务板与版本槽都是它的重建投影，版本只在验收通过后激活。
  对话栏底部的专家团状态条可展开任务板：重派、改需求、取消都在那里。
- **上下文四段装配**：每轮注入按「常驻（项目结构索引）/ 轮换（当前 scope 子节点）/
  队列（待处理任务）/ 注入（素材库 + 画布态势）」分段生成，逐段去重——
  与上轮一致就折叠成一行占位。
- **媒体生成**：内置阿里云百炼（DashScope）、阿里云 Token Plan（订阅制）、火山引擎（ARK）、
  MiniMax、腾讯云、OpenAI 兼容六类供应商，覆盖文生图 / 图生图 / 图生视频；
  生成卡片自带内联参数控制台，变更类操作走「确认闸门」逐条放行，产物自动回喂素材库并广播。
- **Agent 能看图看视频**：`read_media` 按路径把图片交给 Agent 看；`skim_video` 全片粗扫
  （带时间戳低清关键帧）、`read_video_frames` 定点精读，素材引用契约闭环——拖入即参考。
- **聊天模型目录**：内置 Anthropic / DeepSeek / GLM / Kimi / OpenAI / Qwen / Token Plan 目录，
  支持隐藏 / 恢复 / 编辑内置模型，支持按协议（OpenAI / Anthropic / Gemini）自建供应商。
- **MCP 与技能**：可接入 MCP 服务器（工具以 `mcp_<server>_<tool>` 注入）；工作区技能按
  agentskills.io 规范放在 `.huabu/skills/<name>/SKILL.md`，可按需启用/禁用。
- **两套 Agent 运行时**：Pi（默认）与 Mastra（LibSQL 记忆），按工作区切换；
  Mastra 侧 fork / compact / steer 尚未迁移，会显式失败而非静默降级。

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
| 阿里云百炼（媒体） | `DASHSCOPE_KEY` |
| 阿里云 Token Plan（媒体，`sk-sp-` 前缀 Key） | `TOKEN_PLAN_KEY` |
| 火山引擎（媒体） | `ARK_KEY` |
| MiniMax（媒体） | `MINIMAX_KEY` |
| 腾讯云（媒体） | `TENCENT_KEY` |
| OpenAI 兼容（媒体） | `OPENAI_API_KEY` |
| 对话模型 | 走运行时的凭据约定，如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等；Token Plan 订阅通道用 `TOKEN_PLAN_KEY` |

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

只想在浏览器里调试前端时，用无窗口模式启动（不弹 Electron 窗口，只起 Web 桥）：

```bash
pnpm web         # headless 主进程 + 渲染进程；终端会打印带 token 的浏览器地址
```

Web 桥只监听 `127.0.0.1`，token 每次启动生成并写入 `.huabu-dev/bridge-token`
（主进程与渲染进程编译期读同一个文件）；渲染端遇到 401 会自动重取 token 并重试一次。

### 常用命令

```bash
pnpm lint        # 类型检查（node 侧 + web 侧两套 tsconfig）
pnpm build       # 构建到 out/
pnpm dist        # 构建 + electron-builder 打包到 release/（NSIS + portable）
pnpm selfcheck   # IPC 链路自检：preload → window.huabu → ipcMain.handle
pnpm test        # vitest 单测（含 Mastra / pi 双运行时、分级、SuperAgent 等）
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
[Pi SDK](https://github.com/earendil-works/pi) 0.85.1（纯 ESM，主进程 `await import()` 加载）·
Mastra + LibSQL（会话记忆，vendored 在 `vendor/mastra/`）· TypeBox（工具参数 schema）

## 目录结构

```
huabu/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── index.ts           # 窗口与生命周期（--huabu-headless 时只起 Web 桥）
│   │   ├── ipc.ts             # IPC handler 注册与载荷校验
│   │   ├── agent/             # 双运行时（piRuntime / mastra）+ 工具装配 + 上下文压缩
│   │   │   └── mastra/        # Mastra 运行时：记忆、模型网关、存储、工具桥
│   │   ├── assets/            # 素材域：导入/归档/素材库/重命名/删除/标签索引/分级索引
│   │   ├── superagent/        # SuperAgent 领域引擎：journal 事实源 / 任务板投影 / 版本槽 / 专家池 / 编排
│   │   ├── media/             # 媒体生成：供应商适配器、模型目录、缩略图、确认闸门
│   │   ├── models/            # 聊天模型目录、覆盖层、一次性迁移
│   │   ├── mcp/               # MCP 服务器管理与工具注入
│   │   ├── project/           # 项目结构模型（层级看板）
│   │   └── workspace/         # 工作区存储（一个工作区 = 一张画布 + 一个磁盘目录）
│   ├── preload/               # contextBridge 暴露 window.huabu（事件白名单）
│   ├── renderer/              # 渲染进程（React）：画布、右侧栏（对话/素材库）、设置
│   └── shared/                # 主/渲染进程共用契约（IPC 通道名、载荷类型、HuabuApi、分级 schema）
├── vendor/mastra/             # vendored Mastra 源码（workspace 依赖）
├── resources/skills/          # 随应用分发的技能（blockout-shot 等）
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
  自定义工具必须同时在白名单里列名才会激活。
- **`cwd` 越界一律拒绝**（错误码 `cwd_rejected`），不做「悄悄纠正到默认目录」。
- **载荷与日志零密钥**：认证信息只暴露 `{ configured, source, label }`（`label` 是环境变量名，不是值）。
- **渲染端不 import 任何 pi 类型**：主进程对 pi 只用 `import type`，运行时零 `require`
  （pi 是纯 ESM，值导入会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。
- **Web 桥仅开发期启用**（`--huabu-headless` / `HUABU_WEB_BRIDGE=1`）：只监听 `127.0.0.1`、
  每次启动随机 token、CORS 限本机、事件转发按通道白名单过滤，绝不在生产构建中开启。

## English Summary

Huabu ("canvas" in Chinese) is an Electron desktop app that turns an infinite canvas into your
agent workspace: asset files live on the canvas as reference cards (not copies), and a right-side
panel hosts both the chat sessions (create / switch / fork) and the asset library as two mutually
exclusive pages. Agent runtimes — Pi and Mastra — are embedded as SDKs in the main process.
It ships built-in media-generation providers (Alibaba DashScope, Alibaba Token Plan,
Volcengine ARK, MiniMax, Tencent, OpenAI-compatible) for text-to-image / image-to-image /
image-to-video with a confirmation gate, a taggable asset library with a user-defined
classification schema (position coordinates such as episode / scene / shot, defined per workspace
rather than built in), structured session replay with context-usage transparency, and built-in
chat-model catalogs (Anthropic / DeepSeek / GLM / Kimi / OpenAI / Qwen) plus custom multi-protocol
providers. Windows x64 builds are available on the Releases page. MIT licensed.

## License

[MIT](LICENSE) © 2026 acefun29
