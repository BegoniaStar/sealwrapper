import { bridgeCapabilitiesV2, capabilitiesDigest } from './capabilities.ts';

export type TargetId = string;

export type TargetDescriptor = {
  id: TargetId;
  core: {
    version: string;
    source: string;
    mirrors: string[];
    commit: string;
    sourceDeclaredVersion: string;
    runtimeVersion: string;
    releaseArtifactSha256: string;
    release: {
      repository: string;
      commit: string;
      tag: string;
      publishedAt: string;
    };
  };
  testOverlay: {
    id: string;
    protocol: string;
    goVersion: string;
    capabilities: typeof bridgeCapabilitiesV2;
    capabilitiesSha256: string;
    patches: { path: string; sha256: string }[];
  };
  trust: {
    activeKeyId: string;
    keys: { id: string; algorithm: 'ed25519'; publicKey: string }[];
    rotations: Record<string, unknown>[];
    allowedMirrors: string[];
    overlaySignature: { keyId: string; algorithm: 'ed25519'; value: string };
  };
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Immutable, tool-owned SealDice target table.  A target is deliberately a
 * complete provenance descriptor rather than a bare version string: adding a
 * target requires adding its core, overlay, API contract and trust data in a
 * new sealwrapper release.
 */
const registry = {
  '1.6.0': {
    id: '1.6.0',
    core: {
      version: '1.6.0',
      source: 'https://github.com/sealdice/sealdice-core',
      mirrors: ['https://github.com/sealdice/sealdice-core'],
      commit: 'b06a2d92a7af0b8b33be33390206297edf29c7bd',
      sourceDeclaredVersion: '1.5.1-dev',
      runtimeVersion: '1.6.0+20260726',
      releaseArtifactSha256: 'sha256:6cd37580dc35d7a1f0b5c2159a692bab1db97c119d738f4a139dd7ef5c3ea549',
      release: {
        repository: 'https://github.com/sealdice/sealdice-build',
        commit: '40950761aa2b1d0ecdfff050e69ddbea803cf2bf',
        tag: 'v1.6.0',
        publishedAt: '2026-07-26T16:07:20Z',
      },
    },
    testOverlay: {
      id: 'sealwrapper-core-overlay/2',
      protocol: 'sealwrapper.core-bridge/v2',
      goVersion: '1.25.0',
      capabilities: bridgeCapabilitiesV2,
      capabilitiesSha256: capabilitiesDigest(bridgeCapabilitiesV2),
      patches: [{
        path: 'patches/sealdice-core/1.6.0/0001-test-only-bridge.patch',
        sha256: '94682a9aca040ec23cc07fbe1641af5255c395172f9f416bb24f5d1ca8ce2e25',
      }],
    },
    trust: {
      activeKeyId: 'sealwrapper-2026-08-host-config3',
      keys: [{
        id: 'sealwrapper-2026-08-host-config3',
        algorithm: 'ed25519',
        publicKey: 'MCowBQYDK2VwAyEATonx6ZbXFa40PK2/I88xZtJQCHxPYqE2jGYZSWe00BI=',
      }],
      rotations: [],
      // New mirrors must be added here and covered by a newly signed descriptor.
      allowedMirrors: ['https://github.com/sealdice/sealdice-core'],
      overlaySignature: {
        keyId: 'sealwrapper-2026-08-host-config3',
        algorithm: 'ed25519',
        value: 'd77dRRJ2BewIHMiEF+V2OQRodM4zo/UoEawDV87q+//kbvTb9jg2ybWvzZ8BS39W1hIjb1zWgiG9H1m7EwZwDQ==',
      },
    },
  },
} as const satisfies Readonly<Record<string, TargetDescriptor>>;

/** Runtime-frozen so command handlers cannot accidentally mutate provenance. */
export const targetRegistry = deepFreeze(registry);

export const defaultTargetId: TargetId = '1.6.0';
export const targetRegistryVersion = 1;

/** Backwards-compatible alias for the current default registry entry. */
export const pinnedTarget = (targetRegistry as Readonly<Record<string, TargetDescriptor>>)[defaultTargetId];

export function targetIds(): TargetId[] {
  return Object.keys(targetRegistry).sort(compareTargetIds);
}

function semverParts(value: string): { numbers: [number, number, number]; prerelease: string[] } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value);
  if (!match) throw new Error(`Target ID is not a semantic version: ${value}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error(`Target ID is not a canonical semantic version: ${value}`);
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease };
}

/** Compare target IDs using SemVer precedence for deterministic min-version derivation. */
export function compareTargetIds(left: string, right: string): number {
  const a = semverParts(left), b = semverParts(right);
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index], rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart), rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function minimumTargetId(ids: readonly string[]): string {
  if (ids.length === 0) throw new Error('At least one SealDice target is required');
  return [...ids].sort(compareTargetIds)[0];
}

export function hasTarget(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(targetRegistry, id);
}

export function getTarget(id: string): TargetDescriptor {
  const target = (targetRegistry as Readonly<Record<string, TargetDescriptor>>)[id];
  if (!target) throw new Error(`Unknown SealDice target ${id}; install a sealwrapper release that includes its target descriptor`);
  return target;
}
