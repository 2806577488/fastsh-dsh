/**
 * Exercises startBackgroundJob and the streaming decoder against a stand-in
 * jobs registry, so the ring text, settlement status and cancellation can be
 * checked without a live DSH.
 */
import { startBackgroundJob, createStreamDecoder, clampOutputLimit } from '../src/exec.js'
import { fileURLToPath } from 'node:url'

/** Sleep command that starts no PING.EXE. */
const SLEEP = `"${process.execPath}" "${fileURLToPath(new URL('./sleep.cjs', import.meta.url))}"`

const ok = []
const bad = []
const check = (name, cond, detail) => (cond ? ok : bad).push(`${name} ${detail ?? ''}`)

function mockJobs() {
  const appended = []
  let hooks = null
  let outcome = null
  let killReason = null
  let lastSpec = null
  const settlePromise = { resolve: null }
  const settled = new Promise((resolve) => (settlePromise.resolve = resolve))
  const jobs = {
    start(spec) {
      lastSpec = spec
      const handle = {
        id: 'bash-test0001',
        append: (text, options) => appended.push({ text, channel: options?.channel }),
        updateProgress: () => {},
      }
      const raw = spec.run(handle)
      // Mirror the registry: it merges the caller's kill reason into `detail`.
      hooks = {
        cancel(reason) {
          killReason = reason
          raw.cancel(reason)
        },
        done: raw.done.then((value) => {
          const merged =
            value.status === 'killed' && killReason
              ? { ...value, detail: value.detail ? `${value.detail}; ${killReason}` : killReason }
              : value
          outcome = merged
          settlePromise.resolve(merged)
          return merged
        }),
      }
      return handle.id
    },
  }
  return {
    jobs,
    appended,
    settled,
    get hooks() {
      return hooks
    },
    get outcome() {
      return outcome
    },
    get lastSpec() {
      return lastSpec
    },
  }
}

const textOf = (appended) => appended.map((a) => a.text).join('')

// 1. GBK output streamed into the ring
{
  const mock = mockJobs()
  const id = startBackgroundJob({ jobs: mock.jobs, command: 'echo 中文 & echo 第二行', cwd: 'C:\\Windows' })
  check('job id returned', id === 'bash-test0001', id)
  await mock.settled
  const text = textOf(mock.appended)
  check('gbk stream decoded', text.includes('中文') && text.includes('第二行'), JSON.stringify(text))
  check('completed status', mock.outcome.status === 'completed', JSON.stringify(mock.outcome))
}

// 2. UTF-8 output streamed into the ring
{
  const nodeExe = process.execPath
  const mock = mockJobs()
  startBackgroundJob({ jobs: mock.jobs, command: `"${nodeExe}" -e "console.log('中文节点')"`, cwd: 'C:\\Windows' })
  await mock.settled
  const text = textOf(mock.appended)
  check('utf8 stream decoded', text.includes('中文节点'), JSON.stringify(text))
}

// 3. stderr channel kept separate
{
  const mock = mockJobs()
  startBackgroundJob({ jobs: mock.jobs, command: 'echo boom 1>&2', cwd: 'C:\\Windows' })
  await mock.settled
  const err = mock.appended.filter((a) => a.channel === 'stderr').map((a) => a.text).join('')
  check('stderr channel', err.includes('boom'), JSON.stringify(mock.appended))
}

// 4. non-zero exit becomes failed
{
  const mock = mockJobs()
  startBackgroundJob({ jobs: mock.jobs, command: 'exit /b 2', cwd: 'C:\\Windows' })
  await mock.settled
  check('failed status', mock.outcome.status === 'failed' && mock.outcome.detail.includes('2'), JSON.stringify(mock.outcome))
}

// 5. cancel kills the tree and settles as killed
{
  const mock = mockJobs()
  startBackgroundJob({ jobs: mock.jobs, command: `${SLEEP} 30000`, cwd: 'C:\\Windows' })
  await new Promise((r) => setTimeout(r, 600))
  mock.hooks.cancel('user stopped it')
  await Promise.race([mock.settled, new Promise((r) => setTimeout(r, 8000))])
  check('killed status', mock.outcome?.status === 'killed', JSON.stringify(mock.outcome))
  check('kill detail kept', mock.outcome?.detail === 'user stopped it', mock.outcome?.detail)
}

// 6. decoder boundary: a multi-byte character split across chunks
{
  const decoder = createStreamDecoder('auto')
  const full = Buffer.from('前缀中文后缀\n', 'utf8')
  let text = ''
  text += decoder.push(full.subarray(0, 4)) // splits the first Chinese character
  text += decoder.push(full.subarray(4))
  text += decoder.flush()
  check('split utf8 char', text === '前缀中文后缀\n', JSON.stringify(text))
}

// 7. decoder picks GBK on non-UTF-8 bytes ("中文" in code page 936)
{
  const decoder = createStreamDecoder('auto')
  const full = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  let text = ''
  text += decoder.push(full.subarray(0, 1))
  text += decoder.push(full.subarray(1))
  text += decoder.flush()
  check('gbk auto pick', text === '中文' && decoder.encoding === 'gbk', JSON.stringify({ text, encoding: decoder.encoding }))
}

// 8. per-job output ring limit is forwarded and clamped
{
  const mock = mockJobs()
  startBackgroundJob({ jobs: mock.jobs, command: 'echo x', cwd: 'C:\\Windows', outputLimitBytes: 300000 })
  await mock.settled
  check('outputLimitBytes forwarded', mock.lastSpec.outputLimitBytes === 300000, String(mock.lastSpec.outputLimitBytes))
}
{
  const mock = mockJobs()
  startBackgroundJob({ jobs: mock.jobs, command: 'echo x', cwd: 'C:\\Windows' })
  await mock.settled
  check('outputLimitBytes omitted', !('outputLimitBytes' in mock.lastSpec), JSON.stringify(mock.lastSpec.outputLimitBytes))
}
{
  check('clamp floor', clampOutputLimit(1) === 16 * 1024, String(clampOutputLimit(1)))
  check('clamp ceiling', clampOutputLimit(1e12) === 16 * 1024 * 1024, String(clampOutputLimit(1e12)))
  check('clamp invalid', clampOutputLimit('nope') === undefined, String(clampOutputLimit('nope')))
}

console.log('PASS:\n  ' + ok.join('\n  '))
if (bad.length) {
  console.log('FAIL:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log(`\n${ok.length} checks passed`)
