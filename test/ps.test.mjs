/**
 * Native PowerShell subset: every case here must run in-process, and anything
 * outside the subset must return null so the caller falls back to PowerShell.
 */
import { runNativePowerShell } from '../src/ps.js'
import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Fixtures are addressed from the package root.
process.chdir(fileURLToPath(new URL('..', import.meta.url)))

function dropLink(path) {
  try {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path)
  } catch {
    /* ignore */
  }
}

const context = { cwd: process.cwd(), env: process.env }
const run = (command) => runNativePowerShell(command, context)
const ok = []
const bad = []
const check = (name, cond, detail) => (cond ? ok : bad).push(`${name} ${detail ?? ''}`)

// listing
{
  const r = run('Get-ChildItem -Name')
  check('gci -Name', r && r.stdout.split('\n').includes('index.js'), JSON.stringify(r?.stdout?.slice(0, 40)))
}
{
  const r = run('Get-ChildItem | Select-Object -First 1 | ForEach-Object { $_.Name }')
  check('pipeline', r && r.stdout.trim().length > 0, JSON.stringify(r?.stdout))
}
{
  const r = run('Get-ChildItem -Filter *.md -Name')
  check('gci -Filter', r && r.stdout.includes('README.md'), JSON.stringify(r?.stdout))
}
{
  const r = run("Get-ChildItem -File | Where-Object { $_.Extension -eq '.js' } | Select-Object -ExpandProperty Name")
  check('where-object', r && r.stdout.split('\n').includes('index.js'), JSON.stringify(r?.stdout))
}

// path / file probes
{
  const r = run('Test-Path index.js')
  check('test-path true', r && r.stdout === 'True', JSON.stringify(r?.stdout))
}
{
  const r = run('Test-Path no-such-file.txt')
  check('test-path false', r && r.stdout === 'False', JSON.stringify(r?.stdout))
}
{
  const r = run("[System.IO.File]::Exists('index.js')")
  check('file exists', r && r.stdout === 'True', JSON.stringify(r?.stdout))
}
{
  const r = run('[System.IO.Path]::GetExtension("a/b.txt")')
  check('path ext', r && r.stdout === '.txt', JSON.stringify(r?.stdout))
}

// variables
{
  const r = run('$env:USERPROFILE')
  check('env var', r && r.stdout === (process.env.USERPROFILE ?? ''), JSON.stringify(r?.stdout))
}

// content
{
  const r = run('Get-Content package.json | Select-Object -First 1')
  check('get-content', r && r.stdout.trim() === '{', JSON.stringify(r?.stdout))
}

// count
{
  const r = run('Get-ChildItem -Name | Measure-Object -Count')
  check('measure', r && Number(r.stdout) >= 1, JSON.stringify(r?.stdout))
}

// unsupported → must fall back, never fake a result
{
  const r = run('Get-ADUser someone')
  check('unknown cmdlet falls back', r === null, JSON.stringify(r))
}
{
  const r = run('Get-ChildItem | Get-ADUser')
  check('unknown pipeline falls back', r === null, JSON.stringify(r))
}

// statements, subexpressions, date, redirection, processes, call operator
{
  const r = run('Get-Location; Get-Date -Format yyyy')
  check('statement separator', r && r.stdout.split('\n').length === 2, JSON.stringify(r?.stdout))
}
{
  const r = run('Get-Location\nGet-Date -Format yyyy')
  check('newline statements', r && r.stdout.split('\n').length === 2, JSON.stringify(r?.stdout))
}
{
  const r = run('Write-Output "v=$(Get-Date -Format yyyy)"')
  check('subexpression', r && /^v=\d{4}$/.test(r.stdout.trim()), JSON.stringify(r?.stdout))
}
{
  const r = run('Get-Date -Format "yyyy-MM-dd"')
  check('get-date format', r && /^\d{4}-\d{2}-\d{2}$/.test(r.stdout.trim()), JSON.stringify(r?.stdout))
}
{
  const target = 'test/tmp-redirect.txt'
  rmSync(target, { force: true })
  const r = run(`Get-ChildItem -Name > ${target}`)
  const written = existsSync(target) ? readFileSync(target, 'utf8') : ''
  check('redirect >', Boolean(r) && r.stdout === '' && written.includes('index.js'), JSON.stringify(written.slice(0, 40)))
  rmSync(target, { force: true })
}
{
  const r = run('Get-Process -Name node | Select-Object -First 1 | ForEach-Object { $_.ProcessName }')
  check('get-process', r && r.stdout.trim().length > 0, JSON.stringify(r?.stdout))
}
{
  const r = run('& where.exe cmd')
  check('call operator delegate', Boolean(r?.delegate) && r.delegate.file === 'where.exe', JSON.stringify(r?.delegate))
}
{
  check('stdin redirect falls back', run('Get-Content < x.txt') === null)
}

