/**
 * Native PowerShell subset: every case here must run in-process, and anything
 * outside the subset must return null so the caller falls back to PowerShell.
 */
import { runNativePowerShell } from '../src/ps.js'
import { existsSync, readFileSync, rmSync } from 'node:fs'

const context = { cwd: process.cwd(), env: process.env }
const run = (command) => runNativePowerShell(command, context)
const ok = []
const bad = []
const check = (name, cond, detail) => (cond ? ok : bad).push(`${name} ${detail ?? ''}`)

// listing
{
  const r = run('Get-ChildItem -Name')
  check('gci -Name', r && r.stdout.split('\n').includes('fastsh'), JSON.stringify(r?.stdout?.slice(0, 40)))
}
{
  const r = run('Get-ChildItem | Select-Object -First 1 | ForEach-Object { $_.Name }')
  check('pipeline', r && r.stdout.trim().length > 0, JSON.stringify(r?.stdout))
}
{
  const r = run('Get-ChildItem fastsh -Filter *.md -Name')
  check('gci -Filter', r && r.stdout.includes('README.md'), JSON.stringify(r?.stdout))
}
{
  const r = run("Get-ChildItem fastsh -File | Where-Object { $_.Extension -eq '.js' } | Select-Object -ExpandProperty Name")
  check('where-object', r && r.stdout.split('\n').includes('index.js'), JSON.stringify(r?.stdout))
}

// path / file probes
{
  const r = run('Test-Path fastsh\\index.js')
  check('test-path true', r && r.stdout === 'True', JSON.stringify(r?.stdout))
}
{
  const r = run('Test-Path no-such-file.txt')
  check('test-path false', r && r.stdout === 'False', JSON.stringify(r?.stdout))
}
{
  const r = run("[System.IO.File]::Exists('fastsh/index.js')")
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
  const r = run('Get-Content fastsh/package.json | Select-Object -First 1')
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
  const target = 'fastsh/test/tmp-redirect.txt'
  rmSync(target, { force: true })
  const r = run(`Get-ChildItem fastsh -Name > ${target}`)
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
  const r = run('Select-String -Path fastsh/package.json -Pattern name | Select-Object -First 1')
  check('select-string', r && /^fastsh\/package\.json:\d+:/.test(r.stdout.trim()), JSON.stringify(r?.stdout))
}
{
  const target = 'fastsh/test/tmp-outfile.txt'
  rmSync(target, { force: true })
  const r = run(`Get-ChildItem fastsh -Name | Select-Object -First 1 | Out-File ${target}`)
  const bytes = existsSync(target) ? readFileSync(target) : Buffer.alloc(0)
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  check('out-file utf8 without bom', Boolean(r) && r.stdout === '' && bytes.length > 0 && !bom, bytes.subarray(0, 6).toString('hex'))
  rmSync(target, { force: true })
}
{
  const r = run('Get-ChildItem fastsh -Name | ConvertTo-Json')
  let parsed = null
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    /* invalid */
  }
  check('convertto-json', Array.isArray(parsed), JSON.stringify(r?.stdout?.slice(0, 30)))
}
{
  const r = run('Get-ChildItem fastsh -Depth 1 -Name')
  check('gci -Depth 1', r && r.stdout.includes('locale\\en.json'), JSON.stringify(r?.stdout?.slice(0, 60)))
}
{
  check('pathtype leaf', run('Test-Path fastsh/package.json -PathType Leaf').stdout === 'True')
  check('pathtype container', run('Test-Path fastsh -PathType Container').stdout === 'True')
  check('pathtype mismatch', run('Test-Path fastsh -PathType Leaf').stdout === 'False')
}
{
  const target = 'fastsh/test/tmp-stderr.txt'
  rmSync(target, { force: true })
  const r = run(`Get-ChildItem no-such-xyz 2> ${target}`)
  const written = existsSync(target) ? readFileSync(target, 'utf8') : ''
  check('stderr redirect', Boolean(r) && written.includes('no-such-xyz'), JSON.stringify(written.slice(0, 60)))
  rmSync(target, { force: true })
}

console.log('PASS:\n  ' + ok.join('\n  '))
if (bad.length) {
  console.log('FAIL:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log(`\n${ok.length} checks passed`)
