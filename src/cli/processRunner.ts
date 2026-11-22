import { spawn, type ChildProcess } from 'node:child_process';

// 与 vscode.CancellationToken 结构兼容，便于在不依赖 VS Code 的单元测试中使用。
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ProcessRunOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number;
  token?: CancellationLike | undefined;
  maxOutputBytes?: number;
  input?: string;
}

export interface ProcessRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

export class ProcessRunError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProcessRunError';
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 1_500;
const SETTLE_AFTER_EXIT_MS = 500;
// Windows has no POSIX process groups; detached there would open a console.
const USE_PROCESS_GROUPS = process.platform !== 'win32';

// 启动外部 Mio CLI。始终使用参数数组并关闭 shell，路径和参数不会被拼接执行。
export class ProcessRunner {
  private readonly running = new Set<ChildProcess>();
  private readonly terminated = new WeakSet<ChildProcess>();
  private readonly afterTermination = new WeakMap<ChildProcess, () => void>();

  run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessRunResult> {
    return new Promise<ProcessRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(executable, [...args], {
          cwd: options.cwd,
          env: options.env === undefined ? process.env : { ...process.env, ...options.env },
          shell: false,
          windowsHide: true,
          // POSIX: make the child a process-group leader so terminate() can
          // signal descendants too. The child is still awaited (not unref'd).
          detached: USE_PROCESS_GROUPS,
          stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(this.startError(executable, error));
        return;
      }

      this.running.add(child);

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let settled = false;
      let timedOut = false;
      let cancelled = false;

      const collect = (chunk: Buffer, chunks: Buffer[], used: number): number => {
        const remaining = maxOutputBytes - used;
        if (remaining <= 0) {
          truncated = true;
          return used;
        }
        if (chunk.length > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          truncated = true;
          return maxOutputBytes;
        }
        chunks.push(chunk);
        return used + chunk.length;
      };

      const onStdout = (chunk: Buffer): void => {
        stdoutBytes = collect(chunk, stdoutChunks, stdoutBytes);
      };
      const onStderr = (chunk: Buffer): void => {
        stderrBytes = collect(chunk, stderrChunks, stderrBytes);
      };

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);

      let timeout: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          this.terminate(child);
        }, timeoutMs);
        timeout.unref();
      }

      const cancellation = options.token?.onCancellationRequested(() => {
        cancelled = true;
        this.terminate(child);
      });

      let settleTimer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (settleTimer !== undefined) {
          clearTimeout(settleTimer);
        }
        cancellation?.dispose();
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        this.running.delete(child);
      };

      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          cancelled: cancelled || (options.token?.isCancellationRequested ?? false),
          truncated,
        });
      };

      // 'close' waits until every holder of stdout/stderr is gone. After we
      // terminated the process, a surviving descendant (for example one that
      // escaped the process group, or any child on Windows) must not keep the
      // result pending, so settle shortly after the process itself has exited.
      const settleAfterExit = (): void => {
        const exited = child.exitCode !== null || child.signalCode !== null;
        if (settled || settleTimer !== undefined || !exited) {
          return;
        }
        settleTimer = setTimeout(() => {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(child.exitCode, child.signalCode);
        }, SETTLE_AFTER_EXIT_MS);
        settleTimer.unref();
      };
      this.afterTermination.set(child, settleAfterExit);

      child.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(this.startError(executable, error));
      });

      child.once('exit', () => {
        if (this.terminated.has(child)) {
          settleAfterExit();
        }
      });

      child.once('close', (code, signal) => {
        finish(code, signal);
      });

      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        // A CLI rejecting arguments can close stdin before it reports stderr.
        if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED' || settled || this.terminated.has(child)) {
          return;
        }
        settled = true;
        cleanup();
        this.terminate(child);
        reject(new ProcessRunError(`Failed to write to Mio CLI stdin: ${error.message}`, error.code, error));
      });
      if (options.token?.isCancellationRequested) {
        cancelled = true;
        this.terminate(child);
      } else {
        child.stdin?.end(options.input);
      }
    });
  }

  dispose(): void {
    for (const child of this.running) {
      this.terminate(child);
    }
    this.running.clear();
  }

  // POSIX children run in their own process group (see spawn), so the whole
  // tree started by the CLI is signalled, not only the direct child.
  private terminate(child: ChildProcess): void {
    if (this.terminated.has(child)) {
      return;
    }
    this.terminated.add(child);
    this.signal(child, 'SIGTERM');
    const force = setTimeout(() => {
      this.signal(child, 'SIGKILL');
    }, KILL_GRACE_MS);
    force.unref();
    // Already exited (descendants may still hold the pipes): settle anyway.
    this.afterTermination.get(child)?.();
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (USE_PROCESS_GROUPS && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The group is gone (ESRCH) or not ours; fall back to the child.
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // 进程可能已经退出。
    }
  }

  private startError(executable: string, error: unknown): ProcessRunError {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return new ProcessRunError(
      `Failed to start Mio CLI "${executable}": ${message}`,
      typeof code === 'string' ? code : undefined,
      error,
    );
  }
}
