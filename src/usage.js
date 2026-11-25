/**
 * Usage log: one JSON line per fastsh execution.
 *
 * The point is to see how often a command ran natively, where it fell back to
 * real PowerShell, and *why* — the native subset grows from that data. The log
 * lives under the user's own profile, is append-only, rotates at 5 MB, and can
 * be disabled with `FASTSH_USAGE_LOG=off`.
 *
 * A failed write never breaks a command: the whole point is observability, and
 * a read-only profile must not turn into a shell error.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_COMMAND_CHARS = 2000
const DISABLED = /^(?:off|0|false|none|no)$/i

/** Log file path, or null when logging is disabled. */
export function usageLogPath() {
  const forced = (process.env.FASTSH_USAGE_LOG ?? '').trim()
  if (forced) return DISABLED.test(forced) ? null : forced
  const base = process.env.LOCALAPPDATA || process.env.USERPROFILE || process.env.HOME
  return base ? join(base, 'dsh-fastsh', 'usage.jsonl') : join(tmpdir(), 'dsh-fastsh', 'usage.jsonl')
}

function rotate(path) {
  try {
    if (statSync(path).size < MAX_BYTES) return
  } catch {
    return
  }
  try {
    renameSync(path, `${path}.1`)
  } catch {
    /* a failed rename only means the file keeps growing */
  }
}

/** Append one entry. Never throws. */
export function recordUsage(entry) {
  const path = usageLogPath()
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    rotate(path)
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    /* observability must not become a failure mode */
  }
}

/**
 * Commands are logged up to 2 KB: enough to recognise them, bounded so a
 * pasted file cannot balloon the log. `commandChars` keeps the real size.
 */
export function commandForLog(command) {
  const text = String(command ?? '')
  return {
    command: text.length > MAX_COMMAND_CHARS ? `${text.slice(0, MAX_COMMAND_CHARS)}…` : text,
    commandChars: text.length,
  }
}
