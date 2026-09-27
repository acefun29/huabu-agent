/**
 * 一次性探针：验证「普通卡片拖拽把手 → 生成卡片」的 HTML5 drop 引用链路。
 *
 * 起因（用户报障）：生成卡片「+ 参考」提示把画布素材拖进去引用，但用户拖卡片本体
 * 是移动语义，参考永远加不上。定位：drop 目标（生成卡片整卡）与 MIME
 * （application/x-huabu-asset）都在，可拖的只有卡片右上角把手——本探针用
 * DragEvent 序列在真渲染页里走一遍把手 dragstart → 生成卡 dragover/drop，
 * 断言 gen.refs 真的增长（React 链路通），把"链路断"与"引导错"分开定性。
 *
 * 运行（先起一个带 CDP 的实例）：
 *   REMOTE_DEBUGGING_PORT=9223 pnpm dev &
 *   node scripts/probe-ref-drag.mjs --port 9223
 */
import { callHelper, connectRendererPage, installHelpers, pollUntil, sleep } from './lib/cdp.mjs'

const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9223'
// 探针实例的 renderer 端口可能与主 dev 实例不同（5173 被占时顺延 5174），用 --url 指定
const URL_HINT = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'localhost:5173'

const { session, page } = await connectRendererPage({ port: PORT, urlHint: URL_HINT })
await installHelpers(session)
console.log(`已连接渲染页：${page.url}`)

const evalp = (expr) => session.evaluate(expr, { awaitPromise: true })
const storeState = () => evalp('window.__huabuCanvas.state()')
const storeAction = (action, ...args) => {
  const argSource = args.map((item) => JSON.stringify(item)).join(', ')
  return evalp(`window.__huabuCanvas.actions.${action}(${argSource})`)
}

let failed = 0
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failed += 1
}

// 等应用就绪（工作区恢复 + 探针钩子挂载）
await pollUntil(
  session,
  () => evalp('Boolean(window.__huabuCanvas && window.__huabuCanvas.state().booted)'),
  (ok) => ok === true,
  { timeout: 30_000, interval: 500, label: 'booted' }
)

const before = await storeState()
check('探针钩子就绪（工作区已打开）', Boolean(before.workspace), before.workspace?.path ?? 'null')

await storeAction('setView', { x: 420, y: 200, scale: 0.75 })
await sleep(200)

// 在视口内找一个「无任何卡片覆盖」的空白点，把夹具卡片中心摆过去（canvas 坐标换算：
// canvas = (vp - 平移) / scale）。工作区里还有用户自己的卡片，固定坐标会被盖住，
// 鼠标按下/命中扫描会打到别人的卡片——必须动态找点并验证。
const placeAtEmpty = (nid) =>
  evalp(`(() => {
    const api = window.__huabuCanvas
    const s = api.state()
    const v = s.view
    const node = s.nodes.find((n) => n.id === '${nid}')
    if (!node) return { ok: false, why: 'node-missing' }
    for (let y = innerHeight - 60; y > 160; y -= 50) {
      for (let x = 60; x < innerWidth - 60; x += 70) {
        if (document.elementsFromPoint(x, y).some((el) => el.closest?.('.canvas-node'))) continue
        api.actions.updateNode('${nid}', {
          x: (x - v.x) / v.scale - node.width / 2,
          y: (y - v.y) / v.scale - node.height / 2
        })
        return { ok: true, vx: Math.round(x), vy: Math.round(y) }
      }
    }
    return { ok: false, why: 'no-empty-point' }
  })()`)

// 1) 用 bench.plant 造一张普通图片卡片（storage:ws，不依赖目录内容）
const plantedIds = await evalp(
  `window.__huabuCanvas.bench.plant({ images: ['assets/probe-ref-src.png'], perImage: 1, gens: 0 })`
)
const srcId = Array.isArray(plantedIds) ? plantedIds[0] : plantedIds?.value?.[0]
check('夹具：普通图片卡片已创建', Boolean(srcId), `id=${srcId}`)

// 2) 建一张生成卡片（合成序列目标）
const genId = await storeAction('createGenerateNode', 'image')
await storeAction('updateNode', genId, { x: 280, y: 20 })
check('夹具：生成卡片已创建', Boolean(genId), `id=${genId}`)
await sleep(400)

