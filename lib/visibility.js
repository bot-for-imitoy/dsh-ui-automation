/**
 * visibility.js — the cross-plugin suppression switch for the numbered-image
 * tools.
 *
 * A wrapper plugin (for example `dsh-ui-nl`) that owns the natural-language
 * entry point can take the six tools over: while a suppressor matches a
 * Session, that Session no longer sees `ui_screenshot` / `ui_click` / … (nor
 * the numbered-image prompt section), so the only way to drive the desktop is
 * the wrapper's own tool. Subagent Sessions are never suppressed by
 * `dsh-ui-automation` itself — a child composed by the wrapper keeps its
 * per-agent grant.
 *
 * The controller is published as the `uiAutomationVisibility` service. A
 * suppressor calls `ctx.uiAutomationVisibility.suppress(key, applies)` inside
 * an effect and keeps the returned release function; unloading or disabling
 * the suppressor (profile change) releases it and restores the standalone
 * behavior. Keys are reference counted, so a reload that suppresses twice
 * keeps the suppression until both releases run.
 *
 * `applies` keeps the change scoped to the Sessions the wrapper actually
 * serves: a wrapper that can reach only some workspaces hides the raw tools
 * only there, instead of leaving other Sessions with no UI control at all.
 * Omitting it suppresses every Session, which is what a deployment-wide
 * wrapper wants.
 *
 * Installing `dsh-ui-automation` alone never creates a suppressor, so its
 * behavior is exactly the pre-2.2.0 behavior.
 *
 * @module dsh-ui-automation/visibility
 */

/** Reference-counted suppression keys. */
export class UiAutomationVisibility {
  /** @type {Map<string, { count: number, applies: (sessionId: string | undefined, agent: object | undefined) => boolean }>} */
  #suppressors = new Map()

  /**
   * Suppress the tools for matching Sessions.
   * @param {string} key stable suppressor identity (for example the wrapper plugin name)
   * @param {(sessionId: string | undefined, agent: object | undefined) => boolean} [applies] predicate; omission matches every Session
   * @returns {() => void} idempotent release function
   */
  suppress(key, applies = () => true) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError('uiAutomationVisibility.suppress(key) requires a non-empty string key')
    }
    if (typeof applies !== 'function') {
      throw new TypeError('uiAutomationVisibility.suppress(key, applies) requires a predicate function')
    }
    const normalized = key.trim()
    const existing = this.#suppressors.get(normalized)
    this.#suppressors.set(normalized, {
      count: (existing?.count ?? 0) + 1,
      // The newest registration owns the predicate; a reload replaces it.
      applies,
    })
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(normalized)
    }
  }

  /**
   * Release one suppression for a key.
   * @param {string} key suppressor identity
   * @returns {void}
   */
  release(key) {
    const normalized = String(key ?? '').trim()
    const existing = this.#suppressors.get(normalized)
    if (existing === undefined) return
    if (existing.count <= 1) this.#suppressors.delete(normalized)
    else this.#suppressors.set(normalized, { ...existing, count: existing.count - 1 })
  }

  /**
   * Whether any wrapper currently owns the tools.
   * @returns {boolean} `true` while at least one suppression is active
   */
  suppressed() {
    return this.#suppressors.size > 0
  }

  /**
   * Whether any active suppressor hides the tools from this Session.
   * @param {string | undefined} sessionId Session identity
   * @param {object | undefined} agent live Agent, when the caller has one
   * @returns {boolean} `true` when at least one active predicate matches
   */
  suppresses(sessionId, agent) {
    for (const { applies } of this.#suppressors.values()) {
      try {
        if (applies(sessionId, agent) === true) return true
      } catch {
        // A broken predicate must not break tool visibility; treat it as no match.
      }
    }
    return false
  }

  /**
   * Active suppressor keys, for diagnostics and tests.
   * @returns {string[]} keys in insertion order
   */
  activeKeys() {
    return [...this.#suppressors.keys()]
  }
}
