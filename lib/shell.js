/**
 * shell.js — spawn and tear down the managed headless X session.
 *
 * Each launch owns: a private XDG_RUNTIME_DIR, a private D-Bus session bus, one
 * Xvfb display, one AT-SPI driver process and one application. Nothing is
 * shared with the user's desktop, and the whole process group is killed when
 * the application exits or the tool closes it.
 *
 * @module dsh-ui-automation/shell
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Bound a display range like "100-199" or "130". */
export function parseDisplayRange(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{1,3})(?:\s*-\s*(\d{1,3}))?$/.exec(text)
  if (match === null) return { low: 100, high: 199 }
  const low = Number(match[1])
  const high = match[2] === undefined ? low : Number(match[2])
  if (high < low) return { low: Math.min(low, high), high: Math.max(low, high) }
  return { low: Math.max(1, low), high: Math.min(999, high) }
}

/** Whether a display number has no lock file and no socket. */
export function displayFree(number) {
  return !existsSync(`/tmp/.X${number}-lock`) && !existsSync(`/tmp/.X11-unix/X${number}`)
}

/** First free display in the configured range. */
export function allocateDisplay(rangeText) {
  const { low, high } = parseDisplayRange(rangeText)
  for (let number = low; number <= high; number += 1) {
    if (displayFree(number)) return number
  }
  return undefined
}

const live = new Set()

/** Kill every managed shell. Used only for process-exit and plugin-dispose. */
export function killAllShells() {
  for (const child of live) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
  live.clear()
}

/**
 * Spawn one managed shell.
 *
 * @param {object} options
 * @param {string} options.pluginDir package directory (scripts live inside it)
 * @param {number} options.display
 * @param {number} options.width
 * @param {number} options.height
 * @param {string[]} options.command executable and arguments
 * @param {string} options.cwd working directory for the application
 * @param {Record<string,string>} [options.env] extra environment variables
 * @param {string} [options.runRoot] parent directory for runtime state
 */
export function launchShell(options) {
  const runRoot = options.runRoot || os.tmpdir()
  mkdirSync(runRoot, { recursive: true })
  const runDir = mkdtempSync(path.join(runRoot, 'dsh-ui-'))
  const logDir = path.join(runDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const socketPath = path.join(runDir, 'driver.sock')
  const wrapperLog = path.join(logDir, 'wrapper.log')
  const logFd = openSync(wrapperLog, 'a')

  const script = path.join(options.pluginDir, 'scripts', 'ui_shell.sh')
  const driver = path.join(options.pluginDir, 'scripts', 'atspi_driver.py')
  const args = [
    script,
    '--outer',
    '--display', String(options.display),
    '--width', String(options.width),
    '--height', String(options.height),
    '--run-dir', runDir,
    '--log-dir', logDir,
    '--socket', socketPath,
    '--driver', driver,
    '--cwd', options.cwd,
    '--',
    ...options.command,
  ]

  let child
  try {
    child = spawn('bash', args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ...options.env,
        DISPLAY: `:${options.display}`,
        XDG_RUNTIME_DIR: runDir,
      },
    })
  } finally {
    closeSync(logFd)
  }
  live.add(child)

  const exitState = { exited: false, code: null, signal: null }
  const exitPromise = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      exitState.exited = true
      exitState.code = code
      exitState.signal = signal
      live.delete(child)
      resolve(exitState)
    })
    child.once('error', error => {
      exitState.exited = true
      exitState.code = -1
      exitState.signal = null
      exitState.error = error
      live.delete(child)
      resolve(exitState)
    })
  })

  return {
    child,
    pid: child.pid,
    display: options.display,
    width: options.width,
    height: options.height,
    runDir,
    logDir,
    socketPath,
    wrapperLog,
    exitState,
    exitPromise,
    readAppPid() {
      try {
        const raw = readFileSync(path.join(runDir, 'app.pid'), 'utf8').trim()
        return /^\d+$/.test(raw) ? Number(raw) : undefined
      } catch {
        return undefined
      }
    },
    logTail(file, lines = 30) {
      try {
        const text = readFileSync(path.join(logDir, file), 'utf8')
        return text.split('\n').slice(-lines).join('\n').trim()
      } catch {
        return ''
      }
    },
    kill(signal = 'SIGTERM') {
      try {
        process.kill(-child.pid, signal)
        return true
      } catch {
        try {
          child.kill(signal)
          return true
        } catch {
          return false
        }
      }
    },
    remove() {
      try {
        rmSync(runDir, { recursive: true, force: true })
        return true
      } catch {}
      // A surviving gvfsd-fuse leaves a fuse mount inside the runtime dir.
      // Unmount best-effort, then retry once.
      for (const tool of ['fusermount3', 'fusermount']) {
        try { spawnSync(tool, ['-u', path.join(runDir, 'gvfs')], { stdio: 'ignore' }) } catch {}
      }
      try {
        rmSync(runDir, { recursive: true, force: true })
        return true
      } catch {
        return false
      }
    },
  }
}
