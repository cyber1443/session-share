import { spawn, type ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'

/**
 * A pseudo-terminal without a native module.
 *
 * Claude Code's interface draws itself for a terminal: it needs a tty to read
 * keys from and a window size to lay out against, and a plain pipe gives it
 * neither. Node has no pty of its own, and the usual fix -- node-pty -- is a
 * compiled addon, which would end the plugin's promise that installing it
 * runs nothing. Python's standard library has one, and every machine that has
 * git from Xcode's command line tools, or any Linux, has Python. So a few
 * lines of it sit between Node and the program: bytes in on stdin, bytes out
 * on stdout, and window sizes as "cols rows" lines on a third pipe.
 */
export const PTY_HELPER = String.raw`
import os, sys, pty, select, signal, struct, fcntl, termios, errno, time

cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]

def size(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))

master, slave = pty.openpty()
# Sized before the program starts, so its first frame is laid out right.
size(slave, cols, rows)
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    if hasattr(termios, 'TIOCSCTTY'):
        try:
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        except OSError:
            pass
    for target in (0, 1, 2):
        os.dup2(slave, target)
    if slave > 2:
        os.close(slave)
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    try:
        os.execvp(argv[0], argv)
    except Exception as error:
        os.write(2, ('could not start %s: %s\r\n' % (argv[0], error)).encode())
        os._exit(127)

os.close(slave)

def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EINTR):
                continue
            return
        data = data[n:]

def hang_up(*_):
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass

signal.signal(signal.SIGTERM, hang_up)
signal.signal(signal.SIGHUP, hang_up)

watching = [master, 0, 3]
pending = b''
deadline = None
while True:
    timeout = None if deadline is None else max(0, deadline - time.time())
    try:
        ready, _, _ = select.select(watching, [], [], timeout)
    except InterruptedError:
        continue
    if deadline is not None and time.time() >= deadline:
        # Asked to stop and still here: it does not get a say any more.
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        deadline = None
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b''
        if not data:
            break
        write_all(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            write_all(master, data)
        else:
            # Node closed our stdin: that is the request to stop.
            watching.remove(0)
            hang_up()
            deadline = time.time() + 3
    if 3 in ready:
        data = os.read(3, 4096)
        if not data:
            watching.remove(3)
        else:
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                parts = line.split()
                if len(parts) == 2:
                    try:
                        size(master, int(parts[0]), int(parts[1]))
                    except (ValueError, OSError):
                        pass

_, status = os.waitpid(pid, 0)
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
sys.exit(128 + os.WTERMSIG(status))
`

export interface Pty {
  write(data: Buffer | string): void
  resize(cols: number, rows: number): void
  /** Hang up: the program gets SIGHUP, and SIGKILL three seconds later if it is still there. */
  kill(): void
  readonly pid: number | undefined
}

export interface PtyOptions {
  command: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  env?: NodeJS.ProcessEnv
  onData: (data: Buffer) => void
  onExit: (code: number | null, reason: string | null) => void
  /** The interpreter. Injectable so a test can watch it be missing. */
  python?: string
}

export function spawnPty(options: PtyOptions): Pty {
  const child: ChildProcess = spawn(
    options.python ?? 'python3',
    ['-c', PTY_HELPER, String(options.cols), String(options.rows), options.command, ...options.args],
    {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    },
  )
  const control = child.stdio[3] as Writable
  let stderr = ''
  let exited = false

  child.stdout!.on('data', (chunk: Buffer) => options.onData(chunk))
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk}`.slice(-2000)
  })
  // A pipe closing under us is an exit on its way, not a crash.
  child.stdin!.on('error', () => undefined)
  control.on('error', () => undefined)
  child.on('error', (error) => {
    if (exited) return
    exited = true
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    options.onExit(
      null,
      missing ? 'python3 is not installed on that machine, and the terminal needs it' : error.message,
    )
  })
  child.on('close', (code, signal) => {
    if (exited) return
    exited = true
    const said = stderr.trim().split('\n').at(-1) ?? ''
    options.onExit(code, code === 0 ? null : said || (signal ? `stopped by ${signal}` : null))
  })

  return {
    pid: child.pid,
    write(data) {
      if (!exited) child.stdin!.write(data)
    },
    resize(cols, rows) {
      if (!exited) control.write(`${cols} ${rows}\n`)
    },
    kill() {
      if (!exited) child.stdin!.end()
    },
  }
}
