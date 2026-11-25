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
    await env.waitForApp({ pid: app.pid, statusApp: def.appName })
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Bounding box of an exact RGB colour in a raw RGB24 frame. */
function colorBBox(buffer, width, height, rgb) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      if (buffer[offset] === rgb[0] && buffer[offset + 1] === rgb[1] && buffer[offset + 2] === rgb[2]) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function warningCodes(value) {
  return (value.warnings || []).map(warning => warning.code)
}

async function runGtk4Fallback() {
  checks.section('GTK4 X11-origin fallback')
  const env = await TestDisplay.start()
  const app = env.launch([path.join(fixtureDir, 'panel_gtk4')])
  const automation = new Automation({ getConfig: () => env.config(), pluginDir })
  try {
    await env.waitForApp({ pid: app.pid, statusApp: 'panel_gtk4' })
    const first = await automation.screenshot()
    checks.check('GTK4 is numbered instead of refused',
      first.ok === true && first.geometryTrusted === true && first.targetCount >= 6,
      `${first.ok ? 'ok' : first.code}; ${first.targetCount} targets; fallback=${JSON.stringify(first.stats?.gtk4Fallback)}`)
    checks.check('every GTK4 target carries rectSource=x11-origin+window',
      first.targets?.length > 0 && first.targets.every(target => target.rectSource === 'x11-origin+window'),
      `sources: ${[...new Set(first.targets.map(target => target.rectSource))].join(', ')}`)

    const buttonName = '点击 Click'
    const buttonIndex = indexOf(first.targets, buttonName)
    const before = statusOf(env, 'panel_gtk4')
    const clicked = await automation.click({ index: buttonIndex, afterSeconds: 0.2 })
    const after = statusOf(env, 'panel_gtk4')
    checks.check('GTK4 click by index increments the fixture counter',
      clicked.ok === true && after.clicks === before.clicks + 1,
      `#${buttonIndex} clicks ${before.clicks} → ${after.clicks}`, clicked.totalMs)

    // ---- move the window: rects must follow, never a cached offset ----
    env.moveWindow(app.pid, 200, 150)
    await sleep(400)
    const moved = await automation.screenshot()
    const byName = new Map(first.targets.map(target => [target.name || target.label, target.rect]))
    let shifted = 0
    for (const target of moved.targets) {
      const original = byName.get(target.name || target.label)
      if (original === undefined) continue
      if (target.rect[0] === original[0] + 200 && target.rect[1] === original[1] + 150) shifted += 1
    }
    checks.check('moving the window shifts every rect by exactly (+200,+150)',
      moved.ok === true && shifted >= 6 && moved.crop.x === 200 && moved.crop.y === 150,
      `${shifted} targets shifted; crop=(${moved.crop.x},${moved.crop.y},${moved.crop.width},${moved.crop.height})`)

    const movedButton = moved.targets.find(target => (target.name || target.label) === buttonName)
    const movedBefore = statusOf(env, 'panel_gtk4')
    const movedClick = await automation.click({ index: movedButton.index, afterSeconds: 0.2 })
    const movedAfter = statusOf(env, 'panel_gtk4')
    checks.check('click after the move still lands on the button',
      movedClick.ok === true && movedAfter.clicks === movedBefore.clicks + 1,
      `#${movedButton.index} clicks ${movedBefore.clicks} → ${movedAfter.clicks}`)

    // ---- pixel-level accuracy: the grey 444x80 area ----
    const raw = env.rawScreen('/tmp/dsh-ui-gtk4-raw.rgb')
    const pixels = readFileSync(raw.path)
    const bbox = colorBBox(pixels, raw.width, raw.height, [51, 102, 204])
    const expected = { x: 200 + 8, y: 150 + 122, width: 444, height: 80 }
    const delta = bbox === null ? null : Math.max(
      Math.abs(bbox.x - expected.x), Math.abs(bbox.y - expected.y),
      Math.abs(bbox.width - expected.width), Math.abs(bbox.height - expected.height),
    )
    checks.check('pixel-level error of the derived geometry is 0–2 px',
      bbox !== null && delta <= 2,
      bbox === null ? 'grey area not found' : `bbox=${JSON.stringify(bbox)} expected≈${JSON.stringify(expected)} maxΔ=${delta}px`)
    report.gtk4 = { imagePath: moved.imagePath, targets: moved.targetCount, bbox, expected, delta }

    // ---- the same capture with the fallback disabled ----
    const disabled = new Automation({
      getConfig: () => env.config({ gtk4OriginFallback: false }),
      pluginDir,
    })
    const refused = await disabled.screenshot()
    checks.check('gtk4OriginFallback=false refuses the GTK4 app',
      refused.ok === false && refused.code === 'E_NO_GEOMETRY'
        && warningCodes(refused).includes('E_GTK4_FALLBACK_DISABLED')
        && (refused.targets?.length ?? 0) === 0,
      `${refused.code}: ${refused.error}`)
    checks.check('refused GTK4 leaves no usable indices', disabled.latestFor(env.display) === undefined, 'latest invalidated')
  } finally {
    await env.stop()
  }
}

