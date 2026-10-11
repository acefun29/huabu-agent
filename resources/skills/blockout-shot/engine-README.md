# blockout MVP 引擎

极简、零依赖的「数据化粗模」引擎：Agent 只写**驱动参数 + 表达式 + 锚点关系**，坐标/碰撞/度量由引擎解算。
引擎随 huabu 应用分发（应用资源目录），**在会话里经 `blockout` 工具调用**（SKILL.md 的契约表）；本文档是数据格式与语义的权威参考。

## 运行

引擎目录里也可直接命令行调试（开发/诊断用；日常走 blockout 工具）：

```bash
node selftest.mjs                       # 黄金夹具（53 项：表达式 / 解析碰撞对照 / 位姿 / 自动取景 / 运镜约束）
node cli.mjs check   --scene <author.json>
node cli.mjs describe --scene <author.json> --out /tmp/table.json
node cli.mjs resolve --scene <author.json>

# ★ 主交付：自动取景四视图拼版（一张图，机位全部由几何解算，author 里没有任何相机坐标）
node cli.mjs sheet   --scene templates/perfume-on-table.author.json \
                     --out ../../out/perfume-sheet.png --size 1024
node cli.mjs view    --scene templates/perfume-on-table.author.json \
                     --view top --out ../../out/top.png --width 512 --height 512

# 参数化试算：改驱动 → 几何、碰撞、取景全部自动跟随
node cli.mjs sheet   --scene templates/perfume-on-table.author.json --set bottleH=0.30 --out /tmp/tall.png
node cli.mjs sheet   --scene templates/perfume-on-table.author.json --set placeX=0.45 --out /tmp/moved.png

# ★ 运镜：意图进、机位出（逐帧表是引擎产物，不是输入）
node cli.mjs shot    --scene S --shot hero                    # 摘要 + 指标 + 违规
node cli.mjs shot    --scene S --shot hero --out hero.json    # 落盘逐帧表（pos/quat/c2w/lens/fill）
node cli.mjs shot    --scene S --shot hero --frames           # 摘要里附全部逐帧
node cli.mjs shot    --scene S --shot hero --sheet kf.png     # 4 张关键帧拼版（视觉自检）
node cli.mjs shots   --scene S                                # 全部镜头 + 镜头间连续性
```

退出码：`0` 正常 ｜ `1` 用法/IO ｜ `2` 解算有 error ｜ `3` 约束违规（出画/穿模/超速/净距不足）。

## 自动取景（`views`）—— 粗模图完全由参数导出

author 里**只声明意图，不写任何相机坐标**：

```jsonc
"views": {
  "subject": "auto",              // auto = 自动判定主体；也可给模式串如 "perfume/*"
  "fit": "context",               // subject（只框主体）| context（主体 + 裁剪窗内的支撑物，默认）| scene
  "contextRadius": 0.75,          // 裁剪窗外扩倍数（按主体尺寸）
  "marginRatio": 0.18,            // 四周留白比例
  "size": 1024,                   // 拼版边长（一张图）
  "ssaa": 2,
  "layout": ["front", "right", "top", "threequarter"],
  "threeQuarter": { "azimuthDeg": 32, "elevationDeg": 24, "lens": 45 },
  "gridStep": "auto"
}
```

规则：

| 环节 | 解算方式 |
|---|---|
| **主体判定** | 优先「被别的装配体支撑着的那个装配体」（摆在上面的东西），多候选取 AABB 体积最小者；无支撑关系则取最小非平面装配体。`sheet` 输出里带 `subject.reason` 说明判定依据 |
| **裁剪窗（智能截取）** | 以主体 AABB 为中心按 `contextRadius` 外扩成窗口，只纳入**落在窗内**的支撑物，并把支撑物 AABB **裁到窗口内** —— 既看得到"摆在什么上面"，又不会被整张桌子撑爆画框 |
| **正交三视图** | 把取景框 8 个角投影到视平面，按单元格宽高比取 `orthoHeight = max(h, w·cellH/cellW)·(1+margin)`，中心 = 取景框中心。四视图**同尺度**，可互相比较大小 |
| **3/4 透视** | 以取景框外接球为基准反解距离（方位角/仰角/镜头由 `threeQuarter` 决定），保证完整入画 |
| **比例尺** | 由 `orthoHeight / cellH` 反推 worldPerPx，再选一个"好看"的步长（像素间距落在可读区间），标注米制数字 |
| **页脚** | 取景框尺寸 + 主体 id + fit 模式 + 部件数/驱动数 —— 数值随图一起给，Agent 不必从像素里量 |

