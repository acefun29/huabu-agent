---
name: blockout-shot
description: 把「参考图 → 数据化粗模 → 场景摆放 → 运镜 → 视频生成 → 成片复盘」串成一条流水线。当用户要"用白模/粗模预演一个镜头""先搭个 blockout 再让视频模型照着运镜生成""从这张图搭三维场景并打相机动画""previs / animatic / 分镜预演"时使用。核心纪律：几何与运镜全部先用数据写死（author 场景文件），数值自检优先、看图其次；粗模只定义几何与运动，不定义画风。
---

# blockout-shot：数据化粗模 → 运镜 → 视频生成

## 0. 这套流程在解决什么

视频生成模型不接受相机轨迹。所以本技能的立足点是**把"运镜"从"提示词里的玄学"变成"可验证的数据"**：

```
参考图 ──▶ 量化（比例/部件/单位） ──▶ author.json（粗模+运镜，全是数据）
                                        │  check 数值自检 ⇄ sheet 拼版视觉自检
                                        ▼
                                  author.json（场景与运镜收敛）
                                        │ shot 解算 ──▶ 逐帧相机表（引擎产物）
                                        ▼
                              双轨产物（引擎 + 图像模型）
                     ┌──────────────────┴──────────────────┐
                 look track                            structure track
        首尾帧静图（决定画风，图像模型重绘）      preview.mp4 + 逐帧表 + 关键帧拼版
                     │                                     │
                     ▼                                     ▼
        商用 API：首/尾帧 + 运镜指令          （结构条件通道：引擎尚未产 depth 序列，
                                                属未来扩展，本期不可用）
                     └──────────────┬──────────────────────┘
                                    ▼
                              成片 ──▶ skim_video / read_video_frames 复盘 ──▶ 重试/换通道
```

**三条不可违背的纪律**（违反即返工）：

1. **数据先行**：任何几何或运镜改动先改 `author.json`，不靠"再渲染一次看看"。渲染只用来验证数据。
2. **数值优先、看图其次**：每轮迭代先读 `check` 的数值（穿模、离地、包围盒、占屏），数值过了再看拼版图。**不要试图从像素里读坐标——多模态模型做不到，且每张图 800~1500 token。**
3. **粗模不定画风**：白模视频塞进 API 当参考，只会得到"白盒子的视频"。画风由 look track 决定，结构由粗模决定。混用是本流程最常见的翻车点。

## 1. 前置检查（缺一不可，缺则声明降级）

| 前置 | 检查方式 | 缺失时的降级 |
|---|---|---|
| blockout 工具 | 本产品内置，读这份技能后即可调用；结果首行带引擎版本（当前兼容 **v0.2.0-mvp**），版本不符时以工具返回的契约为准 | 工具不可用 = 引擎资源缺失：只产 author 数据与说明交付，声明"未渲染" |
| 工作区可写目录 | 工作产物落 `.huabu/blockout/<场景>/`（自动），成片发布 `assets/video/`（自动） | 让用户先打开工作区 |
| 目标规格 | 比例（9:16 / 16:9…）、时长（秒）、帧率 | 默认 16:9 / 5s / 24fps，并在结果里写明 |
| 参考素材 | 至少一张参考图 / 或用户口述尺寸 | 无参考图时：走"纯文本建场"，并在结果里声明比例是假设值 |

## 2. blockout 工具契约（唯一执行入口）

一个 `blockout` 工具，`action` 枚举与引擎子命令一一对应。**不要试图直接跑引擎脚本**——工具负责路径安全带、ffmpeg、进度与产物发布。

