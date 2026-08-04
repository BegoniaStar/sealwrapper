import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { archiveSealpack, createZipArchive } from '../../src/archive.ts';
import { auditApiContract } from '../../src/api-contract.ts';
import { invokeBridge } from '../../src/bridge.ts';
import { runCli } from '../../src/cli.ts';
import { coreSync, coreVerify } from '../../src/core.ts';
import { loadProjectConfig } from '../../src/config.ts';
import { loadSealLock, renderSealLock } from '../../src/lock.ts';
import { pinnedTarget } from '../../src/pinned-target.ts';
import { auditReplyGrammar } from '../../src/reply-audit.ts';
import { stageSealpack } from '../../src/stage.ts';

const execFileAsync = promisify(execFile);

function config(): any {
  return {
    schemaVersion: 2,
    package: { name: 'Bridge Fixture', version: '1.0.0', authors: ['Tester'], license: 'MIT', description: '', homepage: '' },
    sealDice: { buildTarget: ['1.6.0'], defaultTarget: '1.6.0' },
    release: { directory: 'release', checksum: 'sha256', artifactPolicy: { forbiddenPaths: [], forbiddenExtensions: [] } },
    sealpack: { packageId: 'tester/bridge-fixture', minSealDice: '1.6.0', contents: { decks: { source: 'content/decks' }, reply: { source: 'content/reply' }, helpdoc: { source: 'content/helpdoc' }, templates: { source: 'content/templates' } }, dependencies: {}, permissions: { network: false, networkHosts: [], acknowledgeUnrestrictedNetwork: false, fileRead: [], fileWrite: [], dangerous: false, httpServer: false, ipc: [] }, readme: 'README.md', assets: [], store: { category: 'rules', icon: '', banner: '', screenshots: [] } },
  };
}

