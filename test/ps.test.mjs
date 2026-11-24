/**
 * Native PowerShell subset: every case here must run in-process, and anything
 * outside the subset must return null so the caller falls back to PowerShell.
 */
import { runNativePowerShell } from '../src/ps.js'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
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

// variables in path arguments: exact references expand, anything that still
// needs interpolation must decline to the real engine instead of going literal
{
  const r = run('Test-Path $HOME')
  check('path expands $HOME', r && r.stdout === 'True', JSON.stringify(r?.stdout))
}
{
  const r = run('Test-Path $env:USERPROFILE')
  check('path expands $env:USERPROFILE', r && r.stdout === 'True', JSON.stringify(r?.stdout))
}
{
  const r = run('Get-Item $HOME | Select-Object -ExpandProperty Name')
  check(
    'path expands $HOME for Get-Item',
    r && r.stdout.trim() === basename(process.env.USERPROFILE ?? ''),
    JSON.stringify(r?.stdout),
  )
}
{
  const r = run('Get-Item $PWD | Select-Object -ExpandProperty FullName')
  check('path expands $PWD', r && r.stdout.trim() === process.cwd(), JSON.stringify(r?.stdout))
}
{
  const r = run('Test-Path "$HOME\\."')
  check('embedded $reference declines to the real engine', r === null, JSON.stringify(r))
}
{
  const r = run('Test-Path $env:USERPROFILE\\Documents')
  check('embedded $env reference declines to the real engine', r === null, JSON.stringify(r))
}
{
  const r = runNativePowerShell('Write-Output $HOME', { cwd: process.cwd(), env: {} })
  check('$HOME without env declines', r === null, JSON.stringify(r))
}
{
  const r = runNativePowerShell('Test-Path $HOME', { cwd: process.cwd(), env: {} })
  check('$HOME path without env declines', r === null, JSON.stringify(r))
}
{
  const r = runNativePowerShell('Test-Path $env:NO_SUCH_VAR_FASTSH', { cwd: process.cwd(), env: {} })
  check('missing $env in a path declines', r === null, JSON.stringify(r))
}

