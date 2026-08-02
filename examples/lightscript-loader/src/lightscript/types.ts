export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  file?: string;
  message: string;
  packageId?: string;
  section?: number;
  severity: DiagnosticSeverity;
  stack?: readonly LightScriptStackFrame[];
}

export interface LightScriptStackFrame {
  command: string;
  parameters: string;
}

export interface DiagnosticReporter {
  report(diagnostic: Diagnostic): void;
}

export type TomlScalar = boolean | number | string;
export type TomlValue = TomlScalar | readonly string[];

export interface RawTomlTable {
  fields: Record<string, TomlValue>;
  name: string;
  ordinal: number;
}

export interface ParsedTomlDocument {
  root: Record<string, TomlValue>;
  tables: readonly RawTomlTable[];
}

export interface LightScriptAuto {
  content?: string;
  fields: Readonly<Record<string, TomlValue>>;
  keywordContained: readonly string[];
  keywordFull: readonly string[];
  keywordRegexp: readonly RegExp[];
  ordinal: number;
  program?: string;
}

export interface LightScriptDocument {
  autos: readonly LightScriptAuto[];
  defines: Readonly<Record<string, string>>;
  file: string;
  id: string;
  root: Readonly<Record<string, TomlValue>>;
  sequence: number;
}

export interface LightScriptIndex {
  format: 'sealdice-lightscript-index-v1';
  scripts: readonly string[];
}

export interface LightScriptPackageEnvelope {
  format: 'sealdice-lightscript-toml-v1';
  id?: string;
  source: string;
}

export interface TriggerMatch {
  auto: LightScriptAuto;
  captures: readonly string[];
}

export interface MatchedAuto {
  document: LightScriptDocument;
  match: TriggerMatch;
}

export interface MessageIdentity {
  groupId: string;
  playerName: string;
  senderId: string;
  userName: string;
}

export interface LightScriptHost {
  context: seal.MsgContext;
  message: seal.Message;
  now(): number;
  random(): number;
  reply(text: string): boolean;
}

export interface EvaluationResult {
  error?: string;
  output: string;
  returned: boolean;
}

export interface OutputContext {
  groupId: string;
  platform: string;
  playerName: string;
  senderId: string;
  userName: string;
}

export interface DiceRoll {
  detail: string;
  value: number;
}