> 一张 1024 拼版 ≈ 1 张图的 token；若分四次单独出图，harness 会对每张图各缩一次到 1024px，等于 4 倍 token。这是"省 token"的实际机制。

## 运镜（`shots`）—— 相机坐标同样禁止手写

```jsonc
"shots": {
  "hero": {
    "subject": "perfume/*",
    "durationS": 6, "fps": 24,
    "camera": {
      "target": { "at": "subject", "anchor": "center", "offset": [0, 0, 0.012] },
      "orbit": { "azimuthDeg": 32, "elevationDeg": 18 },
      "framing": { "mode": "fill-height", "fill": 0.42, "lock": "per-frame", "margin": 0.15 },
      "lens": 45, "sensorWidth": 36, "resolution": [960, 540],
      "aimMode": "look-at", "roll": "level", "space": "camera"
    },
    "moves": [
      { "t": 0.8, "type": "hold" },
      { "t": 3.4, "type": "dolly_in", "framing": { "fill": [0.42, 0.66] }, "ease": "easeInOut" },
      { "t": 5.2, "type": "orbit_left", "deg": 26, "ease": "easeInOut" },
      { "t": 6.0, "type": "hold" }
    ],
    "constraints": { "keepInFrame": { "marginPx": 16 }, "levelHorizon": true, "noCollision": true, "minClearance": 0.12, "maxSpeed": 0.8 }
  },
  "turntable": { "subject": "perfume/*", "durationS": 4, "fps": 24, "camera": { /* … */ },
                 "loop": { "mode": "turntable", "revolutions": 1 } }
}
```

| 参数 | 说明 |
|---|---|
| `target` | `at: 'subject'` 或部件 id + `anchor`（`center/base_center/top_center/bbox_*/face(±X±Y±Z)`）+ `offset` |
| `framing` | `mode: fill-height / fill-width / fit`；`fill` 可以是数值或 `[起, 止]`；`lock: per-frame / start-only`；`margin` |
| `orbit` | `azimuthDeg` / `elevationDeg`（起始机位的球坐标，**不是坐标**） |
| `aimMode` | `look-at`（默认）/ `free`（见下方防滥用） |
| `roll` | `level`（默认，地平线锁定）/ 数值 |
| `space` | `world` / `camera`（默认）/ `subject` —— **每个动作可用 `space` 单独覆盖** |
| `moves` | `hold` / `dolly_in·out` / `truck_left·right` / `pedestal_up·down` / `orbit_left·right` / `crane_up·down` / `push_axis` / `pan_left·right` / `tilt_up·down` / `roll_move` |
| 幅度 | `amount`（m）、`deg`（度），或 `framing.fill`（**用构图比例表达推拉**，距离由引擎反解） |
| `ease` | `linear` / `easeIn` / `easeOut` / `easeInOut` / `smooth`（smootherstep，C2 连续，段间不"顿"） |
| `loop` | `{mode:'turntable', revolutions}`（转台）、`once`、`ping-pong` |
| `modifiers` | `handheld`（`amplitudeM/frequencyHz/seed`，**确定性**，禁 `Math.random`） |
| `constraints` | `keepInFrame.marginPx` / `levelHorizon` / `noCollision` / `minClearance` / `maxSpeed` / `noOcclusion` |

**语义要点（实现中实测确认的三条）**：
1. **只做改机位**：构图变化一律靠移动相机反解距离，`lens` 是每镜头常量；`zoom_in/out`、`dolly_zoom` 需要改焦距，本版**明确报「尚未实现」**而不是静默跳过。
2. **`lock: 'per-frame'` 会把平移"吃"成弧线**：为了恒定占屏，相机被约束在等距离球面上滑动，`truck_right 1m` 的实际位移 ≈ 0.985m，且路径不再是直线。这是正确行为（真机位跟随也是如此），夹具 E15 专门锁这条语义。
3. **`aimMode:'free'` 防滥用**：必须填 `aim.reason`（≥4 字）、关键帧 ≤ 8，且输出**恒带 warning**；缺任一项直接 error。

