/**
 * Native PowerShell subset, implemented in Node so common commands never boot
 * powershell.exe.
 *
 * Every construct here has an exact Node equivalent; anything else throws the
 * UNSUPPORTED marker and the caller falls back to real PowerShell. That keeps
 * the native path a fast path, never a lossy reimplementation.
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

const UNSUPPORTED = Symbol('fastsh.ps.unsupported')
const REFUSED = Symbol('fastsh.ps.refused')

function nope(reason) {
  const error = new Error(reason)
  error[UNSUPPORTED] = true
  throw error
}

/** A safety refusal: `-ErrorAction SilentlyContinue` must never hide it. */
function refuse(reason) {
  const error = new Error(reason)
  error[REFUSED] = true
  throw error
}

/** Replace quoted spans with spaces so operator scans ignore them. */
function stripQuoted(text) {
  let out = ''
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
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

function splitPipeline(command) {
  const parts = []
  let current = ''
  let depth = 0
  let quote = null
  for (const ch of command) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '{' || ch === '(') depth += 1
    if (ch === '}' || ch === ')') depth -= 1
    if (ch === '|' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

function tokenize(stage) {
  const tokens = []
  let current = ''
  let quote = null
  let depth = 0
  let started = false
  for (const ch of stage) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      started = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '{') {
      depth += 1
      current += ch
      started = true
      continue
    }
    if (ch === '}') {
      depth -= 1
      current += ch
      started = true
      continue
    }
    if (/\s/.test(ch) && depth === 0) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

function parseStage(stage) {
  const tokens = tokenize(stage)
  if (tokens.length === 0) nope('empty stage')
  const params = new Map()
  const positional = []
  // tokens[0] is the cmdlet name, never an argument.
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.startsWith('-') && token.length > 1 && !/^-?\d/.test(token)) {
      const name = token.slice(1).toLowerCase()
      const next = tokens[i + 1]
      if (next !== undefined && !(next.startsWith('-') && next.length > 1 && !/^-?\d/.test(next))) {
        params.set(name, next)
        i += 1
      } else {
        params.set(name, true)
      }
      continue
    }
    positional.push(token)
  }
  return { name: tokens[0].toLowerCase(), params, positional }
}

/**
 * Resolve one path argument.
 *
 * Paths are where variables actually matter (`"$HOME\out"`, `$env:TEMP\x`), so
 * an exact reference expands exactly like valueOf does. A token that still
 * holds a `$` reference afterwards cannot be interpolated faithfully here:
 * decline to the real engine instead of silently using a literal directory
 * named `$HOME`.
 */
function toPath(value, context) {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  if (raw === '') return context.cwd
  const expanded = typeof value === 'string' ? valueOf(value, context) : value
  const text = String(expanded ?? '')
  // A missing $env:/$HOME expands to '' in string context; as a path that would
  // silently become the working directory, which is never what the caller meant.
  if (text === '') nope(`path resolves to nothing: ${raw}`)
  if (text.includes('$')) nope(`path interpolation: ${text}`)
  if (text === '.') return context.cwd
  return isAbsolute(text) ? text : resolve(context.cwd, text)
}

/** Case-insensitive, separator-normalised form used by the delete guard. */
function comparablePath(path) {
  const resolved = resolve(path)
  return resolved.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Resolve a delete target without guessing.
 *
 * The guard can only protect paths it can see, so a variable that does not
 * resolve exactly, a wildcard, or an empty target is refused here. Falling
 * back to the real engine would be "faithful" but would delete without the
 * guard, and a variable that quietly resolves elsewhere is precisely how a
 * delete lands on the wrong target.
 */
function strictDeletePath(value, context, { literal = false } = {}) {
  const raw = typeof value === 'string' ? value : ''
  if (raw === '') refuse('fastsh: 拒绝删除：缺少路径')
  let expanded
  try {
    expanded = valueOf(raw, context)
  } catch (error) {
    if (error && error[UNSUPPORTED]) {
      refuse(`fastsh: 拒绝删除：无法解析路径 ${raw}（请改用绝对路径）`)
    }
    throw error
  }
  if (typeof expanded !== 'string' || expanded === '') {
    refuse(`fastsh: 拒绝删除：无法解析路径 ${raw}（变量为空或未赋值）`)
  }
  // String interpolation (`"$HOME\out"`), wildcard expansion and friends only
  // exist in the real engine; the native guard cannot see their result.
  if (expanded.includes('$')) {
    refuse(`fastsh: 拒绝删除：路径含变量插值 ${expanded}（请改用绝对路径）`)
  }
  // `-LiteralPath` explicitly promises no wildcard expansion, so `*` there is
  // an ordinary file-name character.
  if (!literal && /[*?]/.test(expanded)) {
    refuse(`fastsh: 拒绝删除：路径含通配符 ${expanded}（请先列目录再逐个删）`)
  }
  return isAbsolute(expanded) ? expanded : resolve(context.cwd, expanded)
}

/** True when `path` and `root` name the same location. */
function samePath(path, root) {
  return comparablePath(path) === comparablePath(root)
}

/** True when `path` is strictly above `root`, e.g. C:\Users above a profile. */
function isAbove(path, root) {
  const above = comparablePath(path)
  const below = comparablePath(root)
  if (above === below) return false
  return below.startsWith(above.endsWith('\\') ? above : `${above}\\`)
}

/**
 * Delete guard: only the statically determinable roots are refused, because
 * those are the ones whose loss is never the caller's intent. Their normal
 * subdirectories stay deletable (`Remove-Item build -Recurse` keeps working).
 */
export function guardDelete(path, context) {
  const env = context.env ?? {}
  const systemRoot = env.SystemRoot ?? env.windir ?? ''
  const roots = [
    env.SystemDrive,
    env.SystemRoot,
    env.windir,
    systemRoot ? join(systemRoot, 'System32') : '',
    systemRoot ? join(systemRoot, 'SysWOW64') : '',
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramData,
    env.USERPROFILE,
    env.DSH_HOME,
    env.DSH_PROFILE_DIR,
    env.DSH_INSTALL_DIR,
    context.cwd,
  ].filter((root) => typeof root === 'string' && root.trim() !== '')

  const resolved = resolve(path)
  // A junction can point at a protected root, so compare what the OS actually
  // resolves the path to as well as the literal path.
  let actual = resolved
  try {
    actual = realpathSync(resolved)
  } catch {
    /* Not created yet: the literal path is all there is. */
  }
  for (const target of [resolved, actual]) {
    for (const root of roots) {
      // The root itself, or anything above it: both take the root with them.
      if (samePath(target, root) || isAbove(target, root)) {
        refuse(`fastsh: 拒绝删除受保护路径 ${target}（请改删其下的具体子目录）`)
      }
    }
    if (/^[A-Za-z]:$/.test(target) || /^\\\\[^\\]+\\[^\\]+$/.test(target)) {
      refuse(`fastsh: 拒绝删除盘符/共享根 ${target}`)
    }
  }
}

function shapeItem(path) {
  const stats = statSync(path)
  const name = basename(path)
  return {
    Name: name,
    FullName: path,
    Length: stats.isFile() ? stats.size : null,
    LastWriteTime: stats.mtime,
    PSIsContainer: stats.isDirectory(),
    Extension: stats.isFile() ? extname(name) : '',
    BaseName: stats.isFile() ? name.slice(0, Math.max(0, name.length - extname(name).length)) : name,
  }
}

function listChildren(path, { recurse, depth, filterRegex, filesOnly, dirsOnly, nameOnly, limit }) {
  const sortLevel = (entries) =>
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

  // PowerShell follows junctions and symlinked directories. Only links need a
  // real-path check: a plain directory tree cannot cycle, and resolving every
  // directory made a recursive search several times slower than needed.
  const visited = new Set([realpathSync(path)])
  const enterLink = (dir) => {
    try {
      const real = realpathSync(dir)
      if (visited.has(real)) return false
      visited.add(real)
      return true
    } catch {
      return false
    }
  }

  const collect = (dir) => {
    const out = []
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    // Sorting only matters for a single-level listing; a recursive search
    // would only pay the cost without anyone seeing the order.
    if (!recurse) entries = sortLevel(entries)
    for (const entry of entries) {
      const full = join(dir, entry.name)
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          isDir = false
        }
      }
      const matched = !filterRegex || filterRegex.test(entry.name)
      if (matched && !(filesOnly && isDir) && !(dirsOnly && !isDir)) {
        out.push(nameOnly ? { Name: entry.name, FullName: full, PSIsContainer: isDir } : shapeItem(full))
        if (limit && out.length >= limit) return out
      }
      if (isDir) out.push({ __dir: full, __link: entry.isSymbolicLink() })
    }
    return out
  }

  if (depth !== undefined) {
    let level = [{ dir: path, link: false }]
    const out = []
    for (let current = 0; current <= depth && level.length > 0; current++) {
      const next = []
      for (const { dir, link } of level) {
        if (link && !enterLink(dir)) continue
        for (const item of collect(dir)) {
          if (item.__dir) next.push({ dir: item.__dir, link: item.__link })
          else out.push(item)
          if (limit && out.length >= limit) return out
        }
      }
      level = next
    }
    return out
  }

  if (!recurse) return collect(path).filter((item) => !item.__dir)

  const out = []
  const walk = (dir) => {
    for (const item of collect(dir)) {
      if (limit && out.length >= limit) return
      if (item.__dir) {
        if (item.__link && !enterLink(item.__dir)) continue
        walk(item.__dir)
      } else out.push(item)
    }
  }
  walk(path)
  return out
}

