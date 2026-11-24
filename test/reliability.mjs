/**
 * reliability.mjs — repeat each operation N times and report success rate and
 * latency, reading the application's own counter after every single call.
 *
 *   node test/reliability.mjs            # N=30 per operation
 *   UI_RELIABILITY_N=50 node test/reliability.mjs
 *
 * Covers Qt6 and GTK3 fixtures (click, double-click, drag, scroll, type) plus
 * the research probes: 30 semantic clicks on app_qt / app_gtk3 / app_gtk4 and
 * 30 CJK text writes on app_gtk4, which is where the GTK4 300ms debounce floor
 * matters most.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { apps, createEngine, parseStatus, statusOf, waitForStatus } from './lib/harness.mjs'

const N = Math.max(1, Number(process.env.UI_RELIABILITY_N) || 30)
const engine = createEngine()
const results = []
const started = Date.now()

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

async function launch(def) {
  const launched = await engine.launch({ command: def.command })
  if (launched.ok !== true) throw new Error(`${def.key} launch failed: ${launched.error}`)
  return engine.instances.get(launched.appId)
}

async function runApp(def) {
  console.log(`\n== ${def.label} (${def.toolkit}) ==`)
  const instance = await launch(def)
  try {
    // --- click ---------------------------------------------------------
    const clickRows = []
    for (let index = 0; index < N; index += 1) {
      const before = parseStatus(await statusOf(engine, instance))
      const result = await engine.click(instance, { name: def.buttonName })
      let now = before
      if (result.ok === true) {
        now = await waitForStatus(engine, instance, status => status.clicks === before.clicks + 1, 1500)
      }
      const ok = result.ok === true && now.clicks === before.clicks + 1
      clickRows.push({
        ok,
        ms: result.elapsedMs ?? 0,
        detail: `clicks ${before.clicks} → ${now.clicks} (${result.code || result.channel}, changed=${result.effect?.changed})`,
      })
    }
    report(def, 'click', clickRows)

    // --- type (ASCII / CJK alternating) --------------------------------
    const typeRows = []
    for (let index = 0; index < N; index += 1) {
      const text = index % 2 === 0 ? `ascii-${index}` : `中文-${index}`
      const result = await engine.type(instance, { name: def.inputName, text })
      const status = parseStatus(await statusOf(engine, instance))
      const ok = result.ok === true && result.readback?.verified === true && status.text === text
      typeRows.push({
        ok,
        ms: result.elapsedMs ?? 0,
        detail: `text=${JSON.stringify(text)} readback=${JSON.stringify(result.readback?.actual ?? status.text)} (${result.code || result.channel})`,
      })
    }
    report(def, 'type', typeRows)

    if (def.hasDragScroll === true) {
      // --- double click ------------------------------------------------
      const dblRows = []
      for (let index = 0; index < N; index += 1) {
        const before = parseStatus(await statusOf(engine, instance))
        const result = await engine.doubleClick(instance, { name: 'dblarea' })
        const after = result.ok === true
          ? await waitForStatus(engine, instance, status => status.dclicks === before.dclicks + 1, 1500)
          : before
        dblRows.push({
          ok: result.ok === true && after.dclicks === before.dclicks + 1,
          ms: result.elapsedMs ?? 0,
          detail: `dclicks ${before.dclicks} → ${after.dclicks} (${result.code || result.channel})`,
        })
      }
      report(def, 'double_click', dblRows)

      // --- drag ---------------------------------------------------------
      const dragRect = await engine.resolveTarget(instance, { name: 'dragarea' })
      const dragRows = []
      for (let index = 0; index < N; index += 1) {
        const before = parseStatus(await statusOf(engine, instance))
        const from = { x: dragRect.rect.x + 20, y: dragRect.rect.y + Math.round(dragRect.rect.height / 2) }
        const to = { x: dragRect.rect.x + dragRect.rect.width - 20, y: from.y }
        const result = await engine.drag(instance, { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, steps: 12, stepMs: 15 })
        const after = result.ok === true
          ? await waitForStatus(engine, instance, status => status.drags === before.drags + 1, 1500)
          : before
        dragRows.push({
          ok: result.ok === true && after.drags === before.drags + 1 && after.dragdist > 0,
          ms: result.elapsedMs ?? 0,
          detail: `drags ${before.drags} → ${after.drags} (${result.code || result.channel})`,
        })
      }
      report(def, 'drag', dragRows)

      // --- scroll -------------------------------------------------------
      const scrollRows = []
      for (let index = 0; index < N; index += 1) {
        const before = parseStatus(await statusOf(engine, instance))
        const result = await engine.scroll(instance, { name: 'wheelarea', direction: 'down', amount: 1 })
        const after = result.ok === true
          ? await waitForStatus(engine, instance, status => status.wheelTicks === before.wheelTicks + 1, 1500)
          : before
        scrollRows.push({
          ok: result.ok === true && after.wheelTicks === before.wheelTicks + 1,
          ms: result.elapsedMs ?? 0,
          detail: `wheelTicks ${before.wheelTicks} → ${after.wheelTicks} (${result.code || result.channel})`,
        })
      }
      report(def, 'scroll', scrollRows)
    }
  } finally {
    await engine.close(instance.appId)
  }
}

const selectedKeys = (process.env.UI_RELIABILITY_APPS || '').split(',').map(part => part.trim()).filter(Boolean)
const defs = Object.values(apps)
  .filter(def => existsSync(def.command[0]))
  .filter(def => selectedKeys.length === 0 || selectedKeys.includes(def.key))
const skipped = Object.values(apps).filter(def => !existsSync(def.command[0]))
if (skipped.length > 0) console.log(`skipping unavailable apps: ${skipped.map(def => def.key).join(', ')}`)
for (const def of defs) await runApp(def)

mkdirSync('test/out', { recursive: true })
const summaryReport = {
  generatedAt: new Date().toISOString(),
  attemptsPerOperation: N,
  durationMs: Date.now() - started,
  environment: {
    display: 'Xvfb 1024x768x24, private D-Bus session per instance',
    pacing: 'Qt 150ms, GTK3 150ms, GTK4 300ms (plugin defaults)',
    readbackTimeoutMs: 700,
  },
  results,
}
writeFileSync('test/out/reliability.json', `${JSON.stringify(summaryReport, null, 2)}\n`)

console.log('\n| app | toolkit | operation | success | rate | mean | p50 | p95 | max |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const row of results) {
  console.log(`| ${row.app} | ${row.toolkit} | ${row.operation} | ${row.success}/${row.attempts} | ${(row.successRate * 100).toFixed(1)}% | ${row.meanMs.toFixed(0)}ms | ${row.p50Ms.toFixed(0)}ms | ${row.p95Ms.toFixed(0)}ms | ${row.maxMs.toFixed(0)}ms |`)
}
console.log(`\ntotal wall clock: ${(summaryReport.durationMs / 1000).toFixed(1)}s — wrote test/out/reliability.json`)

const failed = results.filter(row => row.success !== row.attempts)
process.exit(failed.length === 0 ? 0 : 1)
