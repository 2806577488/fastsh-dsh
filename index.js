/**
 * fastsh — fast, encoding-safe Windows command execution for DSH.
 *
 * Registers one Host tool, `fastsh`, that runs a cmd.exe command line
 * directly instead of booting PowerShell. See README.md for the trade-offs.
 */

import { isAbsolute, resolve } from 'node:path'
import { clampOutputLimit, formatWatchReport, runCommand, runInBackground, startBackgroundJob } from './src/exec.js'

export const name = 'fastsh'

/** The tool registry is the only hard dependency. */
export const inject = ['tools']

const PROMPT_SECTION = `All Windows shell commands MUST run through the \`fastsh\` tool; \`pwsh\` is disabled and calling it errors. Plain commands run on cmd.exe. PowerShell syntax (cmdlets, \`$env:\`, \`$_\`, [System.*]::, pipes) runs natively in milliseconds when supported; anything outside the subset falls back to Windows PowerShell 5.1 (~1.8 s). Any command that may exceed ~30 s (builds, installs, tests, downloads, migrations) MUST pass run_in_background: true. The turn keeps running: say what started, then report on the settle notice. Never cover it with timeoutMs and never poll job_output. Pass conclude_turn: true only to end the turn immediately. Chain with \`&&\`, never \`&\`: cmd's \`&\` ignores failures and the exit code comes only from the last segment. Do not wrap a cmd line in \`powershell -Command\` unless it needs PowerShell syntax. Wait with \`powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds <N>"\`; never \`ping\` (opens a console) or \`timeout /t\` (refuses redirected stdin, which this tool always has). Prove a change with \`Get-FileHash <file>\`; mtime+size is cheaper but \`ls -l\` stops at the minute and SQLite may write the -wal file. Find a file with \`Get-ChildItem <dir> -Recurse -Filter <name> -Name\`, adding \`| Select-Object -First 1\` when one match is enough. Content search belongs to the built-in \`grep\` tool; fastsh's \`Select-String\` only filters a command's own output. Prefer one native cmdlet over a script: \`Get-FileHash <file>\`, \`Get-Content <json> | ConvertFrom-Json\`, \`Resolve-Path\`, \`Select-Object -Unique\`; \`-ErrorAction SilentlyContinue\` replaces \`if (Test-Path ...)\` guards and never bypasses a delete refusal. Keep short commands in the foreground: 30 s is a ceiling, not a default.`

/** PowerShell tool this plugin replaces. */
const REPLACED_TOOL = 'pwsh'

const PARAMETERS = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'What the command does, 5-10 words; shown in the UI. Example: "List files".',
    },
    command: {
      type: 'string',
      description:
        'Command line. cmd syntax runs on cmd.exe; PowerShell syntax (cmdlets, $env:, [System.]::, pipes, redirection) runs natively when supported, else Windows PowerShell 5.1.',
    },
    workdir: {
      type: 'string',
      description: 'Working directory; defaults to the session workspace. Relative paths resolve against it.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Timeout in ms, 1000-600000 (default 120000). Expiry kills the process tree and sets timedOut.',
    },
    maxOutputChars: {
      type: 'number',
      description: 'Max chars kept per stream before the middle is trimmed (default 200000); full text goes to fullOutputPath.',
    },
    logFile: {
      type: 'string',
      description: 'File for the complete raw output (UTF-8), unlike the bounded job_output ring.',
    },
    watch: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files to hash before and after; reports sha256 + size, marks unchanged, reports gone/missing.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Start as a DSH job for commands that may exceed ~30 s; returns jobId at once.',
    },
    outputLimitBytes: {
      type: 'number',
      description: 'run_in_background only: bytes kept for job_output (16 KiB-16 MiB; default 256 KiB, 16 KiB after settle).',
    },
    conclude_turn: {
      type: 'boolean',
      description: 'run_in_background only: end the turn immediately instead of keeping it running.',
    },
    shell: {
      type: 'string',
      enum: ['auto', 'cmd', 'powershell'],
      description: '"auto" routes cmd vs native PowerShell vs real PowerShell; force "cmd" or "powershell".',
    },
    encoding: {
      type: 'string',
      enum: ['auto', 'utf8', 'gbk', 'utf16le'],
      description: '"auto" = strict UTF-8 else the ANSI codepage (GBK here); or force one.',
    },
  },
  required: ['description', 'command'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'integer' },
    signal: { type: 'string' },
    timedOut: { type: 'boolean', description: 'Killed by timeoutMs.' },
    aborted: { type: 'boolean', description: 'Killed by the caller.' },
    durationMs: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    stdoutEncoding: { type: 'string' },
    stderrEncoding: { type: 'string' },
    truncated: { type: 'boolean', description: 'Output was trimmed or byte-capped.' },
    fullOutputPath: { type: 'string', description: 'File with the complete output when trimmed.' },
    logPath: { type: 'string' },
    background: { type: 'boolean' },
    jobId: { type: 'string', description: 'DSH job id for job_output/job_kill.' },
    watching: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files hashed when a background job settles.',
    },
    watchReport: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          before: { type: 'object' },
          after: { type: 'object' },
          changed: { type: 'boolean' },
        },
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Cautions about the command text.',
    },
    pid: { type: 'integer' },
    stdoutPath: { type: 'string' },
    stderrPath: { type: 'string' },
    concluded: { type: 'boolean' },
  },
}