/** Stream a file line by line without loading it whole; return false to stop. */
function forEachLine(path, onLine) {
  const fd = openSync(path, 'r')
  const decoder = new TextDecoder('utf-8')
  const buffer = Buffer.alloc(1024 * 1024)
  let carry = ''
  let lineNumber = 0
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      const text = carry + decoder.decode(buffer.subarray(0, bytes), { stream: true })
      let start = 0
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) !== 10) continue
        let line = text.slice(start, i)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        lineNumber += 1
        if (onLine(line, lineNumber) === false) return lineNumber
        start = i + 1
      }
      carry = text.slice(start)
      // A single pathological line must not grow without bound.
      if (carry.length > 8 * 1024 * 1024) {
        lineNumber += 1
        if (onLine(carry, lineNumber) === false) return lineNumber
        carry = ''
      }
    }
    const rest = carry + decoder.decode()
    if (rest !== '') {
      lineNumber += 1
      onLine(rest, lineNumber)
    }
  } finally {
    closeSync(fd)
  }
  return lineNumber
}

/** Last N lines of a file, reading only a bounded window from the end. */
function readTailLines(path, count) {
  if (count <= 0) return []
  const stats = statSync(path)
  const windowSize = Math.min(stats.size, Math.max(1024 * 1024, count * 256))
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(windowSize)
    readSync(fd, buffer, 0, windowSize, stats.size - windowSize)
    let lines = new TextDecoder('utf-8').decode(buffer).split(/\r?\n/)
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    // The window usually starts mid-line; drop that partial first line.
    if (windowSize < stats.size) lines = lines.slice(1)
    return lines.slice(-count)
  } finally {
    closeSync(fd)
  }
}

function makeFilter(filter) {
  const escaped = String(filter)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function matchesFilter(name, filter) {
  return makeFilter(filter).test(name)
}

function valueOf(token, context) {
  if (typeof token !== 'string') return token
  if (token === '$true' || token === '$True') return true
  if (token === '$false' || token === '$False') return false
  if (token === '$null' || token === '$Null') return null
  if (token === '$PWD' || token === '$pwd') return context.cwd
  if (token === '$HOME' || token === '$home') {
    // PowerShell always defines $HOME; an empty substitute would silently turn
    // `Remove-Item $HOME\x` into a relative path, so decline to the real engine.
    const home = context.env.USERPROFILE || context.env.HOME
    if (!home) nope('$HOME is not available')
    return home
  }
  if (token === '$_') return context.loop
  const envMatch = token.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)$/)
  if (envMatch) return context.env[envMatch[1]] ?? ''
  const bareVar = token.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)
  if (bareVar) return context.vars?.[bareVar[1]] ?? ''
  // Property chains on a variable: `$item.Name`.
  if (/^\$[A-Za-z_][\w:]*(?:\.[A-Za-z_]\w*)+$/.test(token)) return resolveReference(token, context)
  return token
}

/** PowerShell pipelines carry one item or many; array stages need one shape. */
function pipelineValues(input) {
  if (input === undefined) return []
  return Array.isArray(input) ? input : [input]
}

function param(params, ...names) {
  for (const name of names) if (params.has(name)) return params.get(name)
  return undefined
}

function truthy(value) {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value)
}