```
action: 'check' | 'describe' | 'sheet' | 'view' | 'shot' | 'shots' | 'video'   （必填）
scene:  author 场景文件的工作区相对路径（必填）
shot?:  镜头 id（shot/video 用；缺省第一个）
view?:  视图名（view 动作）：front / right / top / threequarter
keyframes?: shot 附带关键帧拼版（4 张关键帧 PNG，视觉自检构图节奏）
width?/height?: 画幅（view/video；video 默认 640×360——预演够用，别上来就 1080p）
size?:  拼版边长（sheet / keyframes，默认 1024；不要低于 1024，每格会不可读）
out?:   输出文件的工作区相对路径（缺省落 .huabu/blockout/<场景名>/）
publish?: video 成片是否发布到素材库（默认 true；同镜头重渲染覆盖旧成片）
```

| action | 干什么 | 结果形态 |
|---|---|---|
| `check` | **数值自检主入口**：解算 + describe 数字表 + 碰撞/意图关系检查 | JSON（parts/worldAabb/collisions/errors/warnings） |
| `describe` | 只出解算数字表（部件位姿、锚点、包围盒） | JSON |
| `sheet` | 自动取景四视图拼版（一张图，同尺度可比大小） | JSON + **拼版 PNG 随结果附图** |
| `view` | 单视图大图（需要看清某个方向时用） | JSON + PNG 附图 |
| `shot` | 运镜解算：摘要 + 指标 + 违规；逐帧表落 `.huabu/blockout/<场景>/<镜头>.frames.json` | JSON |
| `shots` | 全部镜头解算 + 镜头间连续性 | JSON |
| `video` | 渲染白模成片（逐帧光栅化 + H.264 编码，4~12s，带进度） | JSON；成片自动发布素材库 + 画布钉卡 |

退出码语义（看结果首行的标注）：`0` 正常 ｜ `2` **解算有 error**（author 数据写错了——按 errors 改数据重跑）｜ `3` **约束违规**（出画/穿模/超速——按 §4 的职责边界改运镜数据，不要指望引擎替你救）｜ 用法/IO 错误（含 ffmpeg 缺失）工具会直接报错。

## 3. author 场景格式（version 2，一个文件装下场景与运镜）

完整格式与图元/锚点/关系/约束清单见 **`engine-README.md`**（随本技能分发）。要点：

- **坐标是输出不是输入**：`drivers`（5~12 个命名参数）+ 表达式（`$L*0.32`，白名单函数）+ 锚点关系（`at: { anchor, to }`，禁止手写相机坐标），全部由引擎解算并回显。
- 图元：box / plane / wedge / prism / cylinder / cone / sphere / ellipsoid / capsule（局部原点一律在几何中心）。
- 组合用 `combine`（mirror/array/radial + 必填 `labels`，杜绝自动生成的不可读 ID）。
- 碰撞意图用 `relations` 声明（touch/embed/attach/clear/ignore）——**默认安静**：只有未声明的跨装配体穿透与被违反的 clear 才是 error，其余是 info。
- 运镜写在同一文件的 `shots` 段：`target`（锚点引用）+ `orbit`（球坐标起始机位）+ `framing`（用构图比例表达推拉，距离由引擎反解）+ `moves`（分段 + 缓动）+ `constraints`。**改运镜 = 改 shots 段的数据**。
- `views` 段声明拼版意图（subject/fit/margin/layout），机位全部由几何解算。

改参数后**全场景自动跟随**：改 `wheelR` 一处，接地、包围盒、取景、运镜全部重算——这就是"改一处不用改十二处"。

## 4. 七步流程

### 步 1｜参考图 → 量化草案（只取比例，不取绝对坐标）

产出 `analysis.md` + `author.json` 初稿：

1. **定单位与坐标原点**：默认米、Z 轴向上、原点在主体接地点正下方，主体正前方 `+X`。图的左右不构成坐标，别猜。
2. **定比例，不定尺寸**：从图里估计相对比例（长:宽:高），如"轿车约 4.5 : 1.8 : 1.4"。多模态模型判比例尚可、判绝对尺寸不可靠。
3. **定标尺**：① 用户给的真实尺寸 → ② 常识默认（车长 4.5m、人高 1.7m、门高 2.0m…）→ ③ 声明"比例为 1 个单位"并全程只用相对值。**必须显式写下用了哪一档。**
4. **几何体分解**：每个可见物体拆成简单几何体的并集（不做布尔）。逐部件写 `id / shape / size(表达式) / at(锚点关系) / color`。
5. 从零拼大场景不可靠时**先用模板**：`templates/perfume-on-table.author.json`（桌面产品）与 `templates/car-on-road.author.json`（车辆+道路）可直接改驱动参数起步。

