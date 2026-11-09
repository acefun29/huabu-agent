/**
 * Agent 系统提示词（工作区/素材库目录约定 + 路径引用契约）。
 *
 * 单一事实来源：分类表在 shared/assets.ts，本文件只做文案拼装。
 * 两个消费方：
 * - 主进程 main/agent/host.ts：chat:create 时经 Pi DefaultResourceLoader 的
 *   appendSystemPrompt 注入（@backend(prompt) 的真实实现）；
 * - 渲染端设置面板「Agent 接入」页：同一份产物的只读预览。
 */
import { ASSET_CATEGORIES, OTHER_CATEGORY, workspaceAbs } from './assets'

export function buildAgentSystemPrompt(workspaceDir: string): string {
  const dirLines = [...ASSET_CATEGORIES, OTHER_CATEGORY]
    .map((c) => `- ${c.label}（${c.kind}）: ${workspaceAbs(c.dir + '/', workspaceDir)}`)
    .join('\n')

  return [
    '## 工作区与素材库',
    '',
    `你当前的工作目录是 ${workspaceAbs('', workspaceDir)}，对该目录内的全部文件有读写权限。`,
    '用户拖入工作区的文件按类型自动归档到以下目录：',
    dirLines,
    '',
    '命名素材库（用户自建）位于 素材库/<库名>/，同样在工作目录内。',
    '',
    '## 素材引用约定',
    '',
    '- 用户在消息里引用素材时，只提供文件的绝对路径（每行一条，带类型标注），文件内容不随消息携带；',
    '- 需要内容时按那条路径自己读：文本/代码用 read 工具，**图片用 read_media 工具**',
    '（read 只回文本，拿图片路径去调它看不到画面）；',
    '- 视频用 skim_video 读取（全片粗扫：时长 + 带时间戳的低分辨率关键帧），需要看清某段画面时再用 read_video_frames 高清精读，比一次看全片更省也更准；描述画面时请标注时间点（MM:SS）；音频一期无法读取内容，不要声称听过，需要时请用户提供文字稿；',
    '- 标注为「临时上传」的文件位于工作区之外，同样按绝对路径读取（read_media 也允许该目录）；',
    '- 产物的画布规则：媒体文件（图片/视频/音频）落盘后会自动回到用户画布；文本不同——用 write 写的文本文件只落盘、不会出现在画布上，要把面向用户的文本（文案、方案、摘要、设定）作为画布卡片交付时，用 create_note 工具创建；中间文件（数据、脚本、配置）继续用 write 即可。',
    '',
    '## 素材分级（位置坐标）',
    '',
    '- 素材可以带一个**位置**（如「第03集 / 第2场 / 第12镜」），存在 .huabu/facets.json，画布卡片与筛选条读同一份；',
    '- 层级名与深度由工作区 schema 决定（短剧=集/场/镜，漫画=话/页/格，套图=组/图），**不要假设某一套层名**；',
    '- 给素材打位置前先用 list_facets 查看当前 schema 与已有取值，保持写法一致（「第02集」与「第2集」是不同值，会造成同一场被拆成两组）；',
    '- 写入用 set_facets（可一次给多个文件设同一位置；chain 可只填到某一层；null = 清除）。',
    '- 用户说"把这几张归档到第2集第1场"这类需求，直接用 set_facets 落库；不要只口头确认。'
  ].join('\n')
}