function compare(left, op, right, context) {
  const a = valueOf(left, context)
  const b = valueOf(right, context)
  switch (op) {
    case '-eq':
      return String(a) === String(b)
    case '-ne':
      return String(a) !== String(b)
    case '-like': {
      const regex = new RegExp(
        `^${String(b).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
        'i',
      )
      return regex.test(String(a))
    }
    case '-notlike':
      return !compare(left, '-like', right, context)
    case '-match':
      return new RegExp(String(b), 'i').test(String(a))
    case '-gt':
      return Number(a) > Number(b)
    case '-ge':
      return Number(a) >= Number(b)
    case '-lt':
      return Number(a) < Number(b)
    case '-le':
      return Number(a) <= Number(b)
    default:
      nope(`operator ${op}`)
  }
}

function runScriptBlock(block, item, context) {
  const inner = block.startsWith('{') && block.endsWith('}') ? block.slice(1, -1).trim() : block
  const comparison = inner.match(/^\$_\s*(\.\w+)?\s*(-(?:eq|ne|like|notlike|match|gt|ge|lt|le))\s*(.+)$/i)
  if (comparison) {
    const property = comparison[1] ? comparison[1].slice(1) : undefined
    const left = property ? item?.[property] : item
    return compare(left, comparison[2].toLowerCase(), comparison[3].trim(), context)
  }
  const property = inner.match(/^\$_\s*\.(\w+)$/)
  if (property) return item?.[property[1]]
  if (inner === '$_') return item
  nope(`script block: ${inner}`)
}

/** Longest wait the native worker accepts; longer sleeps go to the real engine. */
const MAX_NATIVE_SLEEP_MS = 30_000

/**
 * Sleep without burning CPU. Blocks this worker thread only, so the host and
 * the child-process path stay responsive.
 */
function sleepBlocking(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const utf8Decoder = new TextDecoder('utf-8')
const utf16Decoder = new TextDecoder('utf-16le')
const utf16beDecoder = new TextDecoder('utf-16be')

/** BOM of a file, read from a three-byte prefix: 'utf16le' | 'utf16be' | 'utf8' | null. */
function readBom(path) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(3)
    const read = readSync(fd, head, 0, 3, 0)
    if (read >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf16le'
    if (read >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf16be'
    if (read >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf8'
    return null
  } finally {
    closeSync(fd)
  }
}

/** Decode a file buffer: explicit -Encoding wins, then a BOM, then UTF-8/GBK. */
function decodeFileBuffer(buffer, encoding) {
  const requested = String(encoding ?? '').trim().toLowerCase()
  const utf16leBom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
  const utf16beBom = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff
  const utf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf

  if (!requested) {
    if (utf16leBom) return utf16Decoder.decode(buffer.subarray(2))
    if (utf16beBom) return utf16beDecoder.decode(buffer.subarray(2))
    if (utf8Bom) return utf8Decoder.decode(buffer.subarray(3))
    return decodeBytes(buffer)
  }
  if (requested === 'unicode' || requested === 'utf16le' || requested === 'utf16') {
    return utf16Decoder.decode(buffer.subarray(utf16leBom ? 2 : 0))
  }
  if (requested === 'bigendianunicode' || requested === 'utf16be') {
    return utf16beDecoder.decode(buffer.subarray(utf16beBom ? 2 : 0))
  }
  if (requested === 'utf8' || requested === 'utf8nobom') {
    return utf8Decoder.decode(buffer.subarray(utf8Bom ? 3 : 0))
  }
  if (requested === 'ascii' || requested === 'default' || requested === 'oem') {
    return buffer.toString('latin1')
  }
  nope(`encoding ${requested}`)
}

/** PowerShell's line split: \r\n and \n, without a trailing empty line. */
function splitLines(text) {
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function tailLinesOf(text, count) {
  if (count <= 0) return []
  return splitLines(text).slice(-count)
}

const BOM_UTF16LE = Buffer.from([0xff, 0xfe])

/** Byte codec for -Encoding on write cmdlets; PowerShell's Unicode is UTF-16LE. */
function writeCodec(encoding, context) {
  const text = String(valueOf(encoding ?? '', context)).trim().toLowerCase()
  if (!text || text === 'utf8' || text === 'utf8nobom' || text === 'default') return { codec: 'utf8', bom: false }
  if (text === 'unicode' || text === 'utf16le' || text === 'utf16') return { codec: 'utf16le', bom: true }
  if (text === 'ascii') return { codec: 'latin1', bom: false }
  nope(`encoding ${text}`)
}

function encodeText(text, codec, bom) {
  if (codec === 'utf16le') {
    const body = Buffer.from(text, 'utf16le')
    return bom ? Buffer.concat([BOM_UTF16LE, body]) : body
  }
  if (codec === 'latin1') return Buffer.from(text, 'latin1')
  return Buffer.from(text, 'utf8')
}

/** Hash a file in 1 MiB chunks instead of loading it whole. */
function hashFile(path, codec) {
  const hash = createHash(codec)
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let read
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex').toUpperCase()
}

/** PowerShell puts the item inside an existing destination directory. */
function destinationFor(source, destination) {
  try {
    if (existsSync(destination) && statSync(destination).isDirectory()) return join(destination, basename(source))
  } catch {
    /* fall through to the literal destination */
  }
  return destination
}

function runCmdlet(stage, input, context) {
  const { name, params, positional } = stage
  const args = [...positional]

  switch (name) {
    case 'get-childitem':
    case 'gci':
    case 'dir':
    case 'ls': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const filter = param(params, 'filter')
      const depthParam = param(params, 'depth')
      const depth =
        depthParam === undefined || depthParam === true ? undefined : Number(String(valueOf(depthParam, context)))
      const nameOnly = truthy(params.get('name'))
      const items = listChildren(path, {
        recurse: truthy(params.get('recurse')),
        depth: Number.isFinite(depth) ? depth : undefined,
        filterRegex: filter ? makeFilter(valueOf(filter, context)) : undefined,
        filesOnly: truthy(params.get('file')),
        dirsOnly: truthy(params.get('directory')),
        nameOnly,
        limit: context.earlyLimit,
      })
      // -Name prints the path relative to the listed directory, as PowerShell does.
      return nameOnly ? items.map((item) => relative(path, item.FullName)) : items
    }
    case 'get-item':
    case 'gi': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      return shapeItem(path)
    }
    case 'test-path': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const pathType = String(valueOf(param(params, 'pathtype') ?? 'any', context)).toLowerCase()
      if (!existsSync(path)) return false
      if (pathType === 'leaf') return statSync(path).isFile()
      if (pathType === 'container') return statSync(path).isDirectory()
      return true
    }
    case 'get-content':
    case 'gc':
    case 'cat':
    case 'type': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const encodingParam = param(params, 'encoding')
      const explicit = encodingParam !== undefined ? String(valueOf(encodingParam, context)).trim() : ''
      const raw = truthy(params.get('raw'))

      if (raw) {
        return explicit || readBom(path)
          ? decodeFileBuffer(readFileSync(path), explicit || undefined)
          : readFileSync(path, 'utf8')
      }

      const tail = param(params, 'tail')
      if (tail !== undefined) {
        const count = Number(valueOf(tail, context)) || 0
        // The windowed tail path assumes UTF-8; a BOM or explicit encoding
        // needs the whole file decoded first.
        if (explicit || readBom(path)) {
          return tailLinesOf(decodeFileBuffer(readFileSync(path), explicit || undefined), count)
        }
        return readTailLines(path, count)
      }

      const text =
        explicit || readBom(path) ? decodeFileBuffer(readFileSync(path), explicit || undefined) : readFileSync(path, 'utf8')
      const lines = splitLines(text)
      const first = param(params, 'totalcount') ?? param(params, 'head')
      if (first !== undefined) return lines.slice(0, Number(valueOf(first, context)) || 0)
      return lines
    }
    case 'set-content':
    case 'sc': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const value = param(params, 'value') ?? args[1] ?? ''
      const { codec, bom } = writeCodec(param(params, 'encoding'), context)
      const body = encodeText(`${valueOf(value, context)}\n`, codec, bom)
      writeFileSync(path, body)
      return ''
    }
    case 'add-content': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const value = param(params, 'value') ?? args[1] ?? ''
      const { codec } = writeCodec(param(params, 'encoding'), context)
      appendFileSync(path, encodeText(`${valueOf(value, context)}\n`, codec, false))
      return ''
    }
    case 'new-item':
    case 'ni': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const type = String(valueOf(param(params, 'itemtype') ?? 'file', context)).toLowerCase()
      if (type === 'junction' || type === 'symboliclink') {
        const target = param(params, 'target')
        if (target === undefined) nope('junction without -Target')
        // Junctions let a moved directory keep its old path without copying.
        symlinkSync(toPath(String(valueOf(target, context)), context), path, type === 'junction' ? 'junction' : 'dir')
        return shapeItem(path)
      }
      if (type === 'directory' || type === 'dir') {
        mkdirSync(path, { recursive: truthy(params.get('force')) })
        return shapeItem(path)
      }
      // PowerShell never truncates an existing file: without -Force it errors,
      // with -Force it returns the existing item unchanged.
      if (existsSync(path)) {
        if (!truthy(params.get('force'))) throw new Error(`fastsh: 文件已存在 ${path}`)
        return shapeItem(path)
      }
      writeFileSync(path, '', 'utf8')
      return shapeItem(path)
    }
    case 'remove-item':
    case 'rm':
    case 'del':
    case 'erase': {
      const flags = [...params.keys()]
      const flagOn = (name) => flags.some((key) => key === name || key === `${name}:$true`)
      // -WhatIf never deletes; let the real engine print its what-if lines.
      if (flagOn('whatif')) nope('Remove-Item -WhatIf')
      // -Confirm asks a human; there is no console here, so refuse instead of
      // guessing (deleting is the unsafe guess).
      if (flagOn('confirm')) {
        refuse('fastsh: 无交互确认，请用 -WhatIf 预览后去掉 -Confirm')
      }
      const literal = param(params, 'literalpath')
      const target = literal ?? param(params, 'path') ?? args[0]
      // Pipeline input is PowerShell's own idiom; the real engine owns it.
      if (target === undefined && input !== undefined) nope('Remove-Item from pipeline')
      // Everything below refuses rather than falls back: a delete that leaves
      // the native guard is a delete nobody checked.
      const path = strictDeletePath(target, context, { literal: literal !== undefined })
      guardDelete(path, context)
      // Removing a junction must unlink the link, never recurse into its target.
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
      else rmSync(path, { recursive: truthy(params.get('recurse')), force: truthy(params.get('force')) })
      return ''
    }
    case 'copy-item':
    case 'cp':
    case 'copy': {
      const source = toPath(param(params, 'path') ?? args[0], context)
      const destination = destinationFor(source, toPath(param(params, 'destination') ?? args[1], context))
      cpSync(source, destination, { recursive: truthy(params.get('recurse')), force: truthy(params.get('force')) })
      return ''
    }
    case 'move-item':
    case 'mv':
    case 'move': {
      const source = toPath(param(params, 'path') ?? args[0], context)
      const destination = destinationFor(source, toPath(param(params, 'destination') ?? args[1], context))
      // PowerShell refuses to overwrite without -Force.
      if (!truthy(params.get('force')) && existsSync(destination)) {
        throw new Error(`fastsh: 目标已存在 ${destination}（加 -Force 覆盖）`)
      }
      renameSync(source, destination)
      return ''
    }
    case 'join-path': {
      const base = String(valueOf(param(params, 'path') ?? args[0], context))
      const child = String(valueOf(param(params, 'childpath') ?? args[1], context))
      return join(base, child)
    }
    case 'split-path': {
      const path = String(valueOf(param(params, 'path') ?? args[0], context))
      if (truthy(params.get('leaf'))) return basename(path)
      return dirname(path)
    }
    case 'get-location':
    case 'pwd':
      return context.cwd
    case 'get-date':
    case 'date': {
      const raw = param(params, 'date')
      const date = raw ? new Date(String(valueOf(raw, context))) : new Date()
      if (Number.isNaN(date.getTime())) nope('invalid date')
      const format = param(params, 'format')
      if (format) return formatDotNetDate(date, String(valueOf(format, context)))
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    }
    case 'get-process':
    case 'gps':
    case 'ps': {
      const rows = listProcesses()
      const name = param(params, 'name')
      if (name) return rows.filter((row) => matchesFilter(row.ProcessName, String(valueOf(name, context))))
      const id = param(params, 'id')
      if (id) {
        const wanted = String(valueOf(id, context))
        return rows.filter((row) => String(row.Id) === wanted)
      }
      return rows
    }
    case 'select-string':
    case 'sls': {
      const pattern = param(params, 'pattern') ?? args[0]
      if (pattern === undefined) nope('select-string without pattern')
      const patternText = String(valueOf(pattern, context))
      const simple = truthy(params.get('simplematch'))
      const caseSensitive = truthy(params.get('casesensitive'))
      const regex = simple ? null : new RegExp(patternText, caseSensitive ? '' : 'i')
      const matches = (line) => {
        const text = String(line)
        if (regex) return regex.test(text)
        return caseSensitive ? text.includes(patternText) : text.toLowerCase().includes(patternText.toLowerCase())
      }
      const negate = truthy(params.get('notmatch'))
      const accept = (line) => matches(line) !== negate

      if (input !== undefined) {
        return (Array.isArray(input) ? input : [input]).map(String).filter(accept)
      }
      const pathArg = param(params, 'path') ?? args[1]
      if (pathArg === undefined) nope('select-string without path')
      const display = String(valueOf(pathArg, context))
      const out = []
      forEachLine(toPath(display, context), (line, lineNumber) => {
        if (accept(line)) out.push(`${display}:${lineNumber}:${line}`)
      })
      return out
    }
    case 'tee-object': {
      const target = param(params, 'filepath') ?? param(params, 'path') ?? args[0]
      if (target === undefined) nope('tee-object without a path')
      const filePath = toPath(String(valueOf(target, context)), context)
      const values = input === undefined ? [] : Array.isArray(input) ? input : [input]
      const text = values.map((value) => renderValue(value)).join('\n')
      if (truthy(params.get('append'))) appendFileSync(filePath, `${text}\n`, 'utf8')
      else writeFileSync(filePath, `${text}\n`, 'utf8')
      return values
    }
    case 'out-file': {
      const target = param(params, 'filepath') ?? param(params, 'path') ?? args[0]
      if (target === undefined) nope('out-file without a path')
      const filePath = toPath(String(valueOf(target, context)), context)
      const value = input !== undefined ? input : (param(params, 'inputobject') ?? args[1] ?? '')
      const lines = Array.isArray(value) ? value : [value]
      const text = `${lines.map((line) => renderValue(line)).join('\n')}\n`
      // Explicit -Encoding is honored; the default stays BOM-free UTF-8 (the
      // one deliberate difference from PowerShell 5.1's BOM).
      const { codec, bom } = writeCodec(param(params, 'encoding'), context)
      const body = encodeText(text, codec, bom)
      if (truthy(params.get('append'))) appendFileSync(filePath, encodeText(text, codec, false))
      else writeFileSync(filePath, body)
      return ''
    }
    case 'convertto-json': {
      const value = input !== undefined ? input : (param(params, 'inputobject') ?? args[1] ?? '')
      const compact = truthy(params.get('compress'))
      return JSON.stringify(value, null, compact ? 0 : 2)
    }
    case 'convertfrom-json': {
      const raw =
        input !== undefined
          ? pipelineValues(input)
              .map((value) => (typeof value === 'string' ? value : renderValue(value)))
              .join('\n')
          : String(valueOf(param(params, 'inputobject') ?? args[0] ?? '', context))
      if (!raw.trim()) return ''
      try {
        return JSON.parse(raw)
      } catch (error) {
        throw new Error(`fastsh: JSON 解析失败：${String(error?.message ?? error).slice(0, 80)}`)
      }
    }
    case 'get-filehash': {
      const algorithm = String(valueOf(param(params, 'algorithm') ?? 'SHA256', context))
        .toUpperCase()
        .replace(/[-_]/g, '')
      const codec = { SHA256: 'sha256', SHA1: 'sha1', MD5: 'md5' }[algorithm]
      if (!codec) nope(`Get-FileHash algorithm ${algorithm}`)
      const targets = []
      if (input !== undefined) {
        for (const item of pipelineValues(input)) {
          targets.push(typeof item === 'string' ? item : String(item?.FullName ?? item?.Path ?? item))
        }
      }
      const single = param(params, 'path') ?? args[0]
      if (single !== undefined) targets.push(String(valueOf(single, context)))
      if (targets.length === 0) nope('Get-FileHash without -Path')
      const hashes = targets.map((target) => {
        const resolved = toPath(target, context)
        if (!statSync(resolved).isFile()) throw new Error(`fastsh: 不是文件 ${resolved}`)
        const hash = hashFile(resolved, codec)
        return { Algorithm: algorithm, Hash: hash, Path: resolved }
      })
      return hashes.length === 1 ? hashes[0] : hashes
    }
    case 'resolve-path': {
      const target = toPath(param(params, 'path') ?? args[0], context)
      if (!existsSync(target)) throw new Error(`fastsh: 路径不存在 ${target}`)
      return target
    }
    case 'format-table':
    case 'format-list':
    case 'format-wide':
      // Formatting is the renderer's job; keep the data instead of booting
      // PowerShell just to draw a table.
      return input ?? ''
    case 'out-string':
      return pipelineValues(input)
        .map((value) => renderValue(value))
        .join('\n')
    case 'start-sleep':
    case 'sleep': {
      const milliseconds = param(params, 'milliseconds')
      const seconds = param(params, 'seconds')
      let ms
      if (milliseconds !== undefined) ms = Number(valueOf(milliseconds, context))
      else if (seconds !== undefined) ms = Number(valueOf(seconds, context)) * 1000
      if (ms === undefined || !Number.isFinite(ms) || ms < 0) nope('Start-Sleep without a duration')
      // One serialized worker: a long sleep would stall every later native call,
      // so the real engine owns waits above the cap.
      if (ms > MAX_NATIVE_SLEEP_MS) nope('Start-Sleep longer than the native cap')
      sleepBlocking(ms)
      return ''
    }
    case 'write-output':
    case 'write-host':
    case 'echo':
      return args.map((arg) => String(valueOf(arg, context))).join(' ')
    case 'select-object':
    case 'select': {
      let values = pipelineValues(input)
      if (truthy(params.get('unique'))) {
        const seen = new Set()
        values = values.filter((value) => {
          const key = typeof value === 'string' ? value : JSON.stringify(value)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      const skip = param(params, 'skip')
      if (skip !== undefined) values = values.slice(Number(valueOf(skip, context)))
      const first = param(params, 'first')
      if (first !== undefined) values = values.slice(0, Number(valueOf(first, context)))
      const last = param(params, 'last')
      if (last !== undefined) values = values.slice(-Number(valueOf(last, context)))
      const expand = param(params, 'expandproperty')
      if (expand) return values.map((value) => value?.[String(valueOf(expand, context))])
      const property = param(params, 'property')
      if (property) {
        const keys = String(valueOf(property, context))
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean)
        return values.map((value) => {
          const picked = {}
          for (const key of keys) picked[key] = value?.[key]
          return picked
        })
      }
      return values
    }
    case 'where-object':
    case 'where':
    case '?': {
      const block = param(params, 'filterscript') ?? args[0]
      if (!block) nope('where-object without a filter')
      return pipelineValues(input).filter((value) => truthy(runScriptBlock(block, value, context)))
    }
    case 'foreach-object':
    case 'foreach':
    case '%': {
      const block = param(params, 'process') ?? args[0]
      if (!block) nope('foreach-object without a block')
      return pipelineValues(input).map((value) => runScriptBlock(block, value, context))
    }
    case 'sort-object':
    case 'sort': {
      const keys = String(valueOf(param(params, 'property') ?? args[0] ?? '', context))
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
      const descending = truthy(params.get('descending'))
      const sorted = [...pipelineValues(input)]
      sorted.sort((a, b) => {
        for (const key of keys) {
          const left = a?.[key]
          const right = b?.[key]
          const result = left === right ? 0 : left > right ? 1 : -1
          if (result !== 0) return descending ? -result : result
        }
        return 0
      })
      return sorted
    }
    case 'measure-object':
    case 'measure': {
      const values = pipelineValues(input)
      const property = param(params, 'property')
      const numbers = property
        ? values.map((value) => Number(value?.[String(valueOf(property, context))])).filter((n) => Number.isFinite(n))
        : values.map(Number).filter((n) => Number.isFinite(n))
      const result = {}
      if (truthy(params.get('count')) || numbers.length === 0) result.Count = values.length
      if (truthy(params.get('sum'))) result.Sum = numbers.reduce((a, b) => a + b, 0)
      if (truthy(params.get('average'))) result.Average = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null
      if (truthy(params.get('maximum'))) result.Maximum = numbers.length ? Math.max(...numbers) : null
      if (truthy(params.get('minimum'))) result.Minimum = numbers.length ? Math.min(...numbers) : null
      return result
    }
    default:
      nope(`cmdlet ${name}`)
  }
}

function callDotNet(expression, context) {
  const match = expression.match(/^\[([A-Za-z0-9_.]+)\]::([A-Za-z0-9_]+)\s*(?:\((.*)\))?$/)
  if (!match) nope('not a static call')
  const [, type, member, rawArgs = ''] = match
  const args = splitArguments(rawArgs).map((arg) => valueOf(arg, context))

  switch (type.toLowerCase()) {
    case 'system.io.file': {
      switch (member.toLowerCase()) {
        case 'exists':
          return existsSync(toPath(args[0], context))
        case 'readalltext':
          return readFileSync(toPath(args[0], context), 'utf8')
        case 'readalllines':
          return readFileSync(toPath(args[0], context), 'utf8').split(/\r?\n/).filter((line) => line !== '')
        case 'writealltext':
          writeFileSync(toPath(args[0], context), String(args[1] ?? ''), 'utf8')
          return ''
        case 'appendalltext':
          appendFileSync(toPath(args[0], context), String(args[1] ?? ''), 'utf8')
          return ''
        case 'delete': {
          const path = strictDeletePath(args[0], context)
          guardDelete(path, context)
          rmSync(path, { force: true })
          return ''
        }
        case 'copy':
          cpSync(toPath(args[0], context), toPath(args[1], context))
          return ''
        case 'move':
          renameSync(toPath(args[0], context), toPath(args[1], context))
          return ''
        default:
          nope(`File.${member}`)
      }
    }
    case 'system.io.directory': {
      switch (member.toLowerCase()) {
        case 'exists':
          return existsSync(toPath(args[0], context))
        case 'createdirectory':
          mkdirSync(toPath(args[0], context), { recursive: true })
          return ''
        case 'getfiles':
          return listChildren(toPath(args[0], context), { recurse: false }).filter((item) => !item.PSIsContainer).map((item) => item.FullName)
        case 'getdirectories':
          return listChildren(toPath(args[0], context), { recurse: false }).filter((item) => item.PSIsContainer).map((item) => item.FullName)
        case 'getcurrentdirectory':
          return context.cwd
        case 'delete': {
          // Same strict resolution + guard as Remove-Item: a variable that does
          // not resolve exactly must not turn into a delete.
          const path = strictDeletePath(args[0], context)
          guardDelete(path, context)
          const recursive = args[1] === true || args[1] === 1 || String(args[1]).toLowerCase() === 'true'
          // .NET throws when the target is not a directory; do not fall back to
          // deleting a file that happened to share the name.
          if (!statSync(path).isDirectory()) {
            throw new Error(`fastsh: 拒绝删除：${path} 不是目录`)
          }
          if (recursive) rmSync(path, { recursive: true, force: false })
          else rmdirSync(path)
          return ''
        }
        default:
          nope(`Directory.${member}`)
      }
    }
    case 'system.io.path': {
      switch (member.toLowerCase()) {
        case 'combine':
          return args.map(String).reduce((base, part) => join(base, part))
        case 'getfilename':
          return basename(String(args[0]))
        case 'getfilenamewithoutextension':
          return basename(String(args[0]), extname(String(args[0])))
        case 'getdirectoryname':
          return dirname(String(args[0]))
        case 'getextension':
          return extname(String(args[0]))
        case 'getfullpath':
          return isAbsolute(String(args[0])) ? String(args[0]) : resolve(context.cwd, String(args[0]))
        default:
          nope(`Path.${member}`)
      }
    }
    case 'environment':
    case 'system.environment': {
      const lower = member.toLowerCase()
      if (lower === 'getenvironmentvariable') {
        const name = String(args[0] ?? '')
        const target = String(args[1] ?? 'process').toLowerCase()
        if (target === 'user' || target === 'machine') return readRegistryEnv(name, target)
        return context.env[name] ?? ''
      }
      if (lower === 'setenvironmentvariable') {
        const name = String(args[0] ?? '')
        const target = String(args[2] ?? 'process').toLowerCase()
        const remove = args[1] === null || args[1] === undefined
        const value = remove ? '' : String(args[1])
        if (target === 'process') {
          if (remove) delete context.env[name]
          else context.env[name] = value
          return ''
        }
        if (target === 'user') return remove ? deleteRegistryEnv(name, 'HKCU\\Environment') : writeRegistryEnv(name, value, 'HKCU\\Environment')
        if (target === 'machine') {
          const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
          return remove ? deleteRegistryEnv(name, key) : writeRegistryEnv(name, value, key)
        }
        nope(`SetEnvironmentVariable target ${target}`)
      }
      if (lower === 'currentdirectory') return context.cwd
      nope(`Environment.${member}`)
    }
    case 'math':
    case 'system.math': {
      const numbers = args.map(Number)
      switch (member.toLowerCase()) {
        case 'abs':
          return Math.abs(numbers[0])
        case 'max':
          return Math.max(...numbers)
        case 'min':
          return Math.min(...numbers)
        case 'round':
          return Math.round(numbers[0])
        case 'floor':
          return Math.floor(numbers[0])
        case 'ceiling':
          return Math.ceil(numbers[0])
        case 'pow':
          return Math.pow(numbers[0], numbers[1])
        case 'sqrt':
          return Math.sqrt(numbers[0])
        default:
          nope(`Math.${member}`)
      }
    }
    case 'guid':
    case 'system.guid':
      if (member.toLowerCase() === 'newguid') return randomUUID()
      nope(`Guid.${member}`)
      break
    case 'datetime':
    case 'system.datetime': {
      const lower = member.toLowerCase()
      if (lower === 'now') return new Date().toISOString()
      if (lower === 'utcnow') return new Date().toISOString()
      if (lower === 'today') return new Date().toISOString().slice(0, 10)
      if (lower === 'parse') return new Date(String(args[0])).toISOString()
      nope(`DateTime.${member}`)
      break
    }
    default:
      nope(`type ${type}`)
  }
}

function splitArguments(raw) {
  const args = []
  let current = ''
  let quote = null
  let depth = 0
  let started = false
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '(' || ch === '{') depth += 1
    if (ch === ')' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) args.push(current.trim())
  return args.filter((arg) => arg !== '')
}

function renderValue(value) {
  if (value === null || value === undefined) return ''
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function render(values) {
  const list = Array.isArray(values) ? values : [values]
  if (list.length === 0) return ''

  const objects = list.filter((value) => value && typeof value === 'object' && !(value instanceof Date))
  if (objects.length !== list.length) return list.map(renderValue).join('\n')

  const withItems = objects.some((value) => 'PSIsContainer' in value)
  if (withItems) {
    const rows = objects.map((item) => ({
      Mode: item.PSIsContainer ? 'd-----' : '-a----',
      LastWriteTime: item.LastWriteTime
        ? new Date(item.LastWriteTime).toISOString().replace('T', ' ').slice(0, 19)
        : '',
      Length: item.PSIsContainer ? '' : String(item.Length ?? ''),
      Name: item.Name ?? '',
    }))
    const header = ['Mode', 'LastWriteTime', 'Length', 'Name']
    const widths = header.map((key, index) => Math.max(key.length, ...rows.map((row) => Object.values(row)[index].length)))
    const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join(' ').trimEnd()
    return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map((row) => line(Object.values(row)))].join(
      '\n',
    )
  }
  if (objects.every((value) => Object.keys(value).length === 1)) {
    return objects.map((value) => renderValue(Object.values(value)[0])).join('\n')
  }
  const withProcess = objects.some((value) => 'ProcessName' in value && 'Id' in value)
  if (withProcess) {
    const rows = objects.map((item) => ({
      Id: String(item.Id ?? ''),
      ProcessName: item.ProcessName ?? '',
      WorkingSet: String(item.WorkingSet ?? ''),
    }))
    const header = ['Id', 'ProcessName', 'WorkingSet']
    const widths = header.map((key, index) => Math.max(key.length, ...rows.map((row) => Object.values(row)[index].length)))
    const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join(' ').trimEnd()
    return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map((row) => line(Object.values(row)))].join('\n')
  }
  return objects.map((value) => JSON.stringify(value)).join('\n')
}

/**
 * Try to run a PowerShell-looking command natively.
 * Returns a command-shaped result (or a delegate for `&`), or null when real
 * PowerShell is needed.
 */

const BAD_REDIRECT = Symbol('bad redirect')
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const pad2 = (value) => String(value).padStart(2, '0')

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
let gbkDecoder = null
try {
  gbkDecoder = new TextDecoder('gbk')
} catch {
  gbkDecoder = new TextDecoder()
}

function decodeBytes(buffer) {
  try {
    return utf8Strict.decode(buffer)
  } catch {
    return gbkDecoder.decode(buffer)
  }
}

function splitStatements(text) {
  const out = []
  let current = ''
  let quote = null
  let depth = 0
  for (const ch of text) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '{' || ch === '(') depth += 1
    if (ch === '}' || ch === ')') depth -= 1
    // PowerShell ends a statement at `;` or a newline outside quotes/blocks.
    if ((ch === ';' || ch === '\n') && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return mergeBlockHeaders(out.filter(Boolean))
}

/** Count braces outside quotes; a header split from its block is unbalanced. */
function braceBalance(text) {
  let quote = null
  let balance = 0
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{') balance += 1
    else if (ch === '}') balance -= 1
  }
  return balance
}

/**
 * `if (cond)` and its `{` may land in different statements when the author
 * puts the brace on the next line. Rejoin such header-only statements.
 */
function mergeBlockHeaders(parts) {
  const out = []
  let pending = null
  for (const part of parts) {
    if (pending !== null) {
      pending = `${pending} ${part}`
      if (braceBalance(pending) <= 0) {
        out.push(pending)
        pending = null
      }
      continue
    }
    if (
      /^(?:if|elseif|foreach|try)\s*\(/i.test(part) &&
      !part.includes('{') &&
      braceBalance(part) === 0
    ) {
      pending = part
      continue
    }
    out.push(part)
  }
  if (pending !== null) out.push(pending)
  return out
}

function readBalanced(text, start) {
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      if (depth === 0) return { inner: text.slice(start, i), end: i + 1 }
      depth -= 1
    }
  }
  nope('unbalanced subexpression')
}

function expandSubexpressions(text, context, depth) {
  if (depth > 5) nope('nested subexpression')
  let out = ''
  let quote = null
  for (let i = 0; i < text.length; ) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      out += ch
      i += 1
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
        out += ch
        i += 1
        continue
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      const { inner, end } = readBalanced(text, i + 2)
      out += runStatementsText(inner, context, depth + 1)
      i = end
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function runStatementsText(command, context, depth) {
  return splitStatements(command)
    .map((statement) => runStatement(statement, context, depth).text ?? '')
    .filter((text) => text !== '')
    .join('\n')
}

function splitRedirect(statement) {
  let quote = null
  let depth = 0
  let index = -1
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '{') {
      depth += 1
      continue
    }
    if (ch === ')' || ch === '}') {
      depth -= 1
      continue
    }
    if (ch === '>' && depth === 0) {
      index = i
      break
    }
  }
  if (index < 0) return null

  let opStart = index
  if (statement[index - 1] === '2') opStart = index - 1
  let opEnd = index + 1
  if (statement[opEnd] === '>') opEnd += 1
  const op = statement.slice(opStart, opEnd)
  if (op !== '>' && op !== '>>' && op !== '2>' && op !== '2>>') return BAD_REDIRECT

  const targetText = statement.slice(opEnd).trim()
  if (!targetText) return BAD_REDIRECT
  const target = /^"([^"]*)"$/.test(targetText) || /^'([^']*)'$/.test(targetText) ? targetText.slice(1, -1) : targetText
  if (!target || /\s/.test(target)) return BAD_REDIRECT

  return {
    body: statement.slice(0, opStart).trim(),
    target,
    append: op === '>>' || op === '2>>',
    stream: op.startsWith('2') ? 'stderr' : 'stdout',
  }
}

/** `-ErrorAction` value of a parsed stage, including the `-EA` alias. */
function errorActionOf(stage) {
  for (const [key, value] of stage.params) {
    if (key === 'erroraction' || key === 'ea') return typeof value === 'string' ? value.toLowerCase() : ''
    if (key.startsWith('erroraction:')) return key.slice('erroraction:'.length)
    if (key.startsWith('ea:')) return key.slice(3)
  }
  return ''
}

function runPipeline(command, context) {
  const single = command.trim()
  if (single.startsWith('[')) return callDotNet(single, context)
  if (/^\$[A-Za-z_][\w:]*(?:\.[A-Za-z_]\w*)*$/.test(single)) return resolveReference(single, context)

  const stages = splitPipeline(single)
  if (stages.length === 0) nope('empty pipeline')
  // `Get-ChildItem ... | Select-Object -First N` stops enumerating once N items
  // are found, the way PowerShell's lazy pipeline does, instead of walking the
  // whole tree first.
  let earlyLimit
  if (stages.length === 2 && /^get-childitem\b/i.test(stages[0].trim())) {
    const first = stages[1].match(/\s-first\s+(\d+)/i)
    if (first) earlyLimit = Number(first[1])
  }
  if (earlyLimit) context.earlyLimit = earlyLimit
  try {
    let values
    let index = 0
    // A pipeline may start from a variable: `$items | Select-Object -First 1`.
    if (stages.length > 1 && /^\$[A-Za-z_][\w:]*(?:\.[A-Za-z_]\w*)*$/.test(stages[0].trim())) {
      values = resolveReference(stages[0].trim(), context)
      index = 1
    }
    for (; index < stages.length; index++) {
      const parsed = parseStage(stages[index])
      try {
        values = runCmdlet(parsed, values, context)
      } catch (error) {
        // -ErrorAction hides real errors, never a safety refusal.
        if (error && (error[UNSUPPORTED] || error[REFUSED])) throw error
        const action = errorActionOf(parsed)
        if (action === 'silentlycontinue' || action === 'ignore') {
          values = []
          continue
        }
        throw error
      }
      if (values === undefined) nope('undefined result')
    }
    return values
  } finally {
    if (earlyLimit) delete context.earlyLimit
  }
}

function parseCallOperator(text, context) {
  const tokens = tokenize(text.replace(/^&\s*/, ''))
  if (tokens.length === 0) nope('empty call operator')
  return {
    file: String(valueOf(tokens[0], context)),
    args: tokens.slice(1).map((token) => String(valueOf(token, context))),
  }
}

// ---------------------------------------------------------------------------
// Expressions and control flow
// ---------------------------------------------------------------------------

/** Index of the `}` or `)` closing the one at `start`. */
function findClosing(text, start) {
  const open = text[start]
  const close = open === '(' ? ')' : '}'
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  nope('unbalanced block')
}

/** First top-level ` -op ` occurrence outside quotes and brackets. */
function findOperator(text, operators) {
  let quote = null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1
    if (depth !== 0 || ch !== ' ') continue
    for (const op of operators) {
      if (text.startsWith(op, i)) return { index: i, op }
    }
  }
  return null
}

const COMMAND_HEADS = new Set([
  'get-childitem', 'gci', 'dir', 'ls', 'get-item', 'gi', 'test-path',
  'get-content', 'gc', 'cat', 'type', 'set-content', 'sc', 'add-content',
  'new-item', 'ni', 'remove-item', 'rm', 'del', 'erase', 'copy-item', 'cp',
  'copy', 'move-item', 'mv', 'move', 'join-path', 'split-path', 'get-location',
  'pwd', 'get-date', 'date', 'get-process', 'gps', 'ps', 'select-string',
  'sls', 'out-file', 'convertto-json', 'convertfrom-json', 'get-filehash',
  'resolve-path', 'format-table', 'format-list', 'format-wide', 'out-string',
  'start-sleep', 'sleep', 'ft', 'fl', 'write-output', 'write-host', 'echo',
  'select-object', 'select', 'where-object', 'where', 'foreach-object',
  'foreach', 'sort-object', 'sort', 'measure-object', 'measure',
])

function compareValues(left, op, right) {
  switch (op) {
    case '-eq':
      return String(left) === String(right)
    case '-ne':
      return String(left) !== String(right)
    case '-like': {
      const regex = new RegExp(
        `^${String(right).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
        'i',
      )
      return regex.test(String(left))
    }
    case '-notlike':
      return !compareValues(left, '-like', right)
    case '-match':
      return new RegExp(String(right), 'i').test(String(left))
    case '-notmatch':
      return !compareValues(left, '-match', right)
    case '-gt':
      return Number(left) > Number(right)
    case '-ge':
      return Number(left) >= Number(right)
    case '-lt':
      return Number(left) < Number(right)
    case '-le':
      return Number(left) <= Number(right)
    default:
      nope(`operator ${op}`)
  }
}