// Remove-Item: the guard refuses protected roots, and a delete target that a
// variable could still move is refused instead of handed to the real engine.
{
  const root = 'test/tmp-guard'
  rmSync(root, { recursive: true, force: true })
  mkdirSync(`${root}/sub`, { recursive: true })
  writeFileSync(`${root}/sub/a.txt`, 'x', 'utf8')
  writeFileSync(`${root}/w.txt`, 'x', 'utf8')
  const ctx = { cwd: resolve(root), env: { ...process.env, USERPROFILE: resolve(root) } }

  const blocked = runNativePowerShell(`Remove-Item "${resolve(root)}" -Recurse -Force`, ctx)
  check(
    'guard blocks the profile root',
    blocked && blocked.exitCode === 1 && /拒绝删除受保护路径/.test(blocked.stderr),
    JSON.stringify(blocked),
  )
  check('guard left the tree intact', existsSync(`${root}/sub/a.txt`), '')

  const blockedCwd = runNativePowerShell('Remove-Item . -Recurse -Force', ctx)
  check(
    'guard blocks the working directory',
    blockedCwd && blockedCwd.exitCode === 1 && /拒绝删除受保护路径/.test(blockedCwd.stderr),
    JSON.stringify(blockedCwd),
  )

  const allowed = runNativePowerShell('Remove-Item sub -Recurse -Force', ctx)
  check(
    'guard allows a subdirectory',
    allowed && allowed.exitCode === 0 && !existsSync(`${root}/sub`),
    JSON.stringify(allowed),
  )

  const whatif = runNativePowerShell('Remove-Item w.txt -WhatIf', ctx)
  check('whatif declines instead of deleting', whatif === null && existsSync(`${root}/w.txt`), JSON.stringify(whatif))

  const confirm = runNativePowerShell('Remove-Item w.txt -Confirm', ctx)
  check(
    'confirm is refused instead of deleting',
    confirm && confirm.exitCode === 1 && /交互确认/.test(confirm.stderr) && existsSync(`${root}/w.txt`),
    JSON.stringify(confirm),
  )

  const whatifFalse = runNativePowerShell('Remove-Item w.txt -WhatIf:$false', ctx)
  check(
    'whatif:$false still deletes under the guard',
    whatifFalse && whatifFalse.exitCode === 0 && !existsSync(`${root}/w.txt`),
    JSON.stringify(whatifFalse),
  )

  writeFileSync(`${root}/w.txt`, 'x', 'utf8')
  const noPath = runNativePowerShell('Remove-Item -Recurse -Force', ctx)
  check(
    'missing -Path is refused instead of deleting cwd',
    noPath && noPath.exitCode === 1 && existsSync(`${root}/w.txt`),
    JSON.stringify(noPath),
  )

  const piped = runNativePowerShell('Get-ChildItem w.txt | Remove-Item -Force', ctx)
  check('pipeline input declines to the real engine', piped === null, JSON.stringify(piped))

  // The exact wrong-deletion shape: `"$HOME\x"` used to resolve to the literal
  // directory `$HOME\x` under the working directory and delete that instead.
  const literal = `${root}/$HOME/x`
  mkdirSync(literal, { recursive: true })
  writeFileSync(`${literal}/keep.txt`, 'x', 'utf8')
  const interpolated = runNativePowerShell('Remove-Item "$HOME\\x" -Recurse -Force', ctx)
  check(
    'variable path never deletes the literal $HOME directory',
    interpolated && interpolated.exitCode === 1 && existsSync(`${literal}/keep.txt`),
    JSON.stringify(interpolated),
  )

  const wildcardDir = `${root}/wc`
  mkdirSync(wildcardDir, { recursive: true })
  writeFileSync(`${wildcardDir}/keep.txt`, 'x', 'utf8')
  const wildcard = runNativePowerShell('Remove-Item wc\\* -Recurse -Force', ctx)
  check(
    'wildcard path is refused instead of expanding',
    wildcard && wildcard.exitCode === 1 && existsSync(`${wildcardDir}/keep.txt`),
    JSON.stringify(wildcard),
  )

  const nested = `${root}/nested/leaf`
  mkdirSync(nested, { recursive: true })
  const ancestor = runNativePowerShell('Remove-Item .. -Recurse -Force', {
    cwd: resolve(nested),
    env: { ...process.env, USERPROFILE: resolve(nested) },
  })
  check(
    'guard blocks an ancestor of the working directory',
    ancestor && ancestor.exitCode === 1 && /拒绝删除受保护路径/.test(ancestor.stderr),
    JSON.stringify(ancestor),
  )

  // Exact variables still delete the target they name; the guard sees the value.
  const assigned = resolve(`${root}/assigned`)
  mkdirSync(assigned, { recursive: true })
  writeFileSync(`${assigned}/keep.txt`, 'x', 'utf8')
  const assignedDelete = runNativePowerShell(`$d = "${assigned}"; Remove-Item $d -Recurse -Force`, ctx)
  check(
    'assigned variable deletes the resolved target',
    assignedDelete && assignedDelete.exitCode === 0 && !existsSync(assigned),
    JSON.stringify(assignedDelete),
  )

  const fileDelete = runNativePowerShell('[System.IO.File]::Delete($env:NO_SUCH_VAR_FASTSH)', ctx)
  check(
    'File.Delete with an empty variable is refused',
    fileDelete && fileDelete.exitCode === 1 && /拒绝删除/.test(fileDelete.stderr),
    JSON.stringify(fileDelete),
  )

  // Directory.Delete is native now, so the same guard applies instead of a
  // silent fallback to the real engine.
  const dirTarget = `${root}/dir-del`
  mkdirSync(`${dirTarget}/inner`, { recursive: true })
  writeFileSync(`${dirTarget}/inner/x.txt`, 'x', 'utf8')
  const dirDelete = runNativePowerShell(`[System.IO.Directory]::Delete("${resolve(dirTarget)}", $true)`, ctx)
  check(
    'Directory.Delete removes a subdirectory',
    dirDelete && dirDelete.exitCode === 0 && !existsSync(dirTarget),
    JSON.stringify(dirDelete),
  )
  const dirDeleteProtected = runNativePowerShell(`[System.IO.Directory]::Delete("${resolve(root)}", $true)`, ctx)
  check(
    'Directory.Delete is guarded',
    dirDeleteProtected &&
      dirDeleteProtected.exitCode === 1 &&
      /拒绝删除受保护路径/.test(dirDeleteProtected.stderr) &&
      existsSync(root),
    JSON.stringify(dirDeleteProtected),
  )
  const dirDeleteVar = runNativePowerShell('[System.IO.Directory]::Delete($env:NO_SUCH_VAR_FASTSH, $true)', ctx)
  check(
    'Directory.Delete with an empty variable is refused',
    dirDeleteVar && dirDeleteVar.exitCode === 1 && /拒绝删除/.test(dirDeleteVar.stderr),
    JSON.stringify(dirDeleteVar),
  )
  writeFileSync(`${root}/lp2.txt`, 'x', 'utf8')
  const dirDeleteFile = runNativePowerShell(`[System.IO.Directory]::Delete("${resolve(`${root}/lp2.txt`)}", $true)`, ctx)
  check(
    'Directory.Delete on a file fails without deleting it',
    dirDeleteFile && dirDeleteFile.exitCode === 1 && existsSync(`${root}/lp2.txt`),
    JSON.stringify(dirDeleteFile),
  )

  // -Path refuses wildcards before touching the filesystem; -LiteralPath is a
  // valid target source and still goes through the guard.
  const wildcardPath = runNativePowerShell('Remove-Item -Path a*b.txt -Force', ctx)
  check(
    'wildcard -Path is refused',
    wildcardPath && wildcardPath.exitCode === 1 && /通配符/.test(wildcardPath.stderr),
    JSON.stringify(wildcardPath),
  )
  writeFileSync(`${root}/lp.txt`, 'x', 'utf8')
  const literalPath = runNativePowerShell('Remove-Item -LiteralPath "lp.txt" -Force', ctx)
  check(
    'literalpath deletes a plain literal name',
    literalPath && literalPath.exitCode === 0 && !existsSync(`${root}/lp.txt`),
    JSON.stringify(literalPath),
  )

  // A .Property chain resolves to a real path and stays under the guard.
  const fe = `${root}/fe`
  mkdirSync(fe, { recursive: true })
  writeFileSync(`${fe}/f1.txt`, 'x', 'utf8')
  writeFileSync(`${fe}/f2.txt`, 'x', 'utf8')
  const viaProperty = runNativePowerShell(
    `foreach ($f in Get-ChildItem "${resolve(fe)}") { Remove-Item $f.FullName -Force }`,
    ctx,
  )
  check(
    'foreach .FullName deletes the resolved files',
    viaProperty && viaProperty.exitCode === 0 && !existsSync(`${fe}/f1.txt`) && !existsSync(`${fe}/f2.txt`),
    JSON.stringify(viaProperty),
  )
  rmSync(root, { recursive: true, force: true })
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

// Start-Sleep 原生：等待本身，不再启动 PowerShell（实测 2.9 s → ~1 s）
{
  const started = Date.now()
  const r = run('Start-Sleep -Milliseconds 60')
  const elapsed = Date.now() - started
  check('start-sleep milliseconds', r && r.exitCode === 0 && elapsed >= 55 && elapsed < 2000, `${elapsed}ms`)
  const seconds = run('Start-Sleep -Seconds 0.05')
  check('start-sleep fractional seconds', seconds && seconds.exitCode === 0, JSON.stringify(seconds))
  const alias = run('sleep -Milliseconds 10')
  check('start-sleep alias', alias && alias.exitCode === 0, JSON.stringify(alias))
  const long = run('Start-Sleep -Seconds 120')
  check('start-sleep long declines', long === null, JSON.stringify(long))
  const invalid = run('Start-Sleep -Seconds nope')
  check('start-sleep invalid declines', invalid === null, JSON.stringify(invalid))
}

// sugar: cmdlets that used to need a pile of statements (or a real PowerShell boot)
{
  const expected = createHash('sha256').update(readFileSync('package.json')).digest('hex').toUpperCase()
  const r = run('Get-FileHash package.json')
  const parsed = r && JSON.parse(r.stdout)
  check(
    'get-filehash sha256',
    parsed && parsed.Algorithm === 'SHA256' && parsed.Hash === expected,
    JSON.stringify(parsed && { algorithm: parsed.Algorithm, hash: parsed.Hash?.slice(0, 12) }),
  )
  const md5 = run('Get-FileHash package.json -Algorithm MD5')
  const md5Expected = createHash('md5').update(readFileSync('package.json')).digest('hex').toUpperCase()
  check('get-filehash md5', md5 && JSON.parse(md5.stdout).Hash === md5Expected, JSON.stringify(md5 && md5.stdout.slice(0, 60)))
}
{
  const multi = run('Get-ChildItem test -File | Get-FileHash')
  check(
    'get-filehash from pipeline',
    multi && multi.stdout.split('\n').length >= 2 && multi.stdout.includes('"Algorithm"'),
    JSON.stringify(multi && multi.stdout.split('\n').length),
  )
}
{
  const r = run('echo \'{"a":1,"b":[2]}\' | ConvertFrom-Json')
  check('convertfrom-json inline', r && r.stdout.replace(/\s+/g, '') === '{"a":1,"b":[2]}', JSON.stringify(r?.stdout))
  const target = 'test/tmp-json.json'
  writeFileSync(target, '{\n  "name": "fastsh",\n  "n": 1\n}\n', 'utf8')
  const fromFile = run(`Get-Content "${target}" | ConvertFrom-Json`)
  check(
    'convertfrom-json from file lines',
    fromFile && fromFile.stdout.replace(/\s+/g, '') === '{"name":"fastsh","n":1}',
    JSON.stringify(fromFile?.stdout),
  )
  rmSync(target, { force: true })
  const broken = run('echo \'{oops}\' | ConvertFrom-Json')
  check('convertfrom-json rejects bad json', broken && broken.exitCode === 1 && /JSON 解析失败/.test(broken.stderr), JSON.stringify(broken))
}
{
  const r = run('Resolve-Path .')
  check('resolve-path', r && r.stdout.trim() === process.cwd(), JSON.stringify(r?.stdout))
  const missing = run('Resolve-Path no-such-xyz')
  check('resolve-path missing errors', missing && missing.exitCode === 1, JSON.stringify(missing))
}
{
  const target = 'test/tmp-dup.txt'
  writeFileSync(target, 'a\nb\na\n', 'utf8')
  const unique = run(`Get-Content "${target}" | Select-Object -Unique`)
  check('select-object -unique', unique && unique.stdout === 'a\nb', JSON.stringify(unique?.stdout))
  rmSync(target, { force: true })
}
{
  const plain = run('Get-ChildItem test -Name')
  const formatted = run('Get-ChildItem test -Name | Format-Table')
  check(
    'format-table passes data through',
    formatted && formatted.stdout === plain.stdout,
    JSON.stringify({ plain: plain?.stdout?.slice(0, 40), formatted: formatted?.stdout?.slice(0, 40) }),
  )
  const asText = run("Get-ChildItem test -Name | Out-String")
  check('out-string joins', asText && asText.stdout === plain.stdout, JSON.stringify(asText?.stdout?.slice(0, 40)))
}
{
  const missing = 'no-such-xyz-file'
  const loud = run(`Remove-Item ${missing} -Force`)
  check('remove missing errors by default', loud && loud.exitCode === 1, JSON.stringify(loud))
  const quiet = run(`Remove-Item ${missing} -Force -ErrorAction SilentlyContinue`)
  check('erroraction silences a missing file', quiet && quiet.exitCode === 0, JSON.stringify(quiet))
  const alias = run(`Get-Item ${missing} -EA SilentlyContinue`)
  check('erroraction -EA alias', alias && alias.exitCode === 0 && alias.stdout === '', JSON.stringify(alias))
  const refusal = run('Remove-Item . -Recurse -Force -ErrorAction SilentlyContinue')
  check(
    'erroraction never silences a guard refusal',
    refusal && refusal.exitCode === 1 && /拒绝删除/.test(refusal.stderr),
    JSON.stringify(refusal),
  )
}

console.log('PASS:\n  ' + ok.join('\n  '))
if (bad.length) {
  console.log('FAIL:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log(`\n${ok.length} checks passed`)
