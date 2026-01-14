import { ExtractedItem } from "../../types/build";
import { getOpenAiClient } from "./client";
import { loadPriceList, PriceListRow } from "../pricing/priceList";

export interface PriceMapping {
    item_index: number;
    price_list_index: number;
    unit_price?: string | number;
    unit_manhour?: string | number;
    price_row?: PriceListRow;
    match_reason?: string;
    note?: string;
}

interface PriceMappingResponse {
    mappings: PriceMapping[];
    rawContent: string;
}

function parseMappings(content: string): PriceMapping[] {
    const tryParse = (text: string): PriceMapping[] => {
        try {
            const parsed = JSON.parse(text);
            const payload = Array.isArray(parsed)
                ? { mappings: parsed }
                : parsed && typeof parsed === "object"
                    ? parsed
                    : {};
            const mappingsRaw = (payload as any).mappings;
            if (!Array.isArray(mappingsRaw)) return [];
            return mappingsRaw
                .map((m: any) => ({
                    item_index: m.item_index,
                    price_list_index: m.price_list_index,
                    unit_price: m.unit_price,
                    unit_manhour: m.unit_manhour,
                    match_reason: m.match_reason,
                    note: m.note,
                }))
                .filter((m: any) =>
                    typeof m.item_index === "number" &&
                    typeof m.price_list_index === "number" &&
                    m.item_index >= 0 &&
                    m.price_list_index >= 0
                );
        } catch {
            return [];
        }
    };

    const direct = tryParse(content);
    if (direct.length) return direct;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        const fallback = tryParse(jsonMatch[0]);
        if (fallback.length) return fallback;
    }

    return [];
}

// Standard inch-to-mm conversion for MEP piping (nominal pipe sizes)
const INCH_TO_MM: Record<string, number> = {
    "0.5": 15, "1/2": 15,
    "0.75": 20, "3/4": 20,
    "1": 25,
    "1.25": 32, "1-1/4": 32,
    "1.5": 40, "1-1/2": 40,
    "2": 50,
    "2.5": 65, "2-1/2": 65,
    "3": 80,
    "4": 100,
    "5": 125,
    "6": 150,
    "8": 200,
    "10": 250,
    "12": 300,
};

