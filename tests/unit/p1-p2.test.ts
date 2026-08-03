import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadProjectConfig } from '../../src/config.ts';
import { stageSealpack } from '../../src/stage.ts';
import { toSarif } from '../../src/sarif.ts';
import { normalizeScenario, matchTranscriptExpectation } from '../../src/scenario.ts';
import { publishReleaseFiles, writeReleaseProvenance } from '../../src/release.ts';
import { loadSealLock, renderSealLock } from '../../src/lock.ts';
import { pinnedTarget } from '../../src/pinned-target.ts';

function config(): any {
  return {
    schemaVersion: 2,
    package: { name: 'P1 fixture', version: '1.0.0', authors: ['Tester'], license: 'MIT', description: '', homepage: '' },
    sealDice: { buildTarget: ['1.6.0'], defaultTarget: '1.6.0' },
    release: { directory: 'release', checksum: 'sha256', artifactPolicy: { forbiddenPaths: [], forbiddenExtensions: [] } },
    sealpack: { packageId: 'tester/p1-fixture', minSealDice: '1.6.0', contents: { helpdoc: { source: 'content/helpdoc' }, templates: { source: 'content/templates' } }, dependencies: {}, permissions: { network: false, networkHosts: [], acknowledgeUnrestrictedNetwork: false, fileRead: [], fileWrite: [], dangerous: false, httpServer: false, ipc: [] }, readme: 'README.md', assets: [], store: { category: 'rules', icon: '', banner: '', screenshots: [] } },
  };
}

async function writeLockBackedTarget(root: string) {
  await writeFile(join(root, 'seal.lock'), renderSealLock(pinnedTarget));
  return (await loadSealLock(root, process.cwd())).targets['1.6.0'];
}

test('P1 stages only the fixed helpdoc/templates roots and emits their manifest patterns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-p1-stage-'));
  await Promise.all([mkdir(join(root, 'content', 'helpdoc'), { recursive: true }), mkdir(join(root, 'content', 'templates'), { recursive: true })]);
  await writeFile(join(root, 'seal.config.json'), `${JSON.stringify(config(), null, 2)}\n`);
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, 'content', 'helpdoc', 'guide.json'), '{"mod":"Fixture","helpdoc":{"hello":"world"}}\n');
  await writeFile(join(root, 'content', 'templates', 'fixture.yaml'), 'name: fixture\nversion: 1.0.0\nattrs: {}\n');
  const staged = await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' });
  assert.deepEqual(staged.files.map((file) => file.path), ['README.md', 'helpdoc/guide.json', 'info.toml', 'templates/fixture.yaml']);
  assert.match(staged.manifest, /helpdoc = \["helpdoc\/\*\*"\]/);
  assert.match(staged.manifest, /templates = \["templates\/\*\*"\]/);
});

test('author mixed-package example is complete and lock-backed', async () => {
  const root = join(process.cwd(), 'examples', 'adventure-prompts');
  const loaded = await loadProjectConfig(root);
  const staged = await stageSealpack({ root, config: loaded, target: '1.6.0' });
  const lock = await loadSealLock(root, process.cwd());
  assert.ok(loaded.build);
  assert.equal(lock.targets['1.6.0'].core.runtimeVersion, '1.6.0+20260726');
  assert.ok(staged.files.some((file) => file.path === 'decks/adventure-prompts.json'));
  assert.ok(staged.files.some((file) => file.path === 'reply/adventure.yaml'));
  assert.ok(staged.files.some((file) => file.path === 'scripts/adventure-prompts.js'));
});

test('LightScript Loader is migrated as a standalone target-aware sealpack with package-local assets', async () => {
  const root = join(process.cwd(), 'examples', 'lightscript-loader');
  const config = await loadProjectConfig(root);
  const lock = await loadSealLock(root, process.cwd());
  const staged = await stageSealpack({ root, config, target: '1.6.0' });
  assert.equal(config.sealpack.packageId, 'BegoniaHe/sealdice-lightscriptloader');
  assert.equal(lock.targets['1.6.0'].testOverlay.goVersion, '1.25.0');
  assert.ok(staged.files.some((file) => file.path === 'scripts/lightscript-loader.js'));
  assert.ok(staged.files.some((file) => file.path === 'assets/lightscripts/index.json'));
  assert.ok(staged.files.some((file) => file.path === 'assets/lightscripts/sealwrapper-demo.toml.json'));
  assert.ok(!staged.files.some((file) => file.path === 'extension.json'));
});