/**
 * The tool's output schema is strict about types, so drop absent fields
 * instead of returning null for them.
 */
function stripEmpty(value) {
  const out = {}
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry === null || entry === undefined) continue
    out[key] = entry
  }
  return out
}

function renderText(value) {
  const v = value && typeof value === 'object' ? value : {}

  if (v.background) {
    const lines = v.jobId
      ? [`started as job ${v.jobId}`, 'read it with job_output and stop it with job_kill']
      : [
          'started in background',
          `pid: ${v.pid ?? 'unknown'}`,
          `stdout: ${v.stdoutPath ?? 'unavailable'}`,
          `stderr: ${v.stderrPath ?? 'unavailable'}`,
        ]
    if (v.concluded) lines.push('this turn ends here; DSH notifies you when the job settles')
    if (Array.isArray(v.watching) && v.watching.length) lines.push(`watching: ${v.watching.join(', ')}`)
    if (v.logPath) lines.push(`log: ${v.logPath}`)
    return lines.join('\n')
  }

  // 警告与产物对比放在最上面：它们是这次调用最需要先看到的两行。
  const parts = []
  for (const warning of Array.isArray(v.warnings) ? v.warnings : []) parts.push(warning)
  const watchText = formatWatchReport(v.watchReport)
  if (watchText) parts.push(watchText)

  const marks = []
  if (v.timedOut) marks.push('timed out')
  if (v.aborted) marks.push('aborted')
  const head = `[exit code: ${v.exitCode ?? 'unknown'}]${marks.length ? ` [${marks.join(', ')}]` : ''} (${v.durationMs ?? 0} ms)`

  parts.push(head)
  const stdout = typeof v.stdout === 'string' ? v.stdout.replace(/\s+$/, '') : ''
  if (stdout) parts.push(stdout)
  const stderr = typeof v.stderr === 'string' ? v.stderr.replace(/\s+$/, '') : ''
  if (stderr) parts.push(`stderr:\n${stderr}`)
  if (v.truncated) parts.push('[output truncated to the tail]')
  if (v.logPath) parts.push(`log: ${v.logPath}`)
  if (v.fullOutputPath) parts.push(`full output: ${v.fullOutputPath}`)
  return parts.join('\n')
}

/**
 * The job card renders `label` as both its title and its `$ <label>` line, and
 * the service stores no separate command field — so the command has to be the
 * label, or the card says nothing about what is running.
 */
function jobLabel(description, command) {
  const text = String(command ?? '').replace(/\s+/g, ' ').trim()
  const short = text.length > 120 ? `${text.slice(0, 117)}...` : text
  if (short) return short
  return typeof description === 'string' && description ? description : 'background job'
}

/** Open a DSH job when the jobs service and its controller are available. */
function tryStartJob(ctx, request, input, exec) {
  const jobs = ctx.get('jobs')
  if (!jobs || typeof jobs.start !== 'function') return undefined
  const callId = exec?.callId
  try {
    return startBackgroundJob({
      jobs,
      command: request.command,
      cwd: request.cwd,
      shell: request.shell,
      encoding: request.encoding,
      label: jobLabel(input.description, request.command),
      owner: exec?.agent?.id,
      toolCall: callId ? { callId, rootCallId: exec.rootCallId ?? callId } : undefined,
      outputLimitBytes: clampOutputLimit(input.outputLimitBytes),
      logFile: request.logFile,
      watch: request.watch,
    })
  } catch {
    // The jobs service refuses work when no attached controller serves the owner.
    return undefined
  }
}

