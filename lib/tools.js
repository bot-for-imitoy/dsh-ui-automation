/**
 * tools.js — model-facing ui_* tools.
 *
 * Kept separate from index.js so the integration tests exercise exactly the
 * same definitions the Host registers.
 *
 * @module dsh-ui-automation/tools
 */
import { defineTool } from './dsh-tools.js'

const APP_ID = {
  type: 'string',
  required: true,
  description: 'ui_launch 返回的 appId。',
}

const NAME = {
  type: 'string',
  description: '按无障碍名称定位节点（先 ui_tree 查看）。与 role/path 二选一即可。',
}
const ROLE = {
  type: 'string',
  description: '限定无障碍角色，例如 "push button"、"entry"、"check box"、"label"。',
}
const PATH = {
  type: 'string',
  description: '按 ui_tree 给出的 path（如 "0/1/2"）定位，比名称更精确。',
}
const INDEX = {
  type: 'number',
  description: '同名匹配里的第几个，从 0 开始，默认 0。',
}
const MATCH = {
  type: 'string',
  enum: ['exact', 'contains', 'regex'],
  description: 'name 的匹配方式，默认 exact。',
}
const X = {
  type: 'number',
  description: '屏幕坐标 X（像素）。坐标寻址时与 y 一起给出，且需要设置里允许坐标模式。',
}
const Y = {
  type: 'number',
  description: '屏幕坐标 Y（像素）。',
}
const STEPS = {
  type: 'number',
  description: '拖拽分几步移动，1–120，默认 12；步数越多越像真人滑动。',
}
const STEP_MS = {
  type: 'number',
  description: '每步之间的停顿毫秒数，1–200，默认 15。',
}

/**
 * Tool outputs must be lossless JSON: `undefined` object properties and
 * non-finite numbers are rejected by the Host's output validator. The engine
 * uses `undefined` for "not applicable", so normalise at the tool boundary.
 */
function jsonSafe(value) {
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text)
}

function envelopeLines(value, warnings) {
  const lines = []
  if (warnings !== undefined) lines.push(...warnings)
  return lines
}

function formatError(prefix, value) {
  const lines = [`✗ ${prefix}失败${value.code ? ` [${value.code}]` : ''}${value.appId ? ` appId=${value.appId}` : ''}`]
  if (value.error) lines.push(`  原因：${value.error}`)
  if (value.target) lines.push(`  目标：${describeTarget(value.target)}`)
  if (value.elapsedMs !== undefined) lines.push(`  耗时：${value.elapsedMs}ms`)
  return lines
}

function describeTarget(target) {
  if (!target) return '(无)'
  const label = target.name === '' || target.name === null || target.name === undefined
    ? (target.path ? `path=${target.path}` : '(未命名)')
    : JSON.stringify(target.name)
  const rect = target.rect ? ` @${target.rect.x},${target.rect.y} ${target.rect.width}x${target.rect.height}` : ''
  return `[${target.role}] ${label}${rect}`
}

function effectLine(effect) {
  if (!effect) return ''
  if (effect.changed !== true) return '回读：未观察到状态变化'
  return `回读：状态已变化（${effect.changedNodes} 个节点）`
}

function actionRender(prefix, value) {
  if (value.ok !== true) return [{ type: 'text', text: formatError(prefix, value).join('\n') }]
  const lines = [`✓ ${prefix}成功 appId=${value.appId} 通道=${value.channel} ${effectLine(value.effect)}`]
  if (value.target) lines.push(`  目标：${describeTarget(value.target)}`)
  if (value.actionResult && value.actionResult.action) {
    lines.push(`  AT-SPI action：${value.actionResult.action}（返回 ${value.actionResult.returned === true}，但返回 true 不等于生效）`)
  }
  if (Array.isArray(value.effect?.samples) && value.effect.samples.length > 0) {
    for (const sample of value.effect.samples.slice(0, 3)) {
      lines.push(`  变更：${sample.before} → ${sample.after}`)
    }
  }
  if (value.pacing) lines.push(`  限速：${value.pacing.intervalMs}ms（${value.pacing.toolkit}），本次等待 ${value.pacing.waitedMs}ms`)
  lines.push(`  耗时：${value.elapsedMs}ms`)
  lines.push(...envelopeLines(value, value.warnings))
  return [{ type: 'text', text: lines.join('\n') }]
}

