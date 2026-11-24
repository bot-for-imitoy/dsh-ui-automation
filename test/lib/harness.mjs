/**
 * harness.mjs — shared helpers for the real-machine tests.
 *
 * The tests drive the plugin's engine directly (the same object the ui_* tools
 * call), so a PASS here means the real AT-SPI/XTEST path worked, not that a
 * mock returned true.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UiEngine } from '../../lib/engine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const pluginDir = path.resolve(here, '../..')
export const fixtureDir = path.join(pluginDir, 'test', 'fixtures')
/**
 * Optional research probes (app_qt / app_gtk3 / app_gtk4) used while the
 * GTK4 pitfalls were investigated. They are not part of this repository:
 * point XVFB_PROBE_DIR at a directory containing them to include those cases.
 */
export const researchDir = process.env.XVFB_PROBE_DIR || ''

export function createEngine(overrides = {}) {
  const config = {
    displayRange: '100-199',
    defaultWidth: 1024,
    defaultHeight: 768,
    actionIntervalMs: 150,
    gtk4ActionIntervalMs: 300,
    doubleClickIntervalMs: 120,
    launchTimeoutMs: 20_000,
    actionTimeoutMs: 15_000,
    settleMs: 80,
    allowCoordinateMode: true,
    maxInstances: 4,
    screenshotDir: 'test/out/screenshots',
    enabledSessionIds: '',
    allowedWorkspacePaths: '',
    allowAllSessions: true,
    ...overrides,
  }
  return new UiEngine({
    getConfig: () => config,
    pluginDir,
    log: (level, message) => {
      if (process.env.UI_TEST_DEBUG === '1') console.log(`[${level}] ${message}`)
    },
  })
}

export const apps = {
  panelQt: {
    key: 'panel_qt',
    label: 'Qt6 fixture',
    command: [path.join(fixtureDir, 'panel_qt')],
    toolkit: 'qt6',
    buttonName: 'button',
    checkName: 'check',
    inputName: 'input',
    hasDragScroll: true,
  },
  panelGtk3: {
    key: 'panel_gtk3',
    label: 'GTK3 fixture',
    command: [path.join(fixtureDir, 'panel_gtk3')],
    toolkit: 'gtk3',
    buttonName: 'button',
    checkName: 'check',
    inputName: 'input',
    hasDragScroll: true,
  },
  appQt: {
    key: 'app_qt',
    label: 'Qt6 research probe',
    command: [path.join(researchDir, 'app_qt')],
    toolkit: 'qt6',
    buttonName: 'button',
    checkName: 'check',
    inputName: 'input',
    hasDragScroll: false,
  },
  appGtk3: {
    key: 'app_gtk3',
    label: 'GTK3 research probe',
    command: [path.join(researchDir, 'app_gtk3')],
    toolkit: 'gtk3',
    buttonName: 'button',
    checkName: 'check',
    inputName: 'input',
    hasDragScroll: false,
  },
  appGtk4: {
    key: 'app_gtk4',
    label: 'GTK4 research probe',
    command: [path.join(researchDir, 'app_gtk4')],
    toolkit: 'gtk4',
    buttonName: '点击 Click',
    checkName: 'check',
    inputName: 'input',
    inputFocusPoint: { x: 200, y: 17 },
    hasDragScroll: false,
    checkHasNoAction: true,
  },
}

export class Checks {
  constructor(title) {
    this.title = title
    this.rows = []
  }

  check(name, ok, detail = '', ms) {
    this.rows.push({ name, ok: Boolean(ok), detail, ms })
    const mark = ok ? 'PASS' : 'FAIL'
    const time = ms === undefined ? '' : ` (${ms.toFixed(0)} ms)`
    console.log(`  [${mark}] ${name}${time}${detail ? ` — ${detail}` : ''}`)
    return ok
  }

  section(name) {
    console.log(`== ${name} ==`)
  }

  summary() {
    const failed = this.rows.filter(row => !row.ok)
    console.log(`\n${this.title}: ${this.rows.length - failed.length}/${this.rows.length} passed`)
    if (failed.length > 0) {
      for (const row of failed) console.log(`  FAILED: ${row.name} — ${row.detail}`)
    }
    return failed.length === 0
  }
}

/** Read the fixture's status line out of the accessibility tree. */
export async function statusOf(engine, instance) {
  const snap = await engine.snapshot(instance)
  for (const row of snap.nodes) {
    const name = String(row[1] ?? '')
    const text = String(row[2] ?? '')
    if (name.startsWith('clicks=')) return name
    if (text.startsWith('clicks=')) return text
  }
  // Fall back to any node whose text contains a counter.
  for (const row of snap.nodes) {
    const text = String(row[2] ?? '')
    if (text.includes('clicks=')) return text
  }
  return ''
}

export function parseStatus(line) {
  const num = key => {
    const match = new RegExp(`${key}=(-?\\d+)`).exec(line)
    return match === null ? null : Number(match[1])
  }
  const text = /text='([^']*)'/.exec(line)
  return {
    raw: line,
    clicks: num('clicks'),
    dclicks: num('dclicks'),
    drags: num('drags'),
    dragdist: num('dragdist'),
    wheel: num('wheel'),
    wheelTicks: num('wheelTicks'),
    checked: /checked=(true|false)/.exec(line)?.[1] === 'true',
    text: text === null ? undefined : text[1],
  }
}

/** Wait until the status line satisfies a predicate. */
export async function waitForStatus(engine, instance, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await statusOf(engine, instance)
    try {
      if (predicate(parseStatus(last))) return parseStatus(last)
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  return parseStatus(last)
}

/** Find the named node's screen rectangle via the driver (for coordinate tests). */
export async function rectOf(engine, instance, name) {
  const node = await engine.resolveTarget(instance, { name })
  return node.rect
}

export function requireFiles(paths) {
  const missing = paths.filter(file => !existsSync(file))
  if (missing.length > 0) {
    throw new Error(`missing files:\n${missing.join('\n')}\nBuild fixtures with: make -C test fixtures`)
  }
}
