/**
 * Runs the native PowerShell subset off the host thread. A pathological regex
 * or a huge recursive listing can only wedge this worker; the host terminates
 * it and starts a fresh one.
 *
 * The context object is also how the subset reports *why* it declined a
 * command (`context.unsupported`), which is what the usage log records.
 */
import { parentPort } from 'node:worker_threads'
import { runNativePowerShell } from './ps.js'

parentPort.on('message', ({ id, command, cwd }) => {
  const context = { cwd, env: process.env }
  try {
    const result = runNativePowerShell(command, context)
    parentPort.postMessage({ id, result, unsupported: context.unsupported ?? null })
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message ?? String(error), unsupported: context.unsupported ?? null })
  }
})
