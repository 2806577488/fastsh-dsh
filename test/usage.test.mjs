/**
 * Usage log: every execution appends one JSON line that says which engine
 * served it, where it fell back to real PowerShell, and why.
 */
import { runCommand, startBackgroundJob } from '../src/exec.js'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Fixtures are addressed from the package root.
process.chdir(fileURLToPath(new URL('..', import.meta.url)))

const LOG = 'test/tmp-usage.jsonl'
process.env.FASTSH_USAGE_LOG = LOG
rmSync(LOG, { force: true })

const ok = []
const bad = []
const check = (name, cond, detail) => (cond ? ok : bad).push(`${name} ${detail ?? ''}`)

const readEntries = () => {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const find = (entries, kind, path) => entries.find((entry) => entry.kind === kind && entry.path === path)

// native
{
  const r = await runCommand({ command: 'Get-Location', cwd: process.cwd() })
  check('native run still works', r.exitCode === 0, String(r.exitCode))
  const entry = find(readEntries(), 'run', 'auto-native')
  check('native entry recorded', Boolean(entry), JSON.stringify(readEntries().at(-1)))
  check('native engine', entry?.engine === 'native', JSON.stringify(entry?.engine))
  check('native entry has ts/command/cwd', typeof entry?.ts === 'string' && entry?.command === 'Get-Location' && typeof entry?.cwd === 'string', JSON.stringify(entry?.command))
  check('native entry has no fallbackReason', entry?.fallbackReason === undefined, JSON.stringify(entry?.fallbackReason))
}

// cmd, including the .bat route for multi-line scripts
{
  await runCommand({ command: 'echo hi', cwd: 'C:\\Windows' })
  const entry = find(readEntries(), 'run', 'auto-cmd')
  check('cmd entry engine', entry?.engine === 'cmd', JSON.stringify(entry?.engine))

  await runCommand({ command: 'echo one\necho two', cwd: 'C:\\Windows' })
  const bat = readEntries().filter((item) => item.engine === 'cmd-bat').at(-1)
  check('multi-line cmd logs cmd-bat', Boolean(bat) && bat.path === 'auto-cmd', JSON.stringify(bat?.engine))
}

// native → PowerShell fallback, with a reason
{
  const r = await runCommand({ command: "Get-Item 'HKLM:\\SOFTWARE'", cwd: 'C:\\Windows' })
  check('fallback run still works', r.exitCode === 0, String(r.exitCode))
  const entry = find(readEntries(), 'run', 'auto-native-fallback')
  check('fallback entry recorded', Boolean(entry), JSON.stringify(readEntries().at(-1)))
  check('fallback engine', entry?.engine === 'powershell', JSON.stringify(entry?.engine))
  check('fallbackFrom native', entry?.fallbackFrom === 'native', JSON.stringify(entry?.fallbackFrom))
  check('fallbackReason non-empty', typeof entry?.fallbackReason === 'string' && entry.fallbackReason.length > 0, JSON.stringify(entry?.fallbackReason))
}

// explicit shell and the .ps1 route for long scripts
{
  await runCommand({ command: 'Get-Date', cwd: 'C:\\Windows', shell: 'powershell' })
  const explicit = readEntries().filter((item) => item.path === 'explicit-powershell').at(-1)
  check('explicit powershell logged', explicit?.engine === 'powershell', JSON.stringify(explicit?.engine))

  const script = Array.from({ length: 400 }, (_, i) => `$x${i} = ${i}`).join('\n') + '\nWrite-Output "ok"'
  await runCommand({ command: script, cwd: 'C:\\Windows', shell: 'powershell' })
  const fileRun = readEntries().filter((item) => item.engine === 'powershell-file').at(-1)
  check('long script logs powershell-file', Boolean(fileRun) && fileRun.commandChars > 1000, JSON.stringify(fileRun?.commandChars))
}

// background job settles into one entry with status and job id
{
  let handle = null
  let settle = null
  const jobs = {
    start(spec) {
      handle = { id: 'bash-usage001', append: () => {}, updateProgress: () => {} }
      const raw = spec.run(handle)
      raw.done.then((value) => settle?.(value))
      return handle.id
    },
  }
  const settled = new Promise((resolve) => (settle = resolve))
  startBackgroundJob({ jobs, command: 'echo job-ok', cwd: 'C:\\Windows', label: 'job' })
  await settled
  const entry = readEntries().filter((item) => item.kind === 'job').at(-1)
  check('job entry recorded', Boolean(entry), JSON.stringify(entry))
  check('job entry fields', entry?.jobId === 'bash-usage001' && entry?.status === 'completed' && entry?.engine === 'cmd', JSON.stringify(entry))
  check('job entry duration', typeof entry?.durationMs === 'number' && entry.durationMs >= 0, JSON.stringify(entry?.durationMs))
}

// FASTSH_USAGE_LOG=off disables it
{
  const before = readEntries().length
  process.env.FASTSH_USAGE_LOG = 'off'
  await runCommand({ command: 'echo quiet', cwd: 'C:\\Windows' })
  check('off disables the log', readEntries().length === before, `${before} -> ${readEntries().length}`)
}

rmSync(LOG, { force: true })

console.log('PASS:\n  ' + ok.join('\n  '))
if (bad.length) {
  console.log('FAIL:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log(`\n${ok.length} checks passed`)
