import { config } from "../../config";
import { AttributeMap, AttributeValue } from "../../types/build";
import { extractJsonPayload, getOpenAiClient } from "./client";

export interface RankerCandidate {
  id: string;
  attributeText: string;
}

export interface RankedMatch {
  id: string;
  score: number;
}

// Helper function to extract only the value (without price) from an attribute
function getAttributeValueOnly(attr: string | AttributeValue): string {
  if (typeof attr === 'string') {
    return attr;
  }
  return attr.value;
}

export async function rankMatchesWithOpenAI(
  baseAttributes: AttributeMap,
  candidates: RankerCandidate[]
): Promise<RankedMatch[]> {
  if (candidates.length === 0) {
    return [];
  }

  const client = getOpenAiClient();
  // Only send attribute values, exclude prices
  const attributeList =
    Object.keys(baseAttributes).length === 0
      ? "The user did not provide attributes."
      : Object.entries(baseAttributes)
        .map(([key, value]) => `- ${key}: ${getAttributeValueOnly(value)}`)
        .join("\n");

  const candidateDescriptions = candidates
    .map((candidate) => `• Candidate (${candidate.id}):\n${candidate.attributeText || "No attribute text extracted."}`)
    .join("\n\n");

  const prompt = `
You are ranking PC build candidates based on a user's uploaded attribute list. 
Return a JSON object with a single property "rankedMatches" whose value is an array of { "id": "<candidate id>", "score": <0-100 similarity score> }.
The array must be sorted from highest similarity to lowest and include every candidate ID at least once.
Main goals:
- Score 100 means perfect similarity, 0 means unrelated.
- Keep the output strictly JSON (no extra prose).

Uploaded attributes:
${attributeList}

Candidates:
${candidateDescriptions}
  `.trim();

  const response = await client.chat.completions.create({
    model: config.openAiModel,
    temperature: 0.25,
    messages: [
      {
        role: "system",
        content: "You compare and rank PC builds for similarity in JSON format.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    max_completion_tokens: 800,
  });

  const content = response.choices?.[0]?.message?.content ?? "";
  const payload = extractJsonPayload(content);
  if (!payload) {
    throw new Error("Unable to parse OpenAI ranking response");
  }

  const parsed = JSON.parse(payload) as {
    rankedMatches?: Array<{ id: string; score: number }>;
  };

  const rankedMatches = parsed.rankedMatches ?? [];
  return rankedMatches
    .map<RankedMatch>((entry) => ({
      id: entry.id,
      score: Number(entry.score ?? 0),
    }))
    .filter((entry) => entry.id && Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);
}
