import { config } from "../../config";
import { getOpenAiClient } from "./client";

export type BoqCompareGroup = {
  item_code: string;
  entries: Array<{
    description: string;
    qty: string;
    unit: string;
    boq_item_code?: string;
  }>;
};

export type DrawingCompareGroup = {
  item_code: string;
  details: string[];
};

export type CompareResult = {
  item_code: string;
  result: "matched" | "mismatch";
  reason: string;
};

type CompareResponse = {
  results?: CompareResult[];
};

const tryParseJson = (content: string): CompareResponse => {
  try {
    const parsed = JSON.parse(content) as CompareResponse | CompareResult[];
    if (Array.isArray(parsed)) {
      return { results: parsed as CompareResult[] };
    }
    return parsed as CompareResponse;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      const parsed = JSON.parse(match[0]) as CompareResponse | CompareResult[];
      if (Array.isArray(parsed)) {
        return { results: parsed as CompareResult[] };
      }
      return parsed as CompareResponse;
    } catch {
      return {};
    }
  }
};

const buildPrompt = (boqGroups: BoqCompareGroup[], drawingGroups: DrawingCompareGroup[]) => `
You are a senior estimation engineer. Compare BOQ items against drawing details.

Rules:
- BOQ is the base list. Return ONE result per BOQ item_code.
- A mismatch exists ONLY if you find a contradiction in critical details: quantity, unit, size, dimensions, thickness, type, capacity, or material.
- if you find a mismatch, continue checking all details for the same item_code, focus on qty (if any) and dimentions, and list ALL mismatches.
- Extra details present on one side but missing on the other are OK and should NOT be treated as mismatch.
- If no drawing details are found for a BOQ item_code, treat it as matched.
- If multiple BOQ entries exist under the same item_code, compare all of them against drawing details.
- Keep the reason detailed and specific when mismatched. Use empty reason for matched.
- The reason MUST be markdown formatted (use short headings + bullet points).

Return JSON only in this shape:
{
  "results": [
    { "item_code": "PV-07", "result": "matched", "reason": "" },
    { "item_code": "PV-09", "result": "mismatched", "reason": "..." }
  ]
}

BOQ items (grouped by schedule code):
${JSON.stringify(boqGroups)}

Drawing details (grouped by code):
${JSON.stringify(drawingGroups)}
`.trim();

export async function compareProjectItemsWithOpenAI(
  boqGroups: BoqCompareGroup[],
  drawingGroups: DrawingCompareGroup[]
): Promise<{ results: CompareResult[]; rawContent: string }> {
  const client = getOpenAiClient();
  const prompt = buildPrompt(boqGroups, drawingGroups);

  const response = await client.chat.completions.create({
    model: config.openAiModel,
    messages: [
      { role: "system", content: "Return only JSON and follow the specified schema." },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_completion_tokens: 2000,
    response_format: { type: "json_object" },
  });

  const content =
    response.choices?.[0]?.message?.content ??
    JSON.stringify(response) ??
    "{}";

  const parsed = tryParseJson(content);
  const results = parsed.results ?? [];
  return { results, rawContent: content };
}
