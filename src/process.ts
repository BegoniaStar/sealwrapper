import { spawn } from 'node:child_process';

export type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean; outputExceeded: boolean };
export type ProcessOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number };

function terminateProcess(child: ReturnType<typeof spawn>) {
  // Git and Go can create descendants. A detached POSIX process group lets a
  // timeout or output-limit breach clean those up as one operation.
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* process already exited */ }
  const killTimer = setTimeout(() => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* process already exited */ }
  }, 2_000);
  killTimer.unref();
}

/**
 * Execute an untrusted/externally managed tool with a finite lifetime and a
 * shared combined output budget. Git is always made non-interactive so a CI
 * or local release command cannot hang waiting for credentials.
 */
export async function runProcess(program: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Process timeout must be a positive safe integer');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Process output limit must be a positive safe integer');
  return await new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, timedOut = false, outputExceeded = false, settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminateProcess(child);
    }, timeoutMs);
    timer.unref();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const collect = (destination: Buffer[]) => (value: Buffer) => {
      if (settled || outputExceeded) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        terminateProcess(child);
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => resolvePromise({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      outputExceeded,
    })));
  });
}