export function createTools(engine) {
  const tools = []
  const lookup = (action, args) => {
    const instance = engine.instances.get(args.appId)
    if (instance === undefined) {
      return {
        missing: engine.fail(action, 'E_NO_INSTANCE', `未知实例 ${args.appId}；先调用 ui_launch，或用 ui_list 查看现有实例。`, { appId: args.appId }),
      }
    }
    return { instance }
  }

  tools.push(defineTool({
    name: 'ui_launch',
    description: '在全新的无头 Xvfb 沙盒里启动一个 GUI 应用（私有 D-Bus + 私有 XDG_RUNTIME_DIR + 独立 display），返回 appId 与窗口信息。每个实例互不可见，看不到用户真实桌面上的窗口。启动失败会附上壳/应用日志尾部。',
    parameters: {
      command: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '可执行文件与参数，例如 ["/opt/apps/app_qt"] 或 ["systemsettings"]。',
      },
      cwd: { type: 'string', description: '应用的工作目录，默认插件目录。' },
      display: { type: 'number', description: '指定 X display 号；默认从设置里的显示号范围自动分配空闲号码。' },
      width: { type: 'number', description: '虚拟屏幕宽度，320–4096，默认取设置值（1024）。' },
      height: { type: 'number', description: '虚拟屏幕高度，240–4096，默认取设置值（768）。' },
      appName: { type: 'string', description: '可选的应用名提示，当 AT-SPI 里的进程 ID 不匹配时用于兜底查找。' },
      runRoot: { type: 'string', description: '运行时目录的父目录，默认系统临时目录。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) {
          const lines = formatError('启动', value)
          if (value.logs?.app) lines.push(`  应用日志：\n${indent(value.logs.app)}`)
          if (value.logs?.wrapper) lines.push(`  壳日志：\n${indent(value.logs.wrapper)}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [
          `✓ 已启动 ${value.appId} @ ${value.display}（屏幕 ${value.screen.width}x${value.screen.height}）`,
          `  应用：${value.app.name}（${value.app.toolkit}${value.app.version ? ` ${value.app.version}` : ''}，pid ${value.app.pid}）`,
        ]
        if (value.window) {
          lines.push(`  窗口：${JSON.stringify(value.window.title ?? '')} ${value.window.width}x${value.window.height} @${value.window.x},${value.window.y}`)
        } else {
          lines.push('  窗口：未找到 X11 窗口（AT-SPI 已可见）')
        }
        lines.push(`  启动耗时：${value.startupMs}ms；限速：${value.pacing.intervalMs}ms（${value.pacing.toolkit}）`)
        lines.push(`  运行时目录：${value.shell.runDir}`)
        lines.push(`  ${value.hint}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 200_000,
    async execute(args) {
      return jsonSafe(await engine.launch(args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_click',
    description: '点击一个控件。可用无障碍语义（name/role/path）或屏幕坐标（x/y）寻址。动作后回读应用状态，ok=true 但 effect.changed=false 表示没有观察到变化（AT-SPI 返回成功也可能被工具包丢弃）。Qt/GTK4 会自动按工具包限速。',
    parameters: {
      appId: APP_ID,
      name: NAME,
      role: ROLE,
      path: PATH,
      index: INDEX,
      match: MATCH,
      x: X,
      y: Y,
      button: { type: 'number', description: '鼠标键 1/2/3，默认 1（左键）；坐标模式使用。' },
      action: { type: 'string', description: '强制使用某个 AT-SPI action 名称，默认按 press/click/activate/toggle 顺序选择。' },
      via: { type: 'string', enum: ['auto', 'atspi', 'coordinate'], description: '通道选择：auto 优先 AT-SPI、无 Action 时回退坐标；atspi 强制语义；coordinate 强制坐标。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => actionRender('点击', value),
    },
    timeoutMs: 90_000,
    async execute(args) {
      const found = lookup('click', args)
      if (found.missing !== undefined) return jsonSafe(found.missing)
      return jsonSafe(await engine.click(found.instance, args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_double_click',
    description: '双击。AT-SPI 没有双击动作，因此始终通过 XTEST 发送两次点击，默认间隔 120ms（限制在 40–390ms）。动作后回读应用状态，并留出约 600ms 的多击静默窗口，避免下一次点击被 GTK/Qt 当成三击。',
    parameters: {
      appId: APP_ID,
      name: NAME,
      role: ROLE,
      path: PATH,
      index: INDEX,
      match: MATCH,
      x: X,
      y: Y,
      intervalMs: { type: 'number', description: '两次点击的间隔，40–390ms，默认 120。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => actionRender('双击', value),
    },
    timeoutMs: 90_000,
    async execute(args) {
      const found = lookup('double_click', args)
      if (found.missing !== undefined) return jsonSafe(found.missing)
      return jsonSafe(await engine.doubleClick(found.instance, args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_drag',
    description: '从起点拖拽/滑动到终点：按下 → 分步 MOVE → 松开，默认 12 步、每步 15ms。起点终点可用语义目标（fromName/toName）或坐标；结束时校验指针确实到达终点，并回读应用状态。',
    parameters: {
      appId: APP_ID,
      fromName: { type: 'string', description: '起点节点名称；与 fromX/fromY 二选一。' },
      fromRole: { type: 'string', description: '起点节点角色。' },
      fromPath: { type: 'string', description: '起点节点 path。' },
      fromX: { type: 'number', description: '起点屏幕坐标 X。' },
      fromY: { type: 'number', description: '起点屏幕坐标 Y。' },
      toName: { type: 'string', description: '终点节点名称（用其中心点）；与 toX/toY 二选一。' },
      toRole: { type: 'string', description: '终点节点角色。' },
      toPath: { type: 'string', description: '终点节点 path。' },
      toX: { type: 'number', description: '终点屏幕坐标 X。' },
      toY: { type: 'number', description: '终点屏幕坐标 Y。' },
      steps: STEPS,
      stepMs: STEP_MS,
      durationMs: { type: 'number', description: '总时长（毫秒）；给出时按 steps 均分覆盖 stepMs。' },
      button: { type: 'number', description: '鼠标键，默认 1（左键）。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => actionRender('拖拽', value),
    },
    timeoutMs: 90_000,
    async execute(args) {
      const found = lookup('drag', args)
      if (found.missing !== undefined) return jsonSafe(found.missing)
      return jsonSafe(await engine.drag(found.instance, args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_scroll',
    description: '在指定目标或坐标处滚动滚轮：每次 ±120（X11 按钮 4/5 为上下，6/7 为左右）。动作后回读应用状态。',
    parameters: {
      appId: APP_ID,
      name: NAME,
      role: ROLE,
      path: PATH,
      index: INDEX,
      x: X,
      y: Y,
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: '滚动方向，默认 down。',
      },
      amount: { type: 'number', description: '滚动几格（每格 ±120），1–50，默认 1。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => actionRender('滚动', value),
    },
    timeoutMs: 90_000,
    async execute(args) {
      const found = lookup('scroll', args)
      if (found.missing !== undefined) return jsonSafe(found.missing)
      return jsonSafe(await engine.scroll(found.instance, args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_type',
    description: '输入文本或按键组合。文本优先走 AT-SPI EditableText（中文最可靠），不可用时自动回退到 XTEST 键盘；按键组合（如 ctrl+a、Return、Tab）始终走 XTEST。会自动获取键盘焦点（窗口焦点 + 控件焦点，必要时点击一次），输入后回读文本校验；没有焦点或回读不一致会明确报错。',
    parameters: {
      appId: APP_ID,
      name: NAME,
      role: ROLE,
      path: PATH,
      index: INDEX,
      match: MATCH,
      x: { type: 'number', description: '可选：需要点击聚焦时的屏幕坐标 X（GTK4 等 extents 不可信时用）。' },
      y: { type: 'number', description: '可选：需要点击聚焦时的屏幕坐标 Y。' },
      text: { type: 'string', description: '要输入的字符串（支持中文）；与 keys 二选一。' },
      keys: { type: 'string', description: '按键组合，xdotool 语法，例如 "ctrl+a"、"Return"、"Tab"、"shift+End"。' },
      mode: { type: 'string', enum: ['auto', 'atspi', 'keys'], description: 'auto 优先 EditableText 再回退键盘；atspi 只用 EditableText；keys 强制键盘（走 XTEST）。' },
      clearFirst: { type: 'boolean', description: '键盘输入前先 Ctrl+A 全选，默认 true，使输入结果等于 text。' },
      delayMs: { type: 'number', description: '键盘逐字符间隔，0–200ms，默认 12。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) {
          const lines = formatError('输入', value)
          if (value.readback?.actual !== undefined) lines.push(`  回读：${JSON.stringify(value.readback.actual)}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [`✓ 输入成功 appId=${value.appId} 通道=${value.channel}`]
        if (value.target) lines.push(`  目标：${describeTarget(value.target)}`)
        if (value.keys) lines.push(`  按键：${value.keys}`)
        if (value.readback?.expected !== undefined) {
          lines.push(`  回读：${JSON.stringify(value.readback.actual)}（${value.readback.verified === true ? '已校验' : '未校验'}）`)
        } else if (value.readback?.note) {
          lines.push(`  回读：${value.readback.note}`)
        }
        if (value.focus?.steps?.length) {
          lines.push(`  焦点处理：${value.focus.steps.map(step => step.step).join(' → ')}`)
        }
        lines.push(`  耗时：${value.elapsedMs}ms`)
        if (Array.isArray(value.effect?.samples) && value.effect.samples.length > 0) {
          lines.push(`  变更：${value.effect.samples[0].before} → ${value.effect.samples[0].after}`)
        }
        lines.push(...envelopeLines(value, value.warnings))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const found = lookup('type', args)
      if (found.missing !== undefined) return jsonSafe(found.missing)
      return jsonSafe(await engine.type(found.instance, args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_tree',
    description: '枚举应用的无障碍树（角色、名称、文本、状态、动作、屏幕坐标），用于在点击/输入前定位目标。输出受 maxDepth/maxNodes 限制并标记截断。',
    parameters: {
      appId: APP_ID,
      maxDepth: { type: 'number', description: '最大深度，1–32，默认 10。' },
      maxNodes: { type: 'number', description: '最多返回多少节点，1–2000，默认 400。' },
      includeText: { type: 'boolean', description: '是否包含文本内容，默认 true。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: formatError('枚举', value).join('\n') }]
        const lines = [`无障碍树 ${value.appId}：${value.app.name}（${value.app.toolkit}），${value.nodes.length} 个节点${value.truncated ? '（已截断）' : ''}`]
        for (const node of value.nodes.slice(0, 160)) {
          const lines2 = [`${'  '.repeat(Math.min(node.depth, 12))}[${node.role}] ${JSON.stringify(node.name ?? '')}`]
          if (node.text && node.text !== node.name) lines2.push(` text=${JSON.stringify(node.text.length > 40 ? `${node.text.slice(0, 40)}…` : node.text)}`)
          if (node.value !== null && node.value !== undefined) lines2.push(` value=${node.value}`)
          if (node.states?.length) lines2.push(` states=${node.states.filter(s => ['checked', 'selected', 'focused', 'expanded'].includes(s)).join(',')}`)
          if (node.actions?.length) lines2.push(` actions=[${node.actions.join(',')}]`)
          lines.push(lines2.filter(Boolean).join(''))
        }
        if (value.nodes.length > 160) lines.push(`… 其余 ${value.nodes.length - 160} 个节点省略，用 maxNodes 或更小的 maxDepth 缩小范围。`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const found = lookup('tree', args)
      if (found.missing !== undefined) return jsonSafe(found.missing)
      return jsonSafe(await engine.tree(found.instance, args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_screenshot',
    description: '截取整个虚拟屏幕（XGetImage/ffmpeg x11grab）为 PNG，用于视觉兜底。返回文件路径与字节数。',
    parameters: {
      appId: APP_ID,
      path: { type: 'string', description: '文件名或相对设置中截图目录的路径；省略时自动按时间戳命名。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: formatError('截图', value).join('\n') }]
        return [{ type: 'text', text: `✓ 截图已保存：${value.path}（${value.width}x${value.height}，${value.bytes} 字节，${value.elapsedMs}ms）` }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const found = lookup('screenshot', args)
      if (found.missing !== undefined) return jsonSafe(found.missing)
      return jsonSafe(await engine.screenshot(found.instance, args))
    },
  }))

  tools.push(defineTool({
    name: 'ui_close',
    description: '关闭托管实例：先让驱动退出，再终止整个进程组（应用、Xvfb、私有总线）；默认删除运行时目录。',
    parameters: {
      appId: APP_ID,
      keepLogs: { type: 'boolean', description: '保留运行时目录与日志以便排查，默认 false。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: formatError('关闭', value).join('\n') }]
        const lines = [`✓ 已关闭 ${value.appId}${value.forced ? '（需要 SIGKILL 强制结束）' : ''}，耗时 ${value.elapsedMs}ms`]
        if (value.logDir) lines.push(`  日志保留在：${value.logDir}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 30_000,
    async execute(args) {
      return jsonSafe(await engine.close(args.appId, { keepLogs: args.keepLogs === true }))
    },
  }))

  tools.push(defineTool({
    name: 'ui_list',
    description: '列出当前托管的所有 UI 实例（display、应用、工具包、窗口、存活状态、日志目录）。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: formatError('列出实例', value).join('\n') }]
        if (value.instances.length === 0) return [{ type: 'text', text: '没有托管的 UI 实例。用 ui_launch 启动一个。' }]
        const lines = [`托管实例 ${value.instances.length} 个：`]
        for (const instance of value.instances) {
          const window = instance.window ? `窗口 ${JSON.stringify(instance.window.title ?? '')} ${instance.window.width}x${instance.window.height}` : '无窗口'
          lines.push(`  ${instance.appId} @ ${instance.display} ${instance.appName ?? ''}（${instance.toolkit}）${instance.alive ? '运行中' : `已退出${instance.lastExit ? ` code=${instance.lastExit.code}` : ''}`}；${window}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute() {
      return jsonSafe({ ok: true, instances: engine.list() })
    },
  }))

  return tools
}

function indent(text) {
  return String(text).split('\n').map(line => `    ${line}`).join('\n')
}
