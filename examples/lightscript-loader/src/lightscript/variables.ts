import { describeError } from './diagnostics';
import type { DiagnosticReporter } from './types';

type VariableScope = 'global' | 'group' | 'person';

interface VariableValue {
  expiresAt?: number;
  value: string;
}

interface VariableRecord {
  scope: VariableScope;
  values: Record<string, VariableValue>;
}

interface PersistedState {
  documents: Record<string, Record<string, VariableRecord>>;
  version: 1;
}

export interface VariableAddress {
  groupId: string;
  senderId: string;
}

interface StorageAdapter {
  storageGet(key: string): string;
  storageSet(key: string, value: string): void;
}

const storageKey = 'sealdice-lightscript-state-v1';

function emptyState(): PersistedState {
  return { documents: {}, version: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVariableValue(value: unknown): value is VariableValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['value'] === 'string' &&
    (candidate['expiresAt'] === undefined ||
      (typeof candidate['expiresAt'] === 'number' &&
        Number.isFinite(candidate['expiresAt'])))
  );
}

function isVariableRecord(value: unknown): value is VariableRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate['scope'] !== 'global' &&
    candidate['scope'] !== 'group' &&
    candidate['scope'] !== 'person'
  ) {
    return false;
  }
  if (
    typeof candidate['values'] !== 'object' ||
    candidate['values'] === null ||
    Array.isArray(candidate['values'])
  ) {
    return false;
  }
  return Object.values(candidate['values']).every(isVariableValue);
}

function parseState(raw: string): PersistedState | null {
  if (raw === '') return emptyState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate['version'] !== 1) return null;
    const documents = candidate['documents'];
    if (!isRecord(documents)) return null;
    for (const values of Object.values(documents)) {
      if (!isRecord(values) || !Object.values(values).every(isVariableRecord)) {
        return null;
      }
    }
    return {
      documents: documents as Record<string, Record<string, VariableRecord>>,
      version: 1,
    };
  } catch {
    return null;
  }
}

function cloneRecord(record: VariableRecord): VariableRecord {
  const values: Record<string, VariableValue> = {};
  for (const [key, value] of Object.entries(record.values)) {
    values[key] = {
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
      value: value.value,
    };
  }
  return { scope: record.scope, values };
}

function scopeKey(scope: VariableScope, address: VariableAddress): string {
  switch (scope) {
    case 'global':
      return '';
    case 'group':
      return address.groupId;
    case 'person':
      return address.senderId;
  }
}

function newRecord(): VariableRecord {
  return { scope: 'global', values: {} };
}

export class SolidStateStore {
  private state: PersistedState | undefined;

  public constructor(
    private readonly extension: StorageAdapter,
    private readonly reporter: DiagnosticReporter,
  ) {}

  private currentState(): PersistedState {
    if (this.state !== undefined) return this.state;
    let raw = '';
    try {
      raw = this.extension.storageGet(storageKey);
    } catch (error) {
      this.reporter.report({
        code: 'storage-read-failed',
        message: describeError(error),
        severity: 'warning',
      });
    }
    const parsed = parseState(raw);
    if (parsed === null) {
      this.reporter.report({
        code: 'invalid-solid-storage',
        message: 'Persisted LightScript values are invalid and were ignored',
        severity: 'warning',
      });
      this.state = emptyState();
    } else {
      this.state = parsed;
    }
    return this.state;
  }

  public valuesFor(documentId: string): Record<string, VariableRecord> {
    const state = this.currentState();
    const current = state.documents[documentId];
    if (current !== undefined) return current;
    const values: Record<string, VariableRecord> = {};
    state.documents[documentId] = values;
    return values;
  }

  public save(): void {
    try {
      this.extension.storageSet(
        storageKey,
        JSON.stringify(this.currentState()),
      );
    } catch (error) {
      this.reporter.report({
        code: 'storage-write-failed',
        message: describeError(error),
        severity: 'error',
      });
    }
  }
}

export class VariableService {
  private readonly runtime = new Map<string, VariableRecord>();

  private readonly solid: Record<string, VariableRecord>;

  public constructor(
    documentId: string,
    private readonly storage: SolidStateStore,
    private readonly now: () => number,
  ) {
    this.solid = storage.valuesFor(documentId);
  }

  private record(name: string): VariableRecord {
    const persistent = this.solid[name];
    if (persistent !== undefined) return persistent;
    const transient = this.runtime.get(name);
    if (transient !== undefined) return transient;
    const record = newRecord();
    this.runtime.set(name, record);
    return record;
  }

  private persistIfSolid(name: string): void {
    if (this.solid[name] !== undefined) this.storage.save();
  }

  private deleteExpired(
    name: string,
    record: VariableRecord,
    address: VariableAddress,
  ): VariableValue | undefined {
    const key = scopeKey(record.scope, address);
    const value = record.values[key];
    if (value === undefined) return undefined;
    if (value.expiresAt === undefined || value.expiresAt > this.now())
      return value;
    const retained: Record<string, VariableValue> = {};
    for (const [candidateKey, candidateValue] of Object.entries(
      record.values,
    )) {
      if (candidateKey !== key) retained[candidateKey] = candidateValue;
    }
    record.values = retained;
    this.persistIfSolid(name);
    return undefined;
  }

  public get(name: string, address: VariableAddress): string {
    const record = this.record(name);
    return this.deleteExpired(name, record, address)?.value ?? '';
  }

  public set(name: string, value: string, address: VariableAddress): void {
    const record = this.record(name);
    const key = scopeKey(record.scope, address);
    const prior = this.deleteExpired(name, record, address);
    record.values[key] = {
      ...(prior?.expiresAt === undefined ? {} : { expiresAt: prior.expiresAt }),
      value,
    };
    this.persistIfSolid(name);
  }

  public setSolid(name: string): void {
    if (this.solid[name] !== undefined) return;
    const record = this.runtime.get(name) ?? newRecord();
    this.solid[name] = cloneRecord(record);
    this.runtime.delete(name);
    this.storage.save();
  }

  public setScope(
    name: string,
    scope: VariableScope,
    address: VariableAddress,
  ): void {
    const record = this.record(name);
    if (record.scope === scope) return;
    record.scope = scope;
    const key = scopeKey(scope, address);
    record.values[key] ??= { value: '' };
    this.persistIfSolid(name);
  }

  public setExpiry(
    name: string,
    seconds: number,
    address: VariableAddress,
  ): void {
    const record = this.record(name);
    const key = scopeKey(record.scope, address);
    const current = this.deleteExpired(name, record, address);
    record.values[key] = {
      expiresAt: this.now() + Math.max(0, seconds) * 1_000,
      value: current?.value ?? '',
    };
    this.persistIfSolid(name);
  }
}
