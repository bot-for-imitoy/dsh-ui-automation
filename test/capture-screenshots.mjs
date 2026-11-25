/**
 * capture-screenshots.mjs — regenerate the curated screenshots in screenshots/.
 *
 *   node test/capture-screenshots.mjs            # fixtures + WorkBuddy if installed
 *   node test/capture-screenshots.mjs qt gtk3    # selected targets
 *
 * The fixtures are driven through the plugin's own numbered-image engine; the
 * WorkBuddy capture (a real Electron app) is optional and skipped when the
 * application is not installed.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Automation } from '../lib/automation.js'
import { fixtureDir, pluginDir, TestDisplay } from './lib/env.mjs'
import { indexOf } from './lib/checks.mjs'

const outDir = path.join(pluginDir, 'screenshots')
mkdirSync(outDir, { recursive: true })
const targets = new Set(process.argv.slice(2))
const wanted = name => targets.size === 0 || targets.has(name)

async function fixtureShot({ key, command, appName, out, scenario }) {
  const env = await TestDisplay.start()
  const app = env.launch([command])
  const automation = new Automation({
    getConfig: () => env.config({ screenshotDir: 'test/out/capture', afterSeconds: 0.3 }),
    pluginDir,
  })
  try {
    await env.waitForApp({ pid: app.pid, statusApp: appName })
    let shot = await automation.screenshot()
    if (shot.ok !== true) throw new Error(`screenshot failed: ${shot.code} ${shot.error}`)
    if (scenario) shot = await scenario(automation, shot)
    const destination = path.join(outDir, out)
    copyFileSync(shot.imagePath, destination)
    console.log(`wrote ${destination} (${shot.image.width}×${shot.image.height}, ${shot.targetCount} targets)`)
    return { path: destination, width: shot.image.width, height: shot.image.height, targets: shot.targetCount }
  } finally {
    await env.stop()
  }
}

async function qtShot() {
  return fixtureShot({
    key: 'qt',
    command: path.join(fixtureDir, 'panel_qt'),
    appName: 'panel_qt',
    out: 'qt6-panel.png',
    scenario: async (automation, shot) => {
      const at = name => indexOf(shot.targets, name)
      shot = await automation.click({ index: at('button'), afterSeconds: 0.2 })
      shot = await automation.doubleClick({ index: indexOf(shot.targets, 'dblarea'), afterSeconds: 0.2 })
      shot = await automation.drag({
        fromIndex: indexOf(shot.targets, 'dragarea'),
        toIndex: indexOf(shot.targets, 'wheelarea'),
        steps: 10,
        afterSeconds: 0.2,
      })
      shot = await automation.scroll({ index: indexOf(shot.targets, 'wheelarea'), direction: 'down', amount: 2, afterSeconds: 0.2 })
      shot = await automation.type({ index: indexOf(shot.targets, 'input'), text: '中文键盘输入', afterSeconds: 0.2 })
      return shot
    },
  })
}

async function gtk3Shot() {
  return fixtureShot({
    key: 'gtk3',
    command: path.join(fixtureDir, 'panel_gtk3'),
    appName: 'panel_gtk3',
    out: 'gtk3-panel.png',
    scenario: async (automation, shot) => {
      shot = await automation.click({ index: indexOf(shot.targets, 'button'), afterSeconds: 0.2 })
      shot = await automation.doubleClick({ index: indexOf(shot.targets, 'dblarea'), afterSeconds: 0.2 })
      shot = await automation.drag({
        fromIndex: indexOf(shot.targets, 'dragarea'),
        toIndex: indexOf(shot.targets, 'wheelarea'),
        steps: 10,
        afterSeconds: 0.2,
      })
      shot = await automation.scroll({ index: indexOf(shot.targets, 'wheelarea'), direction: 'down', amount: 2, afterSeconds: 0.2 })
      shot = await automation.type({ index: indexOf(shot.targets, 'input'), text: '中文键盘输入', afterSeconds: 0.2 })
      return shot
    },
  })
}

async function gtk4Shots() {
  const env = await TestDisplay.start()
  const app = env.launch([path.join(fixtureDir, 'panel_gtk4')])
  const automation = new Automation({
    getConfig: () => env.config({ screenshotDir: 'test/out/capture', afterSeconds: 0.2 }),
    pluginDir,
  })
  try {
    await env.waitForApp({ pid: app.pid, statusApp: 'panel_gtk4' })
    const button = (await automation.screenshot()).targets.find(target => target.name === '点击 Click')
    let shot = await automation.click({ index: button.index, afterSeconds: 0.2 })
    if (shot.ok !== true) throw new Error(`GTK4 numbered capture failed: ${shot.code} ${shot.error}`)
    const numbered = path.join(outDir, 'gtk4-numbered.png')
    copyFileSync(shot.imagePath, numbered)
    console.log(`wrote ${numbered} (${shot.image.width}×${shot.image.height}, ${shot.targetCount} targets)`)

    // Fallback disabled: the app is refused and the unnumbered evidence frame
    // is kept, which is exactly what the guard should look like.
    const disabled = new Automation({
      getConfig: () => env.config({ screenshotDir: 'test/out/capture', gtk4OriginFallback: false }),
      pluginDir,
    })
    const refused = await disabled.screenshot()
    if (refused.imagePath === undefined || !existsSync(refused.imagePath)) {
      throw new Error(`GTK4 refusal evidence missing: ${refused.code} ${refused.error}`)
    }
    const evidence = path.join(outDir, 'gtk4-no-geometry.png')
    copyFileSync(refused.imagePath, evidence)
    console.log(`wrote ${evidence} (${refused.code})`)
    return { numbered, evidence, targets: shot.targetCount }
  } finally {
    await env.stop()
  }
}

async function workbuddyShot() {
  const binary = '/opt/WorkBuddy/workbuddy'
  if (!existsSync(binary)) {
    console.log('skip WorkBuddy: /opt/WorkBuddy/workbuddy not installed')
    return undefined
  }
  const env = await TestDisplay.start({ width: 1440, height: 900 })
  const app = env.launch([binary, '--no-sandbox', '--disable-gpu', '--force-renderer-accessibility'], {
    cwd: os.homedir(),
  })
  const automation = new Automation({
    getConfig: () => env.config({
      screenshotDir: 'test/out/capture',
      maxDepth: 32,
      maxTargets: 80,
      afterSeconds: 0,
    }),
    pluginDir,
  })
  try {
    await env.waitForApp({ name: 'workbuddy', timeoutMs: 60_000 })
    await new Promise(resolve => setTimeout(resolve, 6000))
    const shot = await automation.screenshot()
    if (shot.ok !== true) throw new Error(`screenshot failed: ${shot.code} ${shot.error}`)
    const destination = path.join(outDir, 'workbuddy-numbered.png')
    copyFileSync(shot.imagePath, destination)
    console.log(`wrote ${destination} (${shot.image.width}×${shot.image.height}, ${shot.targetCount} targets)`)
    return { path: destination, width: shot.image.width, height: shot.image.height, targets: shot.targetCount }
  } catch (error) {
    console.log(`skip WorkBuddy capture: ${error.message}`)
    return undefined
  } finally {
    await env.stop()
  }
}

const summary = {}
if (wanted('qt')) summary.qt = await qtShot()
if (wanted('gtk3')) summary.gtk3 = await gtk3Shot()
if (wanted('gtk4')) summary.gtk4 = await gtk4Shots()
if (wanted('workbuddy')) summary.workbuddy = await workbuddyShot()

console.log(JSON.stringify(summary, null, 2))
