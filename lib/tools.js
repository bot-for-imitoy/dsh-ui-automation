/**
 * tools.js — the numbered-image tool surface.
 *
 * Six tools only: one screenshot and five actions. Every action takes an index
 * from the most recent numbered image and returns the next numbered image.
 * There is no name/role/path addressing and no coordinate addressing.
 *
 * @module dsh-ui-automation/tools
 */
import { defineTool } from './dsh-tools.js'

const INDEX = {
  type: 'number',
  required: true,
  description: 'Element index printed on the most recent numbered screenshot (starts at 1). Old indices expire as soon as a new screenshot is returned.',
}

const AFTER_SECONDS = {
  type: 'number',
  description: 'Seconds to wait before the automatic re-screenshot, 0–30. Defaults to the plugin setting (1.0).',
}

function jsonSafe(value) {
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text)
}

function describeTarget(target) {
  if (target === undefined || target === null) return ''
  const name = target.name === '' || target.name === undefined || target.name === null
    ? (target.label || '(unnamed)')
    : target.name
  const rect = Array.isArray(target.rect) ? ` @(${target.rect.join(',')})` : ''
  return `#${target.index} [${target.role}] ${JSON.stringify(name)}${rect}`
}

function targetLines(targets, limit = 40) {
  const lines = []
  for (const target of targets.slice(0, limit)) {
    const name = target.name === '' || target.name === undefined || target.name === null
      ? (target.label || '(unnamed)')
      : target.name
    lines.push(`  #${String(target.index).padStart(2)} [${target.role}] ${JSON.stringify(name)} @(${target.rect.join(',')})`)
  }
  if (targets.length > limit) lines.push(`  … ${targets.length - limit} more (raise maxTargets in settings)`)
  return lines
}

function imageSummary(value) {
  return `${value.imagePath}（${value.image?.width ?? value.crop?.width}×${value.image?.height ?? value.crop?.height}）`
}

function renderImage(blocks, value) {
  if (value.attachment !== undefined && value.attachment !== null) {
    // Image first so image-capable UIs show the frame before the index list.
    blocks.unshift({ type: 'image', attachment: value.attachment })
  }
  return blocks
}

function errorRender(value) {
  const lines = [`✗ ${value.action ?? 'ui'} failed${value.code ? ` [${value.code}]` : ''}`]
  if (value.error) lines.push(`  ${value.error}`)
  if (value.imageId) lines.push(`  image: ${value.imageId}`)
  if (value.imagePath) lines.push(`  crop: ${value.imagePath}`)
  if (value.available !== undefined) lines.push(`  available indices: 1..${value.available}`)
  lines.push('  Call ui_screenshot to get a fresh numbered image before addressing anything.')
  return [{ type: 'text', text: lines.join('\n') }]
}

