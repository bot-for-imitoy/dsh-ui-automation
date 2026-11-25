/**
 * smoke.mjs — quick single-fixture sanity run for the numbered-image plugin.
 *
 *   node test/smoke.mjs [qt|gtk3|gtk4]
 */
import path from 'node:path'
import { Automation } from '../lib/automation.js'
import { fixtureDir, pluginDir, TestDisplay } from './lib/env.mjs'

const kind = process.argv[2] || 'qt'
const command = {
  qt: path.join(fixtureDir, 'panel_qt'),
  gtk3: path.join(fixtureDir, 'panel_gtk3'),
  gtk4: path.join(fixtureDir, 'panel_gtk4'),
}[kind]

const env = await TestDisplay.start()
const app = env.launch([command])
try {
  await env.waitForApp({ pid: app.pid })
  const automation = new Automation({
    getConfig: () => env.config(),
    pluginDir,
    log: (level, message) => { if (process.env.UI_DEBUG === '1') console.log(`[${level}] ${message}`) },
  })

  const shot = await automation.screenshot()
  console.log('screenshot:', JSON.stringify({
    ok: shot.ok,
    code: shot.code,
    imagePath: shot.imagePath,
    size: shot.image,
    crop: shot.crop,
    targetCount: shot.targetCount,
    error: shot.error,
  }, null, 1))
  if (shot.ok !== true) process.exit(1)

  for (const target of shot.targets) {
    console.log(`  #${target.index} [${target.role}] ${JSON.stringify(target.name)} rect=${JSON.stringify(target.rect)}`)
  }

  const byName = Object.fromEntries(shot.targets.map(target => [target.name || target.label, target.index]))
  console.log('status before:', env.status(kind === 'qt' ? 'panel_qt' : `panel_${kind}`).status)

  const click = await automation.click({ index: byName.button, afterSeconds: 0.2 })
  console.log('click:', click.ok, click.code, click.channel, click.imagePath)
  console.log('status after:', env.status(kind === 'qt' ? 'panel_qt' : `panel_${kind}`).status)

  if (kind !== 'gtk4') {
    const typed = await automation.type({ index: byName.input, text: '你好 numbered image', afterSeconds: 0.2 })
    console.log('type:', typed.ok, typed.code, typed.channel, JSON.stringify(typed.readback))
  }
  console.log('final image:', (await automation.screenshot()).imagePath)
} finally {
  await env.stop()
}