function createDefinition(ctx) {
  return {
    name: 'fastsh',
    description:
      'Run one Windows command line with cmd.exe or Windows PowerShell and return stdout, stderr and exit code. ' +
      'Plain commands start in ~0.15 s; PowerShell syntax runs natively in milliseconds when supported and falls back to Windows PowerShell 5.1 (~1.8 s) otherwise. ' +
      'stdin is always redirected. Output decodes as strict UTF-8, else the ANSI codepage (GBK here); files written by redirection are untouched. ' +
      "Inherits this process' token and environment, so it can do anything the user can. " +
      'run_in_background starts a DSH job (job_output / job_kill); logFile keeps the complete raw transcript. ' +
      'Native subset: Get-ChildItem (-Name/-File/-Directory/-Recurse/-Filter/-Depth), Get-Item, Get-Content (-Raw/-TotalCount/-Tail), Set/Add-Content, New-Item (incl. junction), Remove/Copy/Move-Item, Test-Path (-PathType), Join/Split-Path, Get-Location, Get-FileHash, Resolve-Path, ConvertFrom/To-Json, Format-Table/List, Select-String, Out-File, Tee-Object, Get-Date (-Format), Get-Process, Select/Where/ForEach/Sort/Measure-Object, $env:/$x/$_ and .Property chains, if/foreach/try, [System.IO.File|Directory|Path|Environment]::, [math]/[Guid]/[DateTime], ; > >> 2> $(...) & exe. ' +
      'Anything else is handed to Windows PowerShell 5.1. This profile has no other shell tool; pwsh is disabled.',

    parameters: PARAMETERS,

    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },

    presentCall(args) {
      const title = typeof args?.description === 'string' && args.description ? args.description : 'Command'
      return { card: 'terminal', title }
    },

    isConcurrencySafe() {
      return true
    },

    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      if (typeof input.command !== 'string' || input.command.trim() === '') {
        throw new Error('fastsh requires a non-empty "command" string.')
      }

      let baseCwd = process.cwd()
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory && exec?.agent) {
        try {
          const resolved = await workingDirectory.ensure(exec.agent, exec.signal)
          if (typeof resolved === 'string' && resolved) baseCwd = resolved
        } catch {
          /* fall back to the host cwd */
        }
      }

      const requested = typeof input.workdir === 'string' && input.workdir.trim() ? input.workdir.trim() : undefined
      const cwd = requested ? (isAbsolute(requested) ? requested : resolve(baseCwd, requested)) : baseCwd

      const request = {
        command: input.command,
        cwd,
        shell: input.shell === 'powershell' || input.shell === 'cmd' ? input.shell : 'auto',
        encoding: typeof input.encoding === 'string' ? input.encoding : 'auto',
        logFile:
          typeof input.logFile === 'string' && input.logFile.trim() ? input.logFile.trim() : undefined,
        watch: Array.isArray(input.watch)
          ? input.watch
              .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
              .map((entry) => entry.trim())
          : undefined,
      }

      if (input.run_in_background === true) {
        const jobId = tryStartJob(ctx, request, input, exec)
        const watching = request.watch?.length ? { watching: request.watch } : {}
        let value
        if (jobId) {
          value = stripEmpty({ background: true, jobId, ...watching })
        } else {
          const started = runInBackground(request)
          value = stripEmpty({
            background: true,
            pid: started.pid,
            stdoutPath: started.stdoutPath,
            stderrPath: started.stderrPath,
            durationMs: 0,
            truncated: false,
            ...watching,
          })
        }

        // Fire and forget: end the turn right away so no model step waits for
        // the process. The job's settlement notification wakes the session.
        if (input.conclude_turn === true && typeof exec?.concludeTurn === 'function') {
          exec.concludeTurn()
          value.concluded = true
        }
        return value
      }

      const result = await runCommand(
        { ...request, timeoutMs: input.timeoutMs, maxChars: input.maxOutputChars },
        exec?.signal,
      )
      if (result.error) throw new Error(`fastsh could not start the command: ${result.error}`)
      return stripEmpty(result)
    },
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(createDefinition(ctx)))

  // Every model must go through fastsh: take the PowerShell tool away instead
  // of merely asking politely. fastsh covers PowerShell syntax through
  // shell: "powershell", so nothing is lost.
  try {
    ctx.effect(() => ctx.tools.restrict({ deny: [REPLACED_TOOL] }))
  } catch {
    /* a tools build without restrict still gets the prompt rule */
  }

  // Agents created later, subagents included, get the same restriction scoped
  // to them. Live agents that predate this plugin need it too, otherwise pwsh
  // stays in their schema even though the guard blocks it.
  const restrictAgent = (agent) => {
    const scopedTools = agent?.ctx?.tools
    if (!scopedTools || typeof scopedTools.restrict !== 'function') return
    try {
      agent.ctx.effect(() => scopedTools.restrict({ deny: [REPLACED_TOOL] }))
    } catch {
      /* the guard still blocks execution */
    }
  }

  ctx.on('agent/created', ({ agent }) => restrictAgent(agent))

  try {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) restrictAgent(agent)
  } catch {
    /* listing live agents is best-effort */
  }

  // Last line of defence: if a pwsh call still reaches execution, refuse it.
  try {
    ctx.effect(() =>
      ctx.tools.guard((execution) =>
        execution?.name === REPLACED_TOOL
          ? `The ${REPLACED_TOOL} tool is disabled in this profile. Run the command with fastsh instead; for PowerShell syntax pass shell: "powershell".`
          : undefined,
      ),
    )
  } catch {
    /* the prompt rule still applies */
  }

  // A nudge in the prompt so the agent actually reaches for this tool.
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() =>
      scoped.systemPrompt.section({
        name: 'fastsh',
        order: 1200,
        text: PROMPT_SECTION,
      }),
    )
  })

  // Background runs are DSH jobs; the registry only accepts work for owners
  // that an attached controller serves.
  ctx.inject(['jobs'], (scoped) => {
    const jobs = scoped.jobs
    if (!jobs || typeof jobs.attachController !== 'function') return
    scoped.effect(() => jobs.attachController('fastsh'))
  })
}
