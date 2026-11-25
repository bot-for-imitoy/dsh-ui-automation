/**
 * dsh-ui-automation — numbered-image UI control for DSH (Linux only).
 *
 * The model sees a screenshot with yellow numbered badges. Every action takes
 * an index from that image, clicks the recorded centre with XTEST, waits, and
 * returns the next numbered image. There is no launch/sandbox management and no
 * name/role/path or coordinate addressing: number = pixel.
 *
 * The plugin drives whatever display is configured — in a test that is a
 * throw-away Xvfb, on a desktop it is the real screen. Tools are therefore
 * limited to allow-listed sessions/workspaces by default.
 *
 * A wrapper that owns a natural-language entry point (`dsh-ui-nl`) can take
 * the surface over through the published `uiAutomationVisibility` service:
 * ordinary Sessions then stop seeing the six tools, while subagent Sessions
 * keep their per-agent grant. See `lib/visibility.js`.
 *
 * @module dsh-ui-automation
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Automation } from './lib/automation.js'
import { loadShipped } from './lib/shipped.js'
import { createTools } from './lib/tools.js'
import { UiAutomationVisibility } from './lib/visibility.js'

const schemastery = await loadShipped('@deepseek-ai/schemastery')
const z = schemastery.default ?? schemastery

/** Cordis diagnostic name. */
export const name = 'ui-automation'

/** Required services. */
export const inject = ['tools', 'workspaceRegistry']

/** Live plugin settings. */
export const Config = z.object({
  display: z.string().default('').volatile()
    .description('目标 X display，例如 ":0" 或 ":107"。留空时使用 process.env.DISPLAY（再缺省为 ":0"）。'),
  dbusAddress: z.string().default('').volatile()
    .description('可选：AT-SPI 所在的 session D-Bus 地址。留空表示继承 Host 环境变量；CI 私总线时填写。'),
  atspiBusAddress: z.string().default('').volatile()
    .description('可选：私有 a11y 总线地址（AT_SPI_BUS_ADDRESS）。留空表示继承 Host 环境；测试/CI 使用独立 a11y 总线时填写。'),
  screenshotDir: z.string().default('').volatile()
    .description('标号图片与 sidecar JSON 的目录；留空表示插件目录下的 screenshots/。'),
  fontFile: z.string().default('/usr/share/fonts/TTF/Hack-Bold.ttf').volatile()
    .description('徽章数字使用的 TTF 字体路径。'),
  maxDepth: z.number().default(24).volatile()
    .description('AT-SPI 遍历深度，4–32，默认 24（Electron 应用需要 24 以上）。'),
  maxTargets: z.number().default(60).volatile()
    .description('一张图标号的最大数量，1–200；超出按阅读顺序截断。'),
  padding: z.number().default(6).volatile()
    .description('按窗口裁剪时四周保留的像素，0–40。'),
  crop: z.boolean().default(true).volatile()
    .description('是否按窗口并集裁剪截图（去掉黑桌面）。'),
  afterSeconds: z.number().default(1).volatile()
    .description('每次操作后等待多少秒再重新截图，0–30；工具参数可覆盖。'),
  keepImages: z.number().default(15).volatile()
    .description('保留最近多少组生成的标号图片（PNG + sidecar），1–500；精选截图不受影响。'),
  gtk4OriginFallback: z.boolean().default(true).volatile()
    .description('GTK4 的 AT-SPI SCREEN 坐标恒为 (0,0)；开启时用 X11 顶层窗口原点 + WINDOW 矩形修复（需要 xwininfo）。关闭后这些应用会被明确拒绝，而不是按 (0,0) 编号。'),
  attachImage: z.boolean().default(true).volatile()
    .description('是否把 PNG 保存为 attachment 并作为图片块放进工具结果；失败时退回 imagePath。'),
  enabledSessionIds: z.string().default('').volatile()
    .description('额外允许使用本插件的会话 ID，逗号分隔。'),
  allowedWorkspacePaths: z.string().default('').volatile()
    .description('允许使用本插件的工作区目录，逗号分隔；留空表示仅插件自身所在目录。'),
  allowAllSessions: z.boolean().default(false).volatile()
    .description('对所有会话开放。默认关闭：插件可以操作用户真实桌面。'),
})

