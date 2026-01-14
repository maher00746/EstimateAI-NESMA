import { config } from "../../config";
import { ExtractedItem } from "../../types/build";
import { getOpenAiClient } from "./client";

type EnrichedItem = {
  idx: number;
  size?: string;
  capacity?: string;
};

function tryParseJson(content: string): { items?: EnrichedItem[] } {
  try {
    return JSON.parse(content) as { items?: EnrichedItem[] };
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as { items?: EnrichedItem[] };
      } catch {
        return {};
      }
    }
    return {};
  }
}

export async function enrichBoqItemsWithOpenAI(
  boqItems: ExtractedItem[]
): Promise<{ items: ExtractedItem[]; rawContent: string }> {
  const client = getOpenAiClient();

  const simplified = boqItems.map((item, idx) => ({
    idx,
    description: item.description || item.full_description || "",
    size: item.size || "",
    capacity: item.capacity || "",
    quantity: item.quantity || "",
    unit: item.unit || "",
    item_type: item.item_type || "",
  }));

  const prompt = `
You are a senior MEP estimator. Enrich the BOQ lines with missing size or capacity while keeping provided values unchanged.

Input items include idx, description, size, capacity, quantity, unit, and item_type. Return JSON only:
{ "items": [ { "idx": 0, "size": "XXmm", "capacity": "1234 L" } ] }

Rules:
- Preserve any existing size or capacity as-is (do not overwrite non-empty values).
- Tanks (day tanks, storage tanks): if capacity is missing, extract or infer it in Liters. If a gallon value appears, convert to liters (1 gal = 3.785 L) and format like "10000 L".
- Pumps: if capacity is missing, set "20 GPM at 15 psi" by default. If a flow/pressure is present in the text, keep it instead.
- Other items: if a size exists in the description, extract it. Convert inch values to millimeters and format as "<number> mm". Keep mm values as-is. If no size is present, leave size empty.
- Never invent quantities or units; focus only on size and capacity fields.
- Maintain the original item order using the idx field.
  `.trim();

  const response = await client.chat.completions.create({
    model: config.openAiModel,
    messages: [
      { role: "system", content: "Return only JSON following the specified schema." },
      {
        role: "user",
        content: `${prompt}\n\nItems:\n${JSON.stringify(simplified).slice(0, 12000)}`,
      },
    ],
    temperature: 0,
    max_completion_tokens: 1200,
    response_format: { type: "json_object" },
  });

  const content = response.choices?.[0]?.message?.content ?? "{}";
  const parsed = tryParseJson(content);
  const enrichedList = parsed.items || [];

  const merged = boqItems.map((item, idx) => {
    const enriched = enrichedList.find((entry) => entry.idx === idx);
    const size = item.size && item.size.trim() ? item.size : enriched?.size;
    const capacity = item.capacity && item.capacity.trim() ? item.capacity : enriched?.capacity;
    return {
      ...item,
      size: size || item.size,
      capacity: capacity || item.capacity,
    };
  });

  return { items: merged, rawContent: content };
}
