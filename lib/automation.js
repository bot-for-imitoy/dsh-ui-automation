/**
 * automation.js — numbered-screenshot engine.
 *
 * The state is one "latest numbered image" per display: a PNG with yellow
 * badges and a sidecar JSON mapping index -> element identity + screen
 * rectangle. Every action resolves its index against that image and clicks the
 * recorded centre with XTEST; afterwards it waits `afterSeconds`, captures a
 * fresh numbered image, and returns it. Indices are only valid for the image
 * they came from.
 *
 * @module dsh-ui-automation/automation
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import * as x11 from './x11.js'

const AFTER_SECONDS_DEFAULT = 1
const AFTER_SECONDS_MAX = 30

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

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, Math.max(0, ms)) })
}

/** Normalized live configuration. */
export function readConfig(config = {}) {
  const envDisplay = typeof process.env.DISPLAY === 'string' ? process.env.DISPLAY : ''
  return {
    display: String(setting(config.display) ?? '').trim() || envDisplay || ':0',
    dbusAddress: String(setting(config.dbusAddress) ?? '').trim(),
    screenshotDir: String(setting(config.screenshotDir) ?? '').trim(),
    fontFile: String(setting(config.fontFile) ?? '/usr/share/fonts/TTF/Hack-Bold.ttf').trim(),
    maxDepth: clamp(integer(setting(config.maxDepth), 24), 4, 32),
    maxTargets: clamp(integer(setting(config.maxTargets), 60), 1, 200),
    padding: clamp(integer(setting(config.padding), 0), 0, 40),
    crop: setting(config.crop) !== false,
    afterSeconds: clamp(Number(setting(config.afterSeconds) ?? AFTER_SECONDS_DEFAULT), 0, AFTER_SECONDS_MAX),
    keepImages: clamp(integer(setting(config.keepImages), 15), 1, 500),
    attachImage: setting(config.attachImage) !== false,
    enabledSessionIds: String(setting(config.enabledSessionIds) ?? '').trim(),
    allowedWorkspacePaths: String(setting(config.allowedWorkspacePaths) ?? '').trim(),
    allowAllSessions: setting(config.allowAllSessions) === true,
  }
}

/** Public shape of one target (sidecar adds appPid/nodePath internally). */
function publicTarget(target) {
  return {
    index: target.index,
    role: target.role,
    name: target.name,
    label: target.label,
    rect: target.rect,
    imageRect: target.imageRect,
    center: target.center,
    actions: target.actions,
    states: target.states,
    kind: target.kind,
  }
}

export class Automation {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig live Config object
   * @param {string} options.pluginDir package directory
   * @param {(level: string, message: string, error?: unknown) => void} [options.log]
   * @param {{ saveImage?: (input: object) => Promise<object> }} [options.attachments]
   */
  constructor({ getConfig, pluginDir, log, attachments }) {
    this.getConfig = getConfig
    this.pluginDir = pluginDir
    this.log = log || (() => {})
    this.attachments = attachments
    this.latest = new Map()
    this.sequence = 0
    this.numberingScript = path.join(pluginDir, 'scripts', 'numbering.py')
  }

  config() {
    return readConfig(this.getConfig())
  }

  outputDir(config) {
    return config.screenshotDir === ''
      ? path.join(this.pluginDir, 'screenshots')
      : path.resolve(this.pluginDir, config.screenshotDir)
  }

  /** Failure envelope shared by every tool. */
  fail(action, code, message, extra = {}) {
    return { ok: false, action, code, error: message, ...extra }
  }

