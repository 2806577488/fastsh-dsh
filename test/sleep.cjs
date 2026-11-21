// Test fixture: a child process that just sleeps, so timeout, abort and
// background cases do not need `ping -n N` (which spawns PING.EXE).
const ms = Number(process.argv[2] ?? 30000)
const delay = Number.isFinite(ms) && ms > 0 ? ms : 30000
setTimeout(() => process.exit(0), delay)
