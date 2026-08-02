export class SealwrapperError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'SealwrapperError';
    this.exitCode = exitCode;
  }
}

export function invariant(condition: unknown, message: string, exitCode = 2): asserts condition {
  if (!condition) throw new SealwrapperError(message, exitCode);
}
