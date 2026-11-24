/**
 * fastsh core: run one Windows command line with cmd.exe (or PowerShell),
 * decode its output robustly, and report a compact, JSON-serialisable result.
 *
 * Design constraints (see README.md):
 *  - The child process inherits this process' token and environment, so it has
 *    exactly the permissions the user launched DSH with (same as PowerShell).
 *  - Bytes are never transcoded on the way to a file: `>` / `>>` are handled by
 *    cmd itself, which writes the program's raw bytes. Only the captured
 *    stdout/stderr text is decoded for display.
 *  - No shell startup state, no profile, no module imports by the shell.
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

export const DEFAULT_TIMEOUT_MS = 120_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 600_000
export const DEFAULT_MAX_CHARS = 200_000

/** Hard cap on bytes retained per stream (the tail is kept). */
const MAX_COLLECT_BYTES = 16 * 1024 * 1024

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const utf8 = new TextDecoder('utf-8')
const utf16le = new TextDecoder('utf-16le')
const utf16be = new TextDecoder('utf-16be')
const latin1 = new TextDecoder('latin1')

/** System ANSI fallback: GBK on this machine (code page 936), then Western. */
let ansiDecoder = null
let ansiLabel = 'latin1'
for (const label of ['gbk', 'windows-1252']) {
  try {
    ansiDecoder = new TextDecoder(label)
    ansiLabel = label
    break
  } catch {
    /* encoding not compiled in */
  }
}
if (!ansiDecoder) ansiDecoder = latin1

/**
 * Decode one captured stream without guessing wrong on valid UTF-8.
 * BOMs win outright; otherwise strict UTF-8 is tried first and the system
 * ANSI code page is the fallback (cp936 output from legacy tools).
 */
export function decodeOutput(buffer, forced = 'auto') {
  if (!buffer || buffer.length === 0) return { text: '', encoding: 'none' }

  if (forced && forced !== 'auto') {
    switch (forced) {
      case 'utf8':
        return { text: utf8.decode(buffer), encoding: 'utf-8' }
      case 'gbk':
        return { text: (ansiLabel === 'gbk' ? ansiDecoder : utf8).decode(buffer), encoding: 'gbk' }
      case 'utf16le':
        return { text: utf16le.decode(buffer), encoding: 'utf-16le' }
      default:
        break
    }
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: utf16le.decode(buffer.subarray(2)), encoding: 'utf-16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: utf16be.decode(buffer.subarray(2)), encoding: 'utf-16be' }
  }
  const body =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer

  try {
    return { text: utf8Strict.decode(body), encoding: 'utf-8' }
  } catch {
    return { text: ansiDecoder.decode(body), encoding: ansiLabel }
  }
}

export function clampTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)))
}

export function clampMaxChars(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS
  return Math.min(2_000_000, Math.max(1_000, Math.floor(n)))
}

const MIN_JOB_OUTPUT_BYTES = 16 * 1024
const MAX_JOB_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * Per-job live output cap for the jobs ring buffer.
 * Omitted or invalid values return undefined so the service default applies.
 */
export function clampOutputLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(MAX_JOB_OUTPUT_BYTES, Math.max(MIN_JOB_OUTPUT_BYTES, Math.floor(n)))
}

// ---------------------------------------------------------------------------
// watch：产物哈希对比
// ---------------------------------------------------------------------------

/** 一次最多对比多少个文件，防止一条命令把时间全花在采样上。 */
const MAX_WATCH_FILES = 32
/** 文本行里只显示哈希前 8 位，完整值留在结果字段里。 */
const WATCH_HASH_CHARS = 8

/** 清理并去重 watch 参数：只接受非空字符串。 */
export function normalizeWatchList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    if (out.length >= MAX_WATCH_FILES) break
  }
  return out
}

/**
 * 采样一个文件：sha256 + 字节数。
 * 不存在记 missing，读不到（权限、目录）记 error——采样失败绝不让命令失败。
 * mtimeMs 只留在内部：命令结束后 mtime+size 没变时直接复用这份哈希。
 */
function sampleOne(resolved, display) {
  try {
    const stats = statSync(resolved)
    if (!stats.isFile()) return { path: display, resolved, state: 'error', error: 'not a regular file' }
    const sha256 = createHash('sha256').update(readFileSync(resolved)).digest('hex')
    return { path: display, resolved, state: 'file', sha256, size: stats.size, mtimeMs: stats.mtimeMs }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { path: display, resolved, state: 'missing' }
    return { path: display, resolved, state: 'error', error: String(error?.code ?? error?.message ?? error) }
  }
}

/**
 * 命令执行前采样。相对路径按 workdir 解析，和命令本身看到的路径一致。
 * @returns {{ files: string[], before: object[] } | null}
 */
export function snapshotWatch(watch, cwd = process.cwd()) {
  const files = normalizeWatchList(watch)
  if (files.length === 0) return null
  const before = files.map((file) => sampleOne(isAbsolute(file) ? file : resolve(cwd, file), file))
  return { files, before }
}