### 步 2｜单物体迭代收敛（数值 → 视觉）

```
循环（最多 4 轮）:
  a. blockout check   ── 数值自检：解算 errors？跨装配体穿透？接地（relations 声明为 touch 的是否贴合）？
  b. blockout sheet   ── 一张四视图拼版（≥1024；同尺度/带米制网格与比例尺；数值摘要随图返回）
  c. 结果自带拼版图，与 check 数字对照着看 ── 只判语义：像不像？哪个部件明显比例错？
     → 改 author.json 的 drivers/size 表达式；不要让模型从像素里量坐标
  d. 数值与语义都过 → 收敛
```

**闸门 G1**：① 长宽高比例与步 1 的目标误差 ≤10%（看 describe 的 worldAabb）；② check 的 collisions 无 error；③ 声明为 touch 的关系 gap ≈ 0；④ 拼版里主体可辨认、无部件缺失。四项全过才进 步 3。

### 步 3｜场景摆放（同一套双循环，数据量更大）

把步 2 收敛的粗模作为 `defs` 定义，在 `scene` 里摆放实例：

- 每个新物体**增量验证**：只对"新物体 + 已有场景"跑 check + sheet，避免 20 个物体一起调。
- 构图问题用 check 的数值回答（包围盒/占屏），不靠眼睛估。
- 需要"排列/阵列/镜像"时用 `combine` + labels，不手写 12 份坐标。

**闸门 G2**：① collisions 无 error；② 主体占屏在 shots 声明的 framing 区间内；③ 拼版里地面与垂直关系正确（无悬空/歪斜）；④ 主体与支撑物的 touch/embed 关系全部 ok。

### 步 4｜运镜设计（shots 段 → 逐帧表）

在 author.json 的 `shots` 里用**分段 + 缓动**描述运镜（完整动作词表见 engine-README.md）：

```jsonc
"hero": {
  "subject": "perfume/*", "durationS": 6, "fps": 24,
  "camera": {
    "target": { "at": "subject", "anchor": "center" },
    "orbit": { "azimuthDeg": 32, "elevationDeg": 18 },
    "framing": { "mode": "fill-height", "fill": 0.42, "lock": "per-frame", "margin": 0.15 },
    "lens": 45, "resolution": [960, 540]
  },
  "moves": [
    { "t": 0.8, "type": "hold" },
    { "t": 3.4, "type": "dolly_in", "framing": { "fill": [0.42, 0.66] }, "ease": "easeInOut" },
    { "t": 5.2, "type": "orbit_left", "deg": 26, "ease": "easeInOut" }
  ],
  "constraints": {
    "coverage": { "frameMin": 3, "frameMax": 40, "inFrameMin": 95, "visibleMin": 80, "graceS": 1.5, "requireAtEnd": true },
    "maxSpeed": 0.8
  }
}
```

- `zoom_in/out`、`dolly_zoom` 需要**改焦距**，本版引擎明确报"尚未实现"——构图变化一律用 `framing.fill` 表达（引擎反解距离）。
- 解算后先 `blockout shot`（数值：逐帧指标与违规）+ `keyframes: true`（关键帧拼版）自检构图与节奏，过了再 `video`。

**闸门 G3**：① 主体在画内（`subjectInFramePct`；出画连续区间必须落在声明的 `graceS` 宽限内，且**镜头结束主体必须回到画内**）；② 无穿墙/穿地（`clearanceM ≥ minClearance`）；③ 起幅与落幅构图符合意图（`frameCoveragePct` 落在声明区间）；④ 主体可见度 `subjectVisiblePct` 不低于声明下限（被挡住要重排或改机位）；⑤ 时长/帧率/分辨率与目标规格一致；⑥ 平滑性：`maxJerk` 不超限（超了说明相机在"抖"不是在"动"）；⑦ 甩镜/急摇必须显式给 `maxAngularSpeed`，且**不要声明 `maxAngularJerk`**（甩镜的急就是意图，声明质量上限会被 autofix 磨平）。

