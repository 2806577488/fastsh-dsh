import {
  runCommand,
  runInBackground,
  decodeOutput,
  detectPowerShell,
  detectDeleteRisk,
  detectPathOverwrite,
  formatWatchReport,
  startBackgroundJob,
} from '../src/exec.js'
import { readFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

// 14. watch: 产物哈希前后对比
{
  const target = 'test/tmp-watch.txt'
  writeFileSync(target, 'watch-one', 'utf8')
  const r = await runCommand({ command: 'echo noop', cwd: process.cwd(), watch: [target] })
  const entry = r.watchReport?.[0]
  check(
    'watch unchanged',
    entry?.changed === false && entry?.before?.sha256 === entry?.after?.sha256 && entry?.before?.size === 9,
    JSON.stringify(entry),
  )
  const text = formatWatchReport(r.watchReport)
  check(
    'watch report text',
    text.includes(`watch  ${target}`) &&
      text.includes('before ') &&
      text.includes('after  ') &&
      text.includes('← 未变化') &&
      text.includes(entry.before.sha256.slice(0, 8)),
    JSON.stringify(text),
  )
  rmSync(target, { force: true })
}
{
  const target = 'test/tmp-watch.txt'
  writeFileSync(target, 'before-change', 'utf8')
  const r = await runCommand({ command: `echo after-change > ${target}`, cwd: process.cwd(), watch: [target] })
  const entry = r.watchReport?.[0]
  check(
    'watch changed',
    entry?.changed === true && entry?.before?.sha256 !== entry?.after?.sha256,
    JSON.stringify(entry),
  )
  check(
    'watch changed omits unchanged mark',
    !formatWatchReport(r.watchReport).includes('未变化'),
    JSON.stringify(formatWatchReport(r.watchReport)),
  )
  rmSync(target, { force: true })
}
{
  const r = await runCommand({ command: 'echo noop', cwd: process.cwd(), watch: ['test/tmp-watch-missing.txt'] })
  const entry = r.watchReport?.[0]
  check(
    'watch missing',
    entry?.before?.missing === true && entry?.after?.missing === true && entry?.changed === false,
    JSON.stringify(entry),
  )
  check('watch missing text', formatWatchReport(r.watchReport).includes('missing'), JSON.stringify(formatWatchReport(r.watchReport)))
}
{
  const target = 'test/tmp-watch-gone.txt'
  writeFileSync(target, 'will-be-deleted', 'utf8')
  const r = await runCommand({ command: `del ${target}`, cwd: process.cwd(), watch: [target] })
  check(
    'watch gone',
    r.watchReport?.[0]?.after?.gone === true && formatWatchReport(r.watchReport).includes('gone'),
    JSON.stringify(r.watchReport?.[0]),
  )
  rmSync(target, { force: true })
}
{
  const target = 'test/tmp-watch-bg.txt'
  writeFileSync(target, 'before-bg', 'utf8')
  const appended = []
  let done = null
  const jobs = {
    start(spec) {
      const handle = {
        id: 'bash-watch0001',
        append: (text, options) => appended.push({ text, channel: options?.channel }),
        updateProgress: () => {},
      }
      done = spec.run(handle).done
      return handle.id
    },
  }
  startBackgroundJob({ jobs, command: `echo after-bg > ${target}`, cwd: process.cwd(), watch: [target] })
  await done
  const text = appended.map((a) => a.text).join('')
  check(
    'watch report in job output',
    text.includes(`watch  ${target}`) && text.includes('after') && !text.includes('未变化'),
    JSON.stringify(text),
  )
  rmSync(target, { force: true })
}
{
  const target = 'test/tmp-watch-detached.txt'
  writeFileSync(target, 'before-detached', 'utf8')
  const started = runInBackground({ command: `echo after-detached > ${target}`, cwd: process.cwd(), watch: [target] })
  let text = ''
  for (let i = 0; i < 100; i++) {
    text = existsSync(started.stdoutPath) ? readFileSync(started.stdoutPath, 'utf8') : ''
    if (text.includes('watch  ')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check(
    'watch report in detached log',
    text.includes(`watch  ${target}`) && text.includes('before') && text.includes('after'),
    JSON.stringify(text.slice(0, 160)),
  )
  rmSync(target, { force: true })
}

// 15. 疑似 shell 文本替换：只在多行或引号嵌套时提示，不改变执行
{
  const r = await runCommand({ command: 'echo one\necho -replace a b', cwd: 'C:\\Windows' })
  check(
    'replacement warning hit by newline',
    Array.isArray(r.warnings) && r.warnings.length === 1 && r.warnings[0].includes('疑似 shell 文本替换'),
    JSON.stringify(r.warnings),
  )
}
{
  const r = await runCommand({ command: 'echo plain', cwd: 'C:\\Windows' })
  check('replacement warning miss', r.warnings === undefined, JSON.stringify(r.warnings))
}
{
  const r = await runCommand({ command: 'echo "...Replace(\'a\',\'b\')"', cwd: 'C:\\Windows' })
  check(
    'replacement warning hit by nested quotes',
    Array.isArray(r.warnings) && r.warnings.length === 1,
    JSON.stringify(r.warnings),
  )
}

// 16. shell 猜测边界：开头误写的 `&` 由 auto 模式剥掉，中间的 `&` 原样保留
{
  const r = await runCommand({ command: '& echo callop', cwd: 'C:\\Windows' })
  check(
    'leading & runs on cmd',
    r.exitCode === 0 && r.stdout.includes('callop') && !r.error,
    JSON.stringify({ exit: r.exitCode, out: r.stdout, stderr: r.stderr, error: r.error }),
  )
}
{
  const r = await runCommand({ command: '& echo one && echo two', cwd: 'C:\\Windows' })
  check(
    'leading & with && runs on cmd',
    r.exitCode === 0 && r.stdout.includes('one') && r.stdout.includes('two'),
    JSON.stringify({ exit: r.exitCode, out: r.stdout, error: r.error }),
  )
}
{
  const r = await runCommand({ command: 'echo a & echo b', cwd: 'C:\\Windows' })
  check('mid & keeps cmd chaining', r.stdout.includes('a') && r.stdout.includes('b'), JSON.stringify(r.stdout))
}

// 17. shell 猜测边界：`python -c` / `py -c` / `node -e` 是程序 + 参数，不是 PowerShell
{
  const launchers = [
    'python -c "import sys; print(\'$\')"',
    'py -c "print(1)"',
    'node -e "console.log(1)"',
    'python -c "print(\\"$env:PATH\\")"',
  ]
  for (const command of launchers) {
    check(`detect cmd: ${command.slice(0, 24)}`, detectPowerShell(command) === false, String(detectPowerShell(command)))
  }
}

// 18. 长输出裁剪：中间被裁掉的错误行要捞回来
{
  // cmd 的 type 不接受正斜杠路径，这里用反斜杠。
  const target = 'test\\tmp-long-output.txt'
  const lines = []
  for (let i = 1; i <= 500; i++) {
    if (i === 250) lines.push('ERROR: boom')
    else if (i === 251) lines.push('MISS: x')
    else lines.push(`line ${i} filler`)
  }
  writeFileSync(target, `${lines.join('\r\n')}\r\n`, 'utf8')
  const r = await runCommand({ command: `type ${target}`, cwd: process.cwd(), maxChars: 1000 })
  check(
    'trim keeps error lines',
    r.truncated === true &&
      r.stdout.includes('ERROR: boom') &&
      r.stdout.includes('MISS: x') &&
      r.stdout.includes('被裁剪的错误行'),
    JSON.stringify({ truncated: r.truncated, head: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 120) }),
  )
  rmSync(target, { force: true })
}

// 14. `shell: "cmd"` must not be handed to the native PowerShell subset.
// `Write-Output` is a cmdlet: the native path would succeed, real cmd must fail.
{
  const r = await runCommand({ command: 'Write-Output hi', shell: 'cmd', cwd: 'C:\\Windows' })
  check('forced cmd bypasses native subset', r.exitCode !== 0, `${r.exitCode} ${JSON.stringify(r.stdout)}`)
}

// 19. 删除类警告：只提醒递归/强制删除，普通删除不吵；提示走现有 warnings 管道
{
  check('delete warning recursive', detectDeleteRisk('Remove-Item build -Recurse -Force').length === 1, '')
  check('delete warning cmd /s', detectDeleteRisk('rd /s /q build').length === 1, '')
  check('delete warning quiet delete', detectDeleteRisk('del a.txt').length === 0, '')
  check('delete warning no false positive', detectDeleteRisk('echo del /s').length === 0, '')
}
{
  const target = 'test/tmp-warn-del'
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(`${target}/a.txt`, 'x', 'utf8')
  const r = await runCommand({ command: `Remove-Item ${target} -Recurse -Force`, cwd: process.cwd() })
  check(
    'delete warning surfaces in result',
    Array.isArray(r.warnings) && r.warnings.some((w) => w.includes('删除类命令')) && !existsSync(target),
    JSON.stringify(r.warnings),
  )
}

// 20. watch：mtime+size 都没变时直接复用命令前的哈希，不再整读一遍
{
  const target = 'test/tmp-watch-mtime.txt'
  const fixed = new Date('2026-01-02T03:04:05.000Z')
  writeFileSync(target, 'AAAA', 'utf8')
  utimesSync(target, fixed, fixed)
  const script =
    `const fs=require('fs');const p='${target}';` +
    `fs.writeFileSync(p,'BBBB');` +
    `fs.utimesSync(p,new Date('2026-01-02T03:04:05.000Z'),new Date('2026-01-02T03:04:05.000Z'))`
  const r = await runCommand({
    command: `"${process.execPath}" -e "${script}"`,
    cwd: process.cwd(),
    watch: [target],
  })
  const entry = r.watchReport?.[0]
  check(
    'watch mtime short-circuit trusts mtime+size',
    entry?.changed === false && entry?.after?.sha256 === entry?.before?.sha256,
    JSON.stringify(entry),
  )
  rmSync(target, { force: true })
}

// 21. 变量路径的删除只能被拒绝，绝不能落到命令里那个字面量目录
{
  const root = 'test/tmp-var-del'
  const literal = `${root}/$HOME/x`
  rmSync(root, { recursive: true, force: true })
  mkdirSync(literal, { recursive: true })
  writeFileSync(`${literal}/keep.txt`, 'x', 'utf8')
  const r = await runCommand({ command: 'Remove-Item "$HOME\\x" -Recurse -Force', cwd: resolve(root) })
  check(
    'variable path deletes nothing',
    r.exitCode === 1 && /拒绝删除/.test(r.stderr) && existsSync(`${literal}/keep.txt`),
    JSON.stringify({ exit: r.exitCode, stderr: r.stderr.slice(0, 80) }),
  )
  rmSync(root, { recursive: true, force: true })
}

// 22. PATH 覆盖提醒：整体赋值丢继承条目，追加才保留
{
  check('path warning whole overwrite', detectPathOverwrite('set "PATH=C:\\a;C:\\Windows\\system32"').length === 1, '')
  check('path warning append is fine', detectPathOverwrite('set "PATH=C:\\a;%PATH%"').length === 0, '')
  check('path warning setx', detectPathOverwrite('setx PATH "C:\\a"').length === 1, '')
  check('path warning powershell overwrite', detectPathOverwrite('$env:PATH = "C:\\a"').length === 1, '')
  check('path warning powershell append', detectPathOverwrite('$env:PATH = "C:\\a;$env:PATH"').length === 0, '')
  check('path warning ignores echo', detectPathOverwrite('echo set PATH=x').length === 0, '')
}
{
  const r = await runCommand({ command: 'set "PATH=C:\\Windows\\system32" && ver', cwd: 'C:\\Windows' })
  check(
    'path warning surfaces in result',
    Array.isArray(r.warnings) && r.warnings.some((w) => w.includes('PATH')),
    JSON.stringify(r.warnings),
  )
}

// 23. Start-Sleep 原生端到端：不再启动 PowerShell
{
  const started = Date.now()
  const r = await runCommand({ command: 'Start-Sleep -Milliseconds 50', cwd: process.cwd() })
  const elapsed = Date.now() - started
  check('start-sleep native end-to-end', r.exitCode === 0 && elapsed < 1500, `${elapsed}ms`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