/** 结果对象里用的精简样本：完整哈希保留，展示细节交给 formatWatchReport。 */
function publicSample(entry, goneWhenMissing) {
  if (entry.state === 'file') return { sha256: entry.sha256, size: entry.size }
  if (entry.state === 'missing') return goneWhenMissing ? { gone: true } : { missing: true }
  return { error: entry.error }
}

/**
 * 命令结束后再次采样并对比，返回结构化报告。
 * 前后完全一致（哈希、字节数、状态都没变）时 changed 为 false。
 */
export function finishWatch(snapshot, cwd = process.cwd()) {
  if (!snapshot) return null
  const after = snapshot.before.map((entry) => {
    const resolved = isAbsolute(entry.path) ? entry.path : resolve(cwd, entry.path)
    // mtime+size 都没变：直接复用命令前的哈希，不再把整个文件读一遍。
    // 代价是“保住 mtime 且大小不变”的写入会被判为未变化；这是性能换来的，
    // 与安全路径无关，所以单独成一处、单独提交。
    if (entry.state === 'file' && entry.mtimeMs !== undefined) {
      try {
        const stats = statSync(resolved)
        if (stats.isFile() && stats.mtimeMs === entry.mtimeMs && stats.size === entry.size) return { ...entry }
      } catch {
        /* 走了完整采样，缺失/错误照常记录 */
      }
    }
    return sampleOne(resolved, entry.path)
  })
  return snapshot.before.map((entry, index) => {
    const next = after[index]
    const changed = entry.state !== next.state || entry.sha256 !== next.sha256 || entry.size !== next.size
    return {
      path: entry.path,
      before: publicSample(entry, false),
      after: publicSample(next, entry.state === 'file'),
      changed,
    }
  })
}

/**
 * 人类可读的多行报告，例如：
 *   watch  out.png
 *          before 31bf9a2c  (1,234,567 B)
 *          after  31bf9a2c  (1,234,567 B)   ← 未变化
 */
export function formatWatchReport(report) {
  if (!Array.isArray(report) || report.length === 0) return ''
  const size = (bytes) => Number(bytes).toLocaleString('en-US')
  const one = (sample) => {
    if (!sample) return 'unknown'
    if (sample.gone) return 'gone'
    if (sample.missing) return 'missing'
    if (sample.error) return `error: ${sample.error}`
    const hash = String(sample.sha256 ?? '')
    return `${hash.slice(0, WATCH_HASH_CHARS)}  (${size(sample.size ?? 0)} B)`
  }
  const lines = []
  for (const entry of report) {
    lines.push(`watch  ${entry.path}`)
    lines.push(`       before ${one(entry.before)}`)
    const afterLine = `       after  ${one(entry.after)}`
    lines.push(entry.changed ? afterLine : `${afterLine}   ← 未变化`)
  }
  return lines.join('\n')
}

/**
 * PowerShell's approved verbs, as `Verb-Noun`. A command line containing one
 * is PowerShell, because no cmd built-in or typical external program spells
 * itself that way.
 */
const POWERSHELL_VERB =
  /\b(?:Add|Backup|Checkpoint|Clear|Close|Compare|Complete|Compress|Confirm|Convert|ConvertFrom|ConvertTo|Copy|Debug|Deny|Deploy|Disable|Dismount|Edit|Enable|Enter|Exit|Expand|Export|Find|ForEach|Format|Get|Group|Hide|Import|Initialize|Install|Invoke|Join|Limit|Lock|Measure|Merge|Mount|Move|New|Open|Optimize|Out|Ping|Pop|Publish|Push|Read|Receive|Redo|Register|Remove|Rename|Repair|Request|Reset|Resize|Resolve|Restart|Restore|Resume|Save|Search|Select|Send|Set|Show|Skip|Sort|Split|Start|Step|Stop|Submit|Suspend|Switch|Sync|Tee|Test|Trace|Undo|Uninstall|Unlock|Unpublish|Unregister|Update|Use|Wait|Watch|Where|Write)-\w+/i