  /** Run the numbering helper and parse its JSON line. */
  runNumbering(command, { display, dbusAddress, args = [], timeoutMs = 45_000 }) {
    return new Promise((resolve, reject) => {
      const child = spawn('python3', [this.numberingScript, command, '--display', display, ...args], {
        env: {
          ...process.env,
          DISPLAY: display,
          ...(dbusAddress === '' ? {} : { DBUS_SESSION_BUS_ADDRESS: dbusAddress }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(Object.assign(new Error(`numbering.py ${command} timed out`), { code: 'E_NUMBERING_TIMEOUT' }))
      }, timeoutMs)
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', error => {
        clearTimeout(timer)
        reject(Object.assign(new Error(`python3 failed to start: ${error.message}`), { code: 'E_NO_PYTHON' }))
      })
      child.on('close', () => {
        clearTimeout(timer)
        const line = stdout.trim().split('\n').filter(Boolean).pop()
        if (line === undefined) {
          reject(Object.assign(new Error(`numbering.py produced no output: ${stderr.trim().slice(0, 400)}`), { code: 'E_NUMBERING' }))
          return
        }
        try {
          resolve(JSON.parse(line))
        } catch (error) {
          reject(Object.assign(new Error(`numbering.py returned invalid JSON: ${line.slice(0, 300)}`), { code: 'E_NUMBERING' }))
        }
      })
    })
  }

  /** Latest image for the configured display, if any. */
  latestFor(display) {
    return this.latest.get(display)
  }

  /** Resolve an index against the latest image; returns undefined when invalid. */
  resolveIndex(latest, index) {
    const wanted = integer(index, -1)
    return latest.targets.find(target => target.index === wanted)
  }

  newImageId() {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
    this.sequence += 1
    return `shot-${stamp}-${process.pid}-${this.sequence}`
  }

  /** Delete old generated shots, keeping curated screenshots untouched. */
  pruneOldImages(dir, keep) {
    try {
      const bases = new Map()
      for (const name of readdirSync(dir)) {
        const match = /^(shot-.*)\.(png|json)$/.exec(name)
        if (match === null) continue
        const base = match[1]
        const mtime = statSync(path.join(dir, name)).mtimeMs
        bases.set(base, Math.max(bases.get(base) ?? 0, mtime))
      }
      const ordered = [...bases.entries()].sort((a, b) => b[1] - a[1])
      for (const [base] of ordered.slice(keep)) {
        rmSync(path.join(dir, `${base}.png`), { force: true })
        rmSync(path.join(dir, `${base}.json`), { force: true })
      }
    } catch (error) {
      this.log('warn', 'failed to prune old screenshots', error)
    }
  }

  /**
   * Capture one numbered screenshot.
   *
   * @returns {Promise<object>} success envelope with imagePath/targets/attachment
   */
  async screenshot() {
    const config = this.config()
    const dir = this.outputDir(config)
    mkdirSync(dir, { recursive: true })
    const imageId = this.newImageId()
    const started = Date.now()
    const args = [
      '--out-dir', dir,
      '--image-id', imageId,
      '--font', config.fontFile,
      '--max-depth', String(config.maxDepth),
      '--max-targets', String(config.maxTargets),
      '--padding', String(config.padding),
    ]
    if (config.crop !== true) args.push('--no-crop')
    if (config.dbusAddress !== '') args.push('--dbus-address', config.dbusAddress)

    let result
    try {
      result = await this.runNumbering('shot', { display: config.display, dbusAddress: config.dbusAddress, args })
    } catch (error) {
      return this.fail('screenshot', error.code || 'E_NUMBERING', error.message, { elapsedMs: Date.now() - started })
    }

    if (result.ok !== true) {
      // A failed capture means the screen is no longer represented by the old
      // image either; force the next action to ask for a fresh one.
      this.latest.delete(config.display)
      return this.fail('screenshot', result.code || 'E_SCREENSHOT', result.error || 'numbered screenshot failed', {
        imageId: result.imageId,
        imagePath: result.imagePath,
        sidecarPath: result.sidecarPath,
        display: result.display,
        screen: result.screen,
        crop: result.crop,
        geometryTrusted: result.geometryTrusted,
        targets: (result.targets || []).map(publicTarget),
        stats: result.stats,
        elapsedMs: Date.now() - started,
      })
    }

    const targets = result.targets.map(publicTarget)
    const snapshot = {
      imageId: result.imageId,
      imagePath: result.imagePath,
      sidecarPath: result.sidecarPath,
      display: result.display,
      screen: result.screen,
      crop: result.crop,
      targets: result.targets,
      publicTargets: targets,
      createdAt: Date.now(),
    }
    this.latest.set(config.display, snapshot)
    this.pruneOldImages(dir, config.keepImages)

    let attachment
    let attachmentError
    if (config.attachImage && this.attachments !== undefined) {
      try {
        attachment = await this.attachments.saveImage({
          data: readFileSync(result.imagePath),
          mediaType: 'image/png',
          name: path.basename(result.imagePath),
        })
      } catch (error) {
        attachmentError = error?.message || String(error)
      }
    }

    return {
      ok: true,
      action: 'screenshot',
      imageId: result.imageId,
      imagePath: result.imagePath,
      sidecarPath: result.sidecarPath,
      display: result.display,
      screen: result.screen,
      crop: result.crop,
      image: result.image,
      geometryTrusted: result.geometryTrusted,
      targets,
      targetCount: targets.length,
      stats: result.stats,
      attachment,
      warnings: attachmentError === undefined ? undefined : [`图片附件保存失败，请用 read_image 读取 imagePath：${attachmentError}`],
      elapsedMs: Date.now() - started,
    }
  }