function normalizeSize(size?: string): string {
    if (!size) return "";
    const lower = size.toLowerCase().trim();

    // Already in mm - extract and return
    const mmMatch = lower.match(/(\d+)\s*mm/i);
    if (mmMatch) return `${mmMatch[1]}mm`;

    // Handle various inch formats: 3", Ø3", 3 inch, 3in, DN3
    const inchPatterns = [
        /(?:ø|Ø|DN)?(\d+(?:[.-]\d+\/\d+)?|\d+\/\d+)\s*(?:"|''|inch|in)\b/i,
        /(?:ø|Ø|DN)(\d+(?:\.\d+)?)\b/i,
    ];

    for (const pattern of inchPatterns) {
        const match = lower.match(pattern);
        if (match) {
            const inchVal = match[1].replace("-", ".");
            const mm = INCH_TO_MM[inchVal];
            if (mm) return `${mm}mm`;
        }
    }

    // Try direct numeric extraction for simple cases like "3" or "4"
    const numMatch = size.match(/^(\d+(?:\.\d+)?)\s*$/);
    if (numMatch) {
        const mm = INCH_TO_MM[numMatch[1]];
        if (mm) return `${mm}mm`;
    }

    return size;
}

function categorizeItem(item: ExtractedItem): string {
    const desc = (item.description ?? item.full_description ?? "").toLowerCase();
    const itemType = (item.item_type ?? "").toLowerCase();

    if (desc.includes("storage tank") || itemType.includes("storage tank")) return "STORAGE_TANK";
    if (desc.includes("day tank") || itemType.includes("day tank")) return "DAY_TANK";
    if (desc.includes("pump") || itemType.includes("pump")) return "PUMP";
    if (desc.includes("filling point") || desc.includes("fill point")) return "FILLING_POINT";
    if (desc.match(/\bbv\b/) || desc.includes("ball valve")) return "BALL_VALVE";
    if (desc.match(/\bcv\b/) || desc.includes("check valve")) return "CHECK_VALVE";
    if (desc.includes("gate valve")) return "GATE_VALVE";
    if (desc.includes("strainer")) return "STRAINER";
    if (desc.includes("pipe") || desc.includes("piping")) return "PIPE";
    if (desc.includes("flexible") || desc.includes("hose")) return "FLEXIBLE_HOSE";
    if (desc.includes("vent")) return "VENT";
    if (desc.includes("leak") || desc.includes("sensor")) return "SENSOR";
    if (desc.includes("level") && (desc.includes("probe") || desc.includes("switch") || desc.includes("indicator"))) return "LEVEL_DEVICE";
    if (desc.includes("control panel") || desc.includes("mcp")) return "CONTROL_PANEL";
    if (desc.includes("conduit") || desc.includes("wiring") || desc.includes("cable")) return "ELECTRICAL";

    return "OTHER";
}

function buildPrompt(items: ExtractedItem[], priceList: PriceListRow[]): string {
    // Build simplified items with category and normalized fields
    const itemsForModel = items.map((item, idx) => {
        const normalizedSize = normalizeSize(item.size || item.dimensions);
        const category = categorizeItem(item);
        return {
            idx,
            category,
            description: (item.description ?? item.full_description ?? "").trim(),
            finishes: item.finishes || "",
            dimensions: item.dimensions || item.size || "",
            size: normalizedSize || item.size || "",
            capacity: item.capacity || "",
            quantity: item.quantity || "",
            section: item.section_code || item.section_name || "",
            item_no: item.item_no || item.item_number || "",
        };
    });

    // Simplify price list - only include relevant columns
    const priceListForModel = priceList.map((row, idx) => {
        const simplified: Record<string, string | number> = { idx };
        for (const [key, value] of Object.entries(row)) {
            // Include description/item columns and price/manhour columns
            const lowerKey = key.toLowerCase();
            if (
                lowerKey.includes("description") ||
                lowerKey.includes("item") ||
                lowerKey.includes("size") ||
                lowerKey.includes("dimension") ||
                lowerKey.includes("capacity") ||
                lowerKey.includes("price") ||
                lowerKey.includes("manhour") ||
                lowerKey.includes("man hour") ||
                lowerKey.includes("unit")
            ) {
                simplified[key] = value;
            }
        }
        return simplified;
    });

    console.log("[price-map] prompt itemsForModel:", itemsForModel);
    console.log("[price-map] prompt priceListForModel (truncated):", priceListForModel.slice(0, 5));

    return `
You are a senior estimator for exhibition stand/booth projects. Your task is to map estimate items (from drawings or BOQ) to the correct rows in a price list and calculate the appropriate price when sizes/dimensions differ.



## MATCHING & SCALING RULES
- Use ONLY provided data; do not invent dimensions, quantities, finishes, or prices.
- Prefer matches where description, finishes, section, and item_no align semantically.
- Normalize sizes (inch → mm) when helpful; also use provided dimensions strings.
- If price list row is per SQM/LM/UNIT, respect that UOM.
- If a price list row includes a base size/dimensions, scale the price to the requested item dimensions:
  - If UOM is SQM: compute target_area = L * W (convert both to meters if possible); scaled_price = unit_price_per_sqm * target_area.
  - If UOM is LM: compute target_length = L (or perimeter if explicitly stated); scaled_price = unit_price_per_lm * target_length.
  - If the price row has an embedded size (e.g., panel 3m x 4m) and the item needs a different size, scale proportionally by area (new_area / base_area) * base_price.
  - If the price row has volumetric dimensions (L x W x H) and the item has different volumetric dimensions, scale proportionally by volume (new_volume / base_volume) * base_price. Example: base 1m x 1m x 1m at $100; target 2m x 1.5m x 1m → volume 3 m³ → scaled_price = 3 * $100 = $300.
  - If dimensions cannot be parsed, fall back to the listed unit_price without scaling.
- When multiple price list rows match, return all confident mappings.

## MATCHING RULES BY CATEGORY (legacy fuel-specific hints retained; apply only when relevant)




## INPUT DATA

Items to price:
${JSON.stringify(itemsForModel, null, 1)}

Price list (idx is zero-based):
${JSON.stringify(priceListForModel, null, 1)}

## OUTPUT FORMAT

Return ONLY valid JSON in this exact structure:
{
  "mappings": [
    {
      "item_index": <zero-based index from items>,
      "price_list_index": <zero-based index from price list>,
      "unit_price": <price from price list, or scaled price if dimensions/area/volume differ>,
      "unit_manhour": <exact value from price list row>,
      "match_reason": "<brief explanation>",
      "note": "<how scaling was computed if applicable>"
    }
  ]
}

## IMPORTANT RULES
1. Return MULTIPLE mappings per item if multiple price list rows match; check all rows.
2. If scaling is required, compute unit_price based on provided dimensions; otherwise copy unit_price/unit_manhour exactly.
3. Only include confident matches - omit items with no good match.
4. Use zero-based indices.
5. Do NOT include any text outside the JSON.
6. If you find a match, continue checking remaining price list rows for additional matches.
`.trim();
}

export async function mapItemsToPriceList(
    items: ExtractedItem[]
): Promise<PriceMappingResponse> {
    const priceList = await loadPriceList({ cleanHeaders: false });
    const prompt = buildPrompt(items, priceList);
    console.log("[price-map] items payload:", items);
    console.log("[price-map] prompt length:", prompt.length);

    const client = getOpenAiClient();

    const systemPrompt = `You are an expert estimator for exhibition stand/booth projects. Map items to price list entries, honoring finishes, dimensions, and UOM. Scale prices when the price list size differs from the requested dimensions. Do NOT invent data; return JSON only.`;

    const response = await client.chat.completions.create({
        model: "gpt-5.2",
        temperature: 0,
        max_completion_tokens: 16000,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
    });

    console.log("[price-map] OpenAI model used:", response.model);
    console.log("[price-map] OpenAI usage:", response.usage);

    const content = response.choices?.[0]?.message?.content ?? "";
    console.log("[price-map] OpenAI content length:", content.length);

    const rawMappings = parseMappings(content);
    const mappings: PriceMapping[] = [];

    for (const mapping of rawMappings) {
        // Validate price_list_index is within bounds
        if (mapping.price_list_index >= priceList.length || mapping.price_list_index < 0) {
            console.warn(`[price-map] Invalid price_list_index ${mapping.price_list_index}, max is ${priceList.length - 1}`);
            continue;
        }
        mappings.push({
            ...mapping,
            price_row: priceList[mapping.price_list_index],
        });
    }

    console.log("[price-map] Total mappings found:", mappings.length);

    return { mappings, rawContent: content };
}