test('legacy TypeScript examples are migrated as independent sealpack projects', async () => {
  const names = [
    '002-author-information',
    '004-custom-command',
    '006-deck-and-template',
    '007-storage',
    '008-context-data',
    '010-delegated-roll',
    '011-network-request',
    '012-custom-coc-rule',
    '013-custom-trpg-rule',
  ];
  for (const name of names) {
    const root = join(process.cwd(), 'examples', name);
    const config = await loadProjectConfig(root);
    const lock = await loadSealLock(root, process.cwd());
    const staged = await stageSealpack({ root, config, target: '1.6.0' });
    assert.equal(config.sealpack.packageId, `sealdice-js-examples/${name}`);
    assert.equal(lock.targets['1.6.0'].core.runtimeVersion, '1.6.0+20260726');
    assert.ok(staged.files.some((file) => file.path === `scripts/${name}.js`));
    const scenarios = await readdir(join(root, 'tests', 'scenarios'));
    assert.ok(scenarios.some((file) => file.endsWith('.json')), `${name} must declare a scenario`);
  }
});

test('P2 scenario expectations support ordered events, no output, and snapshot-compatible subsets', () => {
  const scenario = normalizeScenario({ title: 'multi', packages: ['one.sealpack', 'two.sealpack'], messages: [{ sequence: 2, qq: '2', text: 'b' }, { sequence: 1, qq: '1', text: 'a' }], expect: { outputs: [{ text: 'pong' }] } });
  assert.deepEqual(scenario.messages.map((item: any) => item.sequence), [1, 2]);
  assert.equal(matchTranscriptExpectation({ messages: [{ direction: 'out', text: 'pong' }] }, scenario.expect), null);
  assert.match(matchTranscriptExpectation({ messages: [{ direction: 'out', text: 'other' }] }, scenario.expect) ?? '', /outputs/);
});

test('scenario output expectations can assert a safe dynamic text pattern', () => {
  const scenario = normalizeScenario({
    messages: [{ text: 'today' }],
    expect: { outputs: [{ inReplyToSequence: 1, textPattern: '^今日人品为 [0-9]+$' }] },
  });
  assert.equal(matchTranscriptExpectation({ messages: [{ direction: 'out', inReplyToSequence: 1, text: '今日人品为 88' }] }, scenario.expect), null);
  assert.match(matchTranscriptExpectation({ messages: [{ direction: 'out', inReplyToSequence: 1, text: '今日人品未知' }] }, scenario.expect) ?? '', /text pattern/);
  assert.throws(() => normalizeScenario({ messages: [], expect: { outputs: [{ textPattern: '[' }] } }), /textPattern/);
});

test('P2 scenario declarations preserve deterministic clock, seed, users, variables, and diagnostic expectations', () => {
  const scenario = normalizeScenario({
    title: 'advanced',
    clock: '2026-08-01T00:00:00Z',
    seed: 42,
    users: { '10001': { nickname: '甲', role: 'admin', variables: { hp: 10 } } },
    variables: { campaign: 'fixture' },
    messages: [{ qq: '10001', text: 'hello', scope: 'private' }],
    expect: { noOutput: true, diagnostics: [{ ruleId: 'reply.disabled', severity: 'warning' }] },
  });
  assert.equal(scenario.clock, '2026-08-01T00:00:00.000Z');
  assert.equal(scenario.seed, 42);
  assert.deepEqual(scenario.messages[0].user, { nickname: '甲', role: 'admin', variables: { hp: 10 } });
  assert.equal(matchTranscriptExpectation({ messages: [] }, scenario.expect, [{ ruleId: 'reply.disabled', severity: 'warning' }]), null);
  assert.match(matchTranscriptExpectation({ messages: [] }, scenario.expect, []) ?? '', /diagnostics/);
  assert.throws(() => normalizeScenario({ messages: [], variables: { hp: { nested: true } } }), /string, number, or boolean/);
  assert.throws(() => normalizeScenario({ clock: 'tomorrow', messages: [] }), /ISO-8601/);
  assert.throws(() => normalizeScenario({ messages: [{ sequence: '1', text: 'hello' }] }), /sequence/);
});

test('P2 scenarios declare release gates and explicit cooldown, priority, and seeded-random assertions', () => {
  const scenario = normalizeScenario({
    release: true,
    seed: 99,
    messages: [{ sequence: 1, text: 'trigger' }, { sequence: 2, text: 'trigger' }],
    expect: {
      cooldown: { inputSequence: 2, outputs: 0 },
      priority: { inputSequence: 1, text: 'first rule' },
      random: { inputSequence: 1, oneOf: ['first rule', 'second rule'], repeatable: true },
    },
  });
  assert.equal(scenario.release, true);
  const transcript = { messages: [
    { sequence: 1, direction: 'in', text: 'trigger' },
    { sequence: 2, direction: 'out', inReplyToSequence: 1, text: 'first rule' },
    { sequence: 3, direction: 'in', text: 'trigger' },
  ] };
  assert.equal(matchTranscriptExpectation(transcript, scenario.expect), null);
  assert.throws(() => normalizeScenario({ release: 'yes', messages: [] }), /scenario.release/);
  assert.throws(() => normalizeScenario({ messages: [], expect: { cooldown: { inputSequence: 0, outputs: -1 } } }), /cooldown/);
});

