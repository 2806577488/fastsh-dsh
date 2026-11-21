/**
 * fastsh — fast, encoding-safe Windows command execution for DSH.
 *
 * Registers one Host tool, `fastsh`, that runs a cmd.exe command line
 * directly instead of booting PowerShell. See README.md for the trade-offs.
 */

import { isAbsolute, resolve } from 'node:path'
import { clampOutputLimit, runCommand, runInBackground, startBackgroundJob } from './src/exec.js'

export const name = 'fastsh'

/** The tool registry is the only hard dependency. */
export const inject = ['tools']

const PROMPT_SECTION = `All Windows shell commands MUST run through the \`fastsh\` tool. The \`pwsh\` tool is disabled in this profile: calling it is an error. Plain commands run on cmd.exe; common PowerShell (Get-ChildItem, Get-Content, Test-Path, Select/Where/ForEach/Sort/Measure-Object, $env:, [System.IO.File]::) runs natively in milliseconds, and anything outside that subset falls back to Windows PowerShell. Any command that may run longer than about 30 seconds — builds, package installs, test suites, downloads, emulator runs, migrations — MUST pass run_in_background: true and leave conclude_turn at its default. That returns a job id and ends the turn; never run such a command in the foreground and never raise timeoutMs to cover it. DSH notifies you when the job settles, so do not poll job_output while it runs. To find a file across a tree, use \`Get-ChildItem <dir> -Recurse -Filter <name> -Name\`; append \`| Select-Object -First 1\` when any match will do, because it stops the walk as soon as one is found. Write commands that fail loudly and finish fast: chain with \`&&\`, never \`&\` (cmd's \`&\` runs the rest anyway and the exit code comes only from the last segment); to wait, use \`powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds <N>"\`, never \`ping\` (it opens a console window) and not \`timeout /t\` (it refuses redirected stdin, which this tool always has); never sleep in the foreground to poll — start the work with run_in_background and read it after the settle notice; to prove a file changed, compare second-precision mtime and size (\`stat -c '%s %y'\`) or a hash, because \`ls -l\` stops at the minute and SQLite writes may land in the -wal file instead; and do not wrap a cmd line in \`powershell -Command\` unless it genuinely needs PowerShell syntax. Content search across files belongs to the built-in \`grep\` tool (ripgrep): use it instead of \`Select-String\` or \`Get-ChildItem -Recurse | Select-String\`, which is the slow path; fastsh's \`Select-String\` is for filtering a command's own output.`

/** PowerShell tool this plugin replaces. */
const REPLACED_TOOL = 'pwsh'

