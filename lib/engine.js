/**
 * engine.js — instance lifecycle, debounce pacing, and readback assertions for
 * the ui_* tools.
 *
 * Design rules taken from the headless-shell research (see VERIFY.md):
 *  - every launch gets its own private display, D-Bus session and runtime dir;
 *  - AT-SPI `do_action()` returns success even when the toolkit dropped the
 *    event, so every action is followed by an application-state readback;
 *  - action pacing is per toolkit: Qt needs >=120ms, GTK4 needs >=300ms;
 *  - keyboard input needs X input focus, which a WM-less display does not hand
 *    out by itself.
 *
 * @module dsh-ui-automation/engine
 */
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DriverClient, DriverTransportError, sleep } from './driver.js'
import { allocateDisplay, displayFree, launchShell } from './shell.js'

const DEFAULT_PACING = 150
const GTK4_PACING = 300
const DOUBLE_CLICK_MIN = 40
const DOUBLE_CLICK_MAX = 390

/** Read a schemastery field, supporting volatile references. */
function setting(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function integer(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : fallback
}

/** Whether a pid is still alive. */
function pidAlive(pid) {
  if (!Number.isFinite(Number(pid))) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Normalized, live settings for the engine and tools. */
export function readConfig(config = {}) {
  return {
    displayRange: String(setting(config.displayRange) ?? '100-199').trim() || '100-199',
    defaultWidth: clamp(integer(setting(config.defaultWidth), 1024), 320, 4096),
    defaultHeight: clamp(integer(setting(config.defaultHeight), 768), 240, 4096),
    actionIntervalMs: clamp(integer(setting(config.actionIntervalMs), DEFAULT_PACING), 0, 5000),
    gtk4ActionIntervalMs: clamp(integer(setting(config.gtk4ActionIntervalMs), GTK4_PACING), 0, 5000),
    doubleClickIntervalMs: clamp(integer(setting(config.doubleClickIntervalMs), 120), DOUBLE_CLICK_MIN, DOUBLE_CLICK_MAX),
    doubleClickGuardMs: clamp(integer(setting(config.doubleClickGuardMs), 600), 0, 3000),
    launchTimeoutMs: clamp(integer(setting(config.launchTimeoutMs), 20_000), 1_000, 180_000),
    actionTimeoutMs: clamp(integer(setting(config.actionTimeoutMs), 15_000), 500, 120_000),
    settleMs: clamp(integer(setting(config.settleMs), 80), 0, 2000),
    readbackTimeoutMs: clamp(integer(setting(config.readbackTimeoutMs), 700), 0, 5000),
    allowCoordinateMode: setting(config.allowCoordinateMode) !== false,
    screenshotDir: String(setting(config.screenshotDir) ?? '').trim(),
    maxInstances: clamp(integer(setting(config.maxInstances), 3), 1, 20),
    enabledSessionIds: String(setting(config.enabledSessionIds) ?? '').trim(),
    allowedWorkspacePaths: String(setting(config.allowedWorkspacePaths) ?? '').trim(),
    allowAllSessions: setting(config.allowAllSessions) === true,
  }
}

/** Format one snapshot row for humans. */
function describeRow(row) {
  if (!Array.isArray(row)) return String(row)
  const [role, name, text, value, states] = row
  let out = `[${role}] ${JSON.stringify(name ?? '')}`
  if (typeof text === 'string' && text !== '') out += ` text=${JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)}`
  if (value !== null && value !== undefined) out += ` value=${value}`
  if (typeof states === 'string' && states !== '') out += ` (${states})`
  return out.length > 200 ? `${out.slice(0, 200)}…` : out
}

/** Compare two snapshot node arrays. */
export function diffSnapshots(before, after) {
  const rows = Math.max(before.length, after.length)
  const samples = []
  let changed = 0
  for (let index = 0; index < rows; index += 1) {
    const left = before[index]
    const right = after[index]
    const leftText = JSON.stringify(left)
    const rightText = JSON.stringify(right)
    if (leftText === rightText) continue
    changed += 1
    if (samples.length < 5) samples.push({ before: describeRow(left), after: describeRow(right) })
  }
  return { changed, samples }
}

/** Compact node view used in tool results. */
function trimNode(node) {
  if (!node) return null
  return {
    path: node.path,
    role: node.role,
    name: node.name,
    text: typeof node.text === 'string' && node.text.length > 300 ? `${node.text.slice(0, 300)}…` : node.text,
    value: node.value,
    states: node.states,
    actions: node.actions,
    rect: node.rect,
  }
}

export class UiEngine {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig live Config object
   * @param {string} options.pluginDir package directory
   * @param {(level: string, message: string, error?: unknown) => void} [options.log]
   */
  constructor({ getConfig, pluginDir, log }) {
    this.getConfig = getConfig
    this.pluginDir = pluginDir
    this.log = log || (() => {})
    this.instances = new Map()
    this.counter = 0
  }

  config() {
    return readConfig(this.getConfig())
  }

  /** List managed instances. */
  list() {
    return [...this.instances.values()].map(instance => ({
      appId: instance.appId,
      alive: instance.shell.exitState.exited !== true,
      display: `:${instance.display}`,
      appName: instance.appName,
      appPid: instance.appPid,
      toolkit: instance.toolkit,
      window: instance.window,
      launchedAt: new Date(instance.launchedAt).toISOString(),
      uptimeMs: Date.now() - instance.launchedAt,
      logDir: instance.shell.logDir,
      lastExit: instance.shell.exitState.exited === true
        ? { code: instance.shell.exitState.code, signal: instance.shell.exitState.signal }
        : null,
    }))
  }

  instance(appId) {
    const instance = this.instances.get(appId)
    if (instance === undefined) {
      const error = new Error(`未知实例 ${appId}；先调用 ui_launch，或 ui_list 查看现有实例。`)
      error.code = 'E_NO_INSTANCE'
      throw error
    }
    return instance
  }

  /** Failure envelope. */
  fail(action, code, message, extra = {}) {
    return { ok: false, action, code, error: message, elapsedMs: 0, ...extra }
  }

  /** Sends one driver request and converts transport faults into tool failures. */
  async rpc(instance, cmd, params, timeoutMs) {
    return instance.driver.request(cmd, { launchPid: instance.appPid, ...params }, timeoutMs ?? this.config().actionTimeoutMs)
  }

  async snapshot(instance) {
    const response = await this.rpc(instance, 'snapshot', { maxNodes: 800 })
    if (response.ok === false) throw new Error(`snapshot failed: ${response.error}`)
    return { digest: response.digest, count: response.count, nodes: response.nodes }
  }

  /**
   * Read the application state back after an action.
   *
   * GTK4 applies an AT-SPI click asynchronously (the counter landed ~150ms
   * after `do_action` returned), so a single sample produces false negatives.
   * Poll until the digest changes or the readback window expires.
   */
  async readback(instance, before) {
    const config = this.config()
    await sleep(config.settleMs)
    let after = await this.snapshot(instance)
    const deadline = Date.now() + config.readbackTimeoutMs
    while (after.digest === before.digest && Date.now() < deadline) {
      await sleep(60)
      after = await this.snapshot(instance)
    }
    return after
  }

  /**
   * Enforce the per-toolkit debounce floor before an action.
   *
   * Also leaves a quiet window after a double click: GDK/Qt keep counting
   * clicks for ~500ms, so a second double-click inside that window arrives as
   * GDK_3BUTTON_PRESS / a Qt triple click and is lost (measured 50% loss on
   * GTK3 with a 350ms gap, 100% with 600ms).
   */
  async pace(instance) {
    const config = this.config()
    const interval = instance.toolkit === 'gtk4'
      ? Math.max(config.actionIntervalMs, config.gtk4ActionIntervalMs)
      : config.actionIntervalMs
    const earliest = Math.max(
      (instance.lastActionAt || 0) + interval,
      (instance.lastDoubleClickAt || 0) + config.doubleClickGuardMs,
    )
    const wait = earliest - Date.now()
    if (wait > 0) await sleep(wait)
    instance.lastActionAt = Date.now()
    return {
      intervalMs: interval,
      guardMs: config.doubleClickGuardMs,
      waitedMs: Math.max(0, Math.round(wait)),
      toolkit: instance.toolkit,
    }
  }

  /** Resolve an AT-SPI target through the driver. */
  async resolveTarget(instance, args) {
    const params = {}
    if (args.path !== undefined && args.path !== null && String(args.path) !== '') params.path = String(args.path)
    if (args.name !== undefined && args.name !== null && String(args.name) !== '') params.name = String(args.name)
    if (args.role !== undefined && args.role !== null && String(args.role) !== '') params.role = String(args.role)
    if (args.index !== undefined && args.index !== null) params.index = integer(args.index, 0)
    if (args.match !== undefined && args.match !== null) params.match = String(args.match)
    const response = await this.rpc(instance, 'find', params)
    if (response.ok === false) {
      const error = new Error(response.error || 'target not found')
      error.code = response.code || 'E_NO_NODE'
      throw error
    }
    return response.node
  }

  /** Screen point for a target node or explicit coordinates. */
  pointFor(node, { x, y }) {
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
      return { x: Math.round(Number(x)), y: Math.round(Number(y)), source: 'coordinates' }
    }
    if (node?.rect) {
      const rect = node.rect
      if (rect.x <= 0 && rect.y <= 0) {
        const error = new Error(
          `节点 ${JSON.stringify(node.name)} 的屏幕坐标不可用（extents=${rect.x},${rect.y}）。`
          + (node.role === undefined ? '' : ' GTK4 常报告 (0,0,w,h) 的假坐标；请显式传 x/y。'),
        )
        error.code = 'E_NO_COORDS'
        throw error
      }
      return {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        source: 'target-rect',
        rect,
      }
    }
    const error = new Error('需要目标节点（有可用坐标）或显式 x/y。')
    error.code = 'E_NO_COORDS'
    throw error
  }

  async ensureCoordinateMode() {
    if (this.config().allowCoordinateMode !== true) {
      const error = new Error('坐标模式已被设置禁用（allowCoordinateMode=false）。')
      error.code = 'E_COORDINATE_DISABLED'
      throw error
    }
  }

  /**
   * Make sure X input focus is on the app's window, and (when a target is
   * given) that the target widget itself holds widget focus.
   *
   * A WM-less display hands out no keyboard focus at all, and GTK4 refuses
   * `grab_focus` once another widget holds focus — so an explicit click point
   * (x/y) is the reliable way to move focus there. Everything is verified by
   * re-reading the widget state instead of trusting grab_focus' return value.
   */
  async ensureFocus(instance, targetArgs, focusPoint) {
    const steps = []
    let info = await this.rpc(instance, 'focus_info', { pid: instance.appPid })
    if (info.matchesApp !== true) {
      const focused = await this.rpc(instance, 'focus_window', { pid: instance.appPid })
      steps.push({ step: 'windowfocus', ok: focused.ok !== false, window: focused.window })
      if (focused.ok === false) {
        const error = new Error(focused.error || 'application has no X11 window to focus')
        error.code = focused.code || 'E_NO_WINDOW'
        throw error
      }
    }
    let node = null
    if (targetArgs !== undefined) {
      node = await this.resolveTarget(instance, targetArgs)
      const focus = await this.rpc(instance, 'focus', { path: node.path })
      steps.push({ step: 'grab_focus', ok: focus.ok !== false, focused: focus.focused === true, via: focus.via })

      let current = focus
      if (focus.focused !== true || Array.isArray(focus.node?.states) && !focus.node.states.includes('focused')) {
        const explicit = focusPoint !== undefined && focusPoint !== null
          && Number.isFinite(Number(focusPoint.x)) && Number.isFinite(Number(focusPoint.y))
        let point = null
        if (explicit) {
          point = { x: Math.round(Number(focusPoint.x)), y: Math.round(Number(focusPoint.y)), source: 'explicit' }
        } else if (node.rect !== null && node.rect !== undefined && !(node.rect.x <= 0 && node.rect.y <= 0)) {
          point = this.pointFor(node, {})
        }
        if (point !== null) {
          await this.ensureCoordinateMode()
          // The first click on a WM-less display often only activates the
          // toplevel; a second one lands on the widget. Verify, then repeat.
          for (let attempt = 0; attempt < 2 && current.focused !== true; attempt += 1) {
            const click = await this.rpc(instance, 'click', { x: point.x, y: point.y, button: 1 })
            steps.push({ step: 'click-to-focus', ok: click.ok !== false, point, attempt: attempt + 1 })
            const focusDeadline = Date.now() + 400
            do {
              await sleep(50)
              const reread = await this.rpc(instance, 'find', { path: node.path })
              current = { ...(reread.node ?? {}), focused: reread.node?.states?.includes('focused') === true }
            } while (current.focused !== true && Date.now() < focusDeadline)
          }
        }
      }
      if (current.focused !== true) {
        const error = new Error(
          `控件 ${JSON.stringify(node.name)} 没有取得控件焦点，键盘输入会落到别处。`
          + (node.rect && node.rect.x <= 0 && node.rect.y <= 0
            ? ' 该工具包的 extents 不可信，请用 ui_type 的 x/y 指定点击聚焦的位置。'
            : ' 可尝试显式 x/y 点击该控件后再输入。'),
        )
        error.code = 'E_NO_FOCUS'
        error.details = { steps, node: trimNode(node) }
        throw error
      }
    }
    info = await this.rpc(instance, 'focus_info', { pid: instance.appPid })
    if (info.matchesApp !== true) {
      const error = new Error('应用窗口没有获得键盘焦点；无 WM 的 display 上无法确定按键会送到哪里。')
      error.code = 'E_NO_FOCUS'
      error.details = { steps, focus: info }
      throw error
    }
    return { ok: true, steps, windowId: info.windowId, pid: info.pid }
  }

  /** Launch one application inside a fresh managed shell. */
  async launch(args = {}) {
    const started = Date.now()
    const config = this.config()
    const command = Array.isArray(args.command)
      ? args.command.map(part => String(part))
      : (typeof args.command === 'string' && args.command.trim() !== '' ? ['bash', '-lc', args.command] : [])
    if (command.length === 0) {
      return this.fail('launch', 'E_BAD_COMMAND', 'command 必须是可执行文件与参数组成的数组，或以字符串给出的 shell 命令。')
    }
    if (this.instances.size >= config.maxInstances) {
      return this.fail('launch', 'E_TOO_MANY', `已达并发实例上限 ${config.maxInstances}；先 ui_close 关掉不用的实例。`)
    }
    let cwd = args.cwd ? path.resolve(String(args.cwd)) : this.pluginDir
    if (!existsSync(cwd)) {
      return this.fail('launch', 'E_BAD_CWD', `工作目录不存在：${cwd}`)
    }
    const width = clamp(integer(args.width, config.defaultWidth), 320, 4096)
    const height = clamp(integer(args.height, config.defaultHeight), 240, 4096)
    let display
    if (args.display !== undefined && args.display !== null) {
      display = integer(args.display, 0)
      if (display < 1 || display > 999 || !displayFree(display)) {
        return this.fail('launch', 'E_DISPLAY_BUSY', `display :${display} 已被占用或非法。`)
      }
    } else {
      display = allocateDisplay(config.displayRange)
      if (display === undefined) {
        return this.fail('launch', 'E_NO_DISPLAY', `显示号范围 ${config.displayRange} 内没有空闲 display。`)
      }
    }

    let shell
    try {
      shell = launchShell({
        pluginDir: this.pluginDir,
        display,
        width,
        height,
        command,
        cwd,
        env: args.env && typeof args.env === 'object' ? args.env : undefined,
        runRoot: typeof args.runRoot === 'string' && args.runRoot !== '' ? args.runRoot : undefined,
      })
    } catch (error) {
      return this.fail('launch', 'E_SPAWN', `无法启动托管壳：${error.message}`)
    }

    const driver = new DriverClient(shell.socketPath)
    const appId = `ui-${++this.counter}-${Math.random().toString(36).slice(2, 6)}`
    const instance = {
      appId,
      shell,
      driver,
      display,
      width,
      height,
      appPid: undefined,
      appName: undefined,
      toolkit: 'unknown',
      version: null,
      window: null,
      launchedAt: started,
      lastActionAt: 0,
      command,
      cwd,
    }
    this.instances.set(appId, instance)
    shell.exitPromise.then(exit => {
      instance.exited = exit
      this.log('info', `${appId} application exited (code=${exit.code}, signal=${exit.signal})`)
    })

    const cleanupAndFail = async (code, message) => {
      driver.close()
      try { await this.close(appId, { keepLogs: true, quiet: true }) } catch {}
      return {
        ok: false,
        action: 'launch',
        appId,
        code,
        error: message,
        elapsedMs: Date.now() - started,
        logs: {
          dir: shell.logDir,
          wrapper: shell.logTail('wrapper.log', 30),
          app: shell.logTail('app.log', 30),
          driver: shell.logTail('driver.out', 20),
        },
      }
    }

    // 1. Wait for the driver socket.
    const driverDeadline = Math.min(started + config.launchTimeoutMs, Date.now() + 15_000)
    let driverReady = false
    while (Date.now() < driverDeadline) {
      if (shell.exitState.exited) break
      try {
        const ping = await driver.request('ping', {}, 2500)
        if (ping.ok === true) { driverReady = true; break }
      } catch (error) {
        if (!(error instanceof DriverTransportError)) throw error
      }
      await sleep(60)
    }
    if (!driverReady) {
      const appStarted = shell.logTail('app.log', 10) !== ''
      return cleanupAndFail(
        shell.exitState.exited
          ? (appStarted ? 'E_APP_EXITED' : 'E_SHELL_EXITED')
          : 'E_DRIVER_TIMEOUT',
        shell.exitState.exited
          ? (appStarted
            ? `应用在 AT-SPI 驱动就绪前就退出了（code=${shell.exitState.code}）。`
            : '托管壳在驱动就绪前退出。')
          : '托管壳或 AT-SPI 驱动没有就绪。',
      )
    }

    // 2. Wait for the application window to appear in the X server.
    let appPid
    const pidDeadline = Date.now() + 4000
    while (Date.now() < pidDeadline && appPid === undefined) {
      if (shell.exitState.exited) break
      appPid = shell.readAppPid()
      if (appPid === undefined) await sleep(40)
    }
    instance.appPid = appPid

    // 3. Wait for the application to register with AT-SPI.
    let descriptor
    let appGone = false
    const appDeadline = started + config.launchTimeoutMs
    while (Date.now() < appDeadline) {
      if (shell.exitState.exited) break
      if (appPid !== undefined && !pidAlive(appPid)) { appGone = true; break }
      let apps = []
      try {
        const response = await driver.request('apps', appPid ? { launchPid: appPid } : {}, 3000)
        if (response.ok === true) apps = response.apps || []
        if (apps.length === 0 && typeof args.appName === 'string' && args.appName !== '') {
          const byName = await driver.request('apps', {}, 3000)
          const hint = args.appName.toLowerCase()
          apps = (byName.apps || []).filter(app => String(app.name || '').toLowerCase().includes(hint))
        }
      } catch (error) {
        if (!(error instanceof DriverTransportError)) throw error
      }
      if (apps.length > 0) { descriptor = apps[0]; break }
      await sleep(80)
    }

    if (descriptor === undefined) {
      const exited = shell.exitState.exited || appGone
      const detail = shell.exitState.exited
        ? `code=${shell.exitState.code}, signal=${shell.exitState.signal}`
        : `pid ${appPid} 已退出`
      const message = exited
        ? `应用在进入 AT-SPI 之前退出（${detail}）。`
        : `应用在 ${config.launchTimeoutMs}ms 内没有出现在 AT-SPI 无障碍树中。`
      return cleanupAndFail(exited ? 'E_APP_EXITED' : 'E_NO_A11Y', message)
    }

    // 4. Window geometry, and a short settle so the first readback is stable.
    instance.appPid = appPid ?? descriptor.pid
    instance.appName = descriptor.name
    instance.toolkit = descriptor.toolkit
    instance.version = descriptor.version ?? null
    let windows = []
    try {
      const byApp = await driver.request('windows', { pid: instance.appPid }, 4000)
      windows = byApp.windows || []
      if (windows.length === 0 && instance.appPid !== appPid && appPid !== undefined) {
        const byLaunch = await driver.request('windows', { pid: appPid }, 4000)
        windows = byLaunch.windows || []
      }
      if (windows.length === 0) {
        const all = await driver.request('windows', {}, 4000)
        windows = all.windows || []
      }
    } catch (error) {
      this.log('warn', `${appId}: window enumeration failed: ${error.message}`)
    }
    instance.window = windows.find(window => (window.width ?? 0) > 20 && (window.height ?? 0) > 20) ?? windows[0] ?? null
    await sleep(config.settleMs)

    const pacing = instance.toolkit === 'gtk4'
      ? Math.max(config.actionIntervalMs, config.gtk4ActionIntervalMs)
      : config.actionIntervalMs
    return {
      ok: true,
      action: 'launch',
      appId,
      display: `:${display}`,
      app: {
        name: descriptor.name,
        pid: instance.appPid,
        toolkit: instance.toolkit,
        version: instance.version,
      },
      window: instance.window,
      screen: { width, height },
      startupMs: Date.now() - started,
      pacing: { intervalMs: pacing, toolkit: instance.toolkit },
      shell: { runDir: shell.runDir, logDir: shell.logDir },
      hint: '用 ui_tree 找到目标，再 ui_click / ui_type；完成后 ui_close 回收壳。',
    }
  }

  /** Close one instance and tear down its shell. */
  async close(appId, options = {}) {
    const instance = this.instances.get(appId)
    if (instance === undefined) {
      return this.fail('close', 'E_NO_INSTANCE', `未知实例 ${appId}`)
    }
    const started = Date.now()
    let forced = false
    try { await instance.driver.request('quit', {}, 800) } catch {}
    instance.driver.close()
    if (instance.shell.exitState.exited !== true) {
      instance.shell.kill('SIGTERM')
      const graceful = await Promise.race([
        instance.shell.exitPromise.then(() => true),
        sleep(2500).then(() => false),
      ])
      if (!graceful) {
        forced = true
        instance.shell.kill('SIGKILL')
        await Promise.race([instance.shell.exitPromise, sleep(1500)])
      }
    }
    const logDir = instance.shell.logDir
    let logsRemoved = false
    if (options.keepLogs !== true) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        instance.shell.remove()
        if (!existsSync(instance.shell.runDir)) { logsRemoved = true; break }
        await sleep(150)
      }
    }
    this.instances.delete(appId)
    if (options.quiet !== true) {
      this.log('info', `${appId} closed (forced=${forced})`)
    }
    return {
      ok: true,
      action: 'close',
      appId,
      forced,
      logsRemoved,
      logDir: options.keepLogs === true ? logDir : undefined,
      elapsedMs: Date.now() - started,
    }
  }

  /** Kill everything; called from plugin disposal. */
  async dispose() {
    const ids = [...this.instances.keys()]
    await Promise.all(ids.map(id => this.close(id, { quiet: true }).catch(() => undefined)))
  }

  /** Shared tail for action tools: pace, run, read back, report. */
  async perform(instance, action, { args, channel, run }) {
    const started = Date.now()
    const config = this.config()
    const before = await this.snapshot(instance)
    const pacing = await this.pace(instance)
    const outcome = await run()
    if (outcome?.ok === false) {
      return {
        ok: false,
        action,
        appId: instance.appId,
        code: outcome.code || 'E_ACTION',
        error: outcome.error || 'action failed',
        target: trimNode(outcome.node),
        channel,
        pacing,
        elapsedMs: Date.now() - started,
        readback: { before: { digest: before.digest, count: before.count } },
      }
    }
    const after = await this.readback(instance, before)
    const diff = diffSnapshots(before.nodes, after.nodes)
    const changed = after.digest !== before.digest
    return {
      ok: true,
      action,
      appId: instance.appId,
      channel,
      target: trimNode(outcome?.node),
      effect: {
        changed,
        changedNodes: diff.changed,
        samples: diff.samples,
      },
      readback: {
        before: { digest: before.digest, count: before.count },
        after: { digest: after.digest, count: after.count },
      },
      pacing,
      actionResult: outcome === undefined ? undefined : (() => {
        const { node, ...rest } = outcome
        return rest
      })(),
      elapsedMs: Date.now() - started,
      warnings: changed ? undefined : [
        `回读没有观察到应用状态变化。AT-SPI 调用成功不代表事件被处理；这可能是本来就不会改变可访问状态的纯聚焦操作，也可能是动作被工具包丢弃。`,
      ],
    }
  }

  /** ui_click. */
  async click(instance, args) {
    const started = Date.now()
    try {
      const via = args.via === 'coordinate' ? 'coordinate' : (args.via === 'atspi' ? 'atspi' : 'auto')
      const hasTarget = [args.name, args.role, args.path].some(value => value !== undefined && value !== null && String(value) !== '')
      const hasPoint = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
      if (!hasTarget && !hasPoint) {
        return this.fail('click', 'E_ADDRESSING', '需要 name/role/path 语义寻址，或显式 x/y 坐标。')
      }
      let node = null
      if (hasTarget) node = await this.resolveTarget(instance, args)
      const button = clamp(integer(args.button, 1), 1, 3)

      if (node !== null && via !== 'coordinate' && Array.isArray(node.actions) && node.actions.length > 0) {
        return await this.perform(instance, 'click', {
          args,
          channel: 'atspi',
          run: async () => {
            const result = await this.rpc(instance, 'press', { path: node.path, action: args.action })
            return { ...result, node: result.node ?? node }
          },
        })
      }
      if (via === 'atspi') {
        return this.fail('click', 'E_NO_ACTION', `节点 ${JSON.stringify(node?.name)} 没有可用的 AT-SPI Action；改用坐标模式或换目标。`, {
          appId: instance.appId,
          target: trimNode(node),
          elapsedMs: Date.now() - started,
        })
      }
      await this.ensureCoordinateMode()
      const point = node !== null ? this.pointFor(node, { x: args.x, y: args.y }) : this.pointFor(null, { x: args.x, y: args.y })
      const fallback = node !== null
      return await this.perform(instance, 'click', {
        args,
        channel: fallback ? 'xtest-fallback' : 'xtest',
        run: async () => {
          const result = await this.rpc(instance, 'click', { x: point.x, y: point.y, button, count: 1 })
          return { ...result, node: node ?? undefined }
        },
      })
    } catch (error) {
      return this.fail('click', error.code || 'E_ACTION', error.message, { appId: instance.appId, elapsedMs: Date.now() - started })
    }
  }

  /** ui_double_click. */
  async doubleClick(instance, args) {
    const started = Date.now()
    try {
      const config = this.config()
      const interval = clamp(integer(args.intervalMs, config.doubleClickIntervalMs), DOUBLE_CLICK_MIN, DOUBLE_CLICK_MAX)
      const hasTarget = [args.name, args.role, args.path].some(value => value !== undefined && value !== null && String(value) !== '')
      const hasPoint = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
      if (!hasTarget && !hasPoint) {
        return this.fail('double_click', 'E_ADDRESSING', '需要 name/role/path 语义寻址，或显式 x/y 坐标。')
      }
      await this.ensureCoordinateMode()
      const node = hasTarget ? await this.resolveTarget(instance, args) : null
      const point = this.pointFor(node, { x: args.x, y: args.y })
      const result = await this.perform(instance, 'double_click', {
        args,
        channel: 'xtest',
        run: async () => {
          const value = await this.rpc(instance, 'click', {
            x: point.x, y: point.y, button: 1, count: 2, intervalMs: interval,
          })
          return { ...value, node: node ?? undefined }
        },
      })
      instance.lastDoubleClickAt = Date.now()
      return result
    } catch (error) {
      return this.fail('double_click', error.code || 'E_ACTION', error.message, { appId: instance.appId, elapsedMs: Date.now() - started })
    }
  }

  /** ui_drag / swipe. */
  async drag(instance, args) {
    const started = Date.now()
    try {
      await this.ensureCoordinateMode()
      const resolvePoint = async (name, role, path, x, y) => {
        const hasTarget = [name, role, path].some(value => value !== undefined && value !== null && String(value) !== '')
        if (!hasTarget && !(Number.isFinite(Number(x)) && Number.isFinite(Number(y)))) return null
        const node = hasTarget ? await this.resolveTarget(instance, { name, role, path }) : null
        return { point: this.pointFor(node, { x, y }), node }
      }
      const from = await resolvePoint(args.fromName, args.fromRole, args.fromPath, args.fromX, args.fromY)
      const to = await resolvePoint(args.toName, args.toRole, args.toPath, args.toX, args.toY)
      if (from === null || to === null) {
        return this.fail('drag', 'E_ADDRESSING', '需要起点与终点：fromName/fromRole/fromPath 或 fromX/fromY，以及 toX/toY（或 toName）。')
      }
      const steps = clamp(integer(args.steps, 12), 1, 120)
      let stepMs = clamp(integer(args.stepMs, 15), 1, 200)
      if (args.durationMs !== undefined && args.durationMs !== null) {
        stepMs = clamp(Math.round(Number(args.durationMs) / (steps + 1)), 1, 200)
      }
      const button = clamp(integer(args.button, 1), 1, 3)
      return await this.perform(instance, 'drag', {
        args,
        channel: 'xtest',
        run: async () => {
          const result = await this.rpc(instance, 'drag', {
            x1: from.point.x, y1: from.point.y, x2: to.point.x, y2: to.point.y,
            steps, stepMs, button,
          })
          const final = result.finalPointer || {}
          if (Number.isFinite(final.x) && Number.isFinite(final.y)) {
            const dx = final.x - to.point.x
            const dy = final.y - to.point.y
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
              return { ok: false, code: 'E_POINTER', error: `拖拽结束后指针在 (${final.x},${final.y})，未到目标 (${to.point.x},${to.point.y})`, node: from.node }
            }
          }
          return { ...result, node: from.node }
        },
      })
    } catch (error) {
      return this.fail('drag', error.code || 'E_ACTION', error.message, { appId: instance.appId, elapsedMs: Date.now() - started })
    }
  }

  /** ui_scroll. */
  async scroll(instance, args) {
    const started = Date.now()
    try {
      await this.ensureCoordinateMode()
      const hasTarget = [args.name, args.role, args.path].some(value => value !== undefined && value !== null && String(value) !== '')
      const hasPoint = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
      if (!hasTarget && !hasPoint) {
        return this.fail('scroll', 'E_ADDRESSING', '需要 name/role/path 或以 x/y 指定滚动位置。')
      }
      const node = hasTarget ? await this.resolveTarget(instance, args) : null
      const point = this.pointFor(node, { x: args.x, y: args.y })
      const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down'
      const amount = clamp(integer(args.amount, 1), 1, 50)
      return await this.perform(instance, 'scroll', {
        args,
        channel: 'xtest',
        run: async () => {
          const result = await this.rpc(instance, 'scroll', {
            x: point.x, y: point.y, direction, amount,
          })
          return { ...result, node: node ?? undefined }
        },
      })
    } catch (error) {
      return this.fail('scroll', error.code || 'E_ACTION', error.message, { appId: instance.appId, elapsedMs: Date.now() - started })
    }
  }

  /** ui_type — text and chords, with focus handling and readback. */
  async type(instance, args) {
    const started = Date.now()
    const config = this.config()
    try {
      const hasText = typeof args.text === 'string' && args.text !== ''
      const hasKeys = typeof args.keys === 'string' && args.keys !== ''
      if (!hasText && !hasKeys) {
        return this.fail('type', 'E_BAD_TEXT', '需要 text（要输入的字符串）或 keys（按键组合，例如 ctrl+a、Return）。')
      }
      const hasTarget = [args.name, args.role, args.path].some(value => value !== undefined && value !== null && String(value) !== '')
      const targetArgs = hasTarget ? args : undefined
      const mode = ['auto', 'atspi', 'keys'].includes(args.mode) ? args.mode : 'auto'

      const focusPoint = (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)))
        ? { x: args.x, y: args.y }
        : undefined

      if (hasKeys) {
        const focus = await this.ensureFocus(instance, targetArgs, focusPoint)
        const pacing = await this.pace(instance)
        const before = await this.snapshot(instance)
        const result = await this.rpc(instance, 'key', { keys: args.keys })
        // A chord (Ctrl+A, Tab) often changes no accessible state, so a single
        // sample is the honest readback; polling would just burn the timeout.
        await sleep(config.settleMs)
        const after = await this.snapshot(instance)
        const diff = diffSnapshots(before.nodes, after.nodes)
        return {
          ok: result.ok !== false,
          action: 'type',
          appId: instance.appId,
          channel: 'xtest-key',
          keys: args.keys,
          focus,
          effect: { changed: after.digest !== before.digest, changedNodes: diff.changed, samples: diff.samples },
          readback: { before: before.digest, after: after.digest },
          pacing,
          keyResult: result,
          elapsedMs: Date.now() - started,
          warnings: result.ok === false ? [result.error] : undefined,
        }
      }

      let node = null
      if (hasTarget) node = await this.resolveTarget(instance, targetArgs)

      if (node !== null && mode !== 'keys') {
        const pacing = await this.pace(instance)
        const attempt = await this.rpc(instance, 'set_text', { path: node.path, text: args.text })
        if (attempt.ok === true) {
          if (attempt.after !== args.text) {
            return {
              ok: false,
              action: 'type',
              appId: instance.appId,
              code: 'E_READBACK',
              error: `EditableText.SetTextContents 后回读为 ${JSON.stringify(attempt.after)}，与期望的 ${JSON.stringify(args.text)} 不一致。`,
              channel: 'atspi-set-text',
              target: trimNode(attempt.node ?? node),
              readback: { expected: args.text, actual: attempt.after },
              pacing,
              elapsedMs: Date.now() - started,
            }
          }
          return {
            ok: true,
            action: 'type',
            appId: instance.appId,
            channel: 'atspi-set-text',
            target: trimNode(attempt.node ?? node),
            readback: { expected: args.text, actual: attempt.after, verified: true },
            pacing,
            elapsedMs: Date.now() - started,
          }
        }
        if (mode === 'atspi') {
          return this.fail('type', attempt.code || 'E_ATSPI', attempt.error || 'SetTextContents failed', {
            appId: instance.appId, target: trimNode(node), elapsedMs: Date.now() - started,
          })
        }
      }

      // Keyboard fallback: works for ASCII and (in this Xvfb shell) for CJK.
      const focus = await this.ensureFocus(instance, targetArgs, focusPoint)
      if (args.clearFirst !== false) {
        await this.pace(instance)
        await this.rpc(instance, 'key', { keys: 'ctrl+a' })
      }
      const pacing = await this.pace(instance)
      const typed = await this.rpc(instance, 'type', { text: args.text, delayMs: args.delayMs })
      if (typed.ok === false) {
        return this.fail('type', typed.code || 'E_XDO', typed.error || 'xdotool type failed', {
          appId: instance.appId, elapsedMs: Date.now() - started,
        })
      }
      await sleep(config.settleMs)
      let readback
      if (node !== null) {
        const got = await this.rpc(instance, 'get_text', { path: node.path })
        readback = { expected: args.text, actual: got.text, verified: got.text === args.text }
        if (readback.verified !== true) {
          return {
            ok: false,
            action: 'type',
            appId: instance.appId,
            code: 'E_READBACK',
            error: `键盘输入后回读为 ${JSON.stringify(got.text)}，与期望的 ${JSON.stringify(args.text)} 不一致。`,
            channel: 'xtest',
            target: trimNode(node),
            readback,
            focus,
            pacing,
            elapsedMs: Date.now() - started,
          }
        }
      } else {
        readback = { verified: false, note: '未指定目标节点：仅通过键盘焦点确认事件送入应用窗口，未校验内容。' }
      }
      return {
        ok: true,
        action: 'type',
        appId: instance.appId,
        channel: 'xtest',
        target: trimNode(node),
        readback,
        focus,
        pacing,
        elapsedMs: Date.now() - started,
        warnings: readback.verified === false ? [readback.note] : undefined,
      }
    } catch (error) {
      return this.fail('type', error.code || 'E_ACTION', error.message, {
        appId: instance.appId,
        elapsedMs: Date.now() - started,
        details: error.details,
      })
    }
  }

  /** ui_tree. */
  async tree(instance, args) {
    const started = Date.now()
    try {
      const response = await this.rpc(instance, 'tree', {
        maxDepth: clamp(integer(args.maxDepth, 10), 1, 32),
        maxNodes: clamp(integer(args.maxNodes, 400), 1, 2000),
        includeText: args.includeText !== false,
      })
      if (response.ok === false) {
        return this.fail('tree', response.code || 'E_TREE', response.error, { appId: instance.appId, elapsedMs: Date.now() - started })
      }
      return {
        ok: true,
        action: 'tree',
        appId: instance.appId,
        app: response.app,
        nodes: response.nodes,
        truncated: response.truncated,
        elapsedMs: Date.now() - started,
      }
    } catch (error) {
      return this.fail('tree', error.code || 'E_TREE', error.message, { appId: instance.appId, elapsedMs: Date.now() - started })
    }
  }

  /** ui_screenshot. */
  async screenshot(instance, args) {
    const started = Date.now()
    try {
      const config = this.config()
      const dir = config.screenshotDir === ''
        ? path.join(this.pluginDir, 'screenshots')
        : path.resolve(this.pluginDir, config.screenshotDir)
      mkdirSync(dir, { recursive: true })
      const requested = typeof args.path === 'string' && args.path.trim() !== ''
        ? path.resolve(dir, args.path.trim())
        : path.join(dir, `${instance.appId}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      const response = await this.rpc(instance, 'screenshot', {
        path: requested,
        width: instance.width,
        height: instance.height,
      }, Math.max(config.actionTimeoutMs, 20_000))
      if (response.ok === false) {
        return this.fail('screenshot', response.code || 'E_SCREENSHOT', response.error, {
          appId: instance.appId, elapsedMs: Date.now() - started,
        })
      }
      return {
        ok: true,
        action: 'screenshot',
        appId: instance.appId,
        path: response.path,
        bytes: response.bytes,
        width: response.width,
        height: response.height,
        elapsedMs: Date.now() - started,
      }
    } catch (error) {
      return this.fail('screenshot', error.code || 'E_SCREENSHOT', error.message, { appId: instance.appId, elapsedMs: Date.now() - started })
    }
  }
}
