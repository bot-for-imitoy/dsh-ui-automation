/**
 * x11.js — thin XTEST wrapper over xdotool for the numbered contract.
 *
 * Every operation is a pure coordinate event: the plugin never calls AT-SPI
 * actions for click/double-click/scroll/drag. DISPLAY comes from the plugin
 * configuration, not from the Host environment.
 *
 * @module dsh-ui-automation/x11
 */
import { spawn } from 'node:child_process'

/** Spawn xdotool with a pinned DISPLAY and collect the result. */
function runXdotool(display, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn('xdotool', args, {
      env: { ...process.env, DISPLAY: display },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(Object.assign(new Error(`xdotool ${args[0]} timed out after ${timeoutMs}ms`), { code: 'E_XDO_TIMEOUT' }))
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      reject(Object.assign(new Error(`xdotool is unavailable: ${error.message}`), { code: 'E_NO_XDOTOOL' }))
    })
    child.on('close', code => {
      clearTimeout(timer)
      const elapsedMs = Math.round(performance.now() - started)
      if (code !== 0) {
        reject(Object.assign(
          new Error(`xdotool ${args[0]} failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 400)}`),
          { code: 'E_XDO' },
        ))
        return
      }
      resolve({ stdout: stdout.trim(), elapsedMs })
    })
  })
}

export const SCROLL_BUTTONS = { up: 4, down: 5, left: 6, right: 7 }

/** Single left/right/middle click at an absolute screen point. */
export async function click(display, point, button = 1) {
  return runXdotool(display, ['mousemove', '--sync', point.x, point.y, 'click', button])
}

/** Double click with an explicit gap, emitted in one xdotool process. */
export async function doubleClick(display, point, intervalMs = 120) {
  const gap = Math.max(40, Math.min(390, Number(intervalMs) || 120))
  return runXdotool(display, [
    'mousemove', '--sync', point.x, point.y,
    'mousedown', 1, 'mouseup', 1,
    'sleep', (gap / 1000).toFixed(3),
    'mousedown', 1, 'mouseup', 1,
  ])
}

/** Wheel scroll at an absolute screen point. */
export async function scroll(display, point, direction = 'down', amount = 1) {
  const button = SCROLL_BUTTONS[direction]
  if (button === undefined) throw Object.assign(new Error(`unknown direction ${direction}`), { code: 'E_INPUT' })
  const count = Math.max(1, Math.min(50, Number(amount) || 1))
  return runXdotool(display, [
    'mousemove', '--sync', point.x, point.y,
    'click', '--repeat', count, '--delay', 15, button,
  ])
}

/** Press-move-release drag from one absolute point to another. */
export async function drag(display, from, to, steps = 12, stepMs = 15) {
  const count = Math.max(1, Math.min(120, Number(steps) || 12))
  const pause = Math.max(1, Math.min(200, Number(stepMs) || 15))
  const args = [
    'mousemove', '--sync', from.x, from.y,
    'mousedown', 1,
    'sleep', (pause / 1000).toFixed(3),
  ]
  for (let i = 1; i <= count; i += 1) {
    const x = Math.round(from.x + (to.x - from.x) * i / count)
    const y = Math.round(from.y + (to.y - from.y) * i / count)
    args.push('mousemove', '--sync', x, y, 'sleep', (pause / 1000).toFixed(3))
  }
  args.push('mouseup', 1)
  return runXdotool(display, args, 30_000)
}

/** Type a literal string (CJK included on X11). */
export async function typeText(display, text, delayMs = 12) {
  const delay = Math.max(0, Math.min(200, Number(delayMs) || 12))
  return runXdotool(display, ['type', '--delay', delay, '--clearmodifiers', '--', text], 60_000)
}

/** Send a key chord such as "ctrl+a" or "Return". */
export async function key(display, keys) {
  return runXdotool(display, ['key', '--clearmodifiers', keys], 30_000)
}