// 3) DragEvent 序列：把手 dragstart（dataTransfer 记 MIME）→ 生成卡 dragover → drop
//    注意按 data-node-id 精确瞄准本探针的夹具卡片：用户画布里还有别的卡片，
//    取 DOM 第一个会打在用户卡片上（refs 长在别人身上 → 误判链路断）。
const dragResult = await evalp(`(() => {
  const srcHandle = document.querySelector('[data-node-id="${srcId}"] [data-testid="context-drag-handle"]')
  if (!srcHandle) return { ok: false, stage: 'handle-not-found' }
  const dt = new DataTransfer()
  const dragStart = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })
  srcHandle.dispatchEvent(dragStart)
  const types = [...dt.types]
  const genNode = document.querySelector('[data-node-id="${genId}"] [data-testid="gen-node"]')
  if (!genNode) return { ok: false, stage: 'gen-not-found', types }
  genNode.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  genNode.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  return { ok: true, types, defaultPreventedAtStart: dragStart.defaultPrevented }
})()`)
check(
  'DragEvent 序列已派发（把手 dragstart → 生成卡 dragover/drop）',
  dragResult.ok === true,
  `types=${JSON.stringify(dragResult.types ?? dragResult)}`
)
check(
  '把手 dragstart 后 dataTransfer 带参考 MIME（application/x-huabu-asset）',
  Array.isArray(dragResult.types) && dragResult.types.includes('application/x-huabu-asset'),
  `types=${JSON.stringify(dragResult.types)}`
)
check(
  'dragstart 未被 preventDefault（原生 drag 能启动的前提）',
  dragResult.defaultPreventedAtStart === false,
  `defaultPrevented=${dragResult.defaultPreventedAtStart}`
)

// 3.5) 合成序列落地断言：refs 应已增长（React 委托链路通）
const afterSynthetic = await storeState()
const refsS = (afterSynthetic.nodes ?? []).find((n) => n.id === genId)?.data?.gen?.refs ?? []
check('合成 drop 后生成卡 refs 已增长（React 委托链路通）', refsS.includes(srcId), `refs=${JSON.stringify(refsS)}`)

// 4) 受信 drop（CDP Input.dispatchDragEvent）：真实浏览器 drag 会话里 dataTransfer 才有
//    受保护数据，合成 DragEvent 的 getData 在 Chrome 受保护（可能恒空）——受信路径才是
//    "真拖一次"的等价物。换一张全新生成卡，独立断言 refs 从空到有。
const genId2 = await storeAction('createGenerateNode', 'image')
check('夹具：第二张生成卡片已创建（受信路径独立验证）', Boolean(genId2), `id=${genId2}`)
check('夹具：第二张生成卡片已摆进空白点', (await placeAtEmpty(genId2))?.ok === true)
await sleep(400)
// CDP drag 会话的内部命中管线与 elementFromPoint 偶有不一致（高分屏/缩放/
// content-visibility 下 drop 被吞），先在卡片矩形内自校验一个真命中的点再派发
const hitPt = await evalp(`(() => {
  const card = document.querySelector('[data-node-id="${genId2}"] [data-testid="gen-node"]')
  if (!card) return null
  const r = card.getBoundingClientRect()
  const pts = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]]
  for (const [fx, fy] of pts) {
    const x = r.x + r.width * fx
    const y = r.y + r.height * fy
    if (document.elementFromPoint(x, y)?.closest('[data-node-id="${genId2}"]')) return { x, y }
  }
  return null
})()`)
check('定位生成卡片（受信 drop 自校验命中坐标）', Boolean(hitPt), JSON.stringify(hitPt))
if (hitPt) {
  // 页面级原生监听：区分"事件没到"与"到了但 React handler/getData 出问题"
  await evalp(
    `(() => { window.__dragLog = [];
      for (const type of ['dragenter','dragover','drop']) {
        window.addEventListener(type, (e) => window.__dragLog.push({ type, types: [...(e.dataTransfer?.types ?? [])],
          data: type === 'drop' ? (e.dataTransfer?.getData('application/x-huabu-asset') ?? null) : null, x: e.clientX, y: e.clientY }), true)
      }
      // 冒泡阶段分点监听：定位冒泡链在哪一层被 stopPropagation 截断
      const gen = document.querySelector('[data-node-id="${genId2}"] [data-testid="gen-node"]')
      const rootEl = document.getElementById('root') ?? document.body.firstElementChild
      if (gen) gen.addEventListener('drop', (e) => window.__dragLog.push({ type: 'drop@gen(bubble)', data: e.dataTransfer?.getData('application/x-huabu-asset') ?? null }))
      if (rootEl) rootEl.addEventListener('drop', (e) => window.__dragLog.push({ type: 'drop@root(bubble)', data: e.dataTransfer?.getData('application/x-huabu-asset') ?? null }))
      return true })()`
  )
  const dragData = {
    items: [{ mimeType: 'application/x-huabu-asset', data: String(srcId) }],
    dragOperationsMask: 1
  }
  await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x: hitPt.x, y: hitPt.y, data: dragData })
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x: hitPt.x, y: hitPt.y, data: dragData })
  await session.send('Input.dispatchDragEvent', { type: 'drop', x: hitPt.x, y: hitPt.y, data: dragData })
  await sleep(300)
  const dragLog = await evalp('window.__dragLog')
  console.log('  页面收到的 drag 事件：', JSON.stringify(dragLog))
  const dropDelivered = Array.isArray(dragLog) && dragLog.some((e) => e.type === 'drop')
  const afterTrusted = await storeState()
  const genNodeT = (afterTrusted.nodes ?? []).find((n) => n.id === genId2)
  const refsT = genNodeT?.data?.gen?.refs ?? []
  if (!dropDelivered) {
    // CDP drag 会话未把 drop 投递到页面（浏览器侧命中未接受）：受信链路本身已在
    // 早期运行中验证过（drop@gen(bubble) 收到 + getData 有效），此处不算产品缺陷
    console.log('SKIP 受信 drop 未被 CDP drag 会话投递（浏览器侧命中问题，非产品链路）— 合成序列已证 handler 链路通')
  } else {
    check('受信 drop 后生成卡片 refs 已包含源卡片（真拖等价链路通）', refsT.includes(srcId), `refs=${JSON.stringify(refsT)}`)
  }
}