test('scenarios can deterministically inject fake-host dice masters and registered extension config values', () => {
  const scenario = normalizeScenario({
    messages: [{ qq: '30003', text: '.command' }],
    host: {
      diceMasters: ['30003', 'QQ:30004'],
      extensionConfigs: {
        'fixture-extension': { enabled: true, label: 'test', limit: 3 },
      },
    },
  });
  assert.deepEqual(scenario.host, {
    diceMasters: ['QQ:30003', 'QQ:30004'],
    extensionConfigs: {
      'fixture-extension': { enabled: true, label: 'test', limit: 3 },
    },
  });
  assert.throws(() => normalizeScenario({ messages: [], host: { diceMasters: ['not-an-id'] } }), /diceMasters/);
  assert.throws(() => normalizeScenario({ messages: [], host: { extensionConfigs: { fixture: { nested: {} } } } }), /string, number, or boolean/);
  assert.throws(() => normalizeScenario({ messages: [], host: { extensionConfigs: {}, extra: true } }), /unsupported/);
  assert.throws(() => normalizeScenario({ messages: [{ text: 'x', role: 'superuser' }] }), /role/);
});

test('network mock routes are normalized and reject unsafe declarations', () => {
  const scenario = normalizeScenario({
    messages: [],
    network: {
      routes: [{ method: 'GET', url: 'http://api.example.test/data?q=1', headers: { accept: 'application/json' }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' } }],
    },
  });
  assert.equal(scenario.network.routes[0].response.status, 200);
  assert.throws(() => normalizeScenario({ messages: [], network: { routes: [{ method: 'GET', url: '/relative', response: { status: 200, body: '' } }] } }), /absolute HTTP/);
  assert.throws(() => normalizeScenario({ messages: [], network: { routes: [{ method: 'GET', url: 'http://api.example.test', response: { status: 700, body: '' } }] } }), /HTTP status/);
});

test('P2 scenarios preserve declared inbound QQ segments without granting URL or filesystem access', () => {
  const scenario = normalizeScenario({ messages: [{ qq: '10001', segments: [{ type: 'at', target: '10002' }, { type: 'text', text: 'hello' }, { type: 'image', url: 'https://example.invalid/image.png', alt: '图' }] }] });
  assert.equal(scenario.messages[0].text, 'hello');
  assert.deepEqual(scenario.messages[0].segments.map((segment: any) => segment.type), ['at', 'text', 'image']);
  assert.throws(() => normalizeScenario({ messages: [{ segments: [{ type: 'at', target: 'not-a-qq' }] }] }), /target/);
});

test('P2 scenarios safely normalize common inbound CQ text into inert fake-QQ segments', () => {
  const scenario = normalizeScenario({
    messages: [{
      qq: '10001',
      text: '[CQ:at,qq=10002].seal help[CQ:face,id=14][CQ:image,file=https://example.invalid/card.png]',
    }],
  });
  assert.equal(scenario.messages[0].text, '[CQ:at,qq=10002].seal help[CQ:face,id=14][CQ:image,file=https://example.invalid/card.png]');
  assert.deepEqual(scenario.messages[0].segments, [
    { type: 'at', target: '10002' },
    { type: 'text', text: '.seal help' },
    { type: 'face', id: '14' },
    { type: 'image', url: 'https://example.invalid/card.png', alt: 'CQ 图片' },
  ]);
  const all = normalizeScenario({ messages: [{ text: '[CQ:at,qq=all]公告' }] });
  assert.deepEqual(all.messages[0].segments, [{ type: 'at', target: 'all' }, { type: 'text', text: '公告' }]);
  const unknown = normalizeScenario({ messages: [{ text: '[CQ:record,file=x]' }] });
  assert.equal(unknown.messages[0].segments, undefined);
});

test('P2 emits deterministic SARIF from bridge diagnostics', () => {
  const sarif = toSarif([{ ruleId: 'reply.unknown-cond-type', severity: 'error', path: 'reply/a.yaml', line: 4, column: 5, message: 'bad type' }]);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].results[0].ruleId, 'reply.unknown-cond-type');
});

