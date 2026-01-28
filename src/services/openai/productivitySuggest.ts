import { config } from "../../config";
import { getOpenAiClient } from "./client";

export type ProductivitySuggestItem = {
  id: string;
  description: string;
};

export type ProductivitySuggestBlock = {
  blockId: string;
  itemCode: string;
  description: string;
  qty?: string;
  notes: string[];
  drawingDetails: string[];
  scheduleCodes: string[];
};

export type ProductivitySuggestResult = {
  blockId: string;
  items: Array<{
    item: string;
    suggestedIds: string[];
    notes?: string;
  }>;
};

type ProductivitySuggestResponse = {
  results: ProductivitySuggestResult[];
  rawContent: string;
};

const buildPrompt = (
  blocks: ProductivitySuggestBlock[],
  productivityItems: ProductivitySuggestItem[]
) => `
You are a senior estimator. For each pricing block, determine which productivity rate items are REQUIRED to price the work.
For example: if the block description is "Excavation and Disposal of material arising from excavations", you need two items for pricing: "Excavation" and "Disposal". For EACH required item, search the productivity items list and return ALL matching productivity item IDs that fit the block details. The best match must be listed first.

Rules:
- Use ONLY the provided productivity items list.
- CRITICAL: if blocks expicitly mentioning including Excavation of material AND qty is present as a number, return ALL items from the productivity items list related to excavation (prioretize the item "SHALLOW EXCAVATION"), if no qty, don't include any items related to excavation.
- CRITICAL: if blocks expicitly mentioning including Disposal of material AND qty is present as a number, return ALL items from the productivity items list related to Disposal (prioretize the item "REMOVAL OF MATERIALS"), if no qty, don't include any items related to Disposal.
- Base your decision on the block description, qty, notes, drawing details, and schedule codes.
- Return ALL suggestions that fit the block details for each required item, sorted best match first.
- If you are not confident about an item, return an empty list for that item.
- Do NOT invent items or IDs.

Return JSON only in this exact structure:
{
  "results": [
    {
      "block_id": "<blockId from input>",
      "items": [
        {
          "item": "<required item name>",
          "suggested_ids": ["<productivity_id_1>", "<productivity_id_2>"],
          "notes": "<optional brief rationale>"
        }
      ]
    }
  ]
}

Pricing blocks:
${JSON.stringify(blocks, null, 2)}

Productivity items:
${JSON.stringify(productivityItems, null, 2)}
`.trim();

const tryParseJson = (content: string): Record<string, unknown> => {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
};

export async function suggestProductivityForPricing(
  blocks: ProductivitySuggestBlock[],
  productivityItems: ProductivitySuggestItem[]
): Promise<ProductivitySuggestResponse> {
  const prompt = buildPrompt(blocks, productivityItems);
  const client = getOpenAiClient();

  const response = await client.chat.completions.create({
    model: config.openAiModel,
    messages: [
      { role: "system", content: "Return only JSON and follow the specified schema." },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_completion_tokens: 12000,
    response_format: { type: "json_object" },
  });

  const rawContent =
    response.choices?.[0]?.message?.content ??
    JSON.stringify(response) ??
    "{}";

  console.log("[pricing-suggest] OpenAI model:", response.model);
  console.log("[pricing-suggest] OpenAI usage:", response.usage);
  console.log("[pricing-suggest] response length:", rawContent.length);
  console.log("[pricing-suggest] raw response:", rawContent);

  const parsed = tryParseJson(rawContent);
  const resultsRaw = Array.isArray(parsed.results) ? parsed.results : [];
  const validIds = new Set(productivityItems.map((item) => item.id));
  const validBlocks = new Set(blocks.map((block) => block.blockId));

  const results: ProductivitySuggestResult[] = resultsRaw
    .map((entry: any) => {
      const blockId = String(entry.block_id ?? entry.blockId ?? "").trim();
      if (!blockId || !validBlocks.has(blockId)) return null;
      const itemsRaw = Array.isArray(entry.items ?? entry.requiredItems ?? entry.required_items)
        ? entry.items ?? entry.requiredItems ?? entry.required_items
        : [];
      const items = itemsRaw
        .map((itemEntry: any) => {
          const item = String(itemEntry?.item ?? itemEntry?.name ?? "").trim();
          if (!item) return null;
          const suggestedRaw = Array.isArray(itemEntry.suggested_ids ?? itemEntry.suggestedIds)
            ? itemEntry.suggested_ids ?? itemEntry.suggestedIds
            : [];
          const suggestedIds = Array.from(
            new Set(
              suggestedRaw
                .map((value: unknown) => String(value ?? "").trim())
                .filter((value: string) => value && validIds.has(value))
            )
          );
          const notes = typeof itemEntry.notes === "string" ? itemEntry.notes : undefined;
          return { item, suggestedIds, notes };
        })
        .filter(Boolean) as ProductivitySuggestResult["items"];
      return { blockId, items };
    })
    .filter(Boolean) as ProductivitySuggestResult[];

  return { results, rawContent };
}
