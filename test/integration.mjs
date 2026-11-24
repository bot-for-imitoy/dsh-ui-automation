/**
 * integration.mjs — real-machine operation matrix for dsh-ui-automation.
 *
 * Drives the plugin's own engine and tool definitions (not a mock) against:
 *   - Qt6 and GTK3 fixtures with click / double-click / drag / wheel counters;
 *   - the research probes app_qt (Qt6), app_gtk3, app_gtk4.
 *
 * Every assertion reads the application's own state label back over AT-SPI, so
 * a PASS means the application really changed state.
 *
 *   node test/integration.mjs
 */
import { existsSync, statSync } from 'node:fs'
import { apps, Checks, createEngine, parseStatus, statusOf, waitForStatus } from './lib/harness.mjs'

const checks = new Checks('integration matrix')
const engine = createEngine()
const results = { apps: {}, isolation: null, failures: null, tools: null }

async function expectStatus(name, instance, predicate, detail) {
  const status = await waitForStatus(engine, instance, predicate)
  const ok = predicate(status)
  return checks.check(name, ok, ok ? `${detail} — ${status.raw}` : `期望未满足 — ${status.raw}`)
}

async function open(def) {
  const launched = await engine.launch({ command: def.command })
  if (launched.ok !== true) {
    checks.check(`${def.label} 启动`, false, launched.error)
    return null
  }
  const instance = engine.instances.get(launched.appId)
  checks.check(`${def.label} 启动`, true, `${launched.appId} @ ${launched.display} ${launched.startupMs}ms，toolkit=${launched.app.toolkit}`, launched.startupMs)
  checks.check(`${def.label} 工具包识别`, launched.app.toolkit === def.toolkit, `${launched.app.toolkit}（期望 ${def.toolkit}）`)
  checks.check(`${def.label} 窗口几何`, launched.window !== null && launched.window.width > 100, launched.window ? `${launched.window.width}x${launched.window.height}` : '无窗口')
  return instance
}

