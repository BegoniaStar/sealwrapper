import type {
  LightScriptAuto,
  LightScriptDocument,
  MatchedAuto,
} from './types';

function firstRegexCapture(
  rules: readonly RegExp[],
  message: string,
): readonly string[] | null {
  for (const rule of rules) {
    rule.lastIndex = 0;
    const match = rule.exec(message);
    if (match !== null) return match.slice(1);
  }
  return null;
}

function matchesAuto(
  auto: LightScriptAuto,
  message: string,
): readonly string[] | null {
  if (auto.keywordFull.some((keyword) => keyword === message)) return [];
  if (auto.keywordContained.some((keyword) => message.includes(keyword)))
    return [];
  return firstRegexCapture(auto.keywordRegexp, message);
}

export function matchDocuments(
  documents: readonly LightScriptDocument[],
  message: string,
): readonly MatchedAuto[] {
  const matched: MatchedAuto[] = [];
  for (const document of documents) {
    for (const auto of document.autos) {
      const captures = matchesAuto(auto, message);
      if (captures !== null)
        matched.push({ document, match: { auto, captures } });
    }
  }
  return matched;
}