> **必须报错的，不要指望自动纠错**（引擎的职责边界，别搞反）：
> - **创作意图类 → 引擎只报错不救**：主体出画不回、相机穿模、净距不足、超速。自动改机位等于掩盖设计错误。看到 error，**改运镜数据**（回摆角度、轨迹、时长），不要改相机坐标。
> - **执行质量类 → 引擎自动修并留痕**：相机抖（修饰器幅度过大→缩幅）、缓动不连续（升级 `smooth`）。**每次 `corrections[]` 非空都必须读它**。
> - 想让引擎修意图类问题（一般不要），显式 opt-in：`"autofix": { "aim": true, "clearance": true, "speed": true }`。

### 步 5｜导出双轨

| 轨道 | 产物 | 用途 |
|---|---|---|
| **look track** | 首帧 + 尾帧 + 若干关键帧**高清静图**：风格必须与目标成片一致——用用户的参考图，或用图像生成工具把白模关键帧（`shot --keyframes` 的构图 + author 的部件/颜色语义）重绘成目标风格 | 商用 API 的首/尾帧通道；人工与 Agent 的视觉验收 |
| **structure track** | `preview.mp4`（`blockout video`，白模 animatic）+ 逐帧表（pos/quat/c2w/lens/fov + 覆盖与可见度逐帧值）+ measure 数字 | 运镜节奏验证；镜头资产归档；复盘。**depth/normal/edge 序列与相机参数文件属未来扩展，本版引擎不产**——不要向任何通道承诺结构条件图 |

**闸门 G4（花钱的闸门）**：进入生成前必须① look track 的首/尾帧已确认；② structure track 的 preview.mp4 与逐帧表齐全；③ 已向用户说明将提交的通道与预计成本并获同意（沿用视频生成的确认闸门）。

### 步 6｜视频生成（按能力选通道，不硬凑）

优先级从高到低：

1. **首/尾帧通道**（商用主流，本期主通道）——用 look track 的首尾帧锁定构图与落幅，运镜方向与节奏编译成提示词（由 shots 的 moves 段生成，不手写感受词）。
2. **参考视频通道**（部分供应商）——**必须先 A/B 实测**：把白模 preview.mp4 当参考，看输出是"结构参考"还是"画风参考"；若是画风参考（输出变白盒子/CG 灰）则弃用该通道。A/B 未做之前不要假设它可用。
3. **提示词运镜指令**——由 shots 编译（动作类型 + 幅度 + 节奏），配合首尾帧使用。

每次提交都要在结果里记录：用了哪条通道、哪些素材进了请求、哪些被丢弃、为什么。

### 步 7｜成片复盘（Agent 自己看）

用 `skim_video`（全局粗扫）→ `read_video_frames`（关键区间精读）看成片，逐条比对：

| 检查项 | 判据 | 不达标怎么办 |
|---|---|---|
| 运镜方向 | 推/拉/摇/移与 shots 的 moves 同向 | 换通道或把运镜写进提示词更直白 |
| 运镜节奏 | 各分段时长占比与 moves 一致（±25%） | 缩短分段数，商用模型对长指令遵循差 |
| 起/落幅构图 | 与 look track 首尾帧一致 | 首尾帧通道模型未遵循 → 换模型 |
| 主体一致性 | 主体形态/数量正确 | 提示词补主体描述；提高参考图权重 |
| 画风 | 与 look track 一致 | 参考视频被当成了画风参考 → 弃用该通道 |

**闭环**：把偏差写成一句话结论存进 author.json 该镜头的 `review` 字段，重试时作为新约束——**不要在没有任何复盘的情况下重复提交**。