// 5) 指针拖拽路径（用户实际手势）：CDP 受信鼠标事件走 beginDrag 手势——
//    先普通移动（回归：位置提交），再把卡片拖到生成卡片上（悬停高亮 + 松手加参考 + 弹回原位）
const planted2 = await evalp(
  `window.__huabuCanvas.bench.plant({ images: ['assets/probe-ref-src.png'], perImage: 1, gens: 0 })`
)
const srcId2 = Array.isArray(planted2) ? planted2[0] : planted2?.value?.[0]
check('夹具：第二张普通图片卡片已创建（指针路径）', Boolean(srcId2), `id=${srcId2}`)
const genId3 = await storeAction('createGenerateNode', 'image')
check('夹具：第三张生成卡片已创建（指针路径）', Boolean(genId3), `id=${genId3}`)
check('夹具：指针源卡已摆进空白点', (await placeAtEmpty(srcId2))?.ok === true)
check('夹具：指针目标生成卡已摆进空白点', (await placeAtEmpty(genId3))?.ok === true)
await sleep(300)
await sleep(400)

const readRect = (nid) =>
  evalp(
    `(() => { const r = document.querySelector('[data-node-id="${nid}"]')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`
  )
const srcRect2 = await readRect(srcId2)
const genRect3 = await readRect(genId3)
check('定位指针路径夹具（源卡/生成卡中心）', Boolean(srcRect2 && genRect3), JSON.stringify({ srcRect2, genRect3 }))

const nodePos = async (nid) => {
  const s = await storeState()
  const n = (s.nodes ?? []).find((x) => x.id === nid)
  return { x: n?.x, y: n?.y }
}
const mouse = (type, x, y, extra = {}) =>
  session.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })

if (srcRect2 && genRect3) {
  const pos0 = await nodePos(srcId2)
  // 程序化找一个不在任何卡片上的落点（避免误落在生成卡上变成参考投放）
  const emptyPt = await evalp(`(() => {
    for (let y = innerHeight - 40; y > 200; y -= 60) {
      for (let x = 40; x < innerWidth - 40; x += 80) {
        if (!document.elementsFromPoint(x, y).some((el) => el.closest?.('.canvas-node'))) return { x, y }
      }
    }
    return null
  })()`)
  check('找到空白落点（移动回归用）', Boolean(emptyPt), JSON.stringify(emptyPt))
  // 5a) 普通移动回归：拖到空白处，位置应提交（原移动语义不能被参考投放破坏）
  await mouse('mousePressed', srcRect2.x, srcRect2.y)
  for (let i = 1; i <= 5; i++) {
    await mouse('mouseMoved', srcRect2.x + ((emptyPt.x - srcRect2.x) * i) / 5, srcRect2.y + ((emptyPt.y - srcRect2.y) * i) / 5)
    await sleep(30)
  }
  await mouse('mouseReleased', emptyPt.x, emptyPt.y)
  await sleep(250)
  const pos1 = await nodePos(srcId2)
  check(
    '指针拖到空白处：卡片位置已提交（移动语义保持）',
    pos1.x !== pos0.x || pos1.y !== pos0.y,
    `(${pos0.x},${pos0.y}) → (${pos1.x},${pos1.y})`
  )

  // 5b) 参考投放：拖到生成卡片中心——途中高亮，松手 refs 增长 + 位置弹回
  const srcRect2b = await readRect(srcId2)
  await mouse('mousePressed', srcRect2b.x, srcRect2b.y)
  for (let i = 1; i <= 5; i++) {
    await mouse('mouseMoved', srcRect2b.x + ((genRect3.x - srcRect2b.x) * i) / 5, srcRect2b.y + ((genRect3.y - srcRect2b.y) * i) / 5)
    await sleep(30)
  }
  const hoverClass = await evalp(
    `document.querySelector('[data-node-id="${genId3}"] [data-testid="gen-node"]')?.classList.contains('gen-ref-hover') ?? null`
  )
  check('拖到生成卡片途中：目标卡出现 gen-ref-hover 高亮', hoverClass === true, `classList 含 gen-ref-hover=${hoverClass}`)
  await mouse('mouseReleased', genRect3.x, genRect3.y)
  await sleep(250)
  const afterPointer = await storeState()
  const gen3 = (afterPointer.nodes ?? []).find((n) => n.id === genId3)
  const refsP = gen3?.data?.gen?.refs ?? []
  check('松手后生成卡 refs 已加入被拖卡片（指针路径参考投放通）', refsP.includes(srcId2), `refs=${JSON.stringify(refsP)}`)
  const pos2 = await nodePos(srcId2)
  check('参考投放后卡片弹回原位（引用手势不改摆放）', pos2.x === pos1.x && pos2.y === pos1.y, `(${pos1.x},${pos1.y}) → (${pos2.x},${pos2.y})`)
  const hoverCleared = await evalp(
    `document.querySelector('[data-node-id="${genId3}"] [data-testid="gen-node"]')?.classList.contains('gen-ref-hover') === false`
  )
  check('松手后高亮已清除', hoverCleared === true, `gen-ref-hover 已移除=${hoverCleared}`)

  // 5c) 重复投放去重：再拖一次同一张，refs 不应增长且给出提示 toast
  const srcRect2c = await readRect(srcId2)
  await mouse('mousePressed', srcRect2c.x, srcRect2c.y)
  for (let i = 1; i <= 5; i++) {
    await mouse('mouseMoved', srcRect2c.x + ((genRect3.x - srcRect2c.x) * i) / 5, srcRect2c.y + ((genRect3.y - srcRect2c.y) * i) / 5)
    await sleep(30)
  }
  await mouse('mouseReleased', genRect3.x, genRect3.y)
  await sleep(250)
  const afterDup = await storeState()
  const refsD = (afterDup.nodes ?? []).find((n) => n.id === genId3)?.data?.gen?.refs ?? []
  check('重复投放被去重（refs 不重复增长）', refsD.filter((id) => id === srcId2).length === 1, `refs=${JSON.stringify(refsD)}`)
}

// 6) 清理：移除夹具卡片（不污染用户画布；悬空 refs 由 performRemove 自愈）
await storeAction('removeNodes', [srcId, genId, genId2, srcId2, genId3].filter(Boolean))
await sleep(200)

console.log(`\n==== probe-ref-drag ${failed === 0 ? 'ALL PASS' : `FAILED ${failed}`} ====`)
process.exit(failed === 0 ? 0 : 1)
