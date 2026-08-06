import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import test from 'node:test';

import { loadProjectConfig } from '../../src/config.ts';
import { stageSealpack } from '../../src/stage.ts';

async function fixture(config: object) {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-stage-'));
  await writeFile(join(root, 'seal.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(join(root, 'README.md'), '# fixture\n');
  return root;
}

function resourceConfig() {
  return {
    schemaVersion: 2,
    package: {
      name: 'Resource Fixture', version: '1.2.3', authors: ['Tester'],
      license: 'MIT', description: 'fixture', homepage: 'https://example.invalid/fixture',
    },
    sealDice: { buildTarget: ['1.6.0'], defaultTarget: '1.6.0' },
    release: { directory: 'release', checksum: 'sha256', artifactPolicy: { forbiddenPaths: [], forbiddenExtensions: [] } },
    sealpack: {
      packageId: 'tester/resource-fixture', minSealDice: '1.6.0',
      contents: { decks: { source: 'content/decks' }, reply: { source: 'content/reply' } },
      dependencies: {},
      permissions: { network: false, networkHosts: [], acknowledgeUnrestrictedNetwork: false, fileRead: [], fileWrite: [], dangerous: false, httpServer: false, ipc: [] },
      readme: 'README.md', assets: ['assets/icon.txt'],
      store: { category: 'rules', icon: 'assets/icon.txt', banner: '', screenshots: [] },
    },
  };
}

test('schema v2 accepts a deck/reply-only package with no build', async () => {
  const root = await fixture(resourceConfig());
  const config = await loadProjectConfig(root);
  assert.equal(config.build, undefined);
  assert.equal(config.sealDice.defaultTarget, '1.6.0');
});

test('schema v2 rejects compatibility and legacy target fields', async () => {
  const config = resourceConfig() as any;
  config.sealDice.profiles = [{ id: '1.6.0', kind: 'exact' }];
  const root = await fixture(config);
  await assert.rejects(() => loadProjectConfig(root), /profiles.*unsupported/i);
});

test('schema v2 rejects unknown and legacy configuration fields instead of silently ignoring them', async () => {
  const config = resourceConfig() as any;
  config.extension = { entry: 'legacy-extension.js' };
  const root = await fixture(config);
  await assert.rejects(() => loadProjectConfig(root), /extension.*unsupported/i);

  const nested = resourceConfig() as any;
  nested.sealpack.contents.decks.glob = 'decks/**/*.json';
  const nestedRoot = await fixture(nested);
  await assert.rejects(() => loadProjectConfig(nestedRoot), /glob.*unsupported/i);
});

test('schema v2 rejects metadata control characters and invalid SemVer prerelease identifiers', async () => {
  const newline = resourceConfig() as any;
  newline.package.description = 'unsafe\n// @grant        none';
  const newlineRoot = await fixture(newline);
  await assert.rejects(() => loadProjectConfig(newlineRoot), /control characters/i);

  const author = resourceConfig() as any;
  author.package.authors = ['Tester\u0007'];
  const authorRoot = await fixture(author);
  await assert.rejects(() => loadProjectConfig(authorRoot), /control characters/i);

  const permission = resourceConfig() as any;
  permission.sealpack.permissions.fileRead = ['/tmp/\nmanaged'];
  const permissionRoot = await fixture(permission);
  await assert.rejects(() => loadProjectConfig(permissionRoot), /control characters/i);

  const leadingZero = resourceConfig() as any;
  leadingZero.package.version = '1.2.3-01';
  const leadingZeroRoot = await fixture(leadingZero);
  await assert.rejects(() => loadProjectConfig(leadingZeroRoot), /canonical semantic version/i);
});

test('schema v2 validates optional store asset values by type', async () => {
  for (const value of [null, false, 0, {}]) {
    const config = resourceConfig() as any;
    config.sealpack.store.icon = value;
    const root = await fixture(config);
    await assert.rejects(() => loadProjectConfig(root), /sealpack\.store\.icon.*string/i);
  }

  const omitted = resourceConfig() as any;
  delete omitted.sealpack.store.icon;
  delete omitted.sealpack.store.banner;
  const loaded = await loadProjectConfig(await fixture(omitted));
  assert.equal(loaded.sealpack.store.icon, '');
  assert.equal(loaded.sealpack.store.banner, '');
});

test('staging maps only supported resource roots and generates manifest patterns', async () => {
  const root = await fixture(resourceConfig());
  await mkdir(join(root, 'content/decks'), { recursive: true });
  await mkdir(join(root, 'content/reply/nested'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'content/decks/cards.json'), '{"fortune":["yes"]}\n');
  await writeFile(join(root, 'content/reply/nested/hello.yaml'), 'enable: true\nitems: []\n');
  await writeFile(join(root, 'assets/icon.txt'), 'icon\n');
  const config = await loadProjectConfig(root);
  const staged = await stageSealpack({ root, config, target: '1.6.0' });
  assert.deepEqual(staged.files.map((file) => file.path), [
    'README.md', 'assets/icon.txt', 'decks/cards.json', 'info.toml', 'reply/nested/hello.yaml',
  ]);
  assert.match(staged.manifest, /decks = \["decks\/\*\*"\]/);
  assert.match(staged.manifest, /reply = \["reply\/\*\*"\]/);
  assert.match(staged.manifest, /scripts = \[\]/);
});

test('staging rejects symlinks in a content root', async (t) => {
  const root = await fixture(resourceConfig());
  await mkdir(join(root, 'content/decks'), { recursive: true });
  await writeFile(join(root, 'outside.json'), '{}');
  try {
    await symlink(join(root, 'outside.json'), join(root, 'content/decks', 'linked.json'));
  } catch (error: any) {
    if (error?.code === 'EPERM') t.skip('symlinks are unavailable on this platform');
    throw error;
  }
  const config = await loadProjectConfig(root);
  await assert.rejects(() => stageSealpack({ root, config, target: '1.6.0' }), /symbolic link/i);
});

test('optional JS bundle is staged only inside scripts with a generated userscript header', async () => {
  const raw = resourceConfig() as any;
  raw.build = { entry: 'src/index.ts', ecmaTarget: 'es6', bundleFileName: 'fixture.js' };
  raw.sealpack.contents = { scripts: { bundle: true, path: 'scripts/fixture.js' } };
  const root = await fixture(raw);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'src/index.ts'), 'const answer = 42; console.log(answer);\n');
  await writeFile(join(root, 'assets/icon.txt'), 'icon\n');
  const config = await loadProjectConfig(root);
  const staged = await stageSealpack({ root, config, target: '1.6.0' });
  const bundle = staged.files.find((file) => file.path === 'scripts/fixture.js')?.data.toString('utf8') ?? '';
  assert.match(bundle, /^\/\/ ==UserScript==/);
  assert.match(bundle, /Resource Fixture/);
  assert.match(bundle, /console\.log\(42\)/);
  assert.doesNotMatch(bundle, /const answer/);
  assert.match(staged.manifest, /scripts = \["scripts\/fixture\.js"\]/);
  assert.doesNotMatch(staged.manifest, /scripts = \["scripts\/\*\*"\]/);
});