async function helpdocXlsx(headers: string[]) {
  const cells = headers.map((header, index) => `<c r="${String.fromCharCode(65 + index)}1" t="inlineStr"><is><t>${header}</t></is></c>`).join('');
  return createZipArchive([
    { path: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
    { path: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { path: 'xl/workbook.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fixture" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { path: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
    { path: 'xl/worksheets/sheet1.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cells}</row></sheetData></worksheet>`) },
  ]);
}

test('managed exact core performs strict validation and real install-enable-reload', async (t) => {
  if (process.env.SEALWRAPPER_CORE_INTEGRATION !== '1') {
    if (process.env.CI === 'true' || process.env.SEALWRAPPER_REQUIRE_CORE_INTEGRATION === '1') throw new Error('source-core integration is required; set SEALWRAPPER_CORE_INTEGRATION=1 with Go 1.25.0');
    return t.skip('set SEALWRAPPER_CORE_INTEGRATION=1 with Go 1.25.0 to run source-core integration');
  }
  const go = (await execFileAsync('go', ['version'])).stdout;
  if (!go.includes('go1.25.0 ')) return t.skip(`requires Go 1.25.0, found ${go.trim()}`);
  const root = await mkdtemp(join(tmpdir(), 'sealwrapper-managed-core-'));
  await Promise.all([mkdir(join(root, 'content', 'decks'), { recursive: true }), mkdir(join(root, 'content', 'reply'), { recursive: true }), mkdir(join(root, 'content', 'helpdoc'), { recursive: true }), mkdir(join(root, 'content', 'templates'), { recursive: true })]);
  await writeFile(join(root, 'seal.config.json'), `${JSON.stringify(config(), null, 2)}\n`);
  await writeFile(join(root, 'seal.lock'), renderSealLock(pinnedTarget));
  await writeFile(join(root, 'README.md'), '# bridge fixture\n');
  await writeFile(join(root, 'content', 'decks', 'cards.json'), '{"fortune":["yes"]}\n');
  await writeFile(join(root, 'content', 'decks', 'cards.jsonc'), '// JSONC deck\n{"fortune-jsonc":["yes"]}\n');
  await writeFile(join(root, 'content', 'decks', 'cards.yaml'), 'name: YAML Deck\nfortune-yaml: [yes]\n');
  await writeFile(join(root, 'content', 'decks', 'cards.yml'), 'name: YML Deck\nfortune-yml: [yes]\n');
  await writeFile(join(root, 'content', 'decks', 'cards.toml'), '[meta]\ntitle = "TOML Deck"\n[decks]\nfortune-toml = ["yes"]\n');
  await writeFile(join(root, 'content', 'helpdoc', 'guide.json'), '{"mod":"Bridge Help","helpdoc":{"bridge help":"loaded from package"}}\n');
  await writeFile(join(root, 'content', 'helpdoc', 'guide.xlsx'), await helpdocXlsx(['Key', 'Synonym', 'Content', 'Description', 'Catalogue', 'Tag']));
  await writeFile(join(root, 'content', 'templates', 'bridge.yaml'), 'name: bridge-template\nfullName: Bridge Template\nauthors: [Tester]\nversion: 1.0.0\ntemplateVer: v2\nattrs:\n  defaults: {}\n  defaultsComputed: {}\n  detailOverwrite: {}\nalias: {}\ncommands:\n  set: {}\n  sn: {}\n  st:\n    show: {}\n');
  await writeFile(join(root, 'content', 'templates', 'bridge.yml'), 'name: bridge-template-yml\nversion: 1.0.0\nattrs: {}\n');
  await writeFile(join(root, 'content', 'templates', 'bridge.json'), '{"name":"bridge-template-json","version":"1.0.0","attrs":{}}\n');
  await writeFile(join(root, 'content', 'reply', 'hello.yaml'), 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: matchExact\n        value: hello\n    results:\n      - resultType: replyToSender\n        delay: 0\n        message:\n          - [pong, 1]\n');
  const verified = await coreSync(root);
  const typeAudit = await auditApiContract(verified.worktree, (await loadSealLock(root, process.cwd())).targets['1.6.0']);
  assert.deepEqual(typeAudit.differences, []);
  const replyAudit = await auditReplyGrammar(verified.worktree);
  assert.deepEqual(replyAudit.differences, []);
  const state = join(root, '.seal', 'core', '1.6.0', 'state.json');
  const stateBackup = `${state}.regression-backup`;
  await rename(state, stateBackup);
  await symlink('/tmp', state);
  try { await assert.rejects(() => coreVerify(root), /symbolic-link.*managed core path/i); }
  finally { await unlink(state); await rename(stateBackup, state); }
  const mirror = join(root, '.seal', 'core', '1.6.0', 'mirror.git');
  await execFileAsync('git', ['-C', mirror, 'remote', 'set-url', 'origin', 'https://example.invalid/tampered-core']);
  await assert.rejects(() => coreVerify(root), /mirror remote mismatch/i);
  await execFileAsync('git', ['-C', mirror, 'remote', 'set-url', 'origin', pinnedTarget.core.source]);
  await coreVerify(root);
  const target = (await loadSealLock(root, process.cwd())).targets['1.6.0'];
  const staged = await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' });
  const archive = join(root, '.seal', 'fixture.sealpack');
  await archiveSealpack(staged, archive);
  const checked = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
  assert.equal(checked.ok, true);
  const deniedConfig = config();
  deniedConfig.sealpack.permissions = { ...deniedConfig.sealpack.permissions, network: true, networkHosts: ['example.invalid'], fileRead: ['/outside-test-root'], fileWrite: ['/outside-test-root'] };
  await writeFile(join(root, 'seal.config.json'), `${JSON.stringify(deniedConfig, null, 2)}\n`);
  await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), archive);
  const denied = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
  assert.equal(denied.ok, false);
  assert.ok((denied.diagnostics ?? []).some((item) => item.ruleId === 'bridge.sandbox-permission'));
  await writeFile(join(root, 'seal.config.json'), `${JSON.stringify(config(), null, 2)}\n`);
  await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), archive);
  const deckFormats = [
    ['cards.json', '{"fortune":["yes"]}\n', '{'],
    ['cards.jsonc', '// JSONC deck\n{"fortune-jsonc":["yes"]}\n', '{'],
    ['cards.yaml', 'name: YAML Deck\nfortune-yaml: [yes]\n', 'fortune: ['],
    ['cards.yml', 'name: YML Deck\nfortune-yml: [yes]\n', 'fortune: ['],
    ['cards.toml', '[meta]\ntitle = "TOML Deck"\n[decks]\nfortune-toml = ["yes"]\n', '[decks\nfortune = ['],
  ] as const;
  for (const [name, validDeck, invalidDeck] of deckFormats) {
    await writeFile(join(root, 'content', 'decks', name), invalidDeck);
    const invalidDeckStage = await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' });
    await archiveSealpack(invalidDeckStage, archive);
    const invalidDeckResult = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
    assert.ok((invalidDeckResult.diagnostics ?? []).some((item) => item.path === `decks/${name}` && item.ruleId === 'deck.parse'));
    await writeFile(join(root, 'content', 'decks', name), validDeck);
  }
  await writeFile(join(root, 'content', 'decks', 'cards.json'), '{"helpdoc":{"not":"a deck"}}\n');
  await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), archive);
  const semanticDeckResult = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
  assert.ok((semanticDeckResult.diagnostics ?? []).some((item) => item.path === 'decks/cards.json' && item.ruleId === 'deck.parse'));
  await writeFile(join(root, 'content', 'decks', 'cards.json'), '{"fortune":["yes"]}\n');
  await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), archive);
  const compressionBomb = join(root, '.seal', 'compression-bomb.sealpack');
  // Deliberately override producer limits to preserve the bridge's consumer
  // regression test; normal sealwrapper packaging rejects this input earlier.
  await archiveSealpack({ files: [{ path: 'info.toml', data: Buffer.from('format_version = "1.0.0"\n') }, { path: 'assets/repeated.txt', data: Buffer.alloc(1024 * 1024, 0) }] }, compressionBomb, { compressionRatio: 100_000 });
  const bombResult = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive: compressionBomb });
  assert.equal(bombResult.ok, false);
  assert.ok((bombResult.diagnostics ?? []).some((item) => item.ruleId === 'archive.limits' && /compression ratio/.test(item.message)));
  const smoke = await invokeBridge({ worktree: verified.worktree, target, operation: 'smoke', archive });
  assert.deepEqual(smoke.install?.installed, true);

  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'const sealwrapperSmoke = true; void sealwrapperSmoke;\n');
  const p0Contents = {
    scripts: { bundle: true, path: 'scripts/bridge-fixture.js' },
    decks: { source: 'content/decks' },
    reply: { source: 'content/reply' },
  };
  const p0Variants = [
    ['js-only', { scripts: p0Contents.scripts }],
    ['deck-only', { decks: p0Contents.decks }],
    ['reply-only', { reply: p0Contents.reply }],
    ['js-deck-reply', p0Contents],
  ] as const;
  for (const [name, contents] of p0Variants) {
    const variant = config() as any;
    variant.sealpack.contents = contents;
    if ('scripts' in contents) variant.build = { entry: 'src/index.ts', ecmaTarget: 'es6', bundleFileName: 'bridge-fixture.js' };
    await writeFile(join(root, 'seal.config.json'), `${JSON.stringify(variant, null, 2)}\n`);
    const variantArchive = join(root, '.seal', `${name}.sealpack`);
    await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), variantArchive);
    const variantCheck = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive: variantArchive });
    assert.equal(variantCheck.ok, true, name);
    const variantSmoke = await invokeBridge({ worktree: verified.worktree, target, operation: 'smoke', archive: variantArchive });
    assert.equal(variantSmoke.ok, true, name);
    assert.equal(variantSmoke.install?.installed, true, name);
    assert.equal(variantSmoke.install?.enabled, true, name);
    assert.equal(variantSmoke.install?.reloaded, true, name);
  }
  await writeFile(join(root, 'seal.config.json'), `${JSON.stringify(config(), null, 2)}\n`);
  await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), archive);

  await writeFile(join(root, 'content', 'reply', 'hello.yaml'), 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: unknown\n    results: []\n');
  const invalid = await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' });
  await archiveSealpack(invalid, archive);
  const invalidResult = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.diagnostics?.[0]?.ruleId, 'reply.unknown-cond-type');

  const replyCases = [
    ['missing-cond-type', 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - value: hello\n    results: []\n', 'reply.missing-cond-type', 'error'],
    ['unknown-result-type', 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: matchExact\n        value: hello\n    results:\n      - resultType: nowhere\n        message: x\n', 'reply.unknown-result-type', 'error'],
    ['missing-result-type', 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: matchExact\n        value: hello\n    results:\n      - message: x\n', 'reply.missing-result-type', 'error'],
    ['invalid-regex', 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: matchRegex\n        value: "["\n    results: []\n', 'reply.invalid-regex', 'error'],
    ['unknown-match-type', 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: imaginary\n        value: hello\n    results: []\n', 'reply.unknown-match-type', 'error'],
    ['empty-results', 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: matchExact\n        value: hello\n    results: []\n', 'reply.empty-results', 'warning'],
    ['disabled', 'enable: false\nitems: []\n', 'reply.disabled', 'warning'],
  ] as const;
  for (const [name, contents, ruleId, severity] of replyCases) {
    await writeFile(join(root, 'content', 'reply', 'hello.yaml'), contents);
    await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), archive);
    const result = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
    assert.ok((result.diagnostics ?? []).some((item) => item.ruleId === ruleId && item.severity === severity), name);
    assert.equal(result.ok, severity === 'warning', name);
  }

  await writeFile(join(root, 'content', 'reply', 'hello.yaml'), 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: matchExact\n        value: hello\n    results:\n      - resultType: replyToSender\n        delay: 0\n        message:\n          - [pong, 1]\n');
  await writeFile(join(root, 'content', 'templates', 'invalid.yaml'), 'name: [not-a-template\n');
  const invalidTemplate = await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' });
  await archiveSealpack(invalidTemplate, archive);
  const invalidTemplateResult = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
  assert.equal(invalidTemplateResult.ok, false);
  assert.ok((invalidTemplateResult.diagnostics ?? []).some((item) => item.ruleId === 'template.parse'));
  await writeFile(join(root, 'content', 'templates', 'invalid.yaml'), 'name: valid-again\nversion: 1.0.0\nattrs: {}\n');
  await writeFile(join(root, 'content', 'helpdoc', 'bad.json'), '{"mod":\n');
  const invalidHelpdoc = await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' });
  await archiveSealpack(invalidHelpdoc, archive);
  const invalidHelpdocResult = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
  assert.equal(invalidHelpdocResult.ok, false);
  assert.ok((invalidHelpdocResult.diagnostics ?? []).some((item) => item.ruleId === 'helpdoc.json'));
  await writeFile(join(root, 'content', 'helpdoc', 'bad.json'), '{"mod":"Valid","helpdoc":{"ok":"yes"}}\n');
  await writeFile(join(root, 'content', 'helpdoc', 'bad.xlsx'), await helpdocXlsx(['Wrong', 'Synonym', 'Content']));
  const invalidXlsx = await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' });
  await archiveSealpack(invalidXlsx, archive);
  const invalidXlsxResult = await invokeBridge({ worktree: verified.worktree, target, operation: 'check', archive });
  assert.equal(invalidXlsxResult.ok, false);
  assert.ok((invalidXlsxResult.diagnostics ?? []).some((item) => item.ruleId === 'helpdoc.xlsx-header'));
  await writeFile(join(root, 'content', 'helpdoc', 'bad.xlsx'), await helpdocXlsx(['Key', 'Synonym', 'Content', 'Description', 'Catalogue', 'Tag']));

  const secondRoot = await mkdtemp(join(tmpdir(), 'sealwrapper-second-package-'));
  await Promise.all([mkdir(join(secondRoot, 'content', 'templates'), { recursive: true }), mkdir(join(secondRoot, 'content', 'decks'), { recursive: true }), mkdir(join(secondRoot, 'content', 'reply'), { recursive: true })]);
  const secondConfig = config();
  secondConfig.package.name = 'Second Fixture';
  secondConfig.sealpack.packageId = 'tester/second-fixture';
  secondConfig.sealpack.contents = { templates: { source: 'content/templates' }, decks: { source: 'content/decks' }, reply: { source: 'content/reply' } };
  await writeFile(join(secondRoot, 'seal.config.json'), `${JSON.stringify(secondConfig, null, 2)}\n`);
  await writeFile(join(secondRoot, 'README.md'), '# second fixture\n');
  await writeFile(join(secondRoot, 'content', 'templates', 'duplicate.yaml'), 'name: bridge-template\nversion: 1.0.0\nattrs: {}\n');
  await writeFile(join(secondRoot, 'content', 'decks', 'cards.json'), '{"fortune":["second"]}\n');
  await writeFile(join(secondRoot, 'content', 'reply', 'hello.yaml'), 'enable: true\nitems: []\n');
  const secondArchive = join(secondRoot, 'second.sealpack');
  await archiveSealpack(await stageSealpack({ root: secondRoot, config: await loadProjectConfig(secondRoot), target: '1.6.0' }), secondArchive);
  const valid = await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' });
  await archiveSealpack(valid, archive);
  const scenario = await invokeBridge({ worktree: verified.worktree, target, operation: 'scenario', archive, archives: [secondArchive], scenario: { title: 'P2', clock: '2026-08-01T00:00:00.000Z', seed: 7, variables: { '$mHP': 10 }, conversation: { kind: 'group', id: 'QQ-Group:p2', name: 'P2' }, messages: [{ sequence: 1, qq: '10001', text: 'hello', user: { nickname: '甲', role: 'admin', variables: { '$mMP': 5 } } }, { sequence: 2, qq: '10002', text: 'no-output', scope: 'private', user: { nickname: '乙' } }] } });
  assert.equal(scenario.ok, true);
  assert.equal(scenario.install?.packages?.length, 2);
  assert.ok((scenario.diagnostics ?? []).some((item) => item.ruleId === 'template.name-conflict'));
  assert.ok((scenario.diagnostics ?? []).some((item) => item.ruleId === 'decks.path-conflict'));
  assert.ok((scenario.diagnostics ?? []).some((item) => item.ruleId === 'reply.path-conflict'));
  const scenarioMessages = scenario.transcript?.messages ?? [];
  assert.equal(scenarioMessages.find((item) => item.qq === '10001')?.role, 'admin');
  assert.equal(scenarioMessages.find((item) => item.qq === '10002')?.scope, 'private');
  assert.ok(scenarioMessages.some((item) => item.direction === 'out' && item.timestamp?.startsWith('2026-08-01T00:00:')));

  await writeFile(join(root, 'content', 'reply', 'variables.yaml'), 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: exprTrue\n        value: "$mHP == 10"\n    results:\n      - resultType: replyToSender\n        delay: 0\n        message:\n          - [expr-ok, 1]\n');
  await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), archive);
  const expressionScenario = await invokeBridge({ worktree: verified.worktree, target, operation: 'scenario', archive, scenario: { title: 'expr', clock: '2026-08-01T00:00:00.000Z', variables: { '$mHP': 10 }, messages: [{ sequence: 1, qq: '10001', text: 'expression' }] } });
  assert.equal(expressionScenario.ok, true);
  assert.ok((expressionScenario.transcript?.messages ?? []).some((item) => item.direction === 'out' && item.text === 'expr-ok'));
  await writeFile(join(root, 'content', 'reply', 'variables.yaml'), 'enable: true\nitems: []\n');

  await writeFile(join(root, 'content', 'reply', 'hello.yaml'), 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: matchExact\n        value: timeline\n    results:\n      - resultType: replyToSender\n        delay: 0\n        message:\n          - ["first#{SPLIT}second", 1]\n');
  await archiveSealpack(await stageSealpack({ root, config: await loadProjectConfig(root), target: '1.6.0' }), archive);
  const timelineScenario = await invokeBridge({ worktree: verified.worktree, target, operation: 'scenario', archive, scenario: {
    title: 'timeline',
    clock: '2026-08-01T00:00:00.000Z',
    messages: [
      { sequence: 1, qq: '10001', text: 'timeline', timestamp: '2026-08-01T00:00:00.000Z' },
      // The target core's reply matcher has a real two-second minimum group cooldown.
      { sequence: 2, qq: '10001', text: 'timeline', timestamp: '2026-08-01T00:00:01.000Z' },
      { sequence: 3, qq: '10001', text: 'timeline', timestamp: '2026-08-01T00:00:04.000Z' },
    ],
  } });
  assert.equal(timelineScenario.ok, true, JSON.stringify(timelineScenario.diagnostics));
  assert.deepEqual((timelineScenario.transcript?.messages ?? []).map((item) => [item.transcriptSequence, item.direction, item.inReplyToSequence ?? null, item.text]), [
    [1, 'in', null, 'timeline'], [2, 'out', 1, 'first'], [3, 'out', 1, 'second'],
    [4, 'in', null, 'timeline'],
    [5, 'in', null, 'timeline'], [6, 'out', 3, 'first'], [7, 'out', 3, 'second'],
  ]);
  await writeFile(join(root, 'content', 'reply', 'hello.yaml'), 'enable: true\nitems:\n  - enable: true\n    conditions:\n      - condType: textMatch\n        matchType: matchExact\n        value: hello\n    results:\n      - resultType: replyToSender\n        delay: 0\n        message:\n          - [pong, 1]\n');

  await runCli(['resource', 'check', '--sarif', '.seal/reports/resources.sarif'], { cwd: root, write: () => {} });
  const sarif = JSON.parse(await readFile(join(root, '.seal', 'reports', 'resources.sarif'), 'utf8'));
  assert.equal(sarif.version, '2.1.0');
  const signing = generateKeyPairSync('ed25519');
  await writeFile(join(root, 'release-key.pem'), signing.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await runCli(['package', '--sign-key', 'release-key.pem', '--sign-key-id', 'integration-key'], { cwd: root, write: () => {} });
  const provenance = JSON.parse(await readFile(join(root, 'release', 'bridge-fixture@1.0.0.sealpack.release.json'), 'utf8'));
  assert.equal(provenance.signature.keyId, 'integration-key');
});
