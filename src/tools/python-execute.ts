import { z } from 'zod';
import { config } from '../config.ts';
import {
  runPython as defaultRunPython,
  type RunPythonOpts,
  SANDBOX_OUTPUT_LIMIT_BYTES,
  type SandboxResult,
} from '../shared/sandbox/python-runner.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

type RunnerFn = (opts: RunPythonOpts) => Promise<SandboxResult>;
let runnerImpl: RunnerFn = defaultRunPython;

/**
 * Test seam: swap the runner so the tool's category-to-message mapping can
 * be exercised without reloading the config singleton or actually spawning
 * podman. Pass `null` to restore the production runner.
 *
 * Mirrors the `__set*ForTesting` pattern used by other tools (see
 * `src/shared/net/http.ts` `__setDefaultPinnedFetcherForTesting`).
 */
export function __setRunnerForTesting(impl: RunnerFn | null): void {
  runnerImpl = impl ?? defaultRunPython;
}

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CODE_BYTES = 64_000;

const inputSchema = {
  code: z
    .string()
    .min(1)
    .max(MAX_CODE_BYTES)
    .describe(
      'Python source to execute. Piped to `python3 -u -` inside the sandbox via stdin (never on argv). Up to 64,000 characters.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS)
    .describe(
      `Wall-clock timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}. The container is SIGKILL'd at the deadline.`,
    ),
};

const outputSchema = {
  stdout: z
    .string()
    .describe(`UTF-8 decoded stdout, capped at ${SANDBOX_OUTPUT_LIMIT_BYTES} bytes.`),
  stderr: z
    .string()
    .describe(`UTF-8 decoded stderr, capped at ${SANDBOX_OUTPUT_LIMIT_BYTES} bytes.`),
  exit_code: z
    .number()
    .int()
    .describe(
      'Process exit code. -1 on timeout / signal kill, -2 when the sandbox runtime itself failed to start.',
    ),
  duration_ms: z.number().int().min(0).describe('Wall-clock duration of the run in milliseconds.'),
  timed_out: z.boolean().describe('True when the wall-clock timeout fired.'),
  truncated: z
    .boolean()
    .describe(
      `True when stdout OR stderr exceeded the ${SANDBOX_OUTPUT_LIMIT_BYTES}-byte cap and was cut.`,
    ),
};

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'python-execute',
  title: 'Python Execute',
  description:
    'Run a Python 3.12 script in a fresh, network-isolated, ephemeral sandbox and return its stdout, stderr, exit code, and duration. Reach for this whenever the problem is real Python: data wrangling (parsing/transforming text, JSON, CSV), heavier numerical work that exceeds the calculator (NumPy, pandas, SciPy, SymPy, scikit-learn), plotting (matplotlib renders to base64 / SVG strings you read from stdout), or any task where exact computation on unstructured input matters more than chat-stream reasoning. The runtime ships Python 3.12 with NumPy, pandas, SciPy, SymPy, matplotlib, and scikit-learn pre-installed; no other packages, no network access, no persistent state between calls. Each invocation gets a fresh container with a read-only root filesystem, a 64 MiB tmpfs at /tmp, runs as nobody (UID 65534), and is killed at the wall-clock deadline. Pass your full program as `code` (it goes in via stdin, never on argv); optionally tighten the wall-clock timeout via `timeout_ms` (default 5000, max 15000). On any failure — timeout, runtime exception, sandbox runtime missing, image not built, oversized output — the tool returns a structured isError result and never throws. Use the `calculator` tool instead when the problem is a pure math expression: calculator is faster (no container spin-up) and the right shape for symbolic / numeric work that fits its modes. Use `python-execute` when only Python will do.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 10 },

  handler: async ({ code, timeout_ms }, ctx: ToolContext): Promise<CallToolResult> => {
    ctx.logger.info(
      { timeout_ms, code_bytes: Buffer.byteLength(code, 'utf8') },
      'python-execute invoked',
    );

    const result = await runnerImpl({
      code,
      timeoutMs: timeout_ms,
      runtime: config.pythonSandboxRuntime,
      image: config.pythonSandboxImage,
    });

    const structured = {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
      truncated: result.truncated,
    };

    switch (result.category) {
      case 'success':
        return {
          content: [{ type: 'text', text: formatSuccess(result) }],
          structuredContent: structured,
        };

      case 'code-error':
        ctx.logger.warn(
          {
            exit_code: result.exit_code,
            duration_ms: result.duration_ms,
            container: result.containerName,
          },
          'python-execute code error',
        );
        return {
          content: [{ type: 'text', text: formatCodeError(result) }],
          structuredContent: structured,
          isError: true,
        };

      case 'timeout':
        ctx.logger.warn(
          { timeout_ms, container: result.containerName },
          'python-execute timed out',
        );
        return {
          content: [{ type: 'text', text: formatTimeout(result, timeout_ms) }],
          structuredContent: structured,
          isError: true,
        };

      case 'runtime-not-installed':
        ctx.logger.error(
          { runtime: config.pythonSandboxRuntime },
          'python-execute runtime binary missing',
        );
        return {
          content: [
            {
              type: 'text',
              text:
                `Python sandbox runtime "${config.pythonSandboxRuntime}" is not installed on the server. ` +
                `Install it (Debian/Ubuntu: \`sudo apt-get install -y podman\`; Fedora/RHEL: \`sudo dnf install -y podman\`) ` +
                `and restart the eMCP server. Underlying error: ${result.stderr}`,
            },
          ],
          structuredContent: structured,
          isError: true,
        };

      case 'runtime-failed-to-start':
        ctx.logger.error(
          {
            runtime: config.pythonSandboxRuntime,
            image: config.pythonSandboxImage,
            stderr: result.stderr,
          },
          'python-execute runtime failed to start',
        );
        return {
          content: [
            {
              type: 'text',
              text:
                `Python sandbox failed to start (image "${config.pythonSandboxImage}" likely not built). ` +
                `Build it with \`bash scripts/build-python-sandbox.sh\` and try again.\n\n` +
                `Runtime stderr:\n${result.stderr}`,
            },
          ],
          structuredContent: structured,
          isError: true,
        };
    }
  },
};

