import assert from 'node:assert/strict';
import test from 'node:test';

import { compareReplyGrammar } from '../../src/reply-audit.ts';

const matching = {
  production: { condTypes: ['textMatch'], matchTypes: ['matchExact'], matchOps: ['ge'], resultTypes: ['replyToSender'] },
  overlay: { condTypes: ['textMatch'], matchTypes: ['matchExact'], matchOps: ['ge'], resultTypes: ['replyToSender'] },
};

test('reply grammar audit accepts an overlay that covers the target vocabulary', () => {
  assert.deepEqual(compareReplyGrammar(matching, matching), []);
});

test('reply grammar audit reports missing and extra overlay discriminants', () => {
  const drifted = structuredClone(matching);
  drifted.overlay.condTypes = ['textMatch', 'futureCondition'];
  drifted.production.resultTypes = ['replyToSender', 'futureResult'];
  const differences = compareReplyGrammar(matching, drifted);
  assert.ok(differences.some((line) => line.includes('overlay.condTypes accepts unsupported production value futureCondition')));
  assert.ok(differences.some((line) => line.includes('overlay.resultTypes is missing production value futureResult')));
});
