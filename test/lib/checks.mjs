/**
 * checks.mjs — assertions and fixture-state parsing for the numbered-image tests.
 */

export class Checks {
  constructor(title) {
    this.title = title
    this.rows = []
  }

  check(name, ok, detail = '', ms) {
    this.rows.push({ name, ok: Boolean(ok), detail, ms })
    const mark = ok ? 'PASS' : 'FAIL'
    const time = ms === undefined ? '' : ` (${Math.round(ms)} ms)`
    console.log(`  [${mark}] ${name}${time}${detail ? ` — ${detail}` : ''}`)
    return ok
  }

  section(name) {
    console.log(`== ${name} ==`)
  }

  summary() {
    const failed = this.rows.filter(row => !row.ok)
    console.log(`\n${this.title}: ${this.rows.length - failed.length}/${this.rows.length} passed`)
    for (const row of failed) console.log(`  FAILED: ${row.name} — ${row.detail}`)
    return failed.length === 0
  }
}

/** Parse the fixture's status label. */
export function parseStatus(line) {
  const number = key => {
    const match = new RegExp(`${key}=(-?\\d+)`).exec(line)
    return match === null ? null : Number(match[1])
  }
  const text = /text='([^']*)'/.exec(line)
  return {
    raw: line,
    clicks: number('clicks'),
    dclicks: number('dclicks'),
    drags: number('drags'),
    dragdist: number('dragdist'),
    wheel: number('wheel'),
    wheelTicks: number('wheelTicks'),
    checked: /checked=(true|false)/.exec(line)?.[1] === 'true',
    text: text === null ? undefined : text[1],
  }
}

export function statusOf(env, appName) {
  const result = env.status(appName)
  if (result.ok !== true) throw new Error(`status failed: ${result.error}`)
  return parseStatus(result.status)
}

/** name/label -> index map from one numbered screenshot. */
export function indexMap(targets) {
  const map = new Map()
  for (const target of targets) {
    const key = target.name || target.label
    if (key) map.set(key, target.index)
  }
  return map
}

/** Require one named target and return its index. */
export function indexOf(targets, name) {
  const map = indexMap(targets)
  const index = map.get(name)
  if (index === undefined) {
    throw new Error(`target ${JSON.stringify(name)} is not in the numbered image (have: ${[...map.keys()].join(', ')})`)
  }
  return index
}

/** Same name -> same index and same rect across two screenshots. */
export function stableMapping(left, right) {
  const a = indexMap(left)
  const b = indexMap(right)
  if (a.size !== b.size) return { ok: false, detail: `${a.size} vs ${b.size} targets` }
  for (const [name, index] of a) {
    if (b.get(name) !== index) return { ok: false, detail: `${name}: ${index} -> ${b.get(name)}` }
  }
  const rects = new Map(left.map(target => [target.name || target.label, JSON.stringify(target.rect)]))
  for (const target of right) {
    const key = target.name || target.label
    if (rects.get(key) !== JSON.stringify(target.rect)) {
      return { ok: false, detail: `${key}: rect changed` }
    }
  }
  return { ok: true, detail: `${a.size} targets, identical indices and rects` }
}
