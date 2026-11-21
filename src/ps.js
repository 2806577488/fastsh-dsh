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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

const UNSUPPORTED = Symbol('fastsh.ps.unsupported')

function nope(reason) {
  const error = new Error(reason)
  error[UNSUPPORTED] = true
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

function toPath(value, context) {
  const raw = String(value ?? '')
  if (raw === '' || raw === '.') return context.cwd
  return isAbsolute(raw) ? raw : resolve(context.cwd, raw)
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

function listChildren(path, { recurse, depth, filter, filesOnly, dirsOnly, nameOnly }) {
  const sortLevel = (entries) =>
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

  const collect = (dir) => {
    const out = []
    for (const entry of sortLevel(readdirSync(dir, { withFileTypes: true }))) {
      const full = join(dir, entry.name)
      const isDir = entry.isDirectory()
      if (!(filesOnly && isDir) && !(dirsOnly && !isDir) && !(filter && !matchesFilter(entry.name, filter))) {
        // -Name only needs the directory entry; stat-ing every child made a
        // 5000-entry listing take a second instead of milliseconds.
        out.push(
          nameOnly
            ? { Name: entry.name, FullName: full, PSIsContainer: isDir }
            : shapeItem(full),
        )
      }
      if (isDir) out.push({ __dir: full })
    }
    return out
  }

  // -Depth N: breadth-first, exactly like Get-ChildItem -Depth.
  if (depth !== undefined) {
    let level = [path]
    const out = []
    for (let current = 0; current <= depth && level.length > 0; current++) {
      const next = []
      for (const dir of level) {
        for (const item of collect(dir)) {
          if (item.__dir) next.push(item.__dir)
          else out.push(item)
        }
      }
      level = next
    }
    return out
  }

  const walk = (dir) => {
    const out = []
    for (const item of collect(dir)) {
      if (item.__dir) {
        if (recurse) out.push(...walk(item.__dir))
      } else out.push(item)
    }
    return out
  }
  return walk(path)
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

function matchesFilter(name, filter) {  const escaped = String(filter).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(name)
}

function valueOf(token, context) {
  if (typeof token !== 'string') return token
  if (token === '$true' || token === '$True') return true
  if (token === '$false' || token === '$False') return false
  if (token === '$null' || token === '$Null') return null
  if (token === '$PWD' || token === '$pwd') return context.cwd
  if (token === '$HOME' || token === '$home') return context.env.USERPROFILE ?? context.env.HOME ?? ''
  if (token === '$_') return context.loop
  const envMatch = token.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)$/)
  if (envMatch) return context.env[envMatch[1]] ?? ''
  const bareVar = token.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)
  if (bareVar) return context.vars?.[bareVar[1]] ?? ''
  // Property chains on a variable: `$item.Name`.
  if (/^\$[A-Za-z_][\w:]*(?:\.[A-Za-z_]\w*)+$/.test(token)) return resolveReference(token, context)
  return token
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
        filter: filter ? valueOf(filter, context) : undefined,
        filesOnly: truthy(params.get('file')),
        dirsOnly: truthy(params.get('directory')),
        nameOnly,
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
      if (truthy(params.get('raw'))) return readFileSync(path, 'utf8')

      const tail = param(params, 'tail')
      if (tail !== undefined) return readTailLines(path, Number(valueOf(tail, context)) || 0)

      const first = param(params, 'totalcount') ?? param(params, 'head')
      if (first !== undefined) {
        const count = Number(valueOf(first, context)) || 0
        const lines = []
        // Only read until the requested count is satisfied.
        forEachLine(path, (line) => {
          lines.push(line)
          return lines.length >= count ? false : undefined
        })
        return lines
      }

      const lines = []
      forEachLine(path, (line) => {
        lines.push(line)
      })
      return lines
    }
    case 'set-content':
    case 'sc': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const value = param(params, 'value') ?? args[1] ?? ''
      writeFileSync(path, `${valueOf(value, context)}\n`, 'utf8')
      return ''
    }
    case 'add-content': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const value = param(params, 'value') ?? args[1] ?? ''
      appendFileSync(path, `${valueOf(value, context)}\n`, 'utf8')
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
      if (type === 'directory' || type === 'dir') mkdirSync(path, { recursive: truthy(params.get('force')) })
      else writeFileSync(path, '', 'utf8')
      return shapeItem(path)
    }
    case 'remove-item':
    case 'rm':
    case 'del':
    case 'erase': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      // Removing a junction must unlink the link, never recurse into its target.
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
      else rmSync(path, { recursive: truthy(params.get('recurse')), force: truthy(params.get('force')) })
      return ''
    }
    case 'copy-item':
    case 'cp':
    case 'copy': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const destination = toPath(param(params, 'destination') ?? args[1], context)
      cpSync(path, destination, { recursive: truthy(params.get('recurse')), force: truthy(params.get('force')) })
      return ''
    }
    case 'move-item':
    case 'mv':
    case 'move': {
      const path = toPath(param(params, 'path') ?? args[0], context)
      const destination = toPath(param(params, 'destination') ?? args[1], context)
      renameSync(path, destination)
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
      const encoding = String(valueOf(param(params, 'encoding') ?? 'utf8', context)).toLowerCase()
      // PowerShell 5.1 writes a BOM; this tool deliberately writes BOM-free
      // UTF-8 so downstream tools never see U+FEFF.
      const codec = encoding === 'unicode' || encoding === 'utf16le' ? 'utf16le' : 'utf8'
      if (truthy(params.get('append'))) appendFileSync(filePath, text, codec)
      else writeFileSync(filePath, text, codec)
      return ''
    }
    case 'convertto-json': {
      const value = input !== undefined ? input : (param(params, 'inputobject') ?? args[1] ?? '')
      const compact = truthy(params.get('compress'))
      return JSON.stringify(value, null, compact ? 0 : 2)
    }
    case 'write-output':
    case 'write-host':
    case 'echo':
      return args.map((arg) => String(valueOf(arg, context))).join(' ')
    case 'select-object':
    case 'select': {
      let values = input ?? []
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
      return (input ?? []).filter((value) => truthy(runScriptBlock(block, value, context)))
    }
    case 'foreach-object':
    case 'foreach':
    case '%': {
      const block = param(params, 'process') ?? args[0]
      if (!block) nope('foreach-object without a block')
      return (input ?? []).map((value) => runScriptBlock(block, value, context))
    }
    case 'sort-object':
    case 'sort': {
      const keys = String(valueOf(param(params, 'property') ?? args[0] ?? '', context))
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
      const descending = truthy(params.get('descending'))
      const sorted = [...(input ?? [])]
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
      const values = input ?? []
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
        case 'delete':
          rmSync(toPath(args[0], context), { force: true })
          return ''
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

function runPipeline(command, context) {
  const single = command.trim()
  if (single.startsWith('[')) return callDotNet(single, context)
  if (/^\$[A-Za-z_][\w:]*(?:\.[A-Za-z_]\w*)*$/.test(single)) return resolveReference(single, context)

  const stages = splitPipeline(single)
  if (stages.length === 0) nope('empty pipeline')
  let values
  let index = 0
  // A pipeline may start from a variable: `$items | Select-Object -First 1`.
  if (stages.length > 1 && /^\$[A-Za-z_][\w:]*(?:\.[A-Za-z_]\w*)*$/.test(stages[0].trim())) {
    values = resolveReference(stages[0].trim(), context)
    index = 1
  }
  for (; index < stages.length; index++) {
    const parsed = parseStage(stages[index])
    values = runCmdlet(parsed, values, context)
    if (values === undefined) nope('undefined result')
  }
  return values
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
  'sls', 'out-file', 'convertto-json', 'write-output', 'write-host', 'echo',
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