async function runMatrix(def) {
  checks.section(def.label)
  const instance = await open(def)
  if (instance === null) return
  const appResult = { toolkit: def.toolkit, checks: [] }
  results.apps[def.key] = appResult
  const record = (name, ok, detail, ms) => {
    appResult.checks.push({ name, ok, detail, ms })
    return checks.check(name, ok, detail, ms)
  }

  try {
    const tree = await engine.tree(instance, { maxDepth: 12 })
    const names = tree.nodes.map(node => node.name)
    record('ui_tree 枚举到按钮', names.includes(def.buttonName), `${tree.nodes.length} 节点，按钮=${JSON.stringify(def.buttonName)}`)
    record('ui_tree 枚举到输入框', names.includes(def.inputName), `输入框=${JSON.stringify(def.inputName)}`)

    const before = parseStatus(await statusOf(engine, instance))
    record('初始状态可读', before.clicks !== null, before.raw)

    // --- semantic click -------------------------------------------------
    const click = await engine.click(instance, { name: def.buttonName })
    const afterClick = await waitForStatus(engine, instance, status => status.clicks === before.clicks + 1)
    record('AT-SPI 语义点击 button', click.ok === true && click.effect?.changed === true && afterClick.clicks === before.clicks + 1,
      `channel=${click.channel} ${before.clicks} → ${afterClick.clicks}`, click.elapsedMs)

    // --- coordinate click ----------------------------------------------
    if (def.checkHasNoAction) {
      // GTK4 reports fake (0,0,w,h) extents, so the tool must refuse the
      // implicit centre and succeed only with explicit coordinates.
      const implicit = await engine.click(instance, { name: def.checkName })
      record('GTK4 无 Action + 假坐标时明确报错', implicit.ok === false && implicit.code === 'E_NO_COORDS',
        `${implicit.code}: ${implicit.error}`, implicit.elapsedMs)
      const stateBefore = parseStatus(await statusOf(engine, instance))
      const explicit = await engine.click(instance, { x: 60, y: 100 })
      const stateAfter = await waitForStatus(engine, instance, status => status.checked !== stateBefore.checked)
      record('GTK4 显式坐标点击复选框', explicit.ok === true && explicit.effect?.changed === true && stateAfter.checked !== stateBefore.checked,
        `checked ${stateBefore.checked} → ${stateAfter.checked}`, explicit.elapsedMs)
    } else {
      const rect = await engine.resolveTarget(instance, { name: def.buttonName })
      const centre = { x: Math.round(rect.rect.x + rect.rect.width / 2), y: Math.round(rect.rect.y + rect.rect.height / 2) }
      const beforeXY = parseStatus(await statusOf(engine, instance))
      const byCoords = await engine.click(instance, centre)
      const afterXY = await waitForStatus(engine, instance, status => status.clicks === beforeXY.clicks + 1)
      record('坐标点击 button', byCoords.ok === true && byCoords.channel === 'xtest' && afterXY.clicks === beforeXY.clicks + 1,
        `(${centre.x},${centre.y}) ${beforeXY.clicks} → ${afterXY.clicks}`, byCoords.elapsedMs)
    }

    // --- double click, drag, scroll (fixtures only) ---------------------
    if (def.hasDragScroll) {
      const beforeDbl = parseStatus(await statusOf(engine, instance))
      const dbl = await engine.doubleClick(instance, { name: 'dblarea' })
      const afterDbl = await waitForStatus(engine, instance, status => status.dclicks === beforeDbl.dclicks + 1)
      record('双击 dblarea', dbl.ok === true && afterDbl.dclicks === beforeDbl.dclicks + 1,
        `dclicks ${beforeDbl.dclicks} → ${afterDbl.dclicks}，间隔 ${dbl.actionResult?.count === 2 ? '2 次点击' : '?'}，${dbl.actionResult?.elapsedMs}ms`, dbl.elapsedMs)

      const dragRect = await engine.resolveTarget(instance, { name: 'dragarea' })
      const from = { x: dragRect.rect.x + 20, y: dragRect.rect.y + Math.round(dragRect.rect.height / 2) }
      const to = { x: dragRect.rect.x + dragRect.rect.width - 20, y: from.y }
      const beforeDrag = parseStatus(await statusOf(engine, instance))
      const drag = await engine.drag(instance, { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, steps: 12, stepMs: 15 })
      const afterDrag = await waitForStatus(engine, instance, status => status.drags === beforeDrag.drags + 1)
      record('拖拽 dragarea（12 步 × 15ms）',
        drag.ok === true && afterDrag.drags === beforeDrag.drags + 1 && afterDrag.dragdist > 0
          && drag.actionResult?.finalPointer?.x === to.x,
        `drags ${beforeDrag.drags} → ${afterDrag.drags}，dist=${afterDrag.dragdist}，指针=${JSON.stringify(drag.actionResult?.finalPointer)}`, drag.elapsedMs)

      const beforeScroll = parseStatus(await statusOf(engine, instance))
      const scroll = await engine.scroll(instance, { name: 'wheelarea', direction: 'down', amount: 2 })
      const afterScroll = await waitForStatus(engine, instance, status => status.wheelTicks === beforeScroll.wheelTicks + 2)
      record('滚轮向下 ×2（-240）',
        scroll.ok === true && afterScroll.wheelTicks === beforeScroll.wheelTicks + 2 && afterScroll.wheel === beforeScroll.wheel - 240,
        `wheelTicks ${beforeScroll.wheelTicks} → ${afterScroll.wheelTicks}，wheel=${afterScroll.wheel}`, scroll.elapsedMs)
    }

    // --- typing ---------------------------------------------------------
    for (const [label, text, mode] of [
      ['ASCII', 'hello world', 'auto'],
      ['中文（AT-SPI SetTextContents）', '你好世界', 'auto'],
      ['中文（XTEST 键盘兜底）', '中文键输入', 'keys'],
    ]) {
      const beforeType = parseStatus(await statusOf(engine, instance))
      const focusPoint = def.inputFocusPoint ?? {}
      const typed = await engine.type(instance, { name: def.inputName, text, mode, x: focusPoint.x, y: focusPoint.y })
      const afterType = await waitForStatus(engine, instance, status => status.text === text)
      record(`输入${label}`, typed.ok === true && afterType.text === text,
        `channel=${typed.channel} 回读=${JSON.stringify(afterType.text)}`, typed.elapsedMs)
      if (beforeType.text === text) record('输入前后状态确实不同', false, '测试自身没有变化')
    }

    // --- key chord ------------------------------------------------------
    const chordPoint = def.inputFocusPoint ?? {}
    const chord = await engine.type(instance, { name: def.inputName, keys: 'ctrl+a', x: chordPoint.x, y: chordPoint.y })
    record('按键组合 ctrl+a', chord.ok === true && chord.channel === 'xtest-key' && chord.focus?.steps !== undefined,
      `focus steps=${chord.focus?.steps?.map(step => step.step).join('→') || '(已有焦点)'}`, chord.elapsedMs)

    // --- tree/state after typing ---------------------------------------
    const finalStatus = parseStatus(await statusOf(engine, instance))
    record('最终状态一致', finalStatus.text === '中文键输入', finalStatus.raw)

    // --- screenshot -----------------------------------------------------
    const shot = await engine.screenshot(instance, {})
    record('截图', shot.ok === true && existsSync(shot.path) && statSync(shot.path).size > 5000,
      `${shot.path}（${shot.bytes} 字节，${shot.width}x${shot.height}）`, shot.elapsedMs)

    // --- wrong target must fail loudly ---------------------------------
    const missing = await engine.click(instance, { name: 'this-node-does-not-exist' })
    record('不存在的目标返回结构化错误', missing.ok === false && missing.code === 'E_NO_NODE', `${missing.code}: ${missing.error}`)
  } finally {
    const closed = await engine.close(instance.appId)
    record('ui_close 回收实例', closed.ok === true && !existsSync(closed.logDir ?? instance.shell.runDir),
      `forced=${closed.forced}, ${closed.elapsedMs}ms`)
  }
}

