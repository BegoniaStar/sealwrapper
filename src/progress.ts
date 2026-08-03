import ora, { type Ora } from 'ora';

/**
 * The CLI deliberately keeps progress output separate from its normal output
 * stream.  This keeps stdout suitable for CI logs, shell pipelines and future
 * machine-readable output modes while still giving an interactive terminal a
 * useful indication that a long-running operation is active.
 */
export interface ProgressReporter {
  start(text: string): void;
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

class SilentProgress implements ProgressReporter {
  start(_text: string): void {}
  update(_text: string): void {}
  succeed(_text?: string): void {}
  fail(_text?: string): void {}
  stop(): void {}
}

class OraProgress implements ProgressReporter {
  private spinner: Ora | undefined;
  private readonly stream: NodeJS.WritableStream;
  private hooksInstalled = false;

  /** Last-resort cleanup for explicit `process.exit()`/fatal paths. */
  private readonly onExit = () => {
    this.spinner?.stop();
    this.spinner = undefined;
    this.hooksInstalled = false;
  };

  constructor(stream: NodeJS.WritableStream = process.stderr) {
    this.stream = stream;
  }

  start(text: string): void {
    this.stop();
    this.spinner = ora({
      text,
      stream: this.stream,
      // Keep Ctrl-C on the normal process signal path.  ora's stdin raw mode
      // is useful for interactive prompts, but this CLI has no prompt active
      // while a build or verification operation is running.
      discardStdin: false,
      hideCursor: true,
      isEnabled: true,
    }).start();
    process.once('exit', this.onExit);
    this.hooksInstalled = true;
  }

  update(text: string): void {
    if (this.spinner) this.spinner.text = text;
  }

  succeed(text?: string): void {
    if (this.spinner) this.spinner.succeed(text);
    this.spinner = undefined;
    this.removeHooks();
  }

  fail(text?: string): void {
    if (this.spinner) this.spinner.fail(text);
    this.spinner = undefined;
    this.removeHooks();
  }

  stop(): void {
    this.spinner?.stop();
    this.spinner = undefined;
    this.removeHooks();
  }

  private removeHooks(): void {
    if (!this.hooksInstalled) return;
    process.removeListener('exit', this.onExit);
    this.hooksInstalled = false;
  }
}

export function createProgress(options: {
  /** Suppress animation when output is being captured or piped. */
  captured?: boolean;
  /** Explicit opt-in/out for callers that know their output mode. */
  enabled?: boolean;
  stream?: NodeJS.WritableStream;
} = {}): ProgressReporter {
  const stream = options.stream ?? process.stderr;
  const enabled = options.enabled ?? Boolean((stream as NodeJS.WriteStream).isTTY);
  if (options.captured || !enabled || process.env.CI || process.env.NO_COLOR) return new SilentProgress();
  return new OraProgress(stream);
}

export async function withProgress<T>(progress: ProgressReporter | undefined, text: string, action: () => Promise<T>, successText = `${text} complete`): Promise<T> {
  progress?.start(text);
  try {
    const result = await action();
    progress?.succeed(successText);
    return result;
  } catch (error) {
    progress?.fail(`${text} failed`);
    throw error;
  } finally {
    progress?.stop();
  }
}