**引擎输出的逐帧表**（`--out` 落盘，下游一切从这里取）：
`t / frame / pos[3] / target[3] / quat[4] / c2w[16] / lens / fovDeg / rollDeg / fill / marginPx / clearanceM / nearestSolid / frameCoveragePct / subjectVisiblePct / subjectInFramePct / subjectBBoxPx`。
逐帧值只做 9 位小数收敛——**不能用显示精度**，否则"精确每帧 15°""恒定 0.5m/s"这类不变量会被量化破坏（夹具 E2/E7 锁这条）。

## 覆盖面 / 可见度（三个不同的量，别混用）

| 指标 | 定义 | 回答的问题 |
|---|---|---|
| `fill` | 主体投影**包围盒高度** / 画面高度 | 构图意图（推轨用 `framing.fill` 表达的就是它） |
| `frameCoveragePct` | 主体**像素** / 全画面像素 | **镜头覆盖面**：主体真正占了画面多少（细长主体的 fill 与它差异极大） |
| `subjectInFramePct` | 主体投影包围盒落在画内的**面积**比例 | 主体有多少**落在画内**（出画会拉低；与遮挡无关） |
| `subjectVisiblePct` | 全场渲染里的主体像素 / 只渲染主体时的轮廓像素 | 主体有多少**真的可见**（被别的几何体挡住会拉低） |

像素级两个量走真实光栅化（默认 128px 宽渲染两遍：全场 + 仅主体），`--coverage-res 0` 可关闭。

约束写法定量：

```jsonc
"constraints": {
  "coverage": {
    "frameMin": 3, "frameMax": 40, "inFrameMin": 95, "visibleMin": 80,
    "graceS": 1.5,        // 允许主体连续离开画面多久（甩镜/急摇要用）
    "requireAtEnd": true  // 镜头结束时主体必须回到画内（默认 true）
  },
  "maxAngularSpeed": 420,   // 甩镜的合法上限（不写就是无限制）
  "maxJerk": 6,             // 急动上限：抓"相机在抖"而不是"在动"
  "maxAngularJerk": 400     // 角急动上限：抓"转动卡顿/一顿一顿"
}
```

**出画按"连续区间 + 宽限窗口"判，不按帧数判**：甩镜/急摇本来就该把主体甩出画面（这是运镜意图），所以

- 离画**连续时长 ≤ `graceS`** → `warn`（`motion/subject-off-screen`，记录哪一段）；
- 超过宽限，**或**结束时主体还没回画内（`requireAtEnd`）→ `error`，并直接说明是哪一句：
  `主体出画且镜头结束时仍未回到画内：连续 2.78s（帧 10–77）`。

三个覆盖/可见指标**只在主体在画内的帧上统计**——主体在画外时这三个量天然是 0，那是"出画"问题，不该被误报成"被遮挡"（夹具 E23 锁这条）。

## 自动纠错（`autofix`）——只修执行质量，不改创作意图

职责边界（这条是核心）：

| 类别 | 例子 | 引擎怎么做 |
|---|---|---|
| **执行质量** | 相机在抖（修饰器幅度过大）、转动卡顿（缓动不连续、轨迹毛刺） | **自动修**，并把每一次修改写进 `corrections[]` |
| **创作意图** | 主体没照到、相机穿模、超速、角速度超限 | **只报错**。这类问题"自动修"就是掩盖设计错误——机位被偷偷改回主体，作者永远不知道自己的运镜是错的 |

默认开启（`"autofix": false` 只诊断不修）。质量类修复：

