import stringSimilarity from "string-similarity";
import { AttributeMap, AttributeValue } from "../../types/build";

// Helper to extract string value from attribute
function getAttributeString(attr: string | AttributeValue): string {
  if (typeof attr === 'string') return attr;
  return attr.value;
}

function numericSimilarity(valueA: string, valueB: string): number | null {
  const parsedA = Number(valueA.replace(/[^0-9.]/g, ""));
  const parsedB = Number(valueB.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(parsedA) || !Number.isFinite(parsedB)) {
    return null;
  }
  const maxVal = Math.max(parsedA, parsedB);
  if (maxVal === 0) return 1;
  const diff = Math.abs(parsedA - parsedB);
  return Math.max(0, 1 - diff / maxVal);
}

function valueSimilarity(valueA: string, valueB: string): number {
  const normalizedA = valueA.toLowerCase();
  const normalizedB = valueB.toLowerCase();
  const numericSim = numericSimilarity(normalizedA, normalizedB);
  if (numericSim !== null) {
    return numericSim;
  }
  return stringSimilarity.compareTwoStrings(normalizedA, normalizedB);
}

export interface MatchResult {
  id: string;
  match_score: number;
  shared_attributes: Record<string, { base: string; candidate: string; similarity: number }>;
  differences: {
    onlyInBase: string[];
    onlyInCandidate: string[];
  };
  totalPrice?: string;
}

export function buildMatchSummary(
  baseAttributes: AttributeMap,
  candidateAttributes: AttributeMap
): MatchResult {
  const sharedAttributes: Record<string, { base: string; candidate: string; similarity: number }> =
    {};
  let scoreSum = 0;
  let comparablePairs = 0;

  for (const [key, baseValue] of Object.entries(baseAttributes)) {
    if (Object.prototype.hasOwnProperty.call(candidateAttributes, key)) {
      const candidateValue = candidateAttributes[key];
      const baseStr = getAttributeString(baseValue);
      const candidateStr = getAttributeString(candidateValue);
      const similarity = valueSimilarity(baseStr, candidateStr);
      sharedAttributes[key] = {
        base: baseStr,
        candidate: candidateStr,
        similarity,
      };
      scoreSum += similarity;
      comparablePairs += 1;
    }
  }

  const sharedWeight =
    Math.max(
      Object.keys(baseAttributes).length,
      Object.keys(candidateAttributes).length,
      1
    ) === 0
      ? 0
      : comparablePairs /
      Math.max(Object.keys(baseAttributes).length, Object.keys(candidateAttributes).length, 1);

  const averageValueScore = comparablePairs === 0 ? 0 : scoreSum / comparablePairs;
  const matchScore = Math.min(1, sharedWeight * 0.4 + averageValueScore * 0.6);

  const differences = {
    onlyInBase: Object.keys(baseAttributes).filter(
      (key) => !Object.prototype.hasOwnProperty.call(candidateAttributes, key)
    ),
    onlyInCandidate: Object.keys(candidateAttributes).filter(
      (key) => !Object.prototype.hasOwnProperty.call(baseAttributes, key)
    ),
  };

  return {
    id: "",
    match_score: Number(matchScore.toFixed(4)),
    shared_attributes: sharedAttributes,
    differences,
    totalPrice: undefined,
  };
}

