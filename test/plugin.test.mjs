/**
 * Exercises the plugin entry with a stand-in Cordis context, so registration,
 * argument handling and rendering can be checked without a live DSH.
 */
import { apply } from '../index.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Fixtures are addressed from the package root.
process.chdir(fileURLToPath(new URL('..', import.meta.url)))

/** Sleep command that starts no PING.EXE. */
const SLEEP = `"${process.execPath}" "${fileURLToPath(new URL('./sleep.cjs', import.meta.url))}"`

let definition = null
const sections = []
let attached = 0
const restricted = []
const guards = []
const listeners = {}

const systemPrompt = {
  section(s) {
    sections.push(s)
    return () => {}
  },
}

// Present, but without `start`: exercises the attached-controller path and the
// detached fallback at once.
const jobs = {
  attachController() {
    attached += 1
    return () => {}
  },
}

const ctx = {
  tools: {
    register(def) {
      definition = def
      return () => {}
    },
    restrict(filter) {
      restricted.push(filter)
      return () => {}
    },
    guard(fn) {
      guards.push(fn)
      return () => {}
    },
  },
  get(key) {
    if (key === 'systemPrompt') return systemPrompt
    if (key === 'jobs') return jobs
    return undefined
  },
  effect(fn) {
    fn()
    return () => {}
  },
  inject(_deps, callback) {
    callback({ ...ctx, systemPrompt, jobs })
  },
  on(event, listener) {
    listeners[event] = listener
    return () => {}
  },
}

apply(ctx)

const ok = []
const bad = []
const check = (name, cond, detail) => (cond ? ok : bad).push(`${name} ${detail ?? ''}`)

check('definition registered', !!definition)
check('name', definition?.name === 'fastsh', definition?.name)
check('has output.render', typeof definition?.output?.render === 'function')
check('has execute', typeof definition?.execute === 'function')
check('prompt section added', sections.length === 1, JSON.stringify(sections[0]?.name))
check('jobs controller attached', attached === 1, String(attached))

// pwsh is replaced, not merely discouraged
check('pwsh restricted', restricted.some((f) => Array.isArray(f?.deny) && f.deny.includes('pwsh')), JSON.stringify(restricted))
check('guard registered', guards.length === 1, String(guards.length))
{
  const denial = guards[0]?.({ name: 'pwsh' })
  check('guard denies pwsh', typeof denial === 'string' && denial.includes('fastsh'), String(denial))
  check('guard allows fastsh', guards[0]?.({ name: 'fastsh' }) === undefined)
}
check('agent listener registered', typeof listeners['agent/created'] === 'function')
{
  let agentRestricted = null
  const fakeAgent = {
    ctx: {
      tools: {
        restrict(filter) {
          agentRestricted = filter
          return () => {}
        },
      },
      effect(fn) {
        fn()
        return () => {}
      },
    },
  }
  listeners['agent/created']({ agent: fakeAgent })
  check(
    'per-agent restriction',
    Array.isArray(agentRestricted?.deny) && agentRestricted.deny.includes('pwsh'),
    JSON.stringify(agentRestricted),
  )
}

const signal = new AbortController().signal

// foreground
{
  const value = await definition.execute({ description: 'Echo Chinese', command: 'echo 中文 & exit /b 3' }, { signal })
  const text = definition.output.render({}, value)[0].text
  check('foreground exit code', value.exitCode === 3, String(value.exitCode))
  check('foreground chinese', value.stdout.includes('中文'), JSON.stringify(value.stdout))
  check('render text', text.includes('[exit code: 3]') && text.includes('中文'), JSON.stringify(text))
  check('no null fields', !Object.values(value).includes(null), JSON.stringify(value))
}

// workdir relative
{
  const value = await definition.execute({ description: 'cwd', command: 'echo %CD%', workdir: '..' }, { signal })
  const expected = resolve(process.cwd(), '..')
  check('relative workdir', value.stdout.trim() === expected, `${value.stdout.trim()} vs ${expected}`)
}

// empty command rejected
{
  let threw = false
  try {
    await definition.execute({ description: 'bad', command: '   ' }, { signal })
  } catch {
    threw = true
  }
  check('empty command throws', threw)
}

// background
{
  const value = await definition.execute({ description: 'bg', command: 'echo bg-ok', run_in_background: true }, { signal })
  check('background shape', value.background === true && typeof value.pid === 'number', JSON.stringify(value))
}

// background keeps the turn by default, so the model still sends a message
{
  let concluded = 0
  const runExec = { signal, concludeTurn: () => (concluded += 1) }
  const value = await definition.execute({ description: 'bg2', command: 'echo bg', run_in_background: true }, runExec)
  check('background keeps turn by default', !value.concluded && concluded === 0, JSON.stringify({ concluded, value }))
}

// conclude_turn: true ends the turn immediately
{
  let concluded = 0
  const runExec = { signal, concludeTurn: () => (concluded += 1) }
  const value = await definition.execute(
    { description: 'bg3', command: 'echo bg', run_in_background: true, conclude_turn: true },
    runExec,
  )
  check('conclude_turn true', value.concluded === true && concluded === 1, JSON.stringify({ concluded, value }))
}

// foreground never concludes the turn
{
  let concluded = 0
  const runExec = { signal, concludeTurn: () => (concluded += 1) }
  await definition.execute({ description: 'fg', command: 'echo fg' }, runExec)
  check('foreground keeps turn', concluded === 0, String(concluded))
}

// presentCall
{
  const view = definition.presentCall({ description: 'List files' })
  check('presentCall card', view.card === 'terminal' && view.title === 'List files', JSON.stringify(view))
}

// timeout path
{
  const value = await definition.execute({ description: 'slow', command: `${SLEEP} 30000`, timeoutMs: 1000 }, { signal })
  check('timeout flag', value.timedOut === true, `${value.durationMs}ms`)
}

// every request pays for the tool schema, so keep the fixed context cost lean
{
  const size = (value) => JSON.stringify(value).length
  const prompt = sections.map((s) => s.text).join('')
  const total = prompt.length + definition.description.length + size(definition.parameters) + size(definition.output.schema)
  check(
    'context budget stays lean',
    total <= 6500 && definition.description.length <= 1300 && size(definition.parameters) <= 2000 && size(definition.output.schema) <= 1300,
    `${total} chars`,
  )
}

console.log('PASS:\n  ' + ok.join('\n  '))
if (bad.length) {
  console.log('FAIL:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log(`\n${ok.length} checks passed`)
