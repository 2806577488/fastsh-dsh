// Exits immediately but leaves a grandchild that keeps writing to the inherited
// stdout pipe. That is what keeps 'close' from firing after the tracked process
// is gone — the case the exit-fallback exists for. The pid is written out so the
// test can kill the writer afterwards.
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')

const writer = "const t=setInterval(()=>process.stdout.write('x'),200);setTimeout(()=>clearInterval(t),10000)"
const child = spawn(process.execPath, ['-e', writer], { stdio: 'inherit' })
child.unref()
writeFileSync(process.argv[2], String(child.pid))
