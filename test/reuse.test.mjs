/**
 * Opt-in persistent PowerShell host (FASTSH_REUSE_ENGINE=1): one process, a
 * fresh scope and a clean environment per command, and a restart when a command
 * calls `exit` or times out.
 */
import { runCommand } from '../src/exec.js'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))

const LOG = 'test/tmp-reuse-usage.jsonl'
process.env.FASTSH_USAGE_LOG = LOG
process.env.FASTSH_REUSE_ENGINE = '1'
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
const lastEntry = () => readEntries().at(-1)
const ps = (command, extra = {}) => runCommand({ command, cwd: 'C:\\Windows', shell: 'powershell', ...extra })

// 1. first call pays the host start, the second one must not
{
  const first = await ps('Get-Date -Format HH:mm:ss')
  check('first reused call works', first.exitCode === 0 && first.stdout.trim().length > 0, JSON.stringify(first.stdout.trim()))
  check('first call starts the host (slow)', first.durationMs >= 700, `${first.durationMs}ms`)
  check('engine is powershell-reused', lastEntry()?.engine === 'powershell-reused', JSON.stringify(lastEntry()?.engine))

  const second = await ps('Get-Date -Format HH:mm:ss')
  check('second call is fast', second.exitCode === 0 && second.durationMs < 700, `${second.durationMs}ms`)
}

// 2. variables do not leak between commands
{
  await ps("$leak = 'x'; Write-Output 'set'")
  const after = await ps('Write-Output "value=[$leak]"')
  check('variables reset per call', after.stdout.trim() === 'value=[]', JSON.stringify(after.stdout.trim()))
}

// 3. working directory is set per call (real PowerShell prints a Path table)
{
  const one = await runCommand({ command: 'Get-Location', cwd: 'C:\\Windows', shell: 'powershell' })
  const two = await runCommand({ command: 'Get-Location', cwd: 'C:\\', shell: 'powershell' })
  check(
    'cwd follows the request',
    one.stdout.includes('C:\\Windows') && two.stdout.includes('C:\\') && !two.stdout.includes('C:\\Windows'),
    JSON.stringify([one.stdout.trim(), two.stdout.trim()]),
  )
}

// 4. environment changes are rolled back
{
  await ps("$env:FASTSH_LEAK = '1'; Write-Output 'set'")
  const after = await ps("Write-Output \"leak=[$env:FASTSH_LEAK]\"")
  check('env reset per call', after.stdout.trim() === 'leak=[]', JSON.stringify(after.stdout.trim()))
}

// 5. streams stay separate
{
  const result = await ps("Write-Error 'boom'")
  check('stderr separated', result.stderr.includes('boom') && result.stdout.trim() === '', JSON.stringify({ out: result.stdout.trim(), err: result.stderr.trim().slice(0, 40) }))
}

// 6. `exit N` reports the code and the next call still works
{
  const exited = await ps('exit 7')
  check('exit code propagated', exited.exitCode === 7, String(exited.exitCode))
  const after = await ps('Write-Output after-exit')
  check('host recovers after exit', after.exitCode === 0 && after.stdout.includes('after-exit'), JSON.stringify(after.stdout.trim()))
}

// 7. a timeout kills the host and the next call recovers
{
  const slow = await ps('Start-Sleep -Seconds 5', { timeoutMs: 1000 })
  check('timeout flagged', slow.timedOut === true, `${slow.durationMs}ms`)
  const after = await ps('Write-Output recovered')
  check('host recovers after timeout', after.exitCode === 0 && after.stdout.includes('recovered'), JSON.stringify(after.stdout.trim()))
}

// 8. without the switch the one-shot path is used
{
  process.env.FASTSH_REUSE_ENGINE = ''
  const oneShot = await ps('Get-Date -Format HH:mm:ss')
  check('switch off uses one-shot engine', oneShot.exitCode === 0 && lastEntry()?.engine === 'powershell', JSON.stringify(lastEntry()?.engine))
}

rmSync(LOG, { force: true })

console.log('PASS:\n  ' + ok.join('\n  '))
if (bad.length) {
  console.log('FAIL:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log(`\n${ok.length} checks passed`)
