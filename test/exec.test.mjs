import { runCommand, runInBackground, decodeOutput, detectPowerShell } from '../src/exec.js'
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Fixtures are addressed from the package root.
process.chdir(fileURLToPath(new URL('..', import.meta.url)))

/** Sleep command that starts no PING.EXE. */
const SLEEP = `"${process.execPath}" "${fileURLToPath(new URL('./sleep.cjs', import.meta.url))}"`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

// 1. basic + Chinese (GBK from cmd built-ins)
{
  const r = await runCommand({ command: 'echo 中文ABC & echo 第二行', cwd: 'C:\\Windows' })
  check('chinese gbk decode', r.exitCode === 0 && r.stdout.includes('中文ABC') && r.stdout.includes('第二行'), JSON.stringify(r.stdout))
  check('gbk detected', r.stdoutEncoding === 'gbk', r.stdoutEncoding)
}

// 2. exit code propagation
{
  const r = await runCommand({ command: 'exit /b 7', cwd: 'C:\\Windows' })
  check('exit code', r.exitCode === 7, String(r.exitCode))
}

// 2b. multi-line command runs every line (cmd stops at a newline otherwise)
{
  const r = await runCommand({ command: 'echo one\necho two', cwd: 'C:\\Windows' })
  check('multi-line command', r.stdout.includes('one') && r.stdout.includes('two'), JSON.stringify(r.stdout))
}

// 2c. `&&` belongs to cmd and must run both sides
{
  const r = await runCommand({ command: 'echo one && echo two', cwd: 'C:\\Windows' })
  check('cmd && chaining', r.stdout.includes('one') && r.stdout.includes('two'), JSON.stringify(r.stdout))
}

// 2d. logFile keeps the raw transcript
{
  const log = 'test/tmp-log.txt'
  rmSync(log, { force: true })
  const r = await runCommand({ command: 'echo hello-log & echo err-log 1>&2', cwd: 'C:\\Windows', logFile: log })
  const written = existsSync(log) ? readFileSync(log, 'utf8') : ''
  check(
    'logFile raw output',
    r.logPath === log && written.includes('hello-log') && written.includes('err-log'),
    JSON.stringify(written.slice(0, 40)),
  )
  rmSync(log, { force: true })
}

// 2e. a catastrophic regex is terminated instead of freezing the process
{
  const target = 'test/tmp-redos.txt'
  writeFileSync(target, `${'a'.repeat(20000)}!\n`, 'utf8')
  const started = Date.now()
  const r = await runCommand({
    command: `Select-String -Path "${target}" -Pattern '(a+)+$'`,
    cwd: process.cwd(),
    timeoutMs: 1500,
  })
  const elapsed = Date.now() - started
  check('native timeout kills worker', r.timedOut === true && elapsed < 8000, `${elapsed}ms`)
  const after = await runCommand({ command: 'Get-Location', cwd: process.cwd() })
  check('native works after worker restart', typeof after.stdout === 'string' && after.stdout.length > 0, after.stdout)
  rmSync(target, { force: true })
}

// 3. stderr
{
  const r = await runCommand({ command: 'echo boom 1>&2', cwd: 'C:\\Windows' })
  check('stderr captured', r.stdout === '' && r.stderr.trim() === 'boom', JSON.stringify(r.stderr))
}

// 4. cwd
{
  const r = await runCommand({ command: 'echo %CD%', cwd: 'C:\\Windows' })
  check('cwd honoured', r.stdout.trim() === 'C:\\Windows', r.stdout.trim())
}

// 5. quoting preserved
{
  const r = await runCommand({ command: 'echo "a & b"', cwd: 'C:\\Windows' })
  check('quoting preserved', r.stdout.trim() === '"a & b"', r.stdout.trim())
}

// 6. powershell mode
{
  const r = await runCommand({ command: 'Get-ChildItem C:\\Windows | Select-Object -First 1 | ForEach-Object { $_.Name }', cwd: 'C:\\Windows', shell: 'powershell' })
  check('powershell mode', r.exitCode === 0 && r.stdout.trim().length > 0, `${r.durationMs}ms ${JSON.stringify(r.stdout.slice(0, 40))}`)
}