  /** Wait afterSeconds, then take the next numbered image. */
  async afterAction(action, previousImageId, target, afterSeconds) {
    const config = this.config()
    const seconds = clamp(Number(afterSeconds ?? config.afterSeconds), 0, AFTER_SECONDS_MAX)
    const waitedMs = Math.round(seconds * 1000)
    const start = Date.now()
    if (waitedMs > 0) await sleep(waitedMs)
    const shot = await this.screenshot()
    if (shot.ok !== true) {
      return {
        ...shot,
        action,
        actionApplied: true,
        previousImageId,
        index: target?.index,
        afterSeconds: seconds,
        waitedMs: Date.now() - start,
        error: `动作已执行，但重新截图失败：${shot.error}`,
      }
    }
    return {
      ...shot,
      ok: true,
      action,
      previousImageId,
      index: target?.index,
      point: target === undefined ? undefined : { x: target.center[0], y: target.center[1] },
      afterSeconds: seconds,
      waitedMs: Date.now() - start,
    }
  }

  /** Shared preamble for actions: latest image + index resolution. */
  requireTarget(action, index) {
    const config = this.config()
    const latest = this.latestFor(config.display)
    if (latest === undefined) {
      return {
        error: this.fail(action, 'E_NO_IMAGE',
          `display ${config.display} 还没有标号图片；先调用 ui_screenshot。`),
      }
    }
    const target = this.resolveIndex(latest, index)
    if (target === undefined) {
      return {
        error: this.fail(action, 'E_INDEX',
          `索引 ${index} 不属于最近一张标号图片：当前只有 1..${latest.targets.length}。`
          + '旧图的编号在下一张图里已经失效。', { imageId: latest.imageId, available: latest.targets.length }),
      }
    }
    return { config, latest, target }
  }

  /** ui_click. */
  async click(args = {}) {
    const begun = Date.now()
    const resolved = this.requireTarget('click', args.index)
    if (resolved.error !== undefined) return resolved.error
    const { config, latest, target } = resolved
    const button = clamp(integer(args.button, 1), 1, 3)
    try {
      const action = await x11.click(config.display, { x: target.center[0], y: target.center[1] }, button)
      return {
        ...(await this.afterAction('click', latest.imageId, target, args.afterSeconds)),
        actionMs: action.elapsedMs,
        button,
        target: publicTarget(target),
        totalMs: Date.now() - begun,
      }
    } catch (error) {
      return this.fail('click', error.code || 'E_ACTION', error.message, {
        imageId: latest.imageId, index: target.index, target: publicTarget(target), elapsedMs: Date.now() - begun,
      })
    }
  }