export function createTools(automation) {
  const tools = []

  tools.push(defineTool({
    name: 'ui_screenshot',
    description: 'Capture the configured Linux display, enumerate AT-SPI elements, draw yellow numbered badges and thin outlines onto a cropped PNG, and return the image path plus an index list (index → name/role/rect). Indices are only valid for this image. This is the only way to obtain indices; call it again after any change you did not make through this tool.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return errorRender(value)
        const lines = [
          `✓ numbered screenshot ${value.imageId}`,
          `  image: ${imageSummary(value)}`,
          `  display: ${value.display}  screen: ${value.screen.width}×${value.screen.height}  crop: (${value.crop.x},${value.crop.y},${value.crop.width},${value.crop.height})`,
          `  ${value.targetCount} targets (${value.stats?.totalNodes ?? '?'} AT-SPI nodes scanned)`,
          ...targetLines(value.targets),
          '',
          'Indices expire with this image: the next capture gets new ones.',
          'If you need to look at the image, use read_image with the path above.',
        ]
        return renderImage([{ type: 'text', text: lines.join('\n') }], value)
      },
    },
    timeoutMs: 60_000,
    async execute() {
      return jsonSafe(await automation.screenshot())
    },
  }))

  tools.push(defineTool({
    name: 'ui_click',
    description: 'Click the centre of the numbered element with XTEST, wait afterSeconds, then capture a fresh numbered image. Returns the new image path and index list; the previous indices are no longer valid.',
    parameters: {
      index: INDEX,
      button: { type: 'number', description: 'Mouse button 1/2/3. Default 1 (left).' },
      afterSeconds: AFTER_SECONDS,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return errorRender(value)
        const lines = [
          `✓ clicked ${describeTarget(value.target)}`,
          `  point: (${value.point?.x},${value.point?.y})  action: ${value.actionMs}ms  waited: ${value.afterSeconds}s  total: ${value.totalMs}ms`,
          `  next image: ${imageSummary(value)}`,
          '',
          ...targetLines(value.targets),
        ]
        return renderImage([{ type: 'text', text: lines.join('\n') }], value)
      },
    },
    timeoutMs: 90_000,
    async execute(args) {
      return jsonSafe(await automation.click(args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_double_click',
    description: 'Double-click the centre of the numbered element (XTEST, two clicks with an explicit gap), wait afterSeconds, then capture a fresh numbered image. Previous indices become invalid.',
    parameters: {
      index: INDEX,
      intervalMs: { type: 'number', description: 'Gap between the two clicks, 40–390ms. Default 120.' },
      afterSeconds: AFTER_SECONDS,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return errorRender(value)
        const lines = [
          `✓ double-clicked ${describeTarget(value.target)} (gap ${value.intervalMs}ms)`,
          `  point: (${value.point?.x},${value.point?.y})  action: ${value.actionMs}ms  waited: ${value.afterSeconds}s  total: ${value.totalMs}ms`,
          `  next image: ${imageSummary(value)}`,
          '',
          ...targetLines(value.targets),
        ]
        return renderImage([{ type: 'text', text: lines.join('\n') }], value)
      },
    },
    timeoutMs: 90_000,
    async execute(args) {
      return jsonSafe(await automation.doubleClick(args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_scroll',
    description: 'Scroll the wheel at the centre of the numbered element (±120 per step), wait afterSeconds, then capture a fresh numbered image. Previous indices become invalid.',
    parameters: {
      index: INDEX,
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], required: true, description: 'Wheel direction.' },
      amount: { type: 'number', description: 'Wheel steps, 1–50, each ±120. Default 1.' },
      afterSeconds: AFTER_SECONDS,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return errorRender(value)
        const lines = [
          `✓ scrolled ${value.direction} ×${value.amount} at ${describeTarget(value.target)}`,
          `  point: (${value.point?.x},${value.point?.y})  action: ${value.actionMs}ms  waited: ${value.afterSeconds}s  total: ${value.totalMs}ms`,
          `  next image: ${imageSummary(value)}`,
          '',
          ...targetLines(value.targets),
        ]
        return renderImage([{ type: 'text', text: lines.join('\n') }], value)
      },
    },
    timeoutMs: 90_000,
    async execute(args) {
      return jsonSafe(await automation.scroll(args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_drag',
    description: 'Drag from the centre of fromIndex to the centre of toIndex (press, move in steps, release), wait afterSeconds, then capture a fresh numbered image. Both indices must come from the same most recent image.',
    parameters: {
      fromIndex: { ...INDEX, description: 'Start element index from the most recent numbered screenshot.' },
      toIndex: { ...INDEX, description: 'End element index from the same screenshot.' },
      steps: { type: 'number', description: 'Intermediate pointer moves, 1–120. Default 12.' },
      afterSeconds: AFTER_SECONDS,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return errorRender(value)
        const lines = [
          `✓ dragged ${describeTarget(value.fromTarget)} → ${describeTarget(value.toTarget)} (${value.steps} steps)`,
          `  point: (${value.point?.x},${value.point?.y})  action: ${value.actionMs}ms  waited: ${value.afterSeconds}s  total: ${value.totalMs}ms`,
          `  next image: ${imageSummary(value)}`,
          '',
          ...targetLines(value.targets),
        ]
        return renderImage([{ type: 'text', text: lines.join('\n') }], value)
      },
    },
    timeoutMs: 90_000,
    async execute(args) {
      return jsonSafe(await automation.drag(args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_type',
    description: 'Type text (CJK included; AT-SPI SetTextContents first, XTEST keyboard fallback with readback) or a key chord (ctrl+a, Return, Tab). With index, target that element (click its centre to focus on the XTEST path). Then wait afterSeconds and capture a fresh numbered image; previous indices become invalid.',
    parameters: {
      text: { type: 'string', description: 'Literal text to type. Mutually exclusive with keys.' },
      keys: { type: 'string', description: 'Key chord in xdotool syntax, e.g. "ctrl+a", "Return". Mutually exclusive with text.' },
      index: { type: 'number', description: 'Optional element to click first (focus). Must belong to the most recent numbered image.' },
      afterSeconds: AFTER_SECONDS,
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return errorRender(value)
        const lines = [`✓ typed via ${value.channel}`]
        if (value.target !== undefined) lines.push(`  target: ${describeTarget(value.target)}`)
        if (value.keys !== undefined) lines.push(`  keys: ${value.keys}`)
        if (value.readback !== undefined) {
          if (value.readback.expected !== undefined) {
            lines.push(`  readback: ${JSON.stringify(value.readback.actual)} (${value.readback.verified === true ? 'verified' : 'unverified'})`)
          } else if (value.readback.note) {
            lines.push(`  readback: ${value.readback.note}`)
          }
        }
        if (value.focusMs) lines.push(`  focus click: ${value.focusMs}ms`)
        lines.push(`  action: ${value.actionMs}ms  waited: ${value.afterSeconds}s  total: ${value.totalMs}ms`)
        lines.push(`  next image: ${imageSummary(value)}`)
        lines.push('', ...targetLines(value.targets))
        return renderImage([{ type: 'text', text: lines.join('\n') }], value)
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      return jsonSafe(await automation.type(args))
    },
  }))

  return tools
}
