// Sandbox runner for the python-execute MCP tool.
//
// Spawns a fresh podman (or docker, when EMCP_PYTHON_SANDBOX_RUNTIME=docker)
// container per invocation, pipes the user's Python source into stdin, races
// the child against a wall-clock timeout, and returns a structured result.
// On timeout the local CLI process is SIGKILL'd AND an out-of-band kill is
// issued against the unique container name so the container can't outlive
// the Node parent. The user's code never appears on argv.

import { Buffer } from 'node:buffer';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const SANDBOX_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const SANDBOX_TMPFS_SPEC = '/tmp:rw,exec,size=64m,mode=1777';
export const SANDBOX_MEMORY_LIMIT = '256m';
export const SANDBOX_PIDS_LIMIT = '64';
export const SANDBOX_CPUS_LIMIT = '1';
export const SANDBOX_USER = '65534:65534';

const POST_KILL_GRACE_MS = 2000;

export interface BuildArgsOpts {
  readonly runtime: string;
  readonly image: string;
  readonly containerName: string;
}

/**
 * Build the argv passed to spawn(). Exported for shape-assertion in tests.
 * The user's code is never present in this argv — it is piped via stdin.
 */
export function buildPodmanArgs(opts: BuildArgsOpts): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    opts.containerName,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    SANDBOX_TMPFS_SPEC,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    SANDBOX_USER,
    '--memory',
    SANDBOX_MEMORY_LIMIT,
    '--memory-swap',
    SANDBOX_MEMORY_LIMIT,
    '--pids-limit',
    SANDBOX_PIDS_LIMIT,
    '--cpus',
    SANDBOX_CPUS_LIMIT,
    '--workdir',
    '/tmp',
    opts.image,
    'python3',
    '-u',
    '-',
  ];
}

export type SandboxCategory =
  | 'success'
  | 'code-error'
  | 'timeout'
  | 'runtime-not-installed'
  | 'runtime-failed-to-start';

export interface SandboxResult {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Process exit code. -1 on timeout / signal kill, -2 when the runtime
   * binary itself isn't installed or executable.
   */
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  /** True when stdout OR stderr was cut at SANDBOX_OUTPUT_LIMIT_BYTES. */
  readonly truncated: boolean;
  readonly category: SandboxCategory;
  /** The --name passed to podman. Useful for log correlation only. */
  readonly containerName: string;
}

export interface RunPythonOpts {
  readonly code: string;
  readonly timeoutMs: number;
  readonly runtime: string;
  readonly image: string;
}

export async function runPython(opts: RunPythonOpts): Promise<SandboxResult> {
  const containerName = `sandbox-${randomUUID()}`;
  const argv = buildPodmanArgs({
    runtime: opts.runtime,
    image: opts.image,
    containerName,
  });
  const startedAt = Date.now();

  // spawn() doesn't throw synchronously for ENOENT or "binary not found" —
  // those land on the `error` event we wire up below. The only synchronous
  // throws come from invalid arg shapes (e.g. non-string argv), which the
  // type system already prevents on this code path.
  const child: ChildProcess = spawn(opts.runtime, argv, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = newCappedBuffer();
  const stderr = newCappedBuffer();
  child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));

  // EPIPE on stdin write (child died early) lands here as an async event;
  // swallow it so it doesn't surface as an unhandledRejection. The close
  // event below carries the real outcome.
  child.stdin?.on('error', () => {});
  child.stdin?.write(opts.code);
  child.stdin?.end();

  type Settled =
    | {
        readonly kind: 'close';
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }
    | { readonly kind: 'spawn-error'; readonly err: NodeJS.ErrnoException };

  const settled = new Promise<Settled>((resolve) => {
    child.once('error', (err) =>
      resolve({ kind: 'spawn-error', err: err as NodeJS.ErrnoException }),
    );
    child.once('close', (code, signal) => resolve({ kind: 'close', code, signal }));
  });

  let timedOut = false;
  let outcome: Settled;
  const raced = await raceWithTimeout(settled, opts.timeoutMs);

  if (raced.timedOut) {
    timedOut = true;
    // Both kills are best-effort. child.kill() returns false (not throws)
    // when the process is already gone; spawn() of the kill helper hands
    // ENOENT to its `error` listener, which we ignore.
    child.kill('SIGKILL');
    const killer = spawn(opts.runtime, ['kill', '--signal', 'KILL', containerName], {
      stdio: 'ignore',
    });
    killer.on('error', () => {});
    killer.unref();
    // Brief grace so the streams flush before we read them out. If a
    // SIGKILL'd container somehow refuses to close within the grace
    // window, synthesise a kill result and move on.
    const post = await raceWithTimeout(settled, POST_KILL_GRACE_MS);
    /* c8 ignore next 3 -- post.timedOut requires a SIGKILL'd container that
       refuses to close inside POST_KILL_GRACE_MS, which is not reachable
       under any realistic kernel + container runtime. */
    outcome = post.timedOut ? { kind: 'close', code: null, signal: 'SIGKILL' } : post.value;
  } else {
    outcome = raced.value;
  }

  const duration_ms = Date.now() - startedAt;
  const truncated = stdout.truncated || stderr.truncated;

  if (outcome.kind === 'spawn-error') {
    return {
      stdout: stdout.toString(),
      stderr: outcome.err.message,
      exit_code: -2,
      duration_ms,
      timed_out: false,
      truncated,
      category: outcome.err.code === 'ENOENT' ? 'runtime-not-installed' : 'runtime-failed-to-start',
      containerName,
    };
  }

  const exit_code = outcome.code === null ? -1 : outcome.code;
  const stderrText = stderr.toString();
  let category: SandboxCategory;
  if (timedOut) {
    category = 'timeout';
  } else if (exit_code === 0) {
    category = 'success';
  } else if (exit_code === 125 && /^Error: /m.test(stderrText) && stdout.toString() === '') {
    // podman / docker emits "Error: ..." to stderr and exits 125 when the
    // image can't be resolved or the container can't be created. The user's
    // python never ran, so this is a tool-config failure rather than a
    // code error.
    category = 'runtime-failed-to-start';
  } else {
    category = 'code-error';
  }

  return {
    stdout: stdout.toString(),
    stderr: stderrText,
    exit_code,
    duration_ms,
    timed_out: timedOut,
    truncated,
    category,
    containerName,
  };
}

interface CappedBuffer {
  append(chunk: Buffer): void;
  toString(): string;
  readonly truncated: boolean;
}

function newCappedBuffer(): CappedBuffer {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    append(chunk: Buffer) {
      if (size >= SANDBOX_OUTPUT_LIMIT_BYTES) {
        truncated = true;
        return;
      }
      const room = SANDBOX_OUTPUT_LIMIT_BYTES - size;
      if (chunk.length <= room) {
        chunks.push(chunk);
        size += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, room));
      size += room;
      truncated = true;
    },
    toString() {
      return Buffer.concat(chunks, size).toString('utf8');
    },
    get truncated() {
      return truncated;
    },
  };
}

async function raceWithTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutP = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
    });
    const valueP = p.then((value) => ({ timedOut: false as const, value }));
    return await Promise.race([valueP, timeoutP]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