export default tool;

function formatSuccess(r: {
  stdout: string;
  stderr: string;
  duration_ms: number;
  truncated: boolean;
}): string {
  const lines: string[] = [
    `Exit code: 0  (${r.duration_ms} ms)`,
    r.truncated ? 'Note: output was truncated at 1 MiB.' : '',
    '',
    '--- stdout ---',
    r.stdout.length === 0 ? '(empty)' : r.stdout,
  ];
  if (r.stderr.length > 0) {
    lines.push('', '--- stderr ---', r.stderr);
  }
  return lines.filter((l) => l !== '').join('\n');
}

function formatCodeError(r: {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  truncated: boolean;
}): string {
  const lines: string[] = [
    `Exit code: ${r.exit_code}  (${r.duration_ms} ms)`,
    r.truncated ? 'Note: output was truncated at 1 MiB.' : '',
    '',
  ];
  if (r.stderr.length > 0) {
    lines.push('--- stderr ---', r.stderr);
  }
  if (r.stdout.length > 0) {
    lines.push('', '--- stdout ---', r.stdout);
  }
  return lines.filter((l) => l !== '').join('\n');
}

function formatTimeout(
  r: { stdout: string; stderr: string; duration_ms: number; truncated: boolean },
  timeout_ms: number,
): string {
  const parts: string[] = [
    `Timed out after ${timeout_ms} ms (process killed at ${r.duration_ms} ms).`,
  ];
  if (r.truncated) parts.push('Note: output was truncated at 1 MiB.');
  if (r.stdout.length > 0) parts.push('', '--- partial stdout ---', r.stdout);
  if (r.stderr.length > 0) parts.push('', '--- partial stderr ---', r.stderr);
  return parts.join('\n');
}
