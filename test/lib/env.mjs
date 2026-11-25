/**
 * env.mjs — throw-away X11 + private D-Bus environment for the tests.
 *
 * The plugin itself no longer launches applications: the test owns Xvfb, a
 * private session bus, and the fixture, then points the plugin at the display
 * (and, for the private bus, at its address).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const pluginDir = path.resolve(here, '../..')
export const fixtureDir = path.join(pluginDir, 'test', 'fixtures')

function displayFree(number) {
  return !existsSync(`/tmp/.X${number}-lock`) && !existsSync(`/tmp/.X11-unix/X${number}`)
}

function allocateDisplay(from = 150, to = 199) {
  for (let number = from; number <= to; number += 1) {
    if (displayFree(number)) return number
  }
  throw new Error(`no free X display in :${from}-:${to}`)
}

const A11Y_SNIPPET = `
import dbus
bus = dbus.SessionBus()
obj = bus.get_object('org.a11y.Bus', '/org/a11y/bus')
props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties')
props.Set('org.a11y.Status', 'IsEnabled', dbus.Boolean(True))
print('ok')
`

export class TestDisplay {
  constructor({ display, width, height, root }) {
    this.display = `:${display}`
    this.number = display
    this.width = width
    this.height = height
    this.root = root
    this.apps = []
  }

  static async start({ width = 1024, height = 768 } = {}) {
    const number = allocateDisplay()
    const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-test-'))
    const display = `:${number}`
    const xvfb = spawn('Xvfb', [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], {
      stdio: 'ignore',
    })
    const deadline = Date.now() + 10_000
    let ready = false
    while (Date.now() < deadline) {
      try {
        execFileSync('xdpyinfo', ['-display', display], { stdio: 'ignore', timeout: 1000 })
        ready = true
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    if (!ready) {
      xvfb.kill('SIGKILL')
      throw new Error('Xvfb failed to start')
    }

    const runtimeDir = path.join(root, 'runtime')
    mkdirSync(runtimeDir, { mode: 0o700 })

    const busPath = path.join(root, 'bus')
    const bus = spawnSync('dbus-daemon', [
      '--session', '--fork', '--print-address=1', '--print-pid=1', '--nopidfile',
      `--address=unix:path=${busPath}`,
    ], { encoding: 'utf8' })
    if (bus.status !== 0) throw new Error(`dbus-daemon failed: ${bus.stderr}`)
    const [address, pidText] = bus.stdout.trim().split('\n')
    const dbusPid = Number(pidText)

    const env = {
      ...process.env,
      DISPLAY: display,
      DBUS_SESSION_BUS_ADDRESS: address,
      XDG_RUNTIME_DIR: runtimeDir,
      NO_AT_BRIDGE: '0',
      QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const enabled = spawnSync('python3', ['-c', A11Y_SNIPPET], { env, encoding: 'utf8' })
      if (enabled.status === 0) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const instance = new TestDisplay({ display: number, width, height, root })
    instance.address = address
    instance.dbusPid = dbusPid
    instance.xvfb = xvfb
    instance.env = env
    instance.numbering = path.join(pluginDir, 'scripts', 'numbering.py')
    return instance
  }

  /** Launch one fixture in this display + bus. */
  launch(command, { cwd = fixtureDir, env = {} } = {}) {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...this.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const record = { child, pid: child.pid, output: () => output }
    this.apps.push(record)
    return record
  }

  /** Run one numbering.py subcommand and parse its JSON line. */
  runNumbering(args, command = 'shot', timeoutMs = 45_000) {
    const result = spawnSync('python3', [this.numbering, command, '--display', this.display, ...args], {
      env: { ...this.env },
      encoding: 'utf8',
      timeout: timeoutMs,
    })
    const line = String(result.stdout || '').trim().split('\n').filter(Boolean).pop()
    if (line === undefined) {
      throw new Error(`numbering.py ${command} produced no output: ${result.stderr}`)
    }
    return JSON.parse(line)
  }

  /** Wait until the fixture's pid shows up on the AT-SPI bus. */
  async waitForApp({ pid, name, timeoutMs = 15_000 }) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = this.runNumbering([], 'apps', 10_000)
      const apps = result.apps || []
      const found = apps.find(app => (pid !== undefined && app.pid === pid)
        || (name !== undefined && String(app.name || '').toLowerCase().includes(name.toLowerCase())))
      if (found !== undefined) return found
      if (this.apps.length > 0 && this.apps.some(app => app.child.exitCode !== null)) {
        const dead = this.apps.find(app => app.child.exitCode !== null)
        throw new Error(`fixture exited with ${dead.child.exitCode}: ${dead.output().slice(-500)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`fixture did not appear on AT-SPI within ${timeoutMs}ms`)
  }

  /** Read the fixture's own status label through AT-SPI. */
  status(appName) {
    return this.runNumbering(['--app-name', appName], 'status', 15_000)
  }

  /** Plugin configuration pointing at this environment. */
  config(overrides = {}) {
    return {
      display: this.display,
      dbusAddress: this.address,
      screenshotDir: 'test/out/shots',
      fontFile: '/usr/share/fonts/TTF/Hack-Bold.ttf',
      maxDepth: 24,
      maxTargets: 40,
      padding: 6,
      crop: true,
      afterSeconds: 0.35,
      keepImages: 200,
      attachImage: false,
      allowAllSessions: true,
      enabledSessionIds: '',
      allowedWorkspacePaths: '',
      ...overrides,
    }
  }

  async stop() {
    for (const record of this.apps) {
      try { record.child.kill('SIGTERM') } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 200))
    for (const record of this.apps) {
      try { record.child.kill('SIGKILL') } catch {}
    }
    if (this.dbusPid !== undefined) {
      try { process.kill(this.dbusPid, 'SIGTERM') } catch {}
    }
    try { this.xvfb.kill('SIGTERM') } catch {}
    await new Promise(resolve => setTimeout(resolve, 300))
    try { this.xvfb.kill('SIGKILL') } catch {}
    try { rmSync(this.root, { recursive: true, force: true }) } catch {}
  }
}

/** Locate an optional application (research probe / WorkBuddy). */
export function optionalCommand(paths) {
  for (const candidate of paths) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