// select-string / out-file / convertto-json / depth / pathtype / stderr redirect
{
  const r = run('Select-String -Path package.json -Pattern name | Select-Object -First 1')
  check('select-string', r && /^package\.json:\d+:/.test(r.stdout.trim()), JSON.stringify(r?.stdout))
}
{
  const target = 'test/tmp-outfile.txt'
  rmSync(target, { force: true })
  const r = run(`Get-ChildItem -Name | Select-Object -First 1 | Out-File ${target}`)
  const bytes = existsSync(target) ? readFileSync(target) : Buffer.alloc(0)
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  check('out-file utf8 without bom', Boolean(r) && r.stdout === '' && bytes.length > 0 && !bom, bytes.subarray(0, 6).toString('hex'))
  rmSync(target, { force: true })
}
{
  const r = run('Get-ChildItem -Name | ConvertTo-Json')
  let parsed = null
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    /* invalid */
  }
  check('convertto-json', Array.isArray(parsed), JSON.stringify(r?.stdout?.slice(0, 30)))
}
{
  const r = run('Get-ChildItem -Depth 1 -Name')
  check('gci -Depth 1', r && r.stdout.includes('locale\\en.json'), JSON.stringify(r?.stdout?.slice(0, 60)))
}
{
  check('pathtype leaf', run('Test-Path package.json -PathType Leaf').stdout === 'True')
  check('pathtype container', run('Test-Path test -PathType Container').stdout === 'True')
  check('pathtype mismatch', run('Test-Path test -PathType Leaf').stdout === 'False')
}
{
  const target = 'test/tmp-stderr.txt'
  rmSync(target, { force: true })
  const r = run(`Get-ChildItem no-such-xyz 2> ${target}`)
  const written = existsSync(target) ? readFileSync(target, 'utf8') : ''
  check('stderr redirect', Boolean(r) && written.includes('no-such-xyz'), JSON.stringify(written.slice(0, 60)))
  rmSync(target, { force: true })
}