test('P2 release provenance binds an archive to core and test-only overlay lock data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-provenance-'));
  const artifact = join(root, 'release', 'fixture@1.0.0.sealpack');
  await mkdir(join(root, 'release'), { recursive: true });
  await writeFile(artifact, 'archive');
  const target = await writeLockBackedTarget(root);
  const manifest = await writeReleaseProvenance({ projectRoot: root, artifact, config: config(), target });
  const parsed = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(parsed.format, 'sealwrapper.release/v2');
  assert.deepEqual(parsed.targetMatrix.buildTargets, ['1.6.0']);
  assert.equal(parsed.targetMatrix.defaultTarget, '1.6.0');
  assert.deepEqual(parsed.lock.buildTargets, ['1.6.0']);
  assert.equal(parsed.core.commit, pinnedTarget.core.commit);
  assert.equal(parsed.overlay.nonProductionEquivalent, false);
});

test('release provenance refuses a missing or mismatched lock descriptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-provenance-lock-gate-'));
  const artifact = join(root, 'release', 'fixture@1.0.0.sealpack');
  await mkdir(join(root, 'release'), { recursive: true });
  await writeFile(artifact, 'archive');
  await assert.rejects(
    () => writeReleaseProvenance({ projectRoot: root, artifact, config: config(), target: pinnedTarget }),
    /seal\.lock is required/i,
  );
  const target = await writeLockBackedTarget(root);
  const tampered = structuredClone(target) as any;
  tampered.core.commit = '0'.repeat(40);
  await assert.rejects(
    () => writeReleaseProvenance({ projectRoot: root, artifact, config: config(), target: tampered }),
    /trust verification failed|does not match the complete seal\.lock descriptor|core\.commit/i,
  );
});

test('release provenance rejects ambiguous single- and multi-target inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-provenance-target-input-'));
  const artifact = join(root, 'fixture.sealpack');
  await writeFile(artifact, 'archive');
  await assert.rejects(
    () => writeReleaseProvenance({ projectRoot: root, artifact, config: config(), target: pinnedTarget, targets: [pinnedTarget] }),
    /either target or targets/i,
  );
});

test('P2 can attach a reproducible Ed25519 release signature without placing a private key in the artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-release-signature-'));
  const artifact = join(root, 'release', 'fixture@1.0.0.sealpack');
  const signingKey = join(root, 'release-key.pem');
  const pair = generateKeyPairSync('ed25519');
  await mkdir(join(root, 'release'), { recursive: true });
  await writeFile(artifact, 'archive');
  await writeFile(signingKey, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const target = await writeLockBackedTarget(root);
  const manifest = await writeReleaseProvenance({ projectRoot: root, artifact, config: config(), target, signingKeyPath: signingKey, signingKeyId: 'fixture-release-key' });
  const parsed = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(parsed.signature.algorithm, 'ed25519');
  assert.equal(parsed.signature.keyId, 'fixture-release-key');
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE KEY/);
});

test('release publication never overwrites or partially creates a release set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-atomic-release-'));
  const staging = join(root, '.seal', 'release-tmp');
  const release = join(root, 'release');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'fixture.sealpack'), 'archive');
  await writeFile(join(staging, 'fixture.sealpack.sha256'), 'checksum');
  await writeFile(join(staging, 'fixture.sealpack.release.json'), 'provenance');
  await mkdir(release, { recursive: true });
  await writeFile(join(release, 'fixture.sealpack.release.json'), 'existing');
  await assert.rejects(() => publishReleaseFiles({ projectRoot: root, releaseDirectory: release, files: [
    { source: join(staging, 'fixture.sealpack'), name: 'fixture.sealpack' },
    { source: join(staging, 'fixture.sealpack.sha256'), name: 'fixture.sealpack.sha256' },
    { source: join(staging, 'fixture.sealpack.release.json'), name: 'fixture.sealpack.release.json' },
  ] }), /already exists/);
  await assert.rejects(() => access(join(release, 'fixture.sealpack')));
  await assert.rejects(() => access(join(release, 'fixture.sealpack.sha256')));
  assert.equal(await readFile(join(release, 'fixture.sealpack.release.json'), 'utf8'), 'existing');
  await access(join(staging, 'fixture.sealpack'));
});

test('release publication rejects a symbolic-link directory that escapes the project root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-release-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'sealwrapper-release-outside-'));
  const staging = join(root, '.seal', 'release-tmp');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'fixture.sealpack'), 'archive');
  try {
    await symlink(outside, join(root, 'release'));
  } catch (error: any) {
    if (error?.code === 'EPERM') return t.skip('symlinks are unavailable on this platform');
    throw error;
  }
  await assert.rejects(() => publishReleaseFiles({ projectRoot: root, releaseDirectory: join(root, 'release'), files: [
    { source: join(staging, 'fixture.sealpack'), name: 'fixture.sealpack' },
  ] }), /symbolic-link release directory component/i);
  await assert.rejects(() => access(join(outside, 'fixture.sealpack')));
  await access(join(staging, 'fixture.sealpack'));
});
