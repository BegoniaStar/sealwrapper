import { bridgeCapabilitiesV2, capabilitiesDigest } from './capabilities.ts';

export const pinnedTarget = {
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
};
