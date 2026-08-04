import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../../src/cli.ts';
import { resolveIdentities } from '../../src/identity.ts';
import { writeScenarioReport } from '../../src/reports.ts';
import { ensureSafeProjectDirectory, writeSafeProjectFile } from '../../src/safe-path.ts';

async function workspace(t: test.TestContext, prefix: string): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-project-`));
  const outside = await mkdtemp(join(tmpdir(), `${prefix}-outside-`));
  t.after(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });
  return { root, outside };
}

test('safe project directories reject an escaping symlink before creating output', async (t) => {
  const { root, outside } = await workspace(t, 'sealwrapper-safe-directory');
  await symlink(outside, join(root, '.seal'));
  await assert.rejects(
    () => ensureSafeProjectDirectory(root, join(root, '.seal', 'reports'), { label: 'Scenario report directory' }),
    /symbolic-link.*Scenario report directory/i,
  );
  await assert.rejects(() => readFile(join(outside, 'reports', 'unexpected.txt')));
});

test('safe project writes reject a symlinked final file without modifying its referent', async (t) => {
  const { root, outside } = await workspace(t, 'sealwrapper-safe-file');
  const reports = join(root, '.seal', 'reports');
  const external = join(outside, 'outside.json');
  await mkdir(reports, { recursive: true });
  await writeFile(external, 'outside stays unchanged\n');
  await symlink(external, join(reports, 'report.json'));
  await assert.rejects(
    () => writeSafeProjectFile(root, join(reports, 'report.json'), 'attempted overwrite\n', { label: 'Scenario report' }),
    /symbolic-link Scenario report/i,
  );
  assert.equal(await readFile(external, 'utf8'), 'outside stays unchanged\n');
});

test('reports and identity cache use the project write boundary', async (t) => {
  const { root, outside } = await workspace(t, 'sealwrapper-safe-reports');
  const transcript = { title: 'safe', messages: [{ sequence: 1, qq: '10001', text: 'hello' }] };
  await mkdir(join(root, '.seal'), { recursive: true });
  await symlink(outside, join(root, '.seal', 'reports'));
  await assert.rejects(
    () => writeScenarioReport({ projectRoot: root, name: 'case', transcript, offline: true }),
    /symbolic-link.*Scenario report directory/i,
  );
  await rm(join(root, '.seal', 'reports'));
  await symlink(outside, join(root, '.seal', 'identity-cache'));
  await assert.rejects(
    () => resolveIdentities({ projectRoot: root, transcript, offline: true }),
    /symbolic-link.*Identity cache directory/i,
  );
});

test('scenario discovery rejects a symbolic-link scenarios directory before core access', async (t) => {
  const { root, outside } = await workspace(t, 'sealwrapper-safe-scenarios');
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(outside, 'case.json'), '{"messages": []}\n');
  await symlink(outside, join(root, 'tests', 'scenarios'));
  await assert.rejects(
    () => runCli(['scenario', 'test'], { cwd: root, write: () => {} }),
    /symbolic-link.*Scenario directory/i,
  );
});
