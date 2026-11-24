/**
 * smoke.mjs — fast single-app sanity run used while developing.
 *
 *   node test/smoke.mjs [panel_qt|panel_gtk3|app_qt|app_gtk3|app_gtk4]
 */
import { apps, createEngine, parseStatus, statusOf } from './lib/harness.mjs'

const key = process.argv[2] || 'panel_qt'
const def = Object.values(apps).find(app => app.key === key) || apps.panelQt
const engine = createEngine()

function show(label, value) {
  console.log(`\n### ${label}`)
  console.log(JSON.stringify(value, null, 2).slice(0, 2500))
}

const launched = await engine.launch({ command: def.command })
show('launch', launched)
if (launched.ok !== true) process.exit(1)
const instance = engine.instances.get(launched.appId)

const tree = await engine.tree(instance, { maxDepth: 12 })
console.log('\n### tree')
for (const node of tree.nodes.slice(0, 40)) {
  console.log(`${'  '.repeat(node.depth)}[${node.role}] ${JSON.stringify(node.name)}${node.actions?.length ? ` actions=${JSON.stringify(node.actions)}` : ''}${node.rect ? ` @${node.rect.x},${node.rect.y} ${node.rect.width}x${node.rect.height}` : ''}`)
}
console.log('\nstatus:', (await statusOf(engine, instance)))

show('click button', await engine.click(instance, { name: def.buttonName }))
console.log('status:', (await statusOf(engine, instance)))

if (def.hasDragScroll) {
  show('double click', await engine.doubleClick(instance, { name: 'dblarea' }))
  const dragRect = await engine.resolveTarget(instance, { name: 'dragarea' })
  show('drag', await engine.drag(instance, {
    fromX: dragRect.rect.x + 20, fromY: dragRect.rect.y + dragRect.rect.height / 2,
    toX: dragRect.rect.x + dragRect.rect.width - 20, toY: dragRect.rect.y + dragRect.rect.height / 2,
  }))
  show('scroll', await engine.scroll(instance, { name: 'wheelarea', direction: 'down', amount: 2 }))
}

show('type ascii', await engine.type(instance, { name: def.inputName, text: 'hello' }))
show('type cjk', await engine.type(instance, { name: def.inputName, text: '你好世界' }))
show('type cjk keys', await engine.type(instance, { name: def.inputName, text: '中文键', mode: 'keys' }))
console.log('status:', (await statusOf(engine, instance)), parseStatus(await statusOf(engine, instance)))

show('screenshot', await engine.screenshot(instance, {}))
show('close', await engine.close(instance.appId))
