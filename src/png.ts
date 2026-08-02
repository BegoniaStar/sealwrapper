import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import { SealwrapperError } from './errors.ts';

const execFileAsync = promisify(execFile);

export type PngExporter = (paths: { svg: string; png: string }) => Promise<void>;
type CommandRunner = (program: string, args: string[]) => Promise<unknown>;

const runCommand: CommandRunner = (program, args) => execFileAsync(program, args, { windowsHide: true });

function missingCommand(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Rasterize an already-frozen report SVG without a browser or a bundled native
 * dependency. rsvg-convert is preferred; ImageMagick is a local fallback.
 */
export async function rasterizeSvgToPng({ svg, png }: { svg: string; png: string }, runner: CommandRunner = runCommand): Promise<void> {
  const temporary = `${png}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  try {
    try {
      await runner('rsvg-convert', ['--format=png', '--output', temporary, svg]);
    } catch (error) {
      if (!missingCommand(error)) throw error;
      try {
        await runner('magick', [svg, temporary]);
      } catch (fallbackError) {
        if (missingCommand(fallbackError)) throw new SealwrapperError('PNG reports require local rsvg-convert (preferred) or ImageMagick `magick`; neither executable was found', 3);
        throw fallbackError;
      }
    }
    await rename(temporary, png);
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof SealwrapperError) throw error;
    throw new SealwrapperError(`PNG report rasterization failed: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
}