const PARAMETERS = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description:
        'Clear, concise description of what this command does in active voice, 5-10 words; shown in the UI. Examples: "List files", "Show git status".',
    },
    command: {
      type: 'string',
      description:
        'The command line to run. cmd syntax (%VAR%, dir, type, copy, del, &&, &, |, >) runs on cmd.exe. PowerShell syntax is also accepted directly: common cmdlets and $env:/[System.]/:: expressions run natively in Node, and anything outside that subset is handed to Windows PowerShell.',
    },
    workdir: {
      type: 'string',
      description:
        'Working directory for this command. Defaults to the session workspace; a relative path resolves against it.',
    },
    timeoutMs: {
      type: 'number',
      description:
        'Timeout in milliseconds, default 120000, clamped to 1000-600000. On expiry the whole process tree is killed and the result reports timedOut.',
    },
    maxOutputChars: {
      type: 'number',
      description:
        'Maximum characters kept per stream before the middle is trimmed, default 200000. The complete decoded text is then written to a UTF-8 file reported as fullOutputPath.',
    },
    logFile: {
      type: 'string',
      description:
        'Path that receives the command\'s complete raw output (stdout and stderr, byte-faithful, UTF-8). Unlike job_output, which is a bounded ring buffer, this file keeps the whole transcript of a long build. Parent directories are created and an existing file is overwritten.',
    },
    run_in_background: {
      type: 'boolean',
      description:
        'Required for any command that may run longer than about 30 seconds (builds, installs, tests, downloads, emulators, migrations); optional below that. Starts the command as a DSH background job and returns its job id immediately, without waiting. Read it with job_output, list it with job_list, and stop it with job_kill. The job outlives this turn and is torn down with the session. When the jobs service is unavailable the command is started detached instead and pid plus UTF-8 log paths are returned.',
    },
    outputLimitBytes: {
      type: 'number',
      description:
        'Only with run_in_background: how many bytes of output this job keeps for job_output. Omitted, the jobs service keeps up to 256 KiB while running and trims to 16 KiB once it settles. When set, the job keeps up to this many bytes, including after settlement, so later reads can still recover more of the log. Clamped to 16 KiB-16 MiB.',
    },
    conclude_turn: {
      type: 'boolean',
      description:
        'Only with run_in_background, default true: end this turn immediately after the job starts, so no model step waits for the process. DSH notifies the session when the job settles. Pass false to keep working in the same turn instead.',
    },
    shell: {
      type: 'string',
      enum: ['auto', 'cmd', 'powershell'],
      description:
        'Command interpreter. Default "auto": plain commands use cmd.exe (about 0.15 s); PowerShell-looking commands run in a built-in Node subset first (milliseconds) and fall back to Windows PowerShell 5.1 only outside that subset. Force "cmd" or "powershell" to skip the guess.',
    },
    encoding: {
      type: 'string',
      enum: ['auto', 'utf8', 'gbk', 'utf16le'],
      description:
        'How stdout and stderr are decoded. Default "auto": strict UTF-8 when the bytes are valid UTF-8, otherwise the system ANSI code page (GBK on this machine). Set explicitly when a program emits a known encoding.',
    },
  },
  required: ['description', 'command'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'integer', description: 'Process exit code; omitted when the process was killed before exiting.' },
    signal: { type: 'string', description: 'Termination signal, when the process was signalled.' },
    timedOut: { type: 'boolean', description: 'True when the command was killed by timeoutMs.' },
    aborted: { type: 'boolean', description: 'True when the command was killed by caller cancellation.' },
    durationMs: { type: 'integer', description: 'Wall-clock duration in milliseconds.' },
    stdout: { type: 'string', description: 'Decoded standard output.' },
    stderr: { type: 'string', description: 'Decoded standard error.' },
    stdoutEncoding: { type: 'string', description: 'Encoding actually used for stdout.' },
    stderrEncoding: { type: 'string', description: 'Encoding actually used for stderr.' },
    truncated: { type: 'boolean', description: 'True when output was trimmed or a byte cap was reached.' },
    fullOutputPath: { type: 'string', description: 'UTF-8 file holding the complete decoded output when it was trimmed.' },
    logPath: { type: 'string', description: 'The logFile that received the complete raw output.' },
    background: { type: 'boolean', description: 'True for a run_in_background call.' },
    jobId: { type: 'string', description: 'DSH job id for a background run; pass it to job_output or job_kill.' },
    pid: { type: 'integer', description: 'Detached process id when no jobs service was available.' },
    stdoutPath: { type: 'string', description: 'UTF-8 stdout log of a detached fallback run.' },
    stderrPath: { type: 'string', description: 'UTF-8 stderr log of a detached fallback run.' },
    concluded: { type: 'boolean', description: 'True when this call ended the turn after starting the job.' },
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
    if (v.logPath) lines.push(`log: ${v.logPath}`)
    return lines.join('\n')
  }

  const marks = []
  if (v.timedOut) marks.push('timed out')
  if (v.aborted) marks.push('aborted')
  const head = `[exit code: ${v.exitCode ?? 'unknown'}]${marks.length ? ` [${marks.join(', ')}]` : ''} (${v.durationMs ?? 0} ms)`

  const parts = [head]
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
      'Run one Windows command line with cmd.exe and return its stdout, stderr and exit code. ' +
      'Starts in roughly 0.15 s here, against about 1.5 s for Windows PowerShell 5.1, and inherits this process\' permissions unchanged, so it can do anything PowerShell run by the same user can do. ' +
      'Output is decoded as UTF-8 when the bytes are valid UTF-8 and as the system ANSI code page (GBK) otherwise, so Chinese output is not mojibake; redirected files are written by the program itself and never transcoded. ' +
      'With run_in_background it starts a DSH job, so job_output, job_list and job_kill all work on it. ' +
      'This profile has no other shell tool: pwsh is disabled, so every command must come here. ' +
      'Plain commands run on cmd.exe; PowerShell-looking commands first run in a built-in Node subset and only fall back to Windows PowerShell outside it. ' +
      'Native subset: Get-ChildItem (-Name/-File/-Directory/-Recurse/-Filter/-Depth), Get-Item, Get-Content, Set/Add-Content, New-Item (incl. -ItemType Junction -Target), Remove/Copy/Move-Item, Test-Path (-PathType), Select-String, Out-File, Tee-Object, ConvertTo-Json, Get-Date (-Format), Get-Process, pipelines (Select/Where/ForEach/Sort/Measure-Object), variables $x=..., if/elseif/else, foreach, try/catch, $env:, $_, [System.IO.*]::, and the operators ; > >> 2> $(...) and & exe. ' +
      'Background jobs always spawn a real cmd or PowerShell process, never the native subset. Prefer logFile over Tee-Object for full build logs, because job_output is a bounded ring.',

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
      }

      if (input.run_in_background === true) {
        const jobId = tryStartJob(ctx, request, input, exec)
        let value
        if (jobId) {
          value = stripEmpty({ background: true, jobId })
        } else {
          const started = runInBackground(request)
          value = stripEmpty({
            background: true,
            pid: started.pid,
            stdoutPath: started.stdoutPath,
            stderrPath: started.stderrPath,
            durationMs: 0,
            truncated: false,
          })
        }

        // Fire and forget: end the turn right away so no model step waits for
        // the process. The job's settlement notification wakes the session.
        if (input.conclude_turn !== false && typeof exec?.concludeTurn === 'function') {
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
