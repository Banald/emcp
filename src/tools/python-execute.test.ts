// python-execute tool tests.
//
// **REQUIRES REAL PODMAN AND THE python-sandbox:latest IMAGE.**
//
// Per docs/TESTING.md these tests run as part of the unit gate, but
// `python-execute` is the one tool whose security properties (network
// isolation, read-only rootfs, code-not-on-argv) only have meaning against
// a real container runtime. The trade-off the project accepted: build the
// image once with `bash scripts/build-python-sandbox.sh`, then `npm test`
// runs against it.
//
// If podman or the image is missing, the `before` hook fails loudly with the
// remediation command. There is no skip-and-pretend mode.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { before, describe, it, mock } from 'node:test';
import { z } from 'zod';
import {
  buildPodmanArgs,
  runPython,
  SANDBOX_OUTPUT_LIMIT_BYTES,
  type SandboxResult,
} from '../shared/sandbox/python-runner.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, { __setRunnerForTesting } from './python-execute.ts';

const RUNTIME = process.env.EMCP_PYTHON_SANDBOX_RUNTIME ?? 'podman';
const IMAGE = process.env.EMCP_PYTHON_SANDBOX_IMAGE ?? 'python-sandbox:latest';

const makeCtx = (overrides: Record<string, unknown> = {}): ToolContext =>
  ({
    logger: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
      debug: mock.fn(),
    },
    db: { query: mock.fn(async () => ({ rows: [] })) },
    redis: { get: mock.fn(), set: mock.fn() },
    apiKey: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      prefix: 'mcp_test_abc',
      name: 'test key',
      rateLimitPerMinute: 60,
    },
    requestId: 'req-python-execute-test',
    signal: new AbortController().signal,
    ...overrides,
  }) as unknown as ToolContext;

const textOf = (result: Awaited<ReturnType<typeof tool.handler>>): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

type Args = Parameters<typeof tool.handler>[0];

// In production, the MCP transport validates input via Zod (which applies
// schema defaults like `timeout_ms: 5000`) before calling the handler.
// Mirror that here so tests don't accidentally pass `timeout_ms: undefined`.
const handlerInputSchema = z.object(tool.inputSchema);
const callHandler = async (
  raw: { code: string; timeout_ms?: number },
  ctx?: ToolContext,
): Promise<Awaited<ReturnType<typeof tool.handler>>> =>
  tool.handler(handlerInputSchema.parse(raw) as Args, ctx ?? makeCtx());