  /** ui_double_click. */
  async doubleClick(args = {}) {
    const begun = Date.now()
    const resolved = this.requireTarget('double_click', args.index)
    if (resolved.error !== undefined) return resolved.error
    const { config, latest, target } = resolved
    const intervalMs = clamp(integer(args.intervalMs, 120), 40, 390)
    try {
      const action = await x11.doubleClick(config.display, { x: target.center[0], y: target.center[1] }, intervalMs)
      return {
        ...(await this.afterAction('double_click', latest.imageId, target, args.afterSeconds)),
        actionMs: action.elapsedMs,
        intervalMs,
        target: publicTarget(target),
        totalMs: Date.now() - begun,
      }
    } catch (error) {
      return this.fail('double_click', error.code || 'E_ACTION', error.message, {
        imageId: latest.imageId, index: target.index, target: publicTarget(target), elapsedMs: Date.now() - begun,
      })
    }
  }

  /** ui_scroll. */
  async scroll(args = {}) {
    const begun = Date.now()
    const resolved = this.requireTarget('scroll', args.index)
    if (resolved.error !== undefined) return resolved.error
    const { config, latest, target } = resolved
    const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : undefined
    if (direction === undefined) {
      return this.fail('scroll', 'E_INPUT', 'direction 必须是 up/down/left/right。', { imageId: latest.imageId })
    }
    const amount = clamp(integer(args.amount, 1), 1, 50)
    try {
      const action = await x11.scroll(config.display, { x: target.center[0], y: target.center[1] }, direction, amount)
      return {
        ...(await this.afterAction('scroll', latest.imageId, target, args.afterSeconds)),
        actionMs: action.elapsedMs,
        direction,
        amount,
        target: publicTarget(target),
        totalMs: Date.now() - begun,
      }
    } catch (error) {
      return this.fail('scroll', error.code || 'E_ACTION', error.message, {
        imageId: latest.imageId, index: target.index, target: publicTarget(target), elapsedMs: Date.now() - begun,
      })
    }
  }

  /** ui_drag — fromIndex and toIndex both come from the latest image. */
  async drag(args = {}) {
    const begun = Date.now()
    const fromResolved = this.requireTarget('drag', args.fromIndex)
    if (fromResolved.error !== undefined) return fromResolved.error
    const { config, latest, target: from } = fromResolved
    const to = this.resolveIndex(latest, args.toIndex)
    if (to === undefined) {
      return this.fail('drag', 'E_INDEX',
        `toIndex ${args.toIndex} 不属于最近一张标号图片：当前只有 1..${latest.targets.length}。`,
        { imageId: latest.imageId, available: latest.targets.length })
    }
    const steps = clamp(integer(args.steps, 12), 1, 120)
    try {
      const action = await x11.drag(
        config.display,
        { x: from.center[0], y: from.center[1] },
        { x: to.center[0], y: to.center[1] },
        steps,
      )
      return {
        ...(await this.afterAction('drag', latest.imageId, from, args.afterSeconds)),
        actionMs: action.elapsedMs,
        steps,
        fromTarget: publicTarget(from),
        toTarget: publicTarget(to),
        totalMs: Date.now() - begun,
      }
    } catch (error) {
      return this.fail('drag', error.code || 'E_ACTION', error.message, {
        imageId: latest.imageId, fromIndex: from.index, toIndex: to.index, elapsedMs: Date.now() - begun,
      })
    }
  }

  /** Resolve the element's current AT-SPI text (verification for ui_type). */
  async readNodeText(config, target) {
    try {
      const result = await this.runNumbering('get-text', {
        display: config.display,
        dbusAddress: config.dbusAddress,
        args: ['--app-pid', String(target.appPid), '--node-path', String(target.path),
          ...(target.name ? ['--expect-name', target.name] : [])],
        timeoutMs: 20_000,
      })
      return result.ok === true ? result.text : undefined
    } catch {
      return undefined
    }
  }