test('JS bundle rejects an import that resolves outside the project root', async () => {
  const raw = resourceConfig() as any;
  raw.build = { entry: 'src/index.ts', ecmaTarget: 'es6', bundleFileName: 'fixture.js' };
  raw.sealpack.contents = { scripts: { bundle: true, path: 'scripts/fixture.js' } };
  const root = await fixture(raw);
  await mkdir(join(root, 'src'), { recursive: true });
  const outside = join(tmpdir(), `${basename(root)}-outside.ts`);
  try {
    await writeFile(outside, 'export default 42;\n');
    await writeFile(join(root, 'src/index.ts'), `import value from '${relative(join(root, 'src'), outside).replaceAll('\\\\', '/')}'; console.log(value);\n`);
    const config = await loadProjectConfig(root);
    await assert.rejects(() => stageSealpack({ root, config, target: '1.6.0' }), /outside the project root|project boundary/i);
  } finally {
    await rm(outside, { force: true });
  }
});

test('a project package manifest requires its npm lockfile but is never staged into a sealpack', async () => {
  const root = await fixture(resourceConfig());
  await Promise.all([mkdir(join(root, 'content/decks'), { recursive: true }), mkdir(join(root, 'content/reply'), { recursive: true })]);
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'content/decks', 'cards.json'), '{"cards":["yes"]}\n');
  await writeFile(join(root, 'content/reply', 'reply.yaml'), 'enable: true\nitems: []\n');
  await writeFile(join(root, 'assets', 'icon.txt'), 'icon\n');
  await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"1.2.3"}\n');
  const config = await loadProjectConfig(root);
  await assert.rejects(() => stageSealpack({ root, config, target: '1.6.0' }), /package-lock/);
  await writeFile(join(root, 'package-lock.json'), '{"name":"fixture","version":"1.2.3","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.2.3"}}}\n');
  const staged = await stageSealpack({ root, config, target: '1.6.0' });
  assert.ok(!staged.files.some((file) => file.path === 'package.json' || file.path === 'package-lock.json'));
});