/** Resolve `$var`, `$env:X`, `$_` plus `.Property` chains. */
function resolveReference(text, context) {
  const match = text.match(/^(\$[A-Za-z_][\w:]*|\$_)((?:\.[A-Za-z_]\w*)*)$/)
  if (!match) nope(`reference ${text}`)
  let value = valueOf(match[1], context)
  for (const prop of match[2].split('.').filter(Boolean)) value = value?.[prop]
  return value
}

/** Evaluate a value: literal, variable, expression, or command. */
function evaluateValue(text, context) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('(') && findClosing(raw, 0) === raw.length - 1) {
    return evaluateExpression(raw.slice(1, -1), context)
  }
  if (raw.startsWith('[')) return callDotNet(raw, context)
  if (/^\$[A-Za-z_][\w:]*(?:\.[A-Za-z_]\w*)*$/.test(raw) || raw === '$_') {
    return resolveReference(raw, context)
  }
  if (/^'(.*)'$/s.test(raw) || /^"(.*)"$/s.test(raw)) return raw.slice(1, -1)
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  const head = raw.split(/\s+/)[0].toLowerCase()
  if (COMMAND_HEADS.has(head) || raw.includes('|')) return runPipeline(raw, context)
  return raw
}

/** Evaluate a condition expression. */
function evaluateExpression(text, context) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''

  const or = findOperator(raw, [' -or '])
  if (or) {
    return (
      truthy(evaluateExpression(raw.slice(0, or.index), context)) ||
      truthy(evaluateExpression(raw.slice(or.index + or.op.length), context))
    )
  }
  const and = findOperator(raw, [' -and '])
  if (and) {
    return (
      truthy(evaluateExpression(raw.slice(0, and.index), context)) &&
      truthy(evaluateExpression(raw.slice(and.index + and.op.length), context))
    )
  }
  if (/^-not\s+/i.test(raw)) return !truthy(evaluateExpression(raw.replace(/^-not\s+/i, ''), context))
  if (/^!/.test(raw)) return !truthy(evaluateExpression(raw.slice(1), context))

  const comparison = findOperator(raw, [
    ' -eq ', ' -ne ', ' -gt ', ' -ge ', ' -lt ', ' -le ',
    ' -like ', ' -notlike ', ' -match ', ' -notmatch ',
  ])
  if (comparison) {
    const left = evaluateValue(raw.slice(0, comparison.index), context)
    const right = evaluateValue(raw.slice(comparison.index + comparison.op.length), context)
    return compareValues(left, comparison.op.trim().toLowerCase(), right)
  }
  return evaluateValue(raw, context)
}