// 7. timeout kill
{
  const r = await runCommand({ command: `${SLEEP} 30000`, cwd: 'C:\\Windows', timeoutMs: 1200 })
  check('timeout kills', r.timedOut === true && r.durationMs < 8000, `${r.durationMs}ms exit=${r.exitCode}`)
}

// 8. abort
{
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 800)
  const r = await runCommand({ command: `${SLEEP} 30000`, cwd: 'C:\\Windows' }, ac.signal)
  check('abort kills', r.aborted === true, `${r.durationMs}ms`)
}

// 9. background
{
  const bg = runInBackground({ command: `${SLEEP} 2000 & echo BACKGROUND_DONE`, cwd: 'C:\\Windows' })
  await new Promise((r) => setTimeout(r, 3500))
  const out = existsSync(bg.stdoutPath) ? readFileSync(bg.stdoutPath, 'utf8') : ''
  check('background log', out.includes('BACKGROUND_DONE'), JSON.stringify(out))
}

// 10. decoder unit cases
{
  const gbk = decodeOutput(Buffer.from('d6d0cec4', 'hex'))
  check('decode gbk bytes', gbk.text === '中文' && gbk.encoding === 'gbk', JSON.stringify(gbk))
  const bom = decodeOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]))
  check('strip utf8 bom', bom.text === 'hi', JSON.stringify(bom))
  const u16 = decodeOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]))
  check('utf16le bom', u16.text === '中文', JSON.stringify(u16))
}

// 11. shell auto-detection
{
  const powershell = [
    'Get-ChildItem C:\\Windows',
    'Get-Service | Where-Object Status -eq Running',
    '$env:DSH_HOME',
    '[System.IO.File]::Exists("x")',
    'Select-Object -First 1',
    'ForEach-Object { $_ }',
    '& where.exe cmd',
  ]
  const cmd = [
    'dir /b',
    'echo %CD%',
    'for /l %i in (1,1,3) do @echo %i',
    'git status',
    'copy a b',
    'where.exe node',
    'echo a && echo b',
    'Get-ChildItem fastsh && echo done',
    'echo a & echo b',
  ]
  for (const c of powershell) check(`detect PS: ${c.slice(0, 26)}`, detectPowerShell(c) === true, String(detectPowerShell(c)))
  for (const c of cmd) check(`detect cmd: ${c.slice(0, 26)}`, detectPowerShell(c) === false, String(detectPowerShell(c)))
}

// 12. auto mode actually routes PowerShell syntax
{
  const r = await runCommand({ command: 'Get-ChildItem C:\\Windows | Select-Object -First 1 | ForEach-Object { $_.Name }', cwd: 'C:\\Windows' })
  check('auto routes to powershell', r.exitCode === 0 && r.stdout.trim().length > 0, `${r.durationMs}ms ${JSON.stringify(r.stdout.slice(0, 30))}`)
}
{
  const r = await runCommand({ command: 'echo %CD%', cwd: 'C:\\Windows' })
  check('auto keeps cmd for cmd syntax', r.stdout.trim() === 'C:\\Windows', r.stdout.trim())
}

// 13. a `powershell -Command "<script>"` launcher is peeled off instead of being
// handed to cmd.exe, which cannot pass the inner quoting or newlines through.
{
  const r = await runCommand({ command: 'powershell -NoProfile -Command "Write-Output 你好"', cwd: 'C:\\Windows' })
  check('launcher unwrapped', r.exitCode === 0 && r.stdout.trim() === '你好', JSON.stringify(r.stdout))
}
{
  const r = await runCommand({
    command: 'powershell -NoProfile -Command "Write-Output one\nWrite-Output two"',
    cwd: 'C:\\Windows',
  })
  check('launcher keeps newlines', r.stdout.includes('one') && r.stdout.includes('two'), JSON.stringify(r.stdout))
}
{
  const r = await runCommand({ command: 'powershell -Command "Write-Output 半截', cwd: 'C:\\Windows' })
  check(
    'unterminated launcher rejected',
    typeof r.error === 'string' && r.error.includes('unterminated quote'),
    String(r.error).slice(0, 60),
  )
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