/** PowerShell-only syntax that never appears in a valid cmd command line. */
const POWERSHELL_MARKER =
  /(\$env:|\$_|\$null\b|\$true\b|\$false\b|\$PSVersionTable|\$PSScriptRoot|\$args\b|\$input\b|\[System\.|\[string\]|\[int\]|\[bool\]|\[math\]::|\w+::[A-Za-z]|@\{)/

/**
 * `& exe` 是 PowerShell 的调用运算符，但模型常把它误写进本来该走 cmd 的命令：
 * 一旦命令里还有 `&&`，cmd 会直接报「此时不应有 &」。auto 模式只剥离开头那
 * 一个 `&`；出现在中间的 `&` 是 cmd 的连接符，必须保持原样。
 */
export function stripLeadingCallOperator(command, shell) {
  if (typeof command !== 'string' || shell !== 'auto') return command
  if (!/^\s*&(?!&)/.test(command)) return command
  return command.replace(/^\s*&/, '')
}

/**
 * 明显的「程序 + 参数」形态：`python -c "…"` / `py -c "…"` / `node -e "…"`。
 * 脚本内容里的 `$env:` 之类只是程序参数，不代表外层 shell 是 PowerShell。
 */
const SCRIPT_LAUNCHER =
  /^\s*(?:&\s*)?(?:python(?:\d+(?:\.\d+)?)?|py|node|nodejs)(?:\.exe)?\s+(?:-c|-e|--eval|--exec)\b/i

/**
 * Guess whether a command line is PowerShell rather than cmd.
 * Conservative on purpose: every pattern here is absent from ordinary cmd
 * commands, so a false negative just falls back to cmd's error message.
 */
/** Blank out quoted spans (same length) so operators inside them are ignored. */
function blankQuoted(text) {
  let out = ''
  let quote = null
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      out += ' '
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

export function detectPowerShell(command) {
  if (typeof command !== 'string' || command.length === 0) return false

  // 程序 + 参数：脚本里的引号和 `$` 不参与 shell 判定，交给 cmd 原样透传。
  if (SCRIPT_LAUNCHER.test(command)) return false

  // Quoted spans are blanked so markers inside strings never decide the shell.
  const bare = blankQuoted(command)

  // `&&` and a mid-line `&` belong to cmd: PowerShell 5.1 rejects `&&`, and
  // routing such a command to PowerShell would only produce a syntax error.
  if (bare.includes('&&')) return false
  if (bare.indexOf('&') > 0) return false

  // A leading `&` is PowerShell's call operator.
  if (/^\s*&/.test(bare)) return true

  return POWERSHELL_VERB.test(bare) || POWERSHELL_MARKER.test(bare)
}

/**
 * Models often wrap a PowerShell script in a launcher, e.g. they call fastsh
 * with a whole `powershell -NoProfile -Command "<script>"` line. Running that
 * through cmd.exe loses the inner quoting (`\"` is not an escape there) and
 * collapses newlines, so the inner script arrives broken. Recognise the
 * launcher and return the script itself, so it can take the same
 * `-EncodedCommand` path as native PowerShell syntax.
 *
 * Values: null when the command is not a launcher, `{ error }` when the
 * wrapper cannot be parsed safely, `{ script }` otherwise.
 */
export function unwrapPowerShellInvocation(command) {
  if (typeof command !== 'string') return null
  const launcher = /^\s*(?:powershell|pwsh)(?:\.exe)?\b([\s\S]*)$/i.exec(command)
  if (!launcher) return null
  const rest = launcher[1]

  const encoded = /(?:^|\s)-(?:encodedcommand|enc|e)\b\s+([A-Za-z0-9+/=]+)\s*$/i.exec(rest)
  if (encoded) {
    try {
      return { script: Buffer.from(encoded[1], 'base64').toString('utf16le') }
    } catch (error) {
      return { error: `cannot decode -EncodedCommand: ${error?.message ?? error}` }
    }
  }

  const inline = /(?:^|\s)-(?:command|com|c)\b([\s\S]*)$/i.exec(rest)
  if (!inline) return null
  let body = inline[1].trim()
  if (body.length === 0) return { error: 'powershell -Command was given no script' }

  const quote = body[0]
  if (quote === '"' || quote === "'") {
    if (body.length < 2 || body[body.length - 1] !== quote) {
      return {
        error:
          'powershell -Command has an unterminated quote, so the script cannot be passed ' +
          'through intact. Put the script in a .ps1 file and run it with `powershell ' +
          '-NoProfile -ExecutionPolicy Bypass -File <path>`, or use Python for text edits.',
      }
    }
    body = body.slice(1, -1)
    // cmd's rule for a quoted argument: a doubled quote is one literal quote.
    body = quote === '"' ? body.replace(/""/g, '"') : body.replace(/''/g, "'")
  }
  return body.trim().length === 0
    ? { error: 'powershell -Command was given an empty script' }
    : { script: body }
}

function shellCommand(command, shell) {
  // auto 模式先剥离开头的 `&`（PowerShell 调用运算符的误写），再判断走谁。
  const normalized = stripLeadingCallOperator(command, shell)
  // A launcher wrapper is peeled off first: the script inside it is what must
  // run, and leaving it to cmd.exe would corrupt it before PowerShell sees it.
  const unwrapped = shell === 'cmd' ? null : unwrapPowerShellInvocation(normalized)
  if (unwrapped?.error) return { error: unwrapped.error }
  const script = unwrapped?.script ?? normalized

  const usePowerShell =
    shell === 'powershell' ||
    (shell !== 'cmd' && (unwrapped !== null || detectPowerShell(script)))

  if (usePowerShell) {
    const prologue =
      "$ProgressPreference='SilentlyContinue';" +
      "$WarningPreference='Continue';" +
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      '$OutputEncoding=[System.Text.Encoding]::UTF8;'
    const encoded = Buffer.from(prologue + script, 'utf16le').toString('base64')
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      options: {},
    }
  }
  // cmd.exe via Node's shell mode: `cmd.exe /d /s /c "<command>"` verbatim,
  // so the caller's quoting and operators reach cmd unchanged.
  // cmd.exe stops at the first newline, so a multi-line command silently loses
  // every line after the first. Chain them with cmd's own separator instead.
  return { file: script.replace(/\r?\n/g, ' & '), args: [], options: { shell: true } }
}

/**
 * Kill one process tree. `taskkill /t` must run while the parent is still
 * alive, otherwise its children are reparented and it finds nothing.
 */
function terminateTree(pid, fallback) {
  const giveUp = () => {
    try {
      fallback?.()
    } catch {
      /* already gone */
    }
  }
  if (!pid) {
    giveUp()
    return
  }
  try {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', giveUp)
    killer.on('close', (code) => {
      if (code !== 0) giveUp()
    })
  } catch {
    giveUp()
  }
}

function tailLimit() {
  const chunks = []
  let total = 0
  let dropped = 0
  return {
    push(chunk) {
      chunks.push(chunk)
      total += chunk.length
      // Trim whole chunks so a multi-byte character is never split.
      while (total > MAX_COLLECT_BYTES && chunks.length > 1) {
        const removed = chunks.shift()
        total -= removed.length
        dropped += removed.length
      }
    },
    result() {
      return { buffer: Buffer.concat(chunks), truncated: dropped > 0 || total > MAX_COLLECT_BYTES }
    },
  }
}

function spillFullText(text) {
  try {
    const dir = join(tmpdir(), 'dsh-fastsh')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${randomUUID()}.log`)
    writeFileSync(path, text, 'utf8')
    return path
  } catch {
    return undefined
  }
}

/** 裁剪时最多捞回多少行错误行，以及单行最多多长。 */
const MAX_ERROR_LINES = 20
const MAX_ERROR_LINE_CHARS = 400
const ERROR_LINE_PATTERN = /error|fail|MISS|denied|refused/i

/**
 * 从将被裁掉的中间段里挑出错误行。去重后按出现顺序取前 20 行：
 * 同一句错误刷屏时，重复 20 遍只是噪音。
 */
function collectErrorLines(text, from, to) {
  const hits = []
  const seen = new Set()
  for (const rawLine of text.slice(from, to).split(/\r?\n/)) {
    if (hits.length >= MAX_ERROR_LINES) break
    if (!ERROR_LINE_PATTERN.test(rawLine)) continue
    const line = rawLine.trim().slice(0, MAX_ERROR_LINE_CHARS)
    if (!line || seen.has(line)) continue
    seen.add(line)
    hits.push(line)
  }
  return hits
}

function shape(text, maxChars, encoding) {
  if (text.length <= maxChars) return { text, truncated: false, encoding }
  const head = Math.floor(maxChars * 0.35)
  const tail = maxChars - head
  const fullOutputPath = spillFullText(text)
  // 被裁掉的那段里如果有 ERROR / FAIL / MISS / denied / refused，通常才是
  // 模型下一步要看的结论。宁可多留几十行，也不能把它们裁没。
  const errorLines = collectErrorLines(text, head, text.length - tail)
  const errorBlock = errorLines.length
    ? `\n\n… 被裁剪的错误行 …\n${errorLines.join('\n')}\n… 错误行结束 …\n`
    : ''
  return {
    text:
      `${text.slice(0, head)}\n\n... [${text.length - maxChars} characters omitted] ...` +
      `${errorBlock}\n\n${text.slice(-tail)}`,
    truncated: true,
    encoding,
    fullOutputPath,
  }
}

// ---------------------------------------------------------------------------
// 命令文本里的危险替换
// ---------------------------------------------------------------------------

/**
 * 这些痕迹同时出现时，多半是模型想用 shell 拼字符串做文本替换——多行脚本
 * 或嵌套引号必然在 cmd / PowerShell 里被吞坏。只提示，不改执行行为。
 */
const TEXT_REPLACE_PATTERN = /\.Replace\(|-replace\b|sed\s+-i\b|Set-Content\b/i

export function detectTextReplacement(command) {
  if (typeof command !== 'string' || command === '') return []
  if (!TEXT_REPLACE_PATTERN.test(command)) return []
  const multiline = /[\r\n]/.test(command)
  const quotes = (command.match(/["']/g) ?? []).length
  if (!multiline && quotes < 3) return []
  return ['⚠ 疑似 shell 文本替换：改用 edit 工具或 Python（sys.exit(1)）']
}

// ---------------------------------------------------------------------------
// 删除类命令的提醒
// ---------------------------------------------------------------------------

/** 命令位置上的删除动词（行首，或 `|`、`;`、`&` 之后的一级命令）。 */
const DELETE_COMMAND =
  /(?:^|[|;&]\s*)(?:Remove-Item|rm|del|erase|rd|rmdir|\[System\.IO\.(?:File|Directory)\]::Delete)\b/i
/** 递归删除：PowerShell 的 -Recurse、cmd 的 /s。 */
const DELETE_RECURSIVE = /(?:^|\s)-recurse\b|\/s\b/i
/** 强制/静默删除：PowerShell 的 -Force、cmd 的 /f 与 /q。 */
const DELETE_FORCE = /(?:^|\s)-force\b|\/[fq]\b/i

/**
 * 递归或强制删除是唯一值得在结果最前面提醒的删除形态；普通 `del a.txt`
 * 不提示，否则每次清临时文件都多一行噪音。只提示，不改执行行为。
 */
export function detectDeleteRisk(command) {
  if (typeof command !== 'string' || command === '') return []
  if (!DELETE_COMMAND.test(command)) return []
  if (!DELETE_RECURSIVE.test(command) && !DELETE_FORCE.test(command)) return []
  return ['⚠ 删除类命令（递归/强制）：确认目标是产物或临时目录']
}

// ---------------------------------------------------------------------------
// Native engine isolation
// ---------------------------------------------------------------------------

const NATIVE_TIMEOUT_MS = 60_000
let nativeWorker = null
let nativeSequence = 0
const nativePending = new Map()
let nativeChain = Promise.resolve()

function failNativeWorker(error) {
  const pending = [...nativePending.values()]
  nativePending.clear()
  for (const entry of pending) entry.reject(error)
  nativeWorker = null
}

function ensureNativeWorker() {
  if (nativeWorker) return nativeWorker
  const worker = new Worker(new URL('./native-worker.mjs', import.meta.url))
  worker.on('message', (message) => {
    const entry = nativePending.get(message.id)
    if (!entry) return
    nativePending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error))
    else entry.resolve(message.result)
  })
  worker.on('error', (error) => failNativeWorker(error))
  worker.on('exit', () => {
    if (nativeWorker === worker) nativeWorker = null
    failNativeWorker(new Error('native worker exited'))
  })
  worker.unref()
  nativeWorker = worker
  return worker
}

/**
 * One native command at a time. On timeout the wedged worker is terminated —
 * the only reliable way to stop a catastrophic regex — and the next call gets
 * a fresh one.
 */
function runNativeIsolated(command, cwd, timeoutMs, signal) {
  const run = () =>
    new Promise((resolve) => {
      let worker
      try {
        worker = ensureNativeWorker()
      } catch (error) {
        resolve({ error: error?.message ?? String(error) })
        return
      }

      const id = ++nativeSequence
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        nativePending.delete(id)
        resolve(value)
      }
      const onAbort = () => {
        settle({ aborted: true })
        worker.terminate().catch(() => {})
      }
      const timer = setTimeout(() => {
        settle({ timedOut: true })
        worker.terminate().catch(() => {})
      }, timeoutMs)

      if (signal) {
        if (signal.aborted) {
          settle({ aborted: true })
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      nativePending.set(id, {
        resolve: (result) => settle(result),
        reject: (error) => settle({ error: error?.message ?? String(error) }),
      })
      try {
        worker.postMessage({ id, command, cwd })
      } catch (error) {
        settle({ error: error?.message ?? String(error) })
      }
    })

  const next = nativeChain.then(run, run)
  nativeChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function nativeAbortedResult(startedAt) {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: true,
    durationMs: Date.now() - startedAt,
    stdout: '',
    stderr: '',
    stdoutEncoding: 'none',
    stderrEncoding: 'none',
    truncated: false,
  }
}

function nativeTimedOutResult(startedAt) {
  return {
    exitCode: null,
    signal: null,
    timedOut: true,
    aborted: false,
    durationMs: Date.now() - startedAt,
    stdout: '',
    stderr: '',
    stdoutEncoding: 'none',
    stderrEncoding: 'none',
    truncated: false,
  }
}

/**
 * Run one command to completion.
 * @param {{ command: string, cwd: string, timeoutMs?: number, maxChars?: number,
 *           shell?: 'cmd'|'powershell', encoding?: string, logFile?: string }} request
 * @param {AbortSignal} [signal]
 */
export function runCommand(request, signal) {
  const { command: rawCommand, cwd, shell = 'auto', encoding = 'auto', logFile, watch } = request
  // 误写的调用运算符在 auto 模式先剥掉，否则 cmd 会报「此时不应有 &」。
  const command = stripLeadingCallOperator(rawCommand, shell)
  const timeoutMs = clampTimeout(request.timeoutMs)
  const maxChars = clampMaxChars(request.maxChars)
  const startedAt = Date.now()

  // 采样必须在命令启动之前完成，所以放在任何异步分支之前。
  const watchSnapshot = snapshotWatch(watch, cwd)
  const warnings = [...detectTextReplacement(request.command), ...detectDeleteRisk(request.command)]
  const finalizeResult = (result) => {
    let out = result
    if (watchSnapshot) {
      const report = finishWatch(watchSnapshot, cwd)
      if (report) out = { ...out, watchReport: report }
    }
    if (warnings.length) out = { ...out, warnings }
    return out
  }

  const execute = (native) =>
    new Promise((resolve) => {
      let { file, args, options, error } = shellCommand(command, shell)

    if (error) {
      resolve({
        error,
        exitCode: null,
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: error,
        stdoutEncoding: 'none',
        stderrEncoding: 'none',
        truncated: false,
      })
      return
    }

    if (signal?.aborted) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        durationMs: 0,
        stdout: '',
        stderr: '',
        stdoutEncoding: 'none',
        stderrEncoding: 'none',
        truncated: false,
      })
      return
    }

    if (native) {
      if (native.delegate) {
        // `& exe args` runs the target directly, without a shell wrapper.
        file = native.delegate.file
        args = native.delegate.args
        options = {}
      } else {
        const out = shape(native.stdout ?? '', maxChars, 'utf-8')
        const err = shape(native.stderr ?? '', maxChars, 'utf-8')
        if (logFile) {
          try {
            mkdirSync(dirname(logFile), { recursive: true })
            writeFileSync(logFile, `${native.stdout ?? ''}${native.stderr ?? ''}`, 'utf8')
          } catch {
            /* the result still reports the text */
          }
        }
        resolve({
          exitCode: native.exitCode ?? 0,
          signal: null,
          timedOut: false,
          aborted: false,
          durationMs: Date.now() - startedAt,
          stdout: out.text,
          stderr: err.text,
          stdoutEncoding: 'utf-8',
          stderrEncoding: 'utf-8',
          truncated: out.truncated || err.truncated,
          ...(logFile ? { logPath: logFile } : {}),
          ...(out.fullOutputPath ? { fullOutputPath: out.fullOutputPath } : {}),
        })
        return
      }
    }

    // Raw child bytes also go to the caller's log file, so a long run keeps a
    // complete transcript even when the job ring has to drop old output.
    let logFd = null
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true })
        logFd = openSync(logFile, 'w')
      } catch (error) {
        resolve({
          error: `cannot open logFile ${logFile}: ${error?.message ?? error}`,
          exitCode: null,
          timedOut: false,
          aborted: false,
          durationMs: Date.now() - startedAt,
          stdout: '',
          stderr: '',
          stdoutEncoding: 'none',
          stderrEncoding: 'none',
          truncated: false,
        })
        return
      }
    }

    const closeLog = () => {
      if (logFd === null) return
      try {
        closeSync(logFd)
      } catch {
        /* already closed */
      }
      logFd = null
    }

    const stdout = tailLimit()
    const stderr = tailLimit()

    let child
    try {
      child = spawn(file, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
      })
    } catch (error) {
      resolve({
        error: error?.message ?? String(error),
        exitCode: null,
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        stdoutEncoding: 'none',
        stderrEncoding: 'none',
        truncated: false,
      })
      return
    }

    let settled = false
    let timedOut = false
    let aborted = false
    let timer = null
    let forceTimer = null

    const finish = (payload) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      closeLog()
      resolve(payload)
    }

    /** A killed tree can still hold pipe handles open; settle anyway. */
    const armForceSettle = () => {
      if (forceTimer) return
      forceTimer = setTimeout(() => {
        const out = stdout.result()
        const err = stderr.result()
        const outText = decodeOutput(out.buffer, encoding)
        const errText = decodeOutput(err.buffer, encoding)
        const shapedOut = shape(outText.text, maxChars, outText.encoding)
        const shapedErr = shape(errText.text, maxChars, errText.encoding)
        finish({
          exitCode: null,
          signal: null,
          timedOut,
          aborted,
          durationMs: Date.now() - startedAt,
          stdout: shapedOut.text,
          stderr: shapedErr.text,
          stdoutEncoding: shapedOut.encoding,
          stderrEncoding: shapedErr.encoding,
          truncated: true,
        })
      }, 5_000)
    }

    const requestKill = () => {
      terminateTree(child.pid, () => child.kill())
      armForceSettle()
    }

    function onAbort() {
      aborted = true
      requestKill()
    }

    if (signal) {
      if (signal.aborted) {
        aborted = true
        requestKill()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    timer = setTimeout(() => {
      timedOut = true
      requestKill()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (logFd !== null) {
        try {
          writeSync(logFd, chunk)
        } catch {
          /* a full disk must not abort the command */
        }
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (logFd !== null) {
        try {
          writeSync(logFd, chunk)
        } catch {
          /* ignore */
        }
      }
      stderr.push(chunk)
    })

    child.on('error', (error) => {
      finish({
        error: error?.message ?? String(error),
        exitCode: null,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        stdoutEncoding: 'none',
        stderrEncoding: 'none',
        truncated: false,
      })
    })

    child.on('close', (exitCode, exitSignal) => {
      const out = stdout.result()
      const err = stderr.result()
      const outText = decodeOutput(out.buffer, encoding)
      const errText = decodeOutput(err.buffer, encoding)
      const shapedOut = shape(outText.text, maxChars, outText.encoding)
      const shapedErr = shape(errText.text, maxChars, errText.encoding)
      finish({
        exitCode,
        signal: exitSignal ?? null,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdout: shapedOut.text,
        stderr: shapedErr.text,
        stdoutEncoding: shapedOut.encoding,
        stderrEncoding: shapedErr.encoding,
        truncated: out.truncated || err.truncated || shapedOut.truncated || shapedErr.truncated,
        ...(logFile ? { logPath: logFile } : {}),
        ...(shapedOut.fullOutputPath ? { fullOutputPath: shapedOut.fullOutputPath } : {}),
        ...(shapedErr.fullOutputPath && !shapedOut.fullOutputPath
          ? { fullOutputPath: shapedErr.fullOutputPath }
          : {}),
      })
    })
    })

  // `shell: "cmd"` must stay on cmd: the native PowerShell subset would parse
  // `& echo hi` as the call operator and spawn a bare `echo`, which fails.
  if (
    shell === 'cmd' ||
    shell === 'powershell' ||
    !detectPowerShell(command)
  ) {
    return execute(null).then(finalizeResult)
  }

  // A native command runs in a worker, so a runaway regex or a huge listing
  // can be terminated instead of freezing the host process.
  return runNativeIsolated(command, cwd, Math.min(timeoutMs, NATIVE_TIMEOUT_MS), signal)
    .then((native) => {
      if (!native) return execute(null)
      if (native.aborted) return nativeAbortedResult(startedAt)
      if (native.timedOut) return nativeTimedOutResult(startedAt)
      if (native.error) return execute(null)
      return execute(native)
    })
    .catch(() => execute(null))
    .then(finalizeResult)
}

/**
 * Start one detached command whose stdout/stderr go to UTF-8 log files.
 * The caller gets the pid and the paths, so the run survives this turn.
 */
export function runInBackground(request) {
  const { command, cwd, shell = 'auto', logFile, watch } = request
  const { file, args, options, error } = shellCommand(command, shell)
  if (error) throw new Error(error)
  const watchSnapshot = snapshotWatch(watch, cwd)
  const dir = join(tmpdir(), 'dsh-fastsh')
  mkdirSync(dir, { recursive: true })
  const id = randomUUID().slice(0, 8)
  const stdoutPath = logFile ?? join(dir, `${id}.out.log`)
  const stderrPath = logFile ? `${logFile}.err` : join(dir, `${id}.err.log`)
  if (logFile) mkdirSync(dirname(logFile), { recursive: true })

  const out = openSync(stdoutPath, 'w')
  const err = openSync(stderrPath, 'w')
  try {
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', out, err],
      ...options,
    })
    // 分离进程不等它结束；进程 close 之后把产物对比报告追加进 stdout 日志。
    if (watchSnapshot) {
      const snapshot = watchSnapshot
      child.on('close', () => {
        const text = formatWatchReport(finishWatch(snapshot, cwd))
        if (!text) return
        try {
          appendFileSync(stdoutPath, `\n${text}\n`, 'utf8')
        } catch {
          /* 日志不可写时报告丢失，但不能影响命令本身 */
        }
      })
    }
    child.unref()
    return { pid: child.pid, stdoutPath, stderrPath, command }
  } finally {
    closeSync(out)
    closeSync(err)
  }
}

// ---------------------------------------------------------------------------
// Streaming decode for live job output
// ---------------------------------------------------------------------------

/** How many non-ASCII bytes to hold before committing to UTF-8. */
const DECIDE_AFTER_BYTES = 8 * 1024
const MAX_PENDING_BYTES = 256 * 1024

function isAscii(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) return false
  return true
}

/**
 * Walk a byte prefix as UTF-8.
 * `invalid` means it can never be UTF-8; `incomplete` is how many trailing
 * bytes still form an unfinished sequence (wait for the next chunk).
 */
function validateUtf8(buf) {
  let i = 0
  while (i < buf.length) {
    const byte = buf[i]
    if (byte < 0x80) {
      i += 1
      continue
    }
    let need
    if (byte >= 0xc2 && byte <= 0xdf) need = 1
    else if (byte >= 0xe0 && byte <= 0xef) need = 2
    else if (byte >= 0xf0 && byte <= 0xf4) need = 3
    else return { invalid: true, incomplete: 0 }
    if (i + need >= buf.length) return { invalid: false, incomplete: buf.length - i }
    for (let k = 1; k <= need; k++) {
      const continuation = buf[i + k]
      if (continuation < 0x80 || continuation > 0xbf) return { invalid: true, incomplete: 0 }
    }
    i += need + 1
  }
  return { invalid: false, incomplete: 0 }
}

function labelFor(value) {
  if (value === 'utf8') return 'utf-8'
  if (value === 'gbk') return ansiLabel === 'gbk' ? 'gbk' : ansiLabel
  if (value === 'utf16le') return 'utf-16le'
  return 'utf-8'
}

/**
 * Incremental decoder that never splits a multi-byte character across chunks.
 * In "auto" mode it stays undecided while the stream is ASCII, then commits to
 * UTF-8 when the held bytes are valid UTF-8 up to a line break (or ~8 KiB),
 * and to the system ANSI code page as soon as the bytes cannot be UTF-8.
 */
export function createStreamDecoder(forced = 'auto') {
  let decoder = null
  let decided = null
  let pending = []
  let pendingBytes = 0

  const start = (label, carry) => {
    decided = label
    decoder = new TextDecoder(label)
    pending = []
    pendingBytes = 0
    return decoder.decode(carry, { stream: true })
  }

  return {
    get encoding() {
      return decided
    },
    push(chunk) {
      if (!chunk || chunk.length === 0) return ''
      if (decoder) return decoder.decode(chunk, { stream: true })

      if (forced !== 'auto') return start(labelFor(forced), chunk)

      // Pure ASCII is identical in every encoding, so emit it right away.
      if (pendingBytes === 0 && isAscii(chunk)) return chunk.toString('latin1')

      pending.push(chunk)
      pendingBytes += chunk.length
      const all = Buffer.concat(pending)

      const verdict = validateUtf8(all)
      if (verdict.invalid) return start(ansiLabel, all)
      if (verdict.incomplete === 0 && (all.includes(0x0a) || pendingBytes >= DECIDE_AFTER_BYTES)) {
        return start('utf-8', all)
      }
      if (pendingBytes > MAX_PENDING_BYTES) return start('utf-8', all)
      return ''
    },
    flush() {
      if (decoder) return decoder.decode()
      if (pending.length === 0) return ''
      const all = Buffer.concat(pending)
      pending = []
      pendingBytes = 0
      return all.toString('utf8')
    },
  }
}

// ---------------------------------------------------------------------------
// DSH job integration
// ---------------------------------------------------------------------------

/**
 * Start one command as a DSH-owned background job.
 *
 * The registry pumps `job.append` text into its output ring, so cancel/kill,
 * `job_output`, `job_list` and session teardown all work. The job's owner is
 * the calling Agent's session, which is what fences access.
 *
 * @param {{
 *   jobs: import('@deepseek-ai/cordis').Context['jobs'],
 *   command: string, cwd: string, shell?: 'cmd'|'powershell', encoding?: string,
 *   label: string, owner?: string, toolCall?: { callId: string, rootCallId: string },
 * }} request
 * @returns {string} the registry-issued job id
 */
export function startBackgroundJob(request) {
  const { jobs, command, cwd, shell = 'auto', encoding = 'auto', label, owner, toolCall, logFile, watch } = request
  const outputLimitBytes = clampOutputLimit(request.outputLimitBytes)
  const spec = {
    kind: 'bash',
    label: label || command.slice(0, 60),
    ...(owner ? { owner } : {}),
    ...(toolCall ? { toolCall } : {}),
    ...(outputLimitBytes ? { outputLimitBytes } : {}),
    run(job) {
      const { file, args, options, error } = shellCommand(command, shell)
      if (error) throw new Error(error)
      const out = createStreamDecoder(encoding)
      const err = createStreamDecoder(encoding)

      // 启动前先抓一份产物指纹；命令结束、settle 之前再抓一份并写进 job 输出。
      let watchSnapshot = snapshotWatch(watch, cwd)
      const appendWatch = () => {
        if (!watchSnapshot) return
        const report = finishWatch(watchSnapshot, cwd)
        watchSnapshot = null
        const text = formatWatchReport(report)
        if (text) job.append(`${text}\n`, { channel: 'stdout' })
      }

      // The job ring is bounded, so the raw transcript also goes to a file.
      let logFd = null
      if (logFile) {
        try {
          mkdirSync(dirname(logFile), { recursive: true })
          logFd = openSync(logFile, 'w')
        } catch {
          logFd = null
        }
      }
      const writeLog = (chunk) => {
        if (logFd === null) return
        try {
          writeSync(logFd, chunk)
        } catch {
          /* ignore */
        }
      }
      const closeLog = () => {
        if (logFd === null) return
        try {
          closeSync(logFd)
        } catch {
          /* already closed */
        }
        logFd = null
      }

      let child = null
      let killReason = null
      let settled = false
      let resolveDone = null
      const done = new Promise((resolve) => {
        resolveDone = resolve
      })

      const settle = (status, detail) => {
        if (settled) return
        settled = true
        resolveDone({ status, ...(detail ? { detail } : {}) })
      }

      const drainDecoders = () => {
        const restOut = out.flush()
        if (restOut) job.append(restOut, { channel: 'stdout' })
        const restErr = err.flush()
        if (restErr) job.append(restErr, { channel: 'stderr' })
      }

      try {
        child = spawn(file, args, {
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...options,
        })
      } catch (error) {
        settle('failed', error?.message ?? String(error))
        return { cancel() {}, done }
      }

      child.stdout.on('data', (chunk) => {
        writeLog(chunk)
        const text = out.push(chunk)
        if (text) job.append(text, { channel: 'stdout' })
      })
      child.stderr.on('data', (chunk) => {
        writeLog(chunk)
        const text = err.push(chunk)
        if (text) job.append(text, { channel: 'stderr' })
      })

      child.on('error', (error) => {
        drainDecoders()
        appendWatch()
        closeLog()
        settle('failed', error?.message ?? String(error))
      })

      // 'close' waits for every inherited pipe to be released. A grandchild
      // that outlives the tracked process can therefore keep a finished job
      // "running" forever, so 'exit' settles it after a short grace.
      let exitCodeSeen = null
      let exitTimer = null
      const settleFromExit = (code) => {
        drainDecoders()
        appendWatch()
        closeLog()
        // The registry merges the caller's kill reason into `detail`; do not
        // repeat it here.
        if (killReason !== null) settle('killed')
        else if (code === 0) settle('completed', 'exit code 0')
        else settle('failed', `exit code ${code ?? 'unknown'}`)
      }

      child.on('exit', (code) => {
        exitCodeSeen = code
        exitTimer = setTimeout(() => settleFromExit(exitCodeSeen), 1500)
        exitTimer.unref?.()
      })

      child.on('close', (exitCode) => {
        if (exitTimer) {
          clearTimeout(exitTimer)
          exitTimer = null
        }
        settleFromExit(exitCode)
      })

      return {
        cancel(reason) {
          killReason = reason || 'killed'
          terminateTree(child?.pid, () => child?.kill())
        },
        done,
      }
    },
  }
  return jobs.start(spec)
}
