/**
 * dsh-ui-automation — headless Xvfb UI automation tools for DSH.
 *
 * Every ui_launch creates a throw-away, fully isolated session: a private
 * D-Bus bus, a private XDG_RUNTIME_DIR, its own Xvfb display, its own AT-SPI
 * driver and the application under test. Tools address controls semantically
 * through the accessibility tree and fall back to XTEST coordinates; every
 * action is followed by an application-state readback, because AT-SPI
 * `do_action()` reports success even when the toolkit drops the event.
 *
 * The tools are only visible to sessions in an allow-listed workspace (or to
 * explicitly listed session ids / all sessions, per configuration), so a
 * dangerous launch/input surface is never exposed to every conversation.
 *
 * @module dsh-ui-automation
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UiEngine } from './lib/engine.js'
import { loadShipped } from './lib/shipped.js'
import { killAllShells } from './lib/shell.js'
import { createTools } from './lib/tools.js'

const schemastery = await loadShipped('@deepseek-ai/schemastery')
const z = schemastery.default ?? schemastery

/** Cordis diagnostic name. */
export const name = 'ui-automation'

/** Required services. */
export const inject = ['tools', 'workspaceRegistry']

/** Live (volatile) plugin settings, editable from the plugin settings page. */
export const Config = z.object({
  displayRange: z.string().default('100-199').volatile()
    .description('自动分配 X display 号的闭区间，例如 100-199。每个 ui_launch 占一个。'),
  defaultWidth: z.number().default(1024).volatile()
    .description('默认虚拟屏幕宽度（像素），320–4096。'),
  defaultHeight: z.number().default(768).volatile()
    .description('默认虚拟屏幕高度（像素），240–4096。'),
  actionIntervalMs: z.number().default(150).volatile()
    .description('两次动作之间的最小间隔（毫秒）。Qt 需要 ≥120ms 才不丢 AT-SPI Press，默认 150ms。'),
  gtk4ActionIntervalMs: z.number().default(300).volatile()
    .description('GTK4 应用的最小动作间隔（毫秒）。实测 150ms 仍会丢约 47%，默认 300ms。'),
  doubleClickIntervalMs: z.number().default(120).volatile()
    .description('双击两次点击的默认间隔（毫秒），限制在 40–390ms。'),
  launchTimeoutMs: z.number().default(20000).volatile()
    .description('从启动到应用出现在 AT-SPI 树的超时（毫秒）。'),
  actionTimeoutMs: z.number().default(15000).volatile()
    .description('单次 AT-SPI/XTEST 操作超时（毫秒）。'),
  settleMs: z.number().default(80).volatile()
    .description('动作后等待应用刷新再回读的毫秒数，默认 80ms。'),
  allowCoordinateMode: z.boolean().default(true).volatile()
    .description('是否允许坐标寻址（ui_click 的 x/y、双击、拖拽、滚轮都依赖它）。关闭后只能用语义寻址。'),
  maxInstances: z.number().default(3).volatile()
    .description('同时存在的托管实例上限。'),
  screenshotDir: z.string().default('').volatile()
    .description('ui_screenshot 的目录；留空表示插件目录下的 screenshots/。'),
  enabledSessionIds: z.string().default('').volatile()
    .description('额外允许使用本插件的会话 ID，用逗号分隔；留空表示只按工作区白名单。'),
  allowedWorkspacePaths: z.string().default('').volatile()
    .description('允许使用本插件的工作区目录，用逗号分隔；留空表示仅插件自身所在目录（本工作区）。'),
  allowAllSessions: z.boolean().default(false).volatile()
    .description('对所有会话开放 ui_* 工具。默认关闭，避免把启动/输入能力暴露给所有会话。'),
})

/** Prompt section shown only to sessions that may use the tools. */
const SANDBOX_PROMPT = `## UI 自动化沙盒（dsh-ui-automation）

你可以用 ui_* 工具在无头 Xvfb 沙盒里启动并操作 GUI 应用：

- 每个 ui_launch 都创建私有 D-Bus、私有 XDG_RUNTIME_DIR 和独立 display。沙盒里看不到用户真实桌面上的窗口，也不要把这些工具当成远程桌面：它们是应用沙盒/回归工具。
- 先用 ui_tree 找到目标的 name/role/path，再 ui_click / ui_type / ui_drag / ui_scroll；坐标只作兜底。
- 每个动作都会回读应用状态。ok=true 但 effect.changed=false 表示没有观察到变化，不要假设操作成功，先 ui_tree 复查。
- Qt 与 GTK4 有事件去抖，插件已按工具包自动限速；不要连续快速调用绕过它。
- 用完或失败后调用 ui_close 回收壳；ui_list 查看遗留实例。`

/** Canonical path for allow-list comparison. */
function canonicalPath(value) {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/** Split a comma/semicolon/space separated setting. */
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

  const engine = new UiEngine({ getConfig: () => config, pluginDir, log })

  const workspaceAllowList = () => {
    const raw = engine.config().allowedWorkspacePaths
    const entries = raw === '' ? [pluginDir] : splitList(raw).length > 0 ? splitList(raw) : [pluginDir]
    return entries.map(canonicalPath)
  }

  /** Whether one session may see and call the ui_* tools. */
  const sessionAllowed = sessionId => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const settings = engine.config()
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

  const tools = createTools(engine)
  for (const tool of tools) {
    ctx.tools.register(tool, { when: ({ agent }) => sessionAllowed(agent?.id) })
  }

  // Give allowed sessions the sandbox rules, once, in the system prompt.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const presented = await next()
    const sessionId = context?.agent?.id ?? context?.scope?.id
    if (!sessionAllowed(sessionId)) return presented
    try {
      const sections = (presented.sections || []).filter(section => section.name !== 'ui-automation:sandbox')
      sections.splice(Math.min(1, sections.length), 0, { name: 'ui-automation:sandbox', text: SANDBOX_PROMPT })
      return { ...presented, sections }
    } catch (error) {
      log('error', 'failed to apply the UI automation prompt section', error)
      return presented
    }
  })

  const onExit = () => killAllShells()
  process.once('exit', onExit)
  const dispose = async () => {
    process.removeListener('exit', onExit)
    await engine.dispose()
  }
  ctx.effect(() => dispose, 'ui-automation: managed shells')

  log('info', `ready; tools limited to workspace ${workspaceAllowList().join(', ')}`)
}
