import { createHash } from 'node:crypto';

export type BridgeCapabilities = {
  protocol: string;
  manifestFormatVersions: string[];
  contents: Record<string, { extensions: string[] }>;
  limits: { maxFiles: number; maxArchiveBytes: number; maxExpandedBytes: number; maxCompressionRatio: number };
  networkMock: { version: string; failClosed: boolean; requestFields: string[]; responseFields: string[] };
};

/** Canonical JSON shared by the lock, Node verifier and Go test overlay. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function capabilitiesDigest(capabilities: BridgeCapabilities): string {
  return `sha256:${createHash('sha256').update(canonicalJson(capabilities)).digest('hex')}`;
}

export const bridgeCapabilitiesV2: BridgeCapabilities = {
  protocol: 'sealwrapper.core-bridge/v3',
  manifestFormatVersions: ['1.0.0'],
  contents: {
    scripts: { extensions: ['.js'] },
    decks: { extensions: ['.json', '.jsonc', '.yaml', '.yml', '.toml'] },
    reply: { extensions: ['.yaml', '.yml'] },
    helpdoc: { extensions: ['.json', '.xlsx'] },
    templates: { extensions: ['.json', '.yaml', '.yml'] },
  },
  limits: { maxFiles: 65_535, maxArchiveBytes: 134_217_728, maxExpandedBytes: 536_870_912, maxCompressionRatio: 100 },
  networkMock: {
    version: '1',
    failClosed: true,
    requestFields: ['method', 'url', 'headers', 'body'],
    responseFields: ['status', 'headers', 'body'],
  },
};

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  if (Array.isArray(value)) {
    result.set(prefix, JSON.stringify(value));
    return result;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      for (const [nested, rendered] of flatten(item, prefix ? `${prefix}.${key}` : key)) result.set(nested, rendered);
    }
    return result;
  }
  result.set(prefix, JSON.stringify(value));
  return result;
}

/** Stable, human-readable capability change lines for `lock update`. */
export function diffCapabilities(previous: unknown, next: unknown): string[] {
  const left = flatten(previous), right = flatten(next);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return keys.filter((key) => left.get(key) !== right.get(key)).map((key) => `capability.${key}: ${left.get(key) ?? '<none>'} -> ${right.get(key) ?? '<none>'}`);
}