  /** ui_type — text (AT-SPI SetTextContents first) or a key chord. */
  async type(args = {}) {
    const begun = Date.now()
    const config = this.config()
    const hasText = typeof args.text === 'string' && args.text !== ''
    const hasKeys = typeof args.keys === 'string' && args.keys !== ''
    if (hasText === hasKeys) {
      return this.fail('type', 'E_INPUT', 'text 与 keys 必须二选一。')
    }
    let latest
    let target
    if (args.index !== undefined && args.index !== null) {
      const resolved = this.requireTarget('type', args.index)
      if (resolved.error !== undefined) return resolved.error
      latest = resolved.latest
      target = resolved.target
    }

    if (hasKeys) {
      let focusMs = 0
      try {
        if (target !== undefined) {
          const focusClick = await x11.click(config.display, { x: target.center[0], y: target.center[1] }, 1)
          focusMs = focusClick.elapsedMs
        }
        const action = await x11.key(config.display, args.keys)
        return {
          ...(await this.afterAction('type', latest?.imageId, target, args.afterSeconds)),
          actionMs: action.elapsedMs,
          focusMs,
          channel: 'xtest-key',
          keys: args.keys,
          target: target === undefined ? undefined : publicTarget(target),
          totalMs: Date.now() - begun,
        }
      } catch (error) {
        return this.fail('type', error.code || 'E_ACTION', error.message, { index: target?.index, elapsedMs: Date.now() - begun })
      }
    }

    let channel
    let readback
    try {
      if (target !== undefined) {
        const applied = await this.runNumbering('set-text', {
          display: config.display,
          dbusAddress: config.dbusAddress,
          args: ['--app-pid', String(target.appPid), '--node-path', String(target.path), '--text', args.text,
            ...(target.name ? ['--expect-name', target.name] : [])],
          timeoutMs: 20_000,
        }).catch(() => undefined)
        if (applied?.ok === true && applied.textAfter === args.text) {
          channel = 'atspi-set-text'
          readback = { expected: args.text, actual: applied.textAfter, verified: true }
        }
      }
      if (channel === undefined) {
        let focusMs = 0
        if (target !== undefined) {
          const focusClick = await x11.click(config.display, { x: target.center[0], y: target.center[1] }, 1)
          focusMs = focusClick.elapsedMs
        }
        const action = await x11.typeText(config.display, args.text)
        channel = 'xtest'
        if (target !== undefined) {
          readback = { expected: args.text, actual: await this.readNodeText(config, target) }
          readback.verified = readback.actual === args.text
          if (readback.verified !== true) {
            const shot = await this.afterAction('type', latest.imageId, target, args.afterSeconds)
            return {
              ok: false,
              code: 'E_READBACK',
              error: `键入后回读为 ${JSON.stringify(readback.actual)}，与期望的 ${JSON.stringify(args.text)} 不一致。`,
              action: 'type',
              channel,
              readback,
              focusMs,
              ...shot,
              actionMs: action.elapsedMs,
              totalMs: Date.now() - begun,
            }
          }
        } else {
          readback = { verified: false, note: '未指定 index：键盘事件已发送到当前焦点窗口，未回读内容。' }
        }
        return {
          ...(await this.afterAction('type', latest?.imageId, target, args.afterSeconds)),
          actionMs: action.elapsedMs,
          focusMs,
          channel,
          readback,
          target: target === undefined ? undefined : publicTarget(target),
          totalMs: Date.now() - begun,
        }
      }
      const measured = await this.afterAction('type', latest?.imageId, target, args.afterSeconds)
      return {
        ...measured,
        actionMs: 0,
        channel,
        readback,
        target: target === undefined ? undefined : publicTarget(target),
        totalMs: Date.now() - begun,
      }
    } catch (error) {
      return this.fail('type', error.code || 'E_ACTION', error.message, { index: target?.index, elapsedMs: Date.now() - begun })
    }
  }
}

/** Remove a generated image pair (used by tests/tools that discard a shot). */
export function removeShot(imagePath) {
  if (typeof imagePath !== 'string') return
  const base = imagePath.replace(/\.png$/, '')
  for (const suffix of ['.png', '.json']) {
    try { rmSync(base + suffix, { force: true }) } catch {}
  }
}