| 修复 | 触发 | 做法 |
|---|---|---|
| `param-scale`（修饰器） | `maxJerk` / `maxAngularJerk` 超限且镜头有修饰器 | 按 目标/实测 比例缩全部修饰器幅度（jerk∝幅度，闭式）→ 重采样 |
| 缓动升级 | 同上，但超限来自缓动不连续 | 非 C2 缓动（`easeIn`/`easeOut`/`easeInOut`/默认）升级为 `smooth`：保持时长与幅度，只改曲线形状 |
| `path-smooth` | 上面两步之后仍超限 | 对轨迹做 5 抽二项式平滑（端点保持），就地改帧 |

意图类修复必须显式 opt-in，默认**不做**（做了会改变创作意图，且会掩盖设计错误）：

```jsonc
"autofix": { "aim": true, "clearance": true, "speed": true, "maxPasses": 3 }
// aim       → aim-clamp：二分最小修正角把朝向钳回主体入画
// clearance → clearance-push：沿最近实体外推方向推出到 minClearance 之外
// speed     → param-scale（动作）：按比例缩动作幅度，保形放慢
```

修复循环最多 `autofix.maxPasses`（默认 3）趟，直到无 error；仍然修不好的照常报 error。

**⚠️ 甩镜不要声明 `maxAngularJerk`**：甩镜的"急"（角速度突变）就是意图，声明质量上限等于让 autofix 把这一甩磨平。角速度则要**显式放宽**（如 `maxAngularSpeed: 700`）——甩镜天生超普通上限。

**实测效果**（真实缺陷）：

| 案例 | 修复前 | 修复后 |
|---|---|---|
| `dutch_whip`（回摆不足） | 78 帧里 **66 帧主体完全不在画内**、末帧无主体（意图错误被静默接受） | ① 修正授权：回摆 85° 匹配甩出角度；② 现在只剩一条 **warn**：`主体出画 0.66s，在宽限 1.5s 内（甩镜允许，帧 10–26）`；③ 若回摆仍不足（55°）→ **`ok=false` + error**：`主体出画且镜头结束时仍未回到画内：连续 2.78s（帧 10–77）`，0 处纠错 |
| `handheld_follow`（相机一直在抖） | 手持修饰器是**逐帧白噪声** → 24fps 下 12Hz 振动，急动 **12.79 m/s³** | 改为时间连贯的 value noise：急动 **1.263 m/s³**（降 10 倍），角急动 91 °/s³ |

（顺带被夹具抓出的第三个 bug：`framing.fill` 的轨迹**漏了分段 `ease`**，用构图表达的推轨一直静默走线性——两条缓动曲线急动完全相同才暴露出来。夹具 E22 现在锁这条。）




## 文件

| 文件 | 职责 |
|---|---|
| `expr.mjs` | 表达式求值器：白名单函数、编译期 refs 收集、禁用 `pow/sin/cos/exp/log` 与宿主求值 |
| `geom.mjs` | 9 种图元的网格 + **解析支撑函数** + GJK 距离 + 世界包围盒 + `createPart` |
| `resolve.mjs` | author → resolved：drivers → 图元 → 锚点/关系 → 组合 → 碰撞与意图关系 → `describe` |
| `render.mjs` | 软光栅化（z-buffer / 1÷z 透视正确 / ID 描边 / 米制网格 / 接触压暗 / 2×SSAA）+ 自写 PNG 编码 |
| `cli.mjs` | 命令行入口 |
| `selftest.mjs` | 黄金夹具（改引擎后**先跑这个**） |

## author 场景格式（version 2）