before(() => {
  const v = spawnSync(RUNTIME, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) {
    throw new Error(
      `python-execute tests require "${RUNTIME}" on PATH (exit ${v.status}). ` +
        `Install it (Debian/Ubuntu: sudo apt-get install -y podman; ` +
        `Fedora/RHEL: sudo dnf install -y podman).`,
    );
  }
  const inspect = spawnSync(RUNTIME, ['image', 'inspect', IMAGE], {
    encoding: 'utf8',
  });
  if (inspect.status !== 0) {
    throw new Error(
      `python-execute tests require the "${IMAGE}" image to be built. ` +
        `Run: bash scripts/build-python-sandbox.sh`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tool metadata + schema
// ---------------------------------------------------------------------------

describe('python-execute metadata', () => {
  it('has the required identity fields', () => {
    assert.equal(tool.name, 'python-execute');
    assert.equal(tool.title, 'Python Execute');
    assert.ok(tool.description.length > 200);
  });

  it('description references real Python, network isolation, and the calculator carve-out', () => {
    assert.match(tool.description, /Python/);
    assert.match(tool.description, /network/i);
    assert.match(tool.description, /calculator/);
  });

  it('declares both inputSchema and outputSchema', () => {
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
  });

  it('caps invocation rate at 10 per minute', () => {
    assert.deepEqual(tool.rateLimit, { perMinute: 10 });
  });
});

describe('python-execute input schema', () => {
  const schema = z.object(tool.inputSchema);

  it('accepts a minimal valid input with default timeout', () => {
    const result = schema.safeParse({ code: 'print(1)' });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.timeout_ms, 5000);
  });

  it('rejects empty code', () => {
    assert.equal(schema.safeParse({ code: '' }).success, false);
  });

  it('rejects code longer than 64,000 chars', () => {
    assert.equal(schema.safeParse({ code: 'x'.repeat(64_001) }).success, false);
  });

  it('rejects timeout_ms below 100', () => {
    assert.equal(schema.safeParse({ code: 'print(1)', timeout_ms: 50 }).success, false);
  });

  it('rejects timeout_ms above 15,000', () => {
    assert.equal(schema.safeParse({ code: 'print(1)', timeout_ms: 30_000 }).success, false);
  });

  it('rejects non-integer timeout_ms', () => {
    assert.equal(schema.safeParse({ code: 'print(1)', timeout_ms: 1500.5 }).success, false);
  });
});

// ---------------------------------------------------------------------------
// Argv shape — the user's code must never appear on argv.
// ---------------------------------------------------------------------------

describe('buildPodmanArgs', () => {
  it('builds an argv with every required isolation flag', () => {
    const argv = buildPodmanArgs({
      runtime: 'podman',
      image: 'python-sandbox:latest',
      containerName: 'sandbox-fixed-uuid',
    });

    // Every flag the security-rule depends on is present.
    assert.ok(argv.includes('--rm'));
    assert.ok(argv.includes('-i'));
    assert.ok(argv.includes('--network'));
    assert.ok(argv.includes('none'));
    assert.ok(argv.includes('--read-only'));
    assert.ok(argv.includes('--cap-drop'));
    assert.ok(argv.includes('ALL'));
    assert.ok(argv.includes('--security-opt'));
    assert.ok(argv.includes('no-new-privileges'));
    assert.ok(argv.includes('--user'));
    assert.ok(argv.includes('65534:65534'));
    assert.ok(argv.includes('--workdir'));
    assert.ok(argv.includes('/tmp'));
    assert.ok(argv.includes('--tmpfs'));
    assert.ok(argv.includes('--memory'));
    assert.ok(argv.includes('--memory-swap'));
    assert.ok(argv.includes('--pids-limit'));
    assert.ok(argv.includes('--cpus'));
    // Container name and image both wired in.
    assert.ok(argv.includes('--name'));
    assert.ok(argv.includes('sandbox-fixed-uuid'));
    assert.ok(argv.includes('python-sandbox:latest'));
    // The python invocation reads from stdin (`-`), which means user code
    // is piped, not on argv.
    assert.deepEqual(argv.slice(-3), ['python3', '-u', '-']);
  });

  it('does not allow user code to appear on argv', () => {
    // The contract: callers MUST pipe code via stdin. buildPodmanArgs has no
    // parameter for code at all — even if a future caller tried to mistake
    // an arg for it, the helper has no slot to take it.
    const argv = buildPodmanArgs({
      runtime: 'podman',
      image: IMAGE,
      containerName: 'sandbox-x',
    });
    const sentinel = 'IF_THIS_APPEARS_ON_ARGV_THE_TOOL_IS_BROKEN';
    assert.equal(
      argv.some((part) => part.includes(sentinel)),
      false,
    );
    assert.equal(
      argv.some((part) => part.startsWith('python3') && part !== 'python3'),
      false,
    );
  });

  it('image precedes the in-container command', () => {
    const argv = buildPodmanArgs({
      runtime: 'podman',
      image: 'IMG',
      containerName: 'CN',
    });
    const imageIdx = argv.indexOf('IMG');
    const pyIdx = argv.indexOf('python3');
    assert.ok(imageIdx >= 0 && pyIdx > imageIdx);
  });
});

describe('container name uniqueness', () => {
  it('runPython produces a unique --name per invocation', async () => {
    const a = await runPython({
      code: 'print(1)',
      timeoutMs: 8_000,
      runtime: RUNTIME,
      image: IMAGE,
    });
    const b = await runPython({
      code: 'print(1)',
      timeoutMs: 8_000,
      runtime: RUNTIME,
      image: IMAGE,
    });
    assert.notEqual(a.containerName, b.containerName);
    assert.match(a.containerName, /^sandbox-/);
    assert.match(b.containerName, /^sandbox-/);
  });
});

// ---------------------------------------------------------------------------
// Real-sandbox behavior
// ---------------------------------------------------------------------------

describe('python-execute happy paths', () => {
  it('runs a simple print and returns exit 0', async () => {
    const result = await callHandler({ code: 'print(2 + 2)' });
    assert.equal(
      result.isError,
      undefined,
      `unexpected isError; full result: ${JSON.stringify(result)}`,
    );
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.exit_code, 0);
    assert.equal(sc.timed_out, false);
    assert.equal(sc.truncated, false);
    assert.equal((sc.stdout as string).trim(), '4');
    assert.equal(sc.stderr, '');
    assert.match(textOf(result), /Exit code: 0/);
    assert.match(textOf(result), /^4$/m);
  });

  it('imports the full scientific stack', async () => {
    const result = await callHandler({
      code: 'import numpy, pandas, scipy, sympy, matplotlib, sklearn; print("ok")',
      timeout_ms: 15_000,
    });
    assert.equal(result.isError, undefined);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.exit_code, 0);
    assert.match(sc.stdout as string, /ok/);
  });

  it('writes to /tmp without error', async () => {
    const result = await callHandler({
      code: 'p="/tmp/x"\nopen(p,"w").write("hi")\nprint(open(p).read())',
    });
    assert.equal(result.isError, undefined);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.exit_code, 0);
    assert.match(sc.stdout as string, /hi/);
  });
});