async function runIsolation() {
  checks.section('并行隔离（两个壳互不可见）')
  const first = await engine.launch({ command: apps.panelQt.command })
  const second = await engine.launch({ command: apps.panelGtk3.command })
  if (first.ok !== true || second.ok !== true) {
    checks.check('并行启动两个壳', false, `${first.error ?? ''} ${second.error ?? ''}`)
    return
  }
  const a = engine.instances.get(first.appId)
  const b = engine.instances.get(second.appId)
  checks.check('并行启动两个壳', true, `${first.appId} @ ${first.display} / ${second.appId} @ ${second.display}`)
  checks.check('display 号不同', first.display !== second.display, `${first.display} vs ${second.display}`)

  const treeA = await engine.tree(a, { maxDepth: 3 })
  const treeB = await engine.tree(b, { maxDepth: 3 })
  checks.check('实例 A 只看到自己的应用', treeA.app.name === 'panel_qt' && treeB.app.name === 'panel_gtk3',
    `A=${treeA.app.name} B=${treeB.app.name}`)

  const clickA = await engine.click(a, { name: 'button' })
  const statusA = parseStatus(await statusOf(engine, a))
  const clickB = await engine.click(b, { name: 'button' })
  const statusB = parseStatus(await statusOf(engine, b))
  checks.check('两个实例可并行操作', clickA.ok && clickB.ok && statusA.clicks === 1 && statusB.clicks === 1,
    `A.clicks=${statusA.clicks} B.clicks=${statusB.clicks}`)

  await engine.close(a.appId)
  await engine.close(b.appId)
  const left = engine.list()
  checks.check('关闭后实例表清空', left.length === 0, `${left.length} 个残留`)
  results.isolation = { displays: [first.display, second.display], clicks: [statusA.clicks, statusB.clicks] }
}

