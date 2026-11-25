/**
 * visibility.mjs — unit checks for the cross-plugin suppression switch.
 *
 * The controller is pure: no Xvfb, no D-Bus, no display. The cross-plugin
 * mount (both plugins in one Cordis host) is covered by
 * `dsh-ui-nl/test/visibility.test.mjs`.
 *
 *   node test/visibility.mjs
 */
import { UiAutomationVisibility } from '../lib/visibility.js'
import { Checks } from './lib/checks.mjs'

const checks = new Checks('visibility controller')

checks.section('reference counting')
{
  const visibility = new UiAutomationVisibility()
  checks.check('starts unsuppressed', visibility.suppressed() === false && visibility.activeKeys().length === 0)
  const release = visibility.suppress('ui-nl')
  checks.check('suppress() activates', visibility.suppressed() === true && visibility.activeKeys().join() === 'ui-nl')
  const releaseAgain = visibility.suppress('ui-nl')
  checks.check('a second suppress() for the same key is reference counted', visibility.activeKeys().length === 1)
  release()
  checks.check('one release keeps the other suppression', visibility.suppressed() === true)
  releaseAgain()
  checks.check('the last release restores visibility', visibility.suppressed() === false)
  release()
  releaseAgain()
  checks.check('releases are idempotent', visibility.suppressed() === false)
}

checks.section('predicates')
{
  const visibility = new UiAutomationVisibility()
  const release = visibility.suppress('ui-nl', (sessionId, agent) => sessionId === 'session-a' || agent?.session?.header?.origin === 'subagent')
  checks.check('matching session is suppressed', visibility.suppresses('session-a', {}) === true)
  checks.check('other session is not suppressed', visibility.suppresses('session-b', { session: { header: { origin: 'user' } } }) === false)
  checks.check('predicate sees the agent', visibility.suppresses('session-b', { session: { header: { origin: 'subagent' } } }) === true)
  checks.check('suppressed() reports any active suppressor', visibility.suppressed() === true)
  release()
  checks.check('release removes the predicate', visibility.suppresses('session-a', {}) === false)
}

checks.section('two suppressors')
{
  const visibility = new UiAutomationVisibility()
  const releaseA = visibility.suppress('wrapper-a', () => true)
  const releaseB = visibility.suppress('wrapper-b', sessionId => sessionId === 'session-b')
  checks.check('both keys are active', visibility.activeKeys().join() === 'wrapper-a,wrapper-b')
  checks.check('either predicate can match', visibility.suppresses('session-b', {}) === true)
  releaseA()
  checks.check('releasing one leaves the other matching', visibility.suppresses('session-b', {}) === true)
  checks.check('the released predicate no longer matches', visibility.suppresses('session-a', {}) === false)
  releaseB()
  checks.check('both released', visibility.suppressed() === false)
}

checks.section('validation')
{
  const visibility = new UiAutomationVisibility()
  let threw = false
  try { visibility.suppress('') } catch { threw = true }
  checks.check('empty key is rejected', threw)
  threw = false
  try { visibility.suppress('ui-nl', 'not-a-function') } catch { threw = true }
  checks.check('non-function predicate is rejected', threw)
  const release = visibility.suppress('ui-nl', () => { throw new Error('broken predicate') })
  checks.check('a throwing predicate counts as no match', visibility.suppresses('session-a', {}) === false)
  release()
  checks.check('a throwing predicate releases cleanly', visibility.suppressed() === false)
}

process.exit(checks.summary() ? 0 : 1)