describe('python-execute code errors', () => {
  it('returns isError on a syntax error', async () => {
    const result = await callHandler({ code: 'def (' });
    assert.equal(result.isError, true);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.notEqual(sc.exit_code, 0);
    assert.match(sc.stderr as string, /SyntaxError/);
    assert.match(textOf(result), /SyntaxError/);
  });

  it('returns isError on a runtime exception', async () => {
    const result = await callHandler({ code: 'raise ValueError("boom")' });
    assert.equal(result.isError, true);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.notEqual(sc.exit_code, 0);
    assert.match(sc.stderr as string, /ValueError: boom/);
  });
});

describe('python-execute timeout', () => {
  it('kills a long-running script at the deadline', async () => {
    const start = Date.now();
    const result = await callHandler({
      code: 'import time\ntime.sleep(60)',
      timeout_ms: 1_500,
    });
    const wall = Date.now() - start;

    assert.equal(result.isError, true);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.timed_out, true);
    assert.equal(sc.exit_code, -1);
    // Wall time should be close to the timeout + the post-kill grace
    // (~2s) — definitely well under the 60s the script asked for.
    assert.ok(wall < 10_000, `wall time ${wall}ms exceeded 10s budget`);
    assert.match(textOf(result), /Timed out after 1500/);
  });
});

// ---------------------------------------------------------------------------
// Sandbox isolation properties — these are the security-rule probes.
// ---------------------------------------------------------------------------