const PROMPT = `## 标号图片 UI 控制（dsh-ui-automation）

这个环境可以用"标号截图"操作 Linux 桌面上的 GUI：

- 先 ui_screenshot：返回一张 PNG（黄色数字徽章 + 细边框）和索引清单。需要看图时用 read_image 读 imagePath。
- 之后只用编号操作：ui_click / ui_double_click / ui_scroll / ui_drag / ui_type。不要假设没有出现在图里的元素存在。
- 每次操作都会等 afterSeconds（默认 1s）后自动重新截图，返回值里是**新图片 + 新索引**。旧编号立即失效，下一步必须用新清单。
- 只对用户明确要求的界面操作；如果 display 指向用户真实桌面，格外小心破坏性点击。
- 仅 Linux。`

function canonicalPath(value) {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function splitList(value) {
  return String(value ?? '').split(/[\s,;]+/).map(part => part.trim()).filter(Boolean)
}

/** Main plugin entry. */
export function apply(ctx, config) {
  const pluginDir = path.dirname(fileURLToPath(import.meta.url))
  const log = (level, message, error) => {
    const sink = ctx.logger?.[level]
    if (typeof sink === 'function') sink.call(ctx.logger, `[ui-automation] ${message}`, error)
    else (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[ui-automation] ${message}`, error ?? '')
  }

  const attachments = ctx.get('attachments')
  const automation = new Automation({ getConfig: () => config, pluginDir, log, attachments })

  // Published for wrappers that take the surface over; owned by this plugin
  // fiber, so unloading the plugin removes it and restores standalone behavior.
  const visibility = new UiAutomationVisibility()
  ctx.provide('uiAutomationVisibility', visibility)

  const workspaceAllowList = () => {
    const settings = automation.config()
    const entries = settings.allowedWorkspacePaths === '' ? [pluginDir] : splitList(settings.allowedWorkspacePaths)
    return (entries.length > 0 ? entries : [pluginDir]).map(canonicalPath)
  }

  const sessionAllowed = (sessionId, agent) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    // A wrapper owns the natural-language entry point: Sessions it matches must
    // use it instead of the raw indices. Subagents keep their own grant.
    if (agent?.session?.header?.origin !== 'subagent' && visibility.suppresses(sessionId, agent)) return false
    const settings = automation.config()
    if (settings.allowAllSessions === true) return true
    if (splitList(settings.enabledSessionIds).includes(sessionId)) return true
    let workspace
    try {
      workspace = ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(sessionId))
    } catch (error) {
      log('warn', 'failed to inspect workspaces for tool gating', error)
      return false
    }
    if (workspace === undefined) return false
    return workspaceAllowList().includes(canonicalPath(workspace.path))
  }

  for (const tool of createTools(automation)) {
    ctx.tools.register(tool, { when: ({ agent }) => sessionAllowed(agent?.id, agent) })
  }

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const presented = await next()
    const sessionId = context?.agent?.id ?? context?.scope?.id
    if (!sessionAllowed(sessionId, context?.agent)) return presented
    try {
      const sections = (presented.sections || []).filter(section => section.name !== 'ui-automation:numbered')
      sections.splice(Math.min(1, sections.length), 0, { name: 'ui-automation:numbered', text: PROMPT })
      return { ...presented, sections }
    } catch (error) {
      log('error', 'failed to apply the numbered-image prompt section', error)
      return presented
    }
  })

  log('info', `ready; display=${automation.config().display}; tools limited to ${workspaceAllowList().join(', ')}; suppression=${visibility.activeKeys().join(',') || 'none'}`)
}
