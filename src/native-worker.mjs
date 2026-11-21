/**
 * Runs the native PowerShell subset off the host thread. A pathological regex
 * or a huge recursive listing can only wedge this worker; the host terminates
 * it and starts a fresh one.
 */
import { parentPort } from 'node:worker_threads'
import { runNativePowerShell } from './ps.js'

parentPort.on('message', ({ id, command, cwd }) => {
  try {
    const result = runNativePowerShell(command, { cwd, env: process.env })
    parentPort.postMessage({ id, result })
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message ?? String(error) })
  }
})