describe('python-execute isolation', () => {
  it('blocks outbound network (--network=none is effective)', async () => {
    const result = await callHandler({
      code:
        'import socket\n' +
        'try:\n' +
        '  socket.create_connection(("1.1.1.1", 53), timeout=2)\n' +
        '  print("UNEXPECTED_EGRESS")\n' +
        'except OSError as e:\n' +
        '  print("BLOCKED", type(e).__name__)\n',
      timeout_ms: 8_000,
    });
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.exit_code, 0);
    assert.match(sc.stdout as string, /^BLOCKED /m);
    assert.doesNotMatch(sc.stdout as string, /UNEXPECTED_EGRESS/);
  });

  it('blocks writes outside /tmp (--read-only is effective)', async () => {
    const result = await callHandler({
      code:
        'try:\n' +
        '  open("/etc/probe", "w").write("x")\n' +
        '  print("UNEXPECTED_WRITE")\n' +
        'except OSError as e:\n' +
        '  print("BLOCKED", e.errno)\n',
    });
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.exit_code, 0);
    assert.match(sc.stdout as string, /^BLOCKED /m);
    assert.doesNotMatch(sc.stdout as string, /UNEXPECTED_WRITE/);
  });

  it('gives each invocation a fresh /tmp', async () => {
    // Write a sentinel in run A. Run A finishes, container is removed.
    const a = await callHandler({
      code: 'open("/tmp/marker","w").write("first")\nprint("wrote")',
    });
    assert.equal(a.isError, undefined);
    assert.match((a.structuredContent as Record<string, unknown>).stdout as string, /wrote/);

    // Run B should NOT see the sentinel — fresh tmpfs.
    const b = await callHandler({
      code: 'import os\n' + 'print("present" if os.path.exists("/tmp/marker") else "absent")',
    });
    assert.equal(b.isError, undefined);
    const bsc = b.structuredContent as Record<string, unknown>;
    assert.match(bsc.stdout as string, /^absent$/m);
  });

  it('runs concurrent invocations without cross-talk', async () => {
    // Two parallel runs each write a unique sentinel and read it back.
    // If --name uniqueness or tmpfs isolation broke, we'd see the wrong
    // value in stdout.
    const codeA = 'open("/tmp/m","w").write("AAAAA")\nprint(open("/tmp/m").read())';
    const codeB = 'open("/tmp/m","w").write("BBBBB")\nprint(open("/tmp/m").read())';
    const [a, b] = await Promise.all([callHandler({ code: codeA }), callHandler({ code: codeB })]);
    const asc = a.structuredContent as Record<string, unknown>;
    const bsc = b.structuredContent as Record<string, unknown>;
    assert.match(asc.stdout as string, /AAAAA/);
    assert.doesNotMatch(asc.stdout as string, /BBBBB/);
    assert.match(bsc.stdout as string, /BBBBB/);
    assert.doesNotMatch(bsc.stdout as string, /AAAAA/);
  });
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe('python-execute output truncation', () => {
  it('truncates stdout at 1 MiB', async () => {
    const result = await callHandler({
      // Print ~5 MiB of "x". The wire stream caps the in-process buffer
      // at 1 MiB; the python process keeps writing but the runner drops
      // chunks past the cap.
      code: 'import sys\nfor _ in range(5):\n    sys.stdout.write("x"*1024*1024)\n',
      timeout_ms: 15_000,
    });
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.truncated, true);
    assert.equal(Buffer.byteLength(sc.stdout as string, 'utf8'), SANDBOX_OUTPUT_LIMIT_BYTES);
  });

  it('truncates stderr at 1 MiB', async () => {
    const result = await callHandler({
      code: 'import sys\nfor _ in range(5):\n    sys.stderr.write("x"*1024*1024)\nsys.exit(0)',
      timeout_ms: 15_000,
    });
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.truncated, true);
    assert.equal(Buffer.byteLength(sc.stderr as string, 'utf8'), SANDBOX_OUTPUT_LIMIT_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Tool-config failure paths — tested at the runner layer because they need
// to override config without reloading the singleton.
// ---------------------------------------------------------------------------

describe('runner tool-config failures', () => {
  it('returns runtime-not-installed when the runtime binary is missing', async () => {
    const result = await runPython({
      code: 'print(1)',
      timeoutMs: 8_000,
      runtime: 'definitely-not-a-real-binary-xyz',
      image: IMAGE,
    });
    assert.equal(result.category, 'runtime-not-installed');
    assert.equal(result.exit_code, -2);
    assert.equal(result.timed_out, false);
  });

  it('returns runtime-failed-to-start when the image is missing', async () => {
    const result = await runPython({
      code: 'print(1)',
      timeoutMs: 15_000,
      runtime: RUNTIME,
      image: 'python-sandbox-does-not-exist:nonexistent-tag',
    });
    assert.equal(result.category, 'runtime-failed-to-start');
    // Exit 125 is podman/docker's "container creation failed" code.
    assert.equal(result.exit_code, 125);
    assert.match(result.stderr, /Error/);
  });
});

// ---------------------------------------------------------------------------
// Tool layer mapping for the runner's tool-config error categories. We swap
// the runner so the tool's switch branches for runtime-not-installed and
// runtime-failed-to-start can be exercised without mutating the frozen
// config singleton.
// ---------------------------------------------------------------------------

const stubResult = (overrides: Partial<SandboxResult> = {}): SandboxResult => ({
  stdout: '',
  stderr: '',
  exit_code: -2,
  duration_ms: 1,
  timed_out: false,
  truncated: false,
  category: 'success',
  containerName: 'sandbox-stub',
  ...overrides,
});

describe('python-execute tool-config error mapping', () => {
  it('maps runtime-not-installed to a clear isError message', async () => {
    __setRunnerForTesting(async () =>
      stubResult({
        category: 'runtime-not-installed',
        exit_code: -2,
        stderr: 'spawn podman ENOENT',
      }),
    );
    try {
      const ctx = makeCtx();
      const result = await callHandler({ code: 'print(1)' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not installed/i);
      assert.match(textOf(result), /apt-get install/);
      assert.match(textOf(result), /dnf install/);
      const errorFn = (ctx.logger as unknown as { error: ReturnType<typeof mock.fn> }).error;
      assert.equal(errorFn.mock.callCount(), 1);
    } finally {
      __setRunnerForTesting(null);
    }
  });

  it('maps runtime-failed-to-start to an image-not-built message', async () => {
    __setRunnerForTesting(async () =>
      stubResult({
        category: 'runtime-failed-to-start',
        exit_code: 125,
        stderr: 'Error: image not known',
      }),
    );
    try {
      const ctx = makeCtx();
      const result = await callHandler({ code: 'print(1)' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not built/);
      assert.match(textOf(result), /scripts\/build-python-sandbox\.sh/);
      const errorFn = (ctx.logger as unknown as { error: ReturnType<typeof mock.fn> }).error;
      assert.equal(errorFn.mock.callCount(), 1);
    } finally {
      __setRunnerForTesting(null);
    }
  });

  it('formats a successful result with no stderr', async () => {
    __setRunnerForTesting(async () =>
      stubResult({
        category: 'success',
        exit_code: 0,
        stdout: 'hello\n',
        duration_ms: 42,
      }),
    );
    try {
      const result = await callHandler({ code: 'print(1)' });
      assert.equal(result.isError, undefined);
      assert.match(textOf(result), /Exit code: 0 {2}\(42 ms\)/);
      assert.match(textOf(result), /^hello$/m);
      assert.doesNotMatch(textOf(result), /stderr/);
    } finally {
      __setRunnerForTesting(null);
    }
  });

  it('formats a successful result with a truncated note and stderr', async () => {
    __setRunnerForTesting(async () =>
      stubResult({
        category: 'success',
        exit_code: 0,
        stdout: '',
        stderr: 'warning: deprecated',
        truncated: true,
      }),
    );
    try {
      const result = await callHandler({ code: 'print(1)' });
      assert.equal(result.isError, undefined);
      assert.match(textOf(result), /truncated at 1 MiB/);
      assert.match(textOf(result), /\(empty\)/);
      assert.match(textOf(result), /warning: deprecated/);
    } finally {
      __setRunnerForTesting(null);
    }
  });

  it('formats a code-error with truncated note', async () => {
    __setRunnerForTesting(async () =>
      stubResult({
        category: 'code-error',
        exit_code: 7,
        stderr: 'Traceback (most recent call last):\n  ZeroDivisionError',
        truncated: true,
      }),
    );
    try {
      const result = await callHandler({ code: 'print(1)' });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Exit code: 7/);
      assert.match(textOf(result), /truncated at 1 MiB/);
      assert.match(textOf(result), /ZeroDivisionError/);
    } finally {
      __setRunnerForTesting(null);
    }
  });

  it('formats a timeout with partial output and truncated note', async () => {
    __setRunnerForTesting(async () =>
      stubResult({
        category: 'timeout',
        exit_code: -1,
        stdout: 'partial-out',
        stderr: 'partial-err',
        truncated: true,
        timed_out: true,
        duration_ms: 1234,
      }),
    );
    try {
      const result = await callHandler({ code: 'while True: pass', timeout_ms: 1000 });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Timed out after 1000 ms/);
      assert.match(textOf(result), /killed at 1234 ms/);
      assert.match(textOf(result), /truncated at 1 MiB/);
      assert.match(textOf(result), /partial stdout/);
      assert.match(textOf(result), /partial-out/);
      assert.match(textOf(result), /partial-err/);
    } finally {
      __setRunnerForTesting(null);
    }
  });
});

// ---------------------------------------------------------------------------
// The user's code must never appear in any log line.
// ---------------------------------------------------------------------------

describe('python-execute logging', () => {
  it("does not log the user's code", async () => {
    const sentinel = 'SENTINEL_THAT_MUST_NOT_BE_LOGGED_5f3c9e';
    const ctx = makeCtx();
    await callHandler({ code: `print("${sentinel}")` }, ctx);

    const allLogs = (['info', 'warn', 'error', 'debug'] as const).flatMap((level) => {
      const fn = (ctx.logger as unknown as Record<string, ReturnType<typeof mock.fn>>)[level];
      return fn ? fn.mock.calls.map((c) => JSON.stringify(c.arguments)) : [];
    });
    for (const line of allLogs) {
      assert.equal(line.includes(sentinel), false, `log line leaked the user's code: ${line}`);
    }
  });
});
