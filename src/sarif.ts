function level(severity: string): 'error' | 'warning' | 'note' {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  return 'note';
}

export function toSarif(diagnostics: any[], { toolName = 'sealwrapper', uriBaseId = '%SRCROOT%' } = {}) {
  const ordered = [...diagnostics].sort((left, right) => `${left.path ?? ''}\u0000${left.line ?? 0}\u0000${left.column ?? 0}\u0000${left.ruleId ?? ''}`.localeCompare(`${right.path ?? ''}\u0000${right.line ?? 0}\u0000${right.column ?? 0}\u0000${right.ruleId ?? ''}`));
  const rules = [...new Map(ordered.map((item) => [item.ruleId, { id: item.ruleId, shortDescription: { text: item.ruleId } }])).values()];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: toolName, rules } }, results: ordered.map((item) => ({ ruleId: item.ruleId, level: level(item.severity), message: { text: item.message }, locations: item.path ? [{ physicalLocation: { artifactLocation: { uri: item.path, uriBaseId }, region: { startLine: item.line || 1, startColumn: item.column || 1 } } }] : [] })) }],
  };
}