```jsonc
{
  "version": 2, "units": "m", "up": "Z",
  "drivers": {
    "H_table": 0.75,
    "topW": 1.10,
    "legSpanX": "$topW - $legW - 2*$legInsetX"   // 驱动参数本身也可用表达式
  },
  "defs": {
    "table": {
      "parts": [
        { "id": "top", "shape": "box", "size": ["$topW", "$topD", "$topT"], "color": "#8a6f52",
          "at": { "anchor": "base_center", "to": "ground", "offset": [0, 0, "$H_table - $topT"] } },
        { "id": "leg", "shape": "box", "size": ["$legW", "$legW", "$legH"],
          "at": { "rest": "ground" },
          "combine": [
            { "op": "array", "along": "X", "count": 2, "step": "$legSpanX", "centered": true, "labels": ["L", "R"] },
            { "op": "array", "along": "Y", "count": 2, "step": "$legSpanY", "centered": true, "labels": ["front", "back"] }
          ] },
        { "id": "cap", "shape": "cylinder", "radius": "$capR", "height": "$capH",
          "at": { "anchor": "base_center", "to": { "ref": "neck", "anchor": "top_center" } } }
      ]
    }
  },
  "scene": [
    { "id": "floor", "shape": "plane", "size": [8, 8], "at": { "rest": "ground" } },
    { "use": "table", "id": "table", "at": {} },
    { "use": "perfume", "id": "perfume",
      "at": { "to": { "ref": "table/top", "anchor": "face(+Z)" }, "offset": [0.2, 0.05, 0] } }
  ],
  "relations": [
    { "a": "perfume/body", "b": "table/top", "mode": "touch", "tol": 0.002 },
    { "a": "perfume/label", "b": "perfume/body", "mode": "embed", "maxDepth": 0.05 },
    { "a": "perfume/*", "b": "floor", "mode": "clear", "minGap": 0.4 }
  ],
  "cameras": [{ "name": "hero", "type": "persp", "lens": 45, "eye": [0.7, -0.66, 1.0], "target": [0.19, 0.05, 0.8] }]
}
```

要点：
- **图元**：`box` `plane` `wedge` `prism` `cylinder` `cone` `sphere` `ellipsoid` `capsule`；局部原点一律在**几何中心**。
- **表达式**：`$ref`、`+ - * / ( )`、`min max clamp lerp round floor ceil abs sqrt`。**没有** `pow/sin/cos/exp/log`（跨引擎不保证逐位一致，会破坏"同输入同输出"）。
- **锚点**：`center` `base_center` `top_center` `bbox_min/max` `face(±X/±Y/±Z)` `corner(±X±Y±Z)` `cap(±Z)`。
- **放置**：`at.rest:"ground"`（整件贴地）｜ `at.anchor + at.to:"ground"`（锚点对齐地面）｜ `at.to:{ref,anchor}`（对齐兄弟件或已放置实例的锚点）。offset 是世界轴向的平移。
- **组合**：`array`（`along/count/step/centered/labels`）与 `mirror`（`axis/labels`）。**`labels` 必填**，展开后的 ID 形如 `leg.L_front`。
- **意图关系**：`touch`（应接触）｜`embed`（故意嵌入，带 `maxDepth`）｜`attach`（不检查）｜`clear`（必须留间隙 `minGap`）｜`ignore`。**未声明的跨装配体穿透才是 error**，同装配体内部一律不报（并集建模的正常重叠）。

## MVP 的已知限制（诚实清单）

| 限制 | 说明 |
|---|---|
| 位姿 | 只支持绕 Z 的 yaw；无任意旋转、无部件级缩放（尺寸一律走参数）；镜像仅轴对齐 |
| `wedge` | 固定为直角三角形棱柱，暂不支持 `slope` 渐变 |
| 穿透深度 | 分离时 GJK 精确；**穿透深度是下界**（`approx: true`），不是精确值 |
| 渲染 | 只有 flat 着色 + ID 描边 + 接触压暗；无材质/纹理/透明/阴影贴图；无几何抗锯齿（用 2×SSAA 代替） |
| 相机 | **刻意不支持任意摆放**：只能通过 `views` 意图声明，机位一律解算；尚未接入逐帧运镜（下一步） |
| 遮挡率 | 需要真实光栅化统计，当前未输出 `visibleRatio` |
| 输入 | 无 glTF 导入；`extrude`/`lathe` 未实现 |

## 扩展顺序（建议）

1. **逐帧运镜 + `framing`**（主体是否全程出画）——`engine/blockout.mjs` 的 v0.1 已有可复用实现，接到 MVP 的解算结果上即可
2. 深度/法线/边缘 pass 导出（下游自建受控生成用）
3. 模板库（`use: "template:car"` 之类）
4. `visibleRatio`（ID 缓冲像素计数）
5. 几何裁剪到取景框（3/4 视图里超出的支撑物目前会溢出画框）