async function runLaunchFailures() {
  checks.section('启动失败与超时处理')
  const failed = await engine.launch({ command: ['bash', '-lc', 'echo boom >&2; exit 7'] })
  checks.check('应用立即退出 → 结构化失败（带日志）',
    failed.ok === false && failed.code === 'E_APP_EXITED' && typeof failed.logs?.app === 'string',
    `${failed.code}: ${failed.error}；log=${JSON.stringify((failed.logs?.app || '').slice(0, 60))}`)

  const missing = await engine.launch({ command: ['/definitely/not/a/binary'] })
  checks.check('不存在的可执行文件 → 结构化失败',
    missing.ok === false && ['E_APP_EXITED', 'E_NO_A11Y', 'E_SHELL_EXITED'].includes(missing.code),
    `${missing.code}: ${missing.error}`)

  const badCwd = await engine.launch({ command: apps.panelQt.command, cwd: '/no/such/dir' })
  checks.check('不存在的工作目录 → E_BAD_CWD', badCwd.ok === false && badCwd.code === 'E_BAD_CWD', badCwd.error)

  checks.check('失败启动没有留下实例', engine.list().length === 0, `${engine.list().length} 个残留`)
  results.failures = { exited: failed.code, missing: missing.code, badCwd: badCwd.code }
}

async function runTools() {
  checks.section('工具定义（defineTool → execute → render）')
  const { createTools } = await import('../lib/tools.js')
  const tools = createTools(engine)
  const names = tools.map(tool => tool.name)
  const expected = ['ui_launch', 'ui_click', 'ui_double_click', 'ui_drag', 'ui_scroll', 'ui_type', 'ui_tree', 'ui_screenshot', 'ui_close', 'ui_list']
  checks.check('注册 10 个工具', expected.every(name => names.includes(name)), names.join(', '))
  results.tools = { names }

  const launchDef = tools.find(tool => tool.name === 'ui_launch')
  const launchValue = await launchDef.execute({ command: apps.panelQt.command })
  checks.check('ui_launch 通过工具入口工作', launchValue.ok === true, launchValue.appId)
  const rendered = launchDef.output.render({}, launchValue)
  checks.check('ui_launch 渲染为人类可读文本', rendered[0].type === 'text' && /已启动/.test(rendered[0].text), rendered[0].text.split('\n')[0])

  const clickDef = tools.find(tool => tool.name === 'ui_click')
  const clickValue = await clickDef.execute({ appId: launchValue.appId, name: 'button' })
  checks.check('ui_click 通过工具入口工作', clickValue.ok === true && clickValue.effect?.changed === true, clickValue.channel)
  const clickRender = clickDef.output.render({}, clickValue)[0].text
  checks.check('ui_click 渲染包含回读结论', /状态已变化/.test(clickRender), clickRender.split('\n')[0])

  const unknown = await clickDef.execute({ appId: 'ui-does-not-exist', name: 'button' })
  checks.check('未知 appId → 结构化错误', unknown.ok === false && unknown.code === 'E_NO_INSTANCE', unknown.error)

  const listValue = await tools.find(tool => tool.name === 'ui_list').execute({})
  checks.check('ui_list 列出实例', listValue.ok === true && listValue.instances.length === 1, `${listValue.instances.length} 个`)

  const closeValue = await tools.find(tool => tool.name === 'ui_close').execute({ appId: launchValue.appId })
  checks.check('ui_close 通过工具入口工作', closeValue.ok === true, `forced=${closeValue.forced}`)
}

const only = process.argv[2]
const available = def => existsSync(def.command[0])
const selected = only === undefined
  ? Object.values(apps).filter(available)
  : [Object.values(apps).find(app => app.key === only)].filter(Boolean)
const skipped = Object.values(apps).filter(def => !available(def))
if (skipped.length > 0) console.log(`skipping unavailable apps: ${skipped.map(def => def.key).join(', ')}`)

for (const def of selected) await runMatrix(def)
if (only === undefined) {
  await runIsolation()
  await runLaunchFailures()
  await runTools()
}

const ok = checks.summary()
const { writeFileSync, mkdirSync } = await import('node:fs')
mkdirSync('test/out', { recursive: true })
writeFileSync('test/out/integration.json', `${JSON.stringify({ ok, rows: checks.rows, results }, null, 2)}\n`)
process.exit(ok ? 0 : 1)
