/**
 * Performance guards for the native engine and the command runner.
 *
 * Thresholds are deliberately generous (about 10x the measured baseline on a
 * quiet machine): the goal is to catch order-of-magnitude regressions — a stat
 * in a listing, a whole-file read in a tail, a lost early stop — not to measure
 * this machine's speed. Run with `npm run perf` or `node test/perf.test.mjs`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runNativePowerShell } from '../src/ps.js'
import { runCommand, decodeOutput, detectPowerShell } from '../src/exec.js'

const root = join(import.meta.dirname, 'tmp-perf')
const cwd = process.cwd()
const context = { cwd, env: process.env }
const rows = []
const failures = []

function check(name, ms, limit, note = '') {
  const ok = ms <= limit
  rows.push({ name, ms, limit, ok, note })
  if (!ok) failures.push(`${name}: ${ms.toFixed(0)} ms > ${limit} ms`)
}

function timeSync(fn) {
  const started = process.hrtime.bigint()
  const value = fn()
  return [Number(process.hrtime.bigint() - started) / 1e6, value]
}

async function timeAsync(fn) {
  const started = process.hrtime.bigint()
  const value = await fn()
  return [Number(process.hrtime.bigint() - started) / 1e6, value]
}

rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'flat'), { recursive: true })
for (let i = 0; i < 1500; i++) writeFileSync(join(root, 'flat', `file-${i}.txt`), '')
for (let d = 0; d < 60; d++) {
  const dir = join(root, 'tree', `d${d}`)
  mkdirSync(dir, { recursive: true })
  for (let f = 0; f < 15; f++) writeFileSync(join(dir, `f${f}.txt`), '')
}
const bigFile = join(root, 'big.txt')
writeFileSync(bigFile, 'error: line\n'.repeat(800_000)) // ~10 MB

const flat = join(root, 'flat')
const tree = join(root, 'tree')

// Warm the worker and the module caches before measuring.
runNativePowerShell('Get-Location', context)
await runCommand({ command: 'Get-Location', cwd })

let took
;[took] = timeSync(() => runNativePowerShell('Get-Location', context))
check('native Get-Location', took, 100)

;[took] = timeSync(() => runNativePowerShell(`Get-ChildItem "${flat}" -Name`, context))
check('gci -Name 1500 files (must not stat)', took, 300)

;[took] = timeSync(() => runNativePowerShell(`Get-ChildItem "${tree}" -Recurse -Filter *.txt -Name`, context))
check('gci -Recurse -Filter 900 files', took, 1500)

;[took] = timeSync(() =>
  runNativePowerShell(`Get-ChildItem "${tree}" -Recurse -Filter *.txt -Name | Select-Object -First 1`, context),
)
check('gci -Recurse | Select-Object -First 1', took, 300)

;[took] = timeSync(() => runNativePowerShell(`Select-String -Path "${bigFile}" -Pattern no-such-text`, context))
check('Select-String 10 MB (must stream)', took, 1500)

;[took] = timeSync(() => runNativePowerShell(`Get-Content "${bigFile}" -Tail 5`, context))
check('Get-Content -Tail 5 on 10 MB', took, 400)

const [tailTime] = timeSync(() => runNativePowerShell(`Get-Content "${bigFile}" -Tail 5`, context))
const [fullTime] = timeSync(() => runNativePowerShell(`Get-Content "${bigFile}"`, context))
if (!(tailTime * 3 < fullTime)) {
  failures.push(`tail read is not windowed: ${tailTime.toFixed(0)} ms vs full ${fullTime.toFixed(0)} ms`)
}

;[took] = timeSync(() => decodeOutput(Buffer.from('x'.repeat(10 * 1024 * 1024))))
check('decodeOutput 10 MB', took, 500)

const bigCommand = `Get-ChildItem C:\\ -Name | Select-Object -First 1 ${'echo filler '.repeat(8000)}`
;[took] = timeSync(() => detectPowerShell(bigCommand))
check('detectPowerShell 96 KB', took, 50)

;[took] = await timeAsync(() => runCommand({ command: 'Get-Location', cwd }))
check('runCommand native end-to-end (worker)', took, 1500)

rmSync(root, { recursive: true, force: true })

for (const row of rows) {
  console.log(
    `${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(46)} ${row.ms.toFixed(0).padStart(7)} ms  (limit ${row.limit})`,
  )
}
console.log(`\n${rows.length - failures.length}/${rows.length} performance checks passed`)
if (failures.length > 0) {
  console.log('FAIL:\n  ' + failures.join('\n  '))
  process.exit(1)
}