function runIf(text, context, depth) {
  let rest = text.trim()
  const branches = []
  let elseBody = null
  while (rest) {
    if (/^(if|elseif)\s*\(/i.test(rest)) {
      const openParen = rest.indexOf('(')
      const closeParen = findClosing(rest, openParen)
      const condition = rest.slice(openParen + 1, closeParen)
      const openBrace = rest.indexOf('{', closeParen)
      if (openBrace < 0) nope('if without a block')
      const closeBrace = findClosing(rest, openBrace)
      branches.push({ condition, body: rest.slice(openBrace + 1, closeBrace) })
      rest = rest.slice(closeBrace + 1).trim()
      continue
    }
    if (/^else\s*\{/i.test(rest)) {
      const openBrace = rest.indexOf('{')
      const closeBrace = findClosing(rest, openBrace)
      elseBody = rest.slice(openBrace + 1, closeBrace)
      rest = rest.slice(closeBrace + 1).trim()
      continue
    }
    nope('unexpected if tail')
  }
  for (const branch of branches) {
    if (truthy(evaluateExpression(branch.condition, context))) {
      return runStatementsText(branch.body, context, depth + 1)
    }
  }
  return elseBody === null ? '' : runStatementsText(elseBody, context, depth + 1)
}

function runForeach(text, context, depth) {
  const openParen = text.indexOf('(')
  const closeParen = findClosing(text, openParen)
  const inner = text.slice(openParen + 1, closeParen).trim()
  const head = inner.match(/^\$([A-Za-z_]\w*)\s+in\s+([\s\S]+)$/i)
  if (!head) nope('foreach header')
  const openBrace = text.indexOf('{', closeParen)
  if (openBrace < 0) nope('foreach without a block')
  const closeBrace = findClosing(text, openBrace)
  const body = text.slice(openBrace + 1, closeBrace)

  const collection = evaluateValue(head[2], context)
  const items = Array.isArray(collection) ? collection : collection === '' ? [] : [collection]
  const outputs = []
  for (const item of items) {
    context.vars[head[1]] = item
    context.loop = item
    outputs.push(runStatementsText(body, context, depth + 1))
  }
  return outputs.filter(Boolean).join('\n')
}

function runTry(text, context, depth) {
  let rest = text.trim()
  if (!/^try\s*\{/i.test(rest)) nope('try header')
  const openBrace = rest.indexOf('{')
  const closeBrace = findClosing(rest, openBrace)
  const body = rest.slice(openBrace + 1, closeBrace)
  rest = rest.slice(closeBrace + 1).trim()

  let catchBody = null
  let finallyBody = null
  while (rest) {
    if (/^catch\s*\{/i.test(rest)) {
      const open = rest.indexOf('{')
      const close = findClosing(rest, open)
      catchBody = rest.slice(open + 1, close)
      rest = rest.slice(close + 1).trim()
      continue
    }
    if (/^finally\s*\{/i.test(rest)) {
      const open = rest.indexOf('{')
      const close = findClosing(rest, open)
      finallyBody = rest.slice(open + 1, close)
      rest = rest.slice(close + 1).trim()
      continue
    }
    nope('unexpected try tail')
  }

  let output = ''
  try {
    output = runStatementsText(body, context, depth + 1)
  } catch (error) {
    if (error && error[UNSUPPORTED]) throw error
    if (catchBody === null) throw error
    context.vars._ = error?.message ?? String(error)
    context.loop = context.vars._
    output = runStatementsText(catchBody, context, depth + 1)
  }
  if (finallyBody !== null) {
    const tail = runStatementsText(finallyBody, context, depth + 1)
    if (tail) output = output ? `${output}\n${tail}` : tail
  }
  return output
}

function runStatement(statement, context, depth) {
  const trimmed = String(statement ?? '').trim()
  if (!trimmed) return { text: '' }
  if (depth > 20) nope('block nesting too deep')

  if (/^if\s*\(/i.test(trimmed)) return { text: runIf(trimmed, context, depth) }
  if (/^foreach\s*\(/i.test(trimmed)) return { text: runForeach(trimmed, context, depth) }
  if (/^try\s*\{/i.test(trimmed)) return { text: runTry(trimmed, context, depth) }

  const assignment = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/)
  if (assignment) {
    context.vars[assignment[1]] = evaluateValue(assignment[2], context)
    return { text: '' }
  }

  const expanded = expandSubexpressions(trimmed, context, depth)
  const redirect = splitRedirect(expanded)
  if (redirect === BAD_REDIRECT) nope('redirection')

  const body = (redirect?.body ?? expanded).trim()
  if (!body) nope('empty statement')

  if (body.startsWith('&')) {
    if (redirect) nope('call operator with redirection')
    return { delegate: parseCallOperator(body, context) }
  }

  const stderrTarget = redirect?.stream === 'stderr' ? toPath(redirect.target, context) : null

  try {
    const text = render(runPipeline(body, context))
    if (stderrTarget) {
      // PowerShell still creates the file on success, empty.
      writeFileSync(stderrTarget, '', 'utf8')
      return { text }
    }
    if (redirect) {
      const path = toPath(redirect.target, context)
      if (redirect.append) appendFileSync(path, `${text}\n`, 'utf8')
      else writeFileSync(path, `${text}\n`, 'utf8')
      return { text: '' }
    }
    return { text }
  } catch (error) {
    if (stderrTarget && !(error && error[UNSUPPORTED])) {
      // Deliberately UTF-8; PowerShell 5.1 would write UTF-16LE here.
      writeFileSync(stderrTarget, `${error?.message ?? String(error)}\n`, 'utf8')
      return { text: '' }
    }
    throw error
  }
}

function listProcesses() {
  const raw = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'buffer', windowsHide: true })
  return decodeBytes(raw)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('"'))
    .map((line) => {
      const cells = line.slice(1, -1).split('","')
      const kb = Number(String(cells[4] ?? '').replace(/[^\d]/g, '') || 0)
      return {
        Id: Number(cells[1] ?? 0),
        ProcessName: String(cells[0] ?? '').replace(/\.exe$/i, ''),
        SessionName: cells[2] ?? '',
        WorkingSet: kb * 1024,
      }
    })
}

function writeRegistryEnv(name, value, key) {
  execFileSync('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  return ''
}

function deleteRegistryEnv(name, key) {
  execFileSync('reg.exe', ['delete', key, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' })
  return ''
}

function readRegistryEnv(name, target) {
  const key =
    target === 'user' ? 'HKCU\\Environment' : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  try {
    const raw = execFileSync('reg.exe', ['query', key, '/v', name], { encoding: 'buffer', windowsHide: true })
    const text = decodeBytes(raw)
    const match = text.match(new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.*)`, 'i'))
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

function formatDotNetDate(date, format) {
  const hours = date.getHours()
  const values = {
    yyyy: String(date.getFullYear()),
    yy: pad2(date.getFullYear() % 100),
    MMMM: MONTH_NAMES[date.getMonth()],
    MMM: MONTH_NAMES[date.getMonth()].slice(0, 3),
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dddd: DAY_NAMES[date.getDay()],
    ddd: DAY_NAMES[date.getDay()].slice(0, 3),
    dd: pad2(date.getDate()),
    d: String(date.getDate()),
    HH: pad2(hours),
    H: String(hours),
    hh: pad2(((hours + 11) % 12) + 1),
    h: String(((hours + 11) % 12) + 1),
    mm: pad2(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad2(date.getSeconds()),
    s: String(date.getSeconds()),
    fff: String(date.getMilliseconds()).padStart(3, '0'),
    tt: hours < 12 ? 'AM' : 'PM',
  }
  return format.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fff|tt/g, (token) => values[token] ?? token)
}

export function runNativePowerShell(command, context) {
  const normalized = String(command).replace(/`\r?\n/g, ' ')
  const bare = stripQuoted(normalized)
  // `<` needs a live stdin pipe, which the native path does not own.
  if (/</.test(bare)) return null
  if (/@\{|@\(/.test(bare)) return null

  const statements = splitStatements(normalized)
  if (statements.length === 0) return null

  // One execution = one variable scope.
  const scope = { ...context, vars: {}, loop: undefined }
  try {
    const outputs = []
    for (const statement of statements) {
      const result = runStatement(statement, scope, 0)
      if (result.delegate) {
        if (statements.length > 1) nope('call operator among several statements')
        return { supported: true, delegate: result.delegate, stdout: '', stderr: '', exitCode: 0 }
      }
      outputs.push(result.text)
    }
    return { supported: true, stdout: outputs.filter((text) => text !== '').join('\n'), stderr: '', exitCode: 0 }
  } catch (error) {
    if (error && error[UNSUPPORTED]) return null
    // A real filesystem error is a real command failure, not a fallback.
    return {
      supported: true,
      stdout: '',
      stderr: `${error?.message ?? String(error)}\n`,
      exitCode: 1,
    }
  }
}