## 5. 成本与迭代纪律

| 资源 | 单价感受 | 纪律 |
|---|---|---|
| 引擎渲染 | 本地、近乎免费 | 随便跑；宁可多渲染几次验证数据，也不要猜坐标 |
| 视觉 token | 每张图 800~1500 token | **一轮迭代只发一张拼版**（sheet 结果自带附图，无需再 read_media）；同物体视觉轮次 ≤4 轮 |
| 视频生成 | 按秒计费 | 先 640×360 短预览验证运镜，确认后再出正式档；单镜头重试 ≤3 次，超了换通道并说明 |

## 6. 失败模式速查

| 现象 | 根因 | 对策 |
|---|---|---|
| 甩镜/急摇之后**主体再也没回到画里** | 回摆角度小于甩出角度 | 让回摆角度 ≥ 甩出角度。这是意图错误 → 引擎只报错不救；同时声明宽限：`coverage.graceS` 容忍甩镜期间离画 + `requireAtEnd: true` |
| 镜头**一直在抖**（不是手持感） | 修饰器逐帧独立随机；或幅度与镜头运动量级失衡 | 用时间连贯的 `handheld` 修饰器（确定性 value noise）；声明 `maxJerk`——属执行质量，引擎自动缩幅并留痕 corrections |
| 主体"明明在画面里"但信息很少 | 把 `fill`（包围盒占比）当成"占画面多少" | `fill` 是构图意图、`frameCoveragePct` 才是真实像素占比，细长主体两者差 10 倍 |
| 主体被前景挡住却没报警 | 只看几何位置没看可见度 | 声明 `coverage.visibleMin`，用 `subjectVisiblePct`（真实光栅化遮挡率）判 |
| 生成的视频"灰白、像 CG" | 把白模当画风参考喂进去了 | 改喂 look track 首/尾帧；白模 preview 只作节奏自检 |
| 运镜方向对但幅度不对 | 商用 API 只认首尾帧构图差与提示词枚举 | 幅度由首尾帧的构图差表达，不靠提示词堆形容词 |
| Agent 反复改坐标越改越歪 | 拿像素当尺子 | 回到 check 的数字表收敛 |
| 场景 20 个物体一起调，全局崩 | 无增量验证 | 逐个加入 + 增量 check |
| check 一堆警告看不过来 | 意图没声明（正常的接触被当异常） | 把"轮-地 touch、树冠-树干 embed"这类关系写进 `relations`；默认安静只留真 error |

## 7. 交付物清单（自查用）

- [ ] `analysis.md`：比例来源、标尺档位、几何体分解表
- [ ] `author.json`：合法、可复现、check 无 error、运镜在 `shots` 段、全部物件有可读 id
- [ ] check 结果：G1/G2/G3 判据全绿（或偏差已书面说明）
- [ ] sheet 拼版：至少一张最终版
- [ ] 逐帧表：`.huabu/blockout/<场景>/<镜头>.frames.json`
- [ ] look track：首帧、尾帧高清静图（风格正确）
- [ ] structure track：preview.mp4（video 成片，已发布素材库）
- [ ] 生成记录：通道、进请求的素材、被丢弃的素材与原因
- [ ] 复盘结论：一句话偏差 + 下一步（重试 / 换通道 / 接受），写入该镜头的 `review` 字段

## 8. 与其他技能/工具的关系

- 看图：`read_media`（图片）；成片复盘：`skim_video` / `read_video_frames`。
- 出图：图像生成工具（把白模关键帧重绘成目标画风，喂首尾帧通道）。
- 引擎数据格式、动作词表、约束与 autofix 细节：`engine-README.md`（随本技能分发）。
- 示例场景：`templates/perfume-on-table.author.json`（桌面产品）、`templates/car-on-road.author.json`（车辆+道路）。
- 兼容版本：引擎 **v0.2.0-mvp**（工具结果首行自报）；不匹配时以工具返回的契约为准。
