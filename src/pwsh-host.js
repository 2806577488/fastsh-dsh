/**
 * Optional persistent PowerShell host.
 *
 * Spawning powershell.exe costs ~1.5 s per call, and every fallback pays it.
 * With `FASTSH_REUSE_ENGINE=1` fastsh keeps one host process alive and replays
 * each command inside a fresh scope (`& { 鈥?}`), so the next fallback costs
 * ~10鈥?0 ms instead of a process start.
 *
 * What is reset per call: variables, functions, aliases and the working
 * directory (the script block runs in a child scope, and the location is set
 * before every command). What is reset after each call: environment variables
 * (snapshotted at host start, restored afterwards). What is NOT isolated:
 * loaded modules/types and process-wide settings such as `[Console]` encoding 鈥? * both are what makes reuse cheap.
 *
 * A command that calls `exit` terminates the host; the client then reports the
 * host's exit code with whatever output was written, and the next call starts a
 * new host.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** `FASTSH_REUSE_ENGINE=1` opts in; anything else keeps the one-shot path. */
export function reuseEngineEnabled() {
  const flag = (process.env.FASTSH_REUSE_ENGINE ?? '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
}

const SERVER_SCRIPT = String.raw`
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$baseEnv = @{}
foreach ($key in [Environment]::GetEnvironmentVariables().Keys) { $baseEnv[$key] = [Environment]::GetEnvironmentVariable($key) }
$out = [Console]::Out
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'QUIT') { break }
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  } catch {
    $out.WriteLine('#FASTSH#-1')
    $out.Flush()
    continue
  }
  $code = 0
  try {
    Set-Location -LiteralPath $json.cwd 2> $null
    $script = '$ProgressPreference=''SilentlyContinue'';' + $json.script
    & ([scriptblock]::Create($script)) 1> $json.out 2> $json.err
    if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
  } catch {
    try { Add-Content -LiteralPath $json.err -Value $_.Exception.Message -Encoding Unicode } catch { }
    $code = 1
  }
  $LASTEXITCODE = $null
  foreach ($key in [Environment]::GetEnvironmentVariables().Keys) {
    if (-not $baseEnv.ContainsKey($key)) { [Environment]::SetEnvironmentVariable($key, $null) }
  }
  foreach ($key in $baseEnv.Keys) {
    if ([Environment]::GetEnvironmentVariable($key) -ne $baseEnv[$key]) { [Environment]::SetEnvironmentVariable($key, $baseEnv[$key]) }
  }
  $out.WriteLine('#FASTSH#' + $code)
  $out.Flush()
}
`

/** Decode a PowerShell redirection file (UTF-16LE from `>`), BOM included. */
function decodeRedirectFile(path) {
  try {
    const buffer = readFileSync(path)
    if (buffer.length === 0) return ''
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
    // A redirection file is UTF-16LE; a plain text append may leave no BOM, so
    // count the zero high bytes instead of guessing.
    let nulls = 0
    const sample = Math.min(buffer.length, 200)
    for (let i = 1; i < sample; i += 2) if (buffer[i] === 0) nulls += 1
    if (nulls > sample / 4) return buffer.toString('utf16le')
    return buffer.toString('utf8')
  } catch {
    return ''
  }
}

class PowerShellHost {
  constructor() {
    this.child = null
    this.dir = null
    this.serverPath = null
    this.pending = null
    this.queue = Promise.resolve()
    this.starting = null
  }

  ensureStarted() {
    if (this.child && !this.child.killed) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = new Promise((resolve, reject) => {
      try {
        this.dir ??= join(tmpdir(), 'dsh-fastsh', `host-${randomUUID().slice(0, 8)}`)
        mkdirSync(this.dir, { recursive: true })
        this.serverPath ??= join(this.dir, 'server.ps1')
        writeFileSync(this.serverPath, SERVER_SCRIPT, 'utf8')
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.serverPath],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        )
        this.child = child
        child.stdout.setEncoding('utf8')
        let buffer = ''
        child.stdout.on('data', (chunk) => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).replace(/\r$/, '')
            buffer = buffer.slice(index + 1)
            this.handleLine(line)
          }
        })
        child.stderr.on('data', () => {
          /* host diagnostics are not the command's stderr */
        })
        child.on('exit', (code) => {
          // A killed host must not clear the reference of a fresh one.
          if (this.child !== child) return
          this.child = null
          const pending = this.pending
          this.pending = null
          if (pending) pending.settle({ hostExit: code ?? 1 })
        })
        child.on('error', (error) => {
          if (this.child !== child) return
          this.child = null
          const pending = this.pending
          this.pending = null
          if (pending) pending.settle({ error: error?.message ?? String(error) })
          reject(error)
        })
        child.unref()
        child.stdout.unref?.()
        child.stderr.unref?.()
        resolve()
      } catch (error) {
        this.starting = null
        reject(error)
      }
    })
    this.starting.then(
      () => {
        this.starting = null
      },
      () => {
        this.starting = null
      },
    )
    return this.starting
  }

  handleLine(line) {
    if (line.startsWith('#FASTSH#')) {
      const pending = this.pending
      this.pending = null
      if (!pending) return
      const code = Number.parseInt(line.slice('#FASTSH#'.length), 10)
      pending.settle({ exitCode: Number.isFinite(code) ? code : 1 })
      return
    }
    // `Write-Host` and friends write to the host console, not to the redirected
    // streams; keep that text so it is not silently lost.
    if (this.pending && line !== '') this.pending.console += `${line}\n`
  }

  run(script, cwd, timeoutMs, signal) {
    const task = () => this.runNow(script, cwd, timeoutMs, signal)
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async runNow(script, cwd, timeoutMs, signal) {
    if (signal?.aborted) {
      return { aborted: true, exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0 }
    }
    await this.ensureStarted()
    const startedAt = Date.now()
    const id = randomUUID().slice(0, 8)
    const outPath = join(this.dir, `${id}.out`)
    const errPath = join(this.dir, `${id}.err`)
    const payload = Buffer.from(JSON.stringify({ cwd, out: outPath, err: errPath, script }), 'utf8').toString('base64')

    const outcome = await new Promise((resolve) => {
      let settled = false
      const onAbort = () => {
        this.kill()
        settle({ aborted: true })
      }
      const settle = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (this.pending === pending) this.pending = null
        resolve(value)
      }
      const pending = { console: '', settle }
      this.pending = pending
      const timer = setTimeout(() => {
        this.kill()
        settle({ timedOut: true })
      }, Math.max(1, timeoutMs))
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.child?.stdin.write(`${payload}\n`)
      } catch (error) {
        settle({ error: error?.message ?? String(error) })
      }
    })

    const stdout = decodeRedirectFile(outPath) + (outcome.console ?? '')
    const stderr = decodeRedirectFile(errPath)
    // PowerShell may still hold the redirection handle for a moment (or an AV
    // scanner does); retry, and never fail the command over cleanup.
    for (const path of [outPath, errPath]) {
      try {
        rmSync(path, { force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* the host dir is removed on stop */
      }
    }

    if (outcome.aborted) return { aborted: true, exitCode: null, timedOut: false, stdout, stderr, durationMs: Date.now() - startedAt }
    if (outcome.error) return { error: outcome.error, exitCode: null, timedOut: false, durationMs: Date.now() - startedAt }
    if (outcome.timedOut) return { exitCode: null, timedOut: true, stdout, stderr, durationMs: Date.now() - startedAt }
    if (outcome.hostExit !== undefined) {
      // `exit N` (or a crash) ended the host: the output is still on disk.
      return { exitCode: outcome.hostExit, stdout, stderr, durationMs: Date.now() - startedAt, restarted: true }
    }
    return { exitCode: outcome.exitCode, stdout, stderr, durationMs: Date.now() - startedAt }
  }

  kill() {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin.end()
      child.kill()
    } catch {
      /* already gone */
    }
  }

  stop() {
    this.kill()
    if (this.dir) {
      try {
        rmSync(this.dir, { recursive: true, force: true })
      } catch {
        /* the OS cleans %TEMP% anyway */
      }
      this.dir = null
      this.serverPath = null
    }
  }
}

let host = null

function sharedHost() {
  if (!host) {
    host = new PowerShellHost()
    const stop = () => host?.stop()
    process.once('exit', stop)
  }
  return host
}

/** Run one script through the shared host (serialised, one command at a time). */
export function runReusedPowerShell(script, cwd, timeoutMs) {
  return sharedHost().run(script, cwd, timeoutMs)
}
