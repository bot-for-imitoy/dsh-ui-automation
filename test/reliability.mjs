/**
 * reliability.mjs — 30 attempts per operation, each asserted against the
 * fixture's own counter label.
 *
 * Every action returns the next numbered image, so the measured latency is the
 * end-to-end cost of "act → wait afterSeconds → enumerate → crop → badge → PNG".
 *
 *   node test/reliability.mjs
 *   UI_RELIABILITY_N=50 node test/reliability.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Automation } from '../lib/automation.js'
import { fixtureDir, pluginDir, TestDisplay } from './lib/env.mjs'
import { indexOf, parseStatus } from './lib/checks.mjs'

const N = Math.max(1, Number(process.env.UI_RELIABILITY_N) || 30)
const started = Date.now()
const results = []

function percent(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarize(rows) {
  const latencies = rows.map(row => row.ms).sort((a, b) => a - b)
  const success = rows.filter(row => row.ok).length
  return {
    attempts: rows.length,
    success,
    failures: rows.length - success,
    successRate: rows.length === 0 ? 0 : success / rows.length,
    meanMs: latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length),
    p50Ms: percent(latencies, 50),
    p95Ms: percent(latencies, 95),
    maxMs: latencies.length === 0 ? 0 : latencies[latencies.length - 1],
  }
}

function report(def, operation, rows) {
  const stats = summarize(rows)
  const record = {
    app: def.key,
    label: def.label,
    toolkit: def.toolkit,
    operation,
    ...stats,
    failuresDetail: rows.filter(row => !row.ok).slice(0, 5).map(row => row.detail),
  }
  results.push(record)
  console.log(
    `  ${operation.padEnd(12)} ${String(stats.success).padStart(2)}/${String(stats.attempts).padEnd(3)}`
    + ` ${(stats.successRate * 100).toFixed(1).padStart(5)}%`
    + `  mean ${stats.meanMs.toFixed(0).padStart(4)}ms  p50 ${stats.p50Ms.toFixed(0).padStart(4)}ms`
    + `  p95 ${stats.p95Ms.toFixed(0).padStart(4)}ms  max ${stats.maxMs.toFixed(0).padStart(4)}ms`,
  )
  for (const detail of record.failuresDetail) console.log(`      FAIL: ${detail}`)
}

function statusOf(env, appName) {
  const value = env.status(appName)
  if (value.ok !== true) throw new Error(value.error)
  return parseStatus(value.status)
}

async function waitForStatus(env, appName, predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = statusOf(env, appName)
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  return last
}

async function runFixture(def) {
  console.log(`\n== ${def.label} (${def.toolkit}) ==`)
  const env = await TestDisplay.start()
  const app = env.launch([def.command])
  const automation = new Automation({ getConfig: () => env.config(), pluginDir })
  try {
    await env.waitForApp({ pid: app.pid })
    const initial = await automation.screenshot()
    if (initial.ok !== true) throw new Error(`initial screenshot failed: ${initial.code} ${initial.error}`)
    const initialBy = name => indexOf(initial.targets, name)

    // ---- screenshot ---------------------------------------------------
    const shotRows = []
    for (let i = 0; i < N; i += 1) {
      const shot = await automation.screenshot()
      const ok = shot.ok === true && shot.geometryTrusted === true && shot.targetCount === initial.targetCount
      shotRows.push({
        ok,
        ms: shot.elapsedMs ?? 0,
        detail: `${shot.code || 'ok'} targets=${shot.targetCount} ${shot.image?.width}×${shot.image?.height}`,
      })
    }
    report(def, 'screenshot', shotRows)

    // ---- click --------------------------------------------------------
    const clickRows = []
    let latest = initial
    for (let i = 0; i < N; i += 1) {
      const before = statusOf(env, def.appName)
      const click = await automation.click({ index: initialBy(def.names.button), afterSeconds: 0.2 })
      const after = click.ok === true ? await waitForStatus(env, def.appName, status => status.clicks === before.clicks + 1) : before
      clickRows.push({
        ok: click.ok === true && after.clicks === before.clicks + 1,
        ms: click.totalMs ?? 0,
        detail: `clicks ${before.clicks} → ${after.clicks} (${click.code || 'ok'}, image ${click.imageId || '-'})`,
      })
      if (click.ok === true) latest = click
    }
    report(def, 'click', clickRows)

    // ---- double click -------------------------------------------------
    const dblRows = []
    for (let i = 0; i < N; i += 1) {
      const before = statusOf(env, def.appName)
      const dbl = await automation.doubleClick({ index: initialBy('dblarea'), intervalMs: 120, afterSeconds: 0.2 })
      const after = dbl.ok === true ? await waitForStatus(env, def.appName, status => status.dclicks === before.dclicks + 1) : before
      dblRows.push({
        ok: dbl.ok === true && after.dclicks === before.dclicks + 1,
        ms: dbl.totalMs ?? 0,
        detail: `dclicks ${before.dclicks} → ${after.dclicks} (${dbl.code || 'ok'})`,
      })
    }
    report(def, 'double_click', dblRows)

    // ---- drag ---------------------------------------------------------
    const dragRows = []
    for (let i = 0; i < N; i += 1) {
      const before = statusOf(env, def.appName)
      const drag = await automation.drag({ fromIndex: initialBy('dragarea'), toIndex: initialBy('wheelarea'), steps: 10, afterSeconds: 0.2 })
      const after = drag.ok === true ? await waitForStatus(env, def.appName, status => status.drags === before.drags + 1) : before
      dragRows.push({
        ok: drag.ok === true && after.drags === before.drags + 1 && after.dragdist > 0,
        ms: drag.totalMs ?? 0,
        detail: `drags ${before.drags} → ${after.drags}, dist=${after.dragdist} (${drag.code || 'ok'})`,
      })
    }
    report(def, 'drag', dragRows)

    // ---- scroll -------------------------------------------------------
    const scrollRows = []
    for (let i = 0; i < N; i += 1) {
      const before = statusOf(env, def.appName)
      const scroll = await automation.scroll({ index: initialBy('wheelarea'), direction: 'down', amount: 1, afterSeconds: 0.2 })
      const after = scroll.ok === true ? await waitForStatus(env, def.appName, status => status.wheelTicks === before.wheelTicks + 1) : before
      scrollRows.push({
        ok: scroll.ok === true && after.wheelTicks === before.wheelTicks + 1,
        ms: scroll.totalMs ?? 0,
        detail: `wheelTicks ${before.wheelTicks} → ${after.wheelTicks} (${scroll.code || 'ok'})`,
      })
    }
    report(def, 'scroll', scrollRows)

    // ---- type ---------------------------------------------------------
    const typeRows = []
    for (let i = 0; i < N; i += 1) {
      const text = i % 2 === 0 ? `ascii-${i}` : `中文-${i}`
      const typed = await automation.type({ index: initialBy(def.names.input), text, afterSeconds: 0.2 })
      const status = statusOf(env, def.appName)
      typeRows.push({
        ok: typed.ok === true && typed.readback?.verified === true && status.text === text,
        ms: typed.totalMs ?? 0,
        detail: `text=${JSON.stringify(text)} readback=${JSON.stringify(typed.readback?.actual ?? status.text)} (${typed.code || typed.channel})`,
      })
    }
    report(def, 'type', typeRows)
    void latest

    return {
      screenshot: { count: shotRows.filter(row => row.ok).length },
      lastStatus: statusOf(env, def.appName).raw,
    }
  } finally {
    await env.stop()
  }
}

const defs = [
  {
    key: 'panel_qt', label: 'Qt6 fixture', toolkit: 'qt6',
    command: path.join(fixtureDir, 'panel_qt'), appName: 'panel_qt',
    names: { button: 'button', input: 'input' },
  },
  {
    key: 'panel_gtk3', label: 'GTK3 fixture', toolkit: 'gtk3',
    command: path.join(fixtureDir, 'panel_gtk3'), appName: 'panel_gtk3',
    names: { button: 'button', input: 'input' },
  },
]

const summary = { generatedAt: new Date().toISOString(), attemptsPerOperation: N, durationMs: 0, results, footers: {} }
for (const def of defs) {
  summary.footers[def.key] = await runFixture(def)
}
summary.durationMs = Date.now() - started

mkdirSync('test/out', { recursive: true })
writeFileSync('test/out/reliability.json', `${JSON.stringify(summary, null, 2)}\n`)

console.log('\n| app | toolkit | operation | success | rate | mean | p50 | p95 | max |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const row of results) {
  console.log(`| ${row.app} | ${row.toolkit} | ${row.operation} | ${row.success}/${row.attempts} | ${(row.successRate * 100).toFixed(1)}% | ${row.meanMs.toFixed(0)}ms | ${row.p50Ms.toFixed(0)}ms | ${row.p95Ms.toFixed(0)}ms | ${row.maxMs.toFixed(0)}ms |`)
}
console.log(`\ntotal wall clock: ${(summary.durationMs / 1000).toFixed(1)}s — wrote test/out/reliability.json`)

const failed = results.filter(row => row.success !== row.attempts)
process.exit(failed.length === 0 ? 0 : 1)