async function runMixed() {
  checks.section('Mixed desktop: Qt6 + GTK3 + GTK4')
  const env = await TestDisplay.start({ width: 1440, height: 900 })
  const qt = env.launch([path.join(fixtureDir, 'panel_qt')])
  const gtk3 = env.launch([path.join(fixtureDir, 'panel_gtk3')])
  const gtk4 = env.launch([path.join(fixtureDir, 'panel_gtk4')])
  const automation = new Automation({ getConfig: () => env.config(), pluginDir })
  const expectedApps = { panel_qt: 'button', panel_gtk3: 'button', panel_gtk4: '点击 Click' }
  try {
    for (const [app, statusApp] of [[qt, 'panel_qt'], [gtk3, 'panel_gtk3'], [gtk4, 'panel_gtk4']]) {
      await env.waitForApp({ pid: app.pid, statusApp })
    }
    env.moveWindow(qt.pid, 20, 20)
    env.moveWindow(gtk3.pid, 520, 20)
    env.moveWindow(gtk4.pid, 20, 320)
    await sleep(500)

    const shot = await automation.screenshot()
    checks.check('all three toolkits are numbered together',
      shot.ok === true && shot.geometryTrusted === true
        && Object.keys(expectedApps).every(name => shot.targets.some(target => target.appName === name)),
      `${shot.targetCount} targets; apps=${[...new Set(shot.targets.map(target => target.appName))].join(', ')}`)

    const buttons = {}
    for (const [appName, name] of Object.entries(expectedApps)) {
      const target = shot.targets.find(candidate => candidate.appName === appName && (candidate.name || candidate.label) === name)
      buttons[appName] = target
    }
    checks.check('each toolkit has a clickable button target',
      Object.values(buttons).every(Boolean),
      Object.entries(buttons).map(([app, target]) => `${app}:#${target?.index}@(${target?.center})`).join(' '))
    checks.check('targets are not all collapsed onto the top-left corner',
      Object.values(buttons).every(target => target.center[0] + target.center[1] > 40)
        && new Set(Object.values(buttons).map(target => target.center.join(','))).size === 3,
      `centres: ${Object.values(buttons).map(target => `(${target.center})`).join(' ')}`)

    // click each app's button in turn, always resolving against the latest image
    let latest = shot
    for (const [appName, name] of Object.entries(expectedApps)) {
      const before = Object.fromEntries(Object.keys(expectedApps).map(app => [app, statusOf(env, app)]))
      const target = latest.targets.find(candidate => candidate.appName === appName && (candidate.name || candidate.label) === name)
      const result = await automation.click({ index: target.index, afterSeconds: 0.2 })
      latest = result
      const after = Object.fromEntries(Object.keys(expectedApps).map(app => [app, statusOf(env, app)]))
      const othersUnchanged = Object.keys(expectedApps)
        .filter(other => other !== appName)
        .every(other => after[other].clicks === before[other].clicks)
      checks.check(`click lands on ${appName} only`,
        result.ok === true && after[appName].clicks === before[appName].clicks + 1 && othersUnchanged,
        `#${target.index} @(${target.center}) → ${appName} clicks ${before[appName].clicks} → ${after[appName].clicks}; others=${Object.keys(expectedApps).filter(other => other !== appName).map(other => `${other}:${before[other].clicks}→${after[other].clicks}`).join(',')}`)
    }

    // fallback disabled on the same mixed screen: only GTK4 is refused
    const disabled = new Automation({
      getConfig: () => env.config({ gtk4OriginFallback: false }),
      pluginDir,
    })
    const withoutFallback = await disabled.screenshot()
    const gtk4Targets = (withoutFallback.targets || []).filter(target => target.appName === 'panel_gtk4')
    checks.check('fallback disabled drops only the GTK4 app',
      withoutFallback.ok === true && gtk4Targets.length === 0
        && warningCodes(withoutFallback).includes('E_GTK4_FALLBACK_DISABLED')
        && withoutFallback.geometryTrusted === false,
      `${withoutFallback.targetCount} remaining targets; warnings=${warningCodes(withoutFallback).join(', ')}`)
    const qTarget = withoutFallback.targets.find(target => target.appName === 'panel_qt'
      && (target.name || target.label) === 'button')
    const qBefore = statusOf(env, 'panel_qt')
    const qClick = qTarget === undefined ? { ok: false } : await disabled.click({ index: qTarget.index, afterSeconds: 0.2 })
    const qAfter = statusOf(env, 'panel_qt')
    checks.check('other toolkits stay clickable with the fallback disabled',
      qClick.ok === true && qAfter.clicks === qBefore.clicks + 1,
      `Qt clicks ${qBefore.clicks} → ${qAfter.clicks}`)
    report.mixed = {
      targets: shot.targetCount,
      apps: [...new Set(shot.targets.map(target => target.appName))],
      buttons: Object.fromEntries(Object.entries(buttons).map(([app, target]) => [app, target.center])),
    }
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
await runGtk4Fallback()
await runMixed()

const ok = checks.summary()
mkdirSync('test/out', { recursive: true })
writeFileSync('test/out/integration.json', `${JSON.stringify({ ok, rows: checks.rows, report }, null, 2)}\n`)
process.exit(ok ? 0 : 1)