// variables, control flow, junction, registry environment
{
  check('variable assign/ref', run("$x = 'abc'; Write-Output $x").stdout.trim() === 'abc')
}
{
  const r = run('$f = Get-Item package.json; Write-Output $f.Name')
  check('variable property', r.stdout.trim() === 'package.json', JSON.stringify(r?.stdout))
}
{
  const r = run('$list = Get-ChildItem -Name; $list | Select-Object -First 1')
  check('variable pipeline input', r.stdout.trim().length > 0 && !r.stdout.includes('\n'), JSON.stringify(r?.stdout))
}
{
  check(
    'if/else true',
    run("$x = 5; if ($x -gt 3) { Write-Output 'big' } else { Write-Output 'small' }").stdout.trim() === 'big',
  )
  check(
    'if/else false',
    run("$x = 1; if ($x -gt 3) { Write-Output 'big' } else { Write-Output 'small' }").stdout.trim() === 'small',
  )
  check(
    'if command condition',
    run("if (Test-Path package.json) { Write-Output 'yes' } else { Write-Output 'no' }").stdout.trim() === 'yes',
  )
}
{
  const r = run('foreach ($n in Get-ChildItem -Name) { Write-Output $n }')
  check('foreach', r && r.stdout.includes('package.json') && r.stdout.split('\n').length >= 3, JSON.stringify(r?.stdout?.slice(0, 40)))
}
{
  check('try/catch', run("try { Get-Item no-such-file-xyz } catch { Write-Output 'caught' }").stdout.trim() === 'caught')
}
{
  dropLink('test/tmp-junction')
  const created = run('New-Item -ItemType Junction -Path test/tmp-junction -Target test')
  const listed = run('Get-ChildItem test/tmp-junction -Name')
  const removed = run('Remove-Item test/tmp-junction -Force')
  check(
    'junction create/list/remove',
    Boolean(created) && listed.stdout.includes('sleep.cjs') && Boolean(removed) && !existsSync('test/tmp-junction'),
    JSON.stringify({ created: created?.stdout, listed: listed?.stdout?.slice(0, 30) }),
  )
  dropLink('test/tmp-junction')
}
{
  const r = run("[Environment]::SetEnvironmentVariable('FASTSH_TEST','v1'); [Environment]::GetEnvironmentVariable('FASTSH_TEST')")
  check('env set/get process', r.stdout.trim() === 'v1', JSON.stringify(r?.stdout))
}
{
  const set = run("[Environment]::SetEnvironmentVariable('FASTSH_USER_TEST','v2','User'); [Environment]::GetEnvironmentVariable('FASTSH_USER_TEST','User')")
  const cleaned = run(
    "[Environment]::SetEnvironmentVariable('FASTSH_USER_TEST',$null,'User'); [Environment]::GetEnvironmentVariable('FASTSH_USER_TEST','User')",
  )
  check(
    'env set/get user registry',
    set.stdout.trim() === 'v2' && cleaned.stdout.trim() === '',
    JSON.stringify({ set: set?.stdout, cleaned: cleaned?.stdout }),
  )
}

// tee-object keeps the pipeline and writes the same text to a file
{
  const target = 'test/tmp-tee.txt'
  rmSync(target, { force: true })
  const r = run(`Get-ChildItem -Name | Select-Object -First 2 | Tee-Object -FilePath ${target}`)
  const written = existsSync(target) ? readFileSync(target, 'utf8') : ''
  check('tee-object', Boolean(r) && r.stdout === written.replace(/\n$/, ''), JSON.stringify({ out: r?.stdout, file: written }))
  rmSync(target, { force: true })
}

// -Name fast path, streaming content, tail/totalcount
{
  const started = Date.now()
  const r = run('Get-ChildItem C:\\Windows\\System32 -Name')
  const elapsed = Date.now() - started
  check('gci -Name skips stat', r && r.stdout.split('\n').length > 1000 && elapsed < 600, `${elapsed}ms`)
}
{
  const target = 'test/tmp-lines.txt'
  writeFileSync(target, 'one\ntwo\nthree\nfour\n', 'utf8')
  check('get-content -Tail', JSON.stringify(run(`Get-Content "${target}" -Tail 2`).stdout) === JSON.stringify('three\nfour'), JSON.stringify(run(`Get-Content "${target}" -Tail 2`).stdout))
  check('get-content -TotalCount', JSON.stringify(run(`Get-Content "${target}" -TotalCount 2`).stdout) === JSON.stringify('one\ntwo'), JSON.stringify(run(`Get-Content "${target}" -TotalCount 2`).stdout))
  check('get-content full', run(`Get-Content "${target}"`).stdout.split('\n').length === 4, JSON.stringify(run(`Get-Content "${target}"`).stdout))
  rmSync(target, { force: true })
}
{
  const target = 'test/tmp-big.txt'
  writeFileSync(target, 'error: x\n'.repeat(200000), 'utf8')
  const started = Date.now()
  const r = run(`Select-String -Path "${target}" -Pattern error`)
  const elapsed = Date.now() - started
  check('select-string streams', r && r.stdout.split('\n').length === 200000 && elapsed < 3000, `${elapsed}ms, ${r?.stdout?.split('\n').length} matches`)
  rmSync(target, { force: true })
}

console.log('PASS:\n  ' + ok.join('\n  '))
if (bad.length) {
  console.log('FAIL:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log(`\n${ok.length} checks passed`)
