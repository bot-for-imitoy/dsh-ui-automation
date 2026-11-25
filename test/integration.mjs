/**
 * integration.mjs — real-machine matrix for the numbered-image contract.
 *
 * The test owns Xvfb + a private D-Bus + the fixture (the plugin never launches
 * applications). Every assertion reads the fixture's own counter label back
 * through AT-SPI, so success means the application changed state.
 *
 *   node test/integration.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Automation } from '../lib/automation.js'
import { createTools } from '../lib/tools.js'
import { fixtureDir, pluginDir, TestDisplay } from './lib/env.mjs'
import { Checks, indexOf, indexMap, parseStatus, stableMapping, statusOf } from './lib/checks.mjs'

const checks = new Checks('numbered-image integration matrix')
const report = { apps: {}, errors: {}, tools: {}, gtk4: null }

function exists(file) {
  return typeof file === 'string' && existsSync(file)
}

function targetNames(targets) {
  return targets.map(target => target.name || target.label)
}

async function runFixture(def) {
  checks.section(def.label)
  const env = await TestDisplay.start()
  const app = env.launch([def.command])
  const automation = new Automation({
    getConfig: () => env.config(),
    pluginDir,
    log: (level, message) => { if (process.env.UI_DEBUG === '1') console.log(`[${level}] ${message}`) },
  })
  const result = { checks: [] }
  report.apps[def.key] = result
  const record = (name, ok, detail, ms) => {
    result.checks.push({ name, ok, detail, ms })
    return checks.check(name, ok, detail, ms)
  }

  try {
    await env.waitForApp({ pid: app.pid })
    record('fixture visible on AT-SPI', true, `${def.appName} pid ${app.pid}`)

    // ---- screenshot ---------------------------------------------------
    const first = await automation.screenshot()
    record('ui_screenshot succeeds', first.ok === true, first.ok ? first.imageId : `${first.code}: ${first.error}`, first.elapsedMs)
    if (first.ok !== true) return
    record('image file exists', exists(first.imagePath) && exists(first.sidecarPath), first.imagePath)
    record('geometry trusted', first.geometryTrusted === true, `${first.stats.distinctPositions} distinct positions`)
    record('cropped to the window (no black desktop)',
      first.image.width < first.screen.width && first.image.height < first.screen.height,
      `image ${first.image.width}×${first.image.height} vs screen ${first.screen.width}×${first.screen.height}`)
    record('numbered 6+ targets', first.targetCount >= 6, `${first.targetCount}: ${targetNames(first.targets).join(', ')}`)
    for (const wanted of [def.names.input, def.names.button, def.names.check, 'dragarea', 'dblarea', 'wheelarea']) {
      record(`target ${wanted} numbered`, targetNames(first.targets).includes(wanted), '')
    }
    const sidecar = JSON.parse(readFileSync(first.sidecarPath, 'utf8'))
    record('sidecar records identity per index',
      Array.isArray(sidecar.targets) && sidecar.targets.every(target => target.index && target.appPid && target.path && Array.isArray(target.center)),
      `${sidecar.targets.length} entries, e.g. #1 pid=${sidecar.targets[0].appPid} path=${sidecar.targets[0].path}`)

    // ---- numbering stability -----------------------------------------
    const second = await automation.screenshot()
    const stable = stableMapping(first.targets, second.targets)
    record('same screen → same indices', stable.ok === true, stable.detail)
    record('a new capture gets a new imageId', second.imageId !== first.imageId, `${first.imageId} → ${second.imageId}`)

    // ---- click --------------------------------------------------------
    const beforeClick = statusOf(env, def.appName)
    const clickIndex = indexOf(second.targets, def.names.button)
    const clicked = await automation.click({ index: clickIndex, afterSeconds: 0.25 })
    const afterClick = statusOf(env, def.appName)
    record('click by index → counter +1',
      clicked.ok === true && afterClick.clicks === beforeClick.clicks + 1 && clicked.imageId !== second.imageId,
      `#${clickIndex} clicks ${beforeClick.clicks} → ${afterClick.clicks}, image ${clicked.imageId}`, clicked.totalMs)
    record('click returned an existing new image', exists(clicked.imagePath) && clicked.imagePath !== first.imagePath, clicked.imagePath)

    // ---- double click -------------------------------------------------
    const beforeDbl = statusOf(env, def.appName)
    const dblIndex = indexOf(clicked.targets, 'dblarea')
    const dbl = await automation.doubleClick({ index: dblIndex, intervalMs: 120, afterSeconds: 0.25 })
    const afterDbl = statusOf(env, def.appName)
    record('double click by index → dclicks +1',
      dbl.ok === true && afterDbl.dclicks === beforeDbl.dclicks + 1,
      `#${dblIndex} dclicks ${beforeDbl.dclicks} → ${afterDbl.dclicks}, image ${dbl.imageId}`, dbl.totalMs)

    // ---- drag ---------------------------------------------------------
    const beforeDrag = statusOf(env, def.appName)
    const fromIndex = indexOf(dbl.targets, 'dragarea')
    const toIndex = indexOf(dbl.targets, 'wheelarea')
    const dragged = await automation.drag({ fromIndex, toIndex, steps: 10, afterSeconds: 0.25 })
    const afterDrag = statusOf(env, def.appName)
    record('drag fromIndex → toIndex → drags +1 and distance > 0',
      dragged.ok === true && afterDrag.drags === beforeDrag.drags + 1 && afterDrag.dragdist > 0,
      `#${fromIndex}→#${toIndex} drags ${beforeDrag.drags} → ${afterDrag.drags}, dist=${afterDrag.dragdist}`, dragged.totalMs)

    // ---- scroll -------------------------------------------------------
    const beforeScroll = statusOf(env, def.appName)
    const scrollIndex = indexOf(dragged.targets, 'wheelarea')
    const scrolled = await automation.scroll({ index: scrollIndex, direction: 'down', amount: 2, afterSeconds: 0.25 })
    const afterScroll = statusOf(env, def.appName)
    record('scroll by index → wheel ticks +2, −240',
      scrolled.ok === true && afterScroll.wheelTicks === beforeScroll.wheelTicks + 2 && afterScroll.wheel === beforeScroll.wheel - 240,
      `#${scrollIndex} wheelTicks ${beforeScroll.wheelTicks} → ${afterScroll.wheelTicks}, wheel=${afterScroll.wheel}`, scrolled.totalMs)

    // ---- typing -------------------------------------------------------
    for (const [label, text] of [['ASCII', 'hello numbered'], ['CJK', '你好，标号图片']]) {
      const inputIndex = indexOf(scrolled.targets, def.names.input)
      const typed = await automation.type({ index: inputIndex, text, afterSeconds: 0.25 })
      const status = statusOf(env, def.appName)
      record(`type ${label} through the input index`,
        typed.ok === true && status.text === text && typed.readback?.verified === true,
        `channel=${typed.channel} readback=${JSON.stringify(typed.readback?.actual)}`, typed.totalMs)
    }

    const chordIndex = indexOf((await automation.screenshot()).targets, def.names.input)
    const chord = await automation.type({ index: chordIndex, keys: 'ctrl+a', afterSeconds: 0.25 })
    record('key chord through the input index', chord.ok === true && chord.channel === 'xtest-key',
      `#${chordIndex} ${chord.channel}`, chord.totalMs)

    // ---- invalid indices ---------------------------------------------
    const outOfRange = await automation.click({ index: 999 })
    record('index out of range → E_INDEX', outOfRange.ok === false && outOfRange.code === 'E_INDEX',
      `${outOfRange.code}: ${outOfRange.error}`)
    const zero = await automation.click({ index: 0 })
    record('index 0 → E_INDEX', zero.ok === false && zero.code === 'E_INDEX', zero.code)
    const noImage = new Automation({ getConfig: () => env.config(), pluginDir })
    const withoutImage = await noImage.click({ index: 1 })
    record('click before any screenshot → E_NO_IMAGE', withoutImage.ok === false && withoutImage.code === 'E_NO_IMAGE',
      `${withoutImage.code}: ${withoutImage.error}`)

    // ---- tools layer ---------------------------------------------------
    const tools = createTools(automation)
    const names = tools.map(tool => tool.name)
    record('registered tools', names.length === 6
      && ['ui_screenshot', 'ui_click', 'ui_double_click', 'ui_scroll', 'ui_drag', 'ui_type'].every(name => names.includes(name)),
      names.join(', '))
    const screenshotTool = tools.find(tool => tool.name === 'ui_screenshot')
    const shotValue = await screenshotTool.execute({})
    const rendered = screenshotTool.output.render({}, shotValue)
    record('ui_screenshot tool entry works', shotValue.ok === true, shotValue.imageId)
    record('ui_screenshot render is readable', rendered[0].type === 'text' && rendered[0].text.includes('numbered screenshot'),
      rendered[0].text.split('\n')[0])
    const clickTool = tools.find(tool => tool.name === 'ui_click')
    const clickValue = await clickTool.execute({ index: indexOf(shotValue.targets, def.names.button), afterSeconds: 0.2 })
    record('ui_click tool entry works', clickValue.ok === true && clickValue.imageId !== shotValue.imageId, clickValue.imageId)
    const badValue = await clickTool.execute({ index: 12345 })
    record('tool error is structured', badValue.ok === false && badValue.code === 'E_INDEX', badValue.code)

    // Attachment path: when the Host has an attachment store, the PNG is saved
    // and the renderer emits an image content block ahead of the index list.
    const fakeRef = {
      attachmentId: 'att-test-1', mediaType: 'image/png', bytes: 1234,
      width: 320, height: 240, name: 'shot.png',
    }
    const withAttachments = new Automation({
      getConfig: () => env.config({ attachImage: true }),
      pluginDir,
      attachments: { saveImage: async () => fakeRef },
    })
    const attached = await withAttachments.screenshot()
    const attachedRender = screenshotTool.output.render({}, attached)
    record('attachment is created and rendered as an image block',
      attached.ok === true && attached.attachment?.attachmentId === 'att-test-1'
        && attachedRender[0].type === 'image' && attachedRender[1].type === 'text',
      `blocks: ${attachedRender.map(block => block.type).join(', ')}`)
  } finally {
    await env.stop()
  }
}

async function runGtk4Limit() {
  checks.section('GTK4 geometry limit (reproducible E_NO_GEOMETRY)')
  const env = await TestDisplay.start()
  const app = env.launch([path.join(fixtureDir, 'panel_gtk4')])
  const automation = new Automation({ getConfig: () => env.config(), pluginDir })
  try {
    await env.waitForApp({ pid: app.pid })
    const shot = await automation.screenshot()
    checks.check('GTK4 screenshot is refused with E_NO_GEOMETRY',
      shot.ok === false && shot.code === 'E_NO_GEOMETRY' && shot.geometryTrusted === false,
      `${shot.code}: ${shot.error}`)
    checks.check('evidence image is still written',
      exists(shot.imagePath) && shot.targets.length >= 3,
      `${shot.imagePath} (${shot.targets?.length} targets, no badges)`)
    checks.check('no stale indices are kept', automation.latestFor(env.display) === undefined, 'latest image invalidated')
    report.gtk4 = { imagePath: shot.imagePath, targets: shot.targets?.length, code: shot.code }
  } finally {
    await env.stop()
  }
}

const appDefs = [
  {
    key: 'panel_qt', label: 'Qt6 fixture', command: path.join(fixtureDir, 'panel_qt'), appName: 'panel_qt',
    names: { input: 'input', button: 'button', check: 'check' },
  },
  {
    key: 'panel_gtk3', label: 'GTK3 fixture', command: path.join(fixtureDir, 'panel_gtk3'), appName: 'panel_gtk3',
    names: { input: 'input', button: 'button', check: 'check' },
  },
]

for (const def of appDefs) await runFixture(def)
await runGtk4Limit()

const ok = checks.summary()
mkdirSync('test/out', { recursive: true })
writeFileSync('test/out/integration.json', `${JSON.stringify({ ok, rows: checks.rows, report }, null, 2)}\n`)
process.exit(ok ? 0 : 1)
