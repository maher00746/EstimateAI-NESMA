import { config } from "../../config";
import { AttributeMap, ExtractedItem } from "../../types/build";
import { getPromptByKey } from "../../modules/storage/promptRepository";
import { getOpenAiClient } from "../openai/client";

export const DRAWING_SYSTEM_PROMPT =
  "You are a rules-aware parser. Always return JSON, and never add explanatory prose outside the JSON.";

export const DRAWING_EXTRACTION_PROMPT = `
**Role:** You are a Senior Estimation Engineer for an exhibition stand building company.
**Task:** Parse the provided architectural drawings/renders and generate a Bill of Quantities (BOQ).
**Output Format:** A strict JSON Array of Objects.

## 1. Estimation Methodology & Rules
You must strictly follow these engineering assumptions derived from company standards. Do not merely describe the image; translate it into construction line items.

### Section A: Flooring (Mandatory)
Regardless of the drawing details, every booth must have these foundational items calculated based on the total booth area (L * W).
1.  **Raised Platform:** Always A.1.
    *   *Desc:* "Raised platform"
    *   *Finish:* "Wooden structure, MDF, Plywood framing"
    *   *Dim:* Total Area (Lm * Wm * 0.10mH)
    *   *UOM:* SQM
2.  **Floor Finish:** A.2 or A.4 (Sequence).
    *   *Finish:* Detect from render. If wood look: "Glossy finish laminate". If fabric: "Galaxy grade Carpet".
    *   *UOM:* SQM
3.  **Plastic Protection:** Always the last item in Section A.
    *   *Desc:* "Plastic protection"
    *   *Finish:* "Consumables"
    *   *UOM:* SQM (Matches total area)
4.  **Skirting:** Perimeter of open sides.
    *   *Desc:* "Skirting"
    *   *Dim:* 0.10mH
    *   *Finish:* "MDF, Spray paint finish"
    *   *UOM:* LM (Linear Meter)

### Section B: Wall Structure & Ceiling
Break down large structures into specific functional components. Do not group all walls into one line.
*   **Dimensions:** If not explicitly written, estimate based on visual scale (Standard Height: 3.0m - 4.5m, Standard Depth: 0.10m - 0.20m).
*   **Descriptions:** Use specific names: "Back wall", "Meeting room wall", "Partition wall", "Offset panels", "Ceiling beams".
*   **Finishes:**
    *   **Standard Wall:** "Wooden structure, MDF, Roller paint (Bothside/Oneside)".
    *   **Features:** If the render shows glowing lines, add: "...with LED strip light incorporated".
    *   **Ceiling:** "Wooden structure, MDF, Roller paint finish".

### Section C: Custom-made Items (Joinery/Carpentry)
Includes all *built* furniture (Reception desks, podiums, totems, bar counters).
*   **Desc:** Item Name (e.g., "Reception Table", "Display counter 1").
*   **Finish:** High-quality finish is assumed. "Wooden structure, MDF, Spray paint finish".
*   **Logos on Counters:** If a logo is on the furniture, add: "with vinyl sticker logo on front".
*   **Lighting:** If under-lit, add: "with LED strip light".

### Section D: Graphics
Identify every logo visible in the renders.
*   **Locations:** "Logo on ceiling", "Logo on Bulkhead", "Logo on back wall".
*   **Finish Logic:**
    *   **Glowing/Thick:** "Acrylic Front lit Logo".
    *   **Thick/No Glow:** "MDF spray paint nonlit Logo".
    *   **Flat/Small:** "Vinyl sticker".
*   **Dimensions:** Estimate text bounding box (L * H).

### Section E: Furniture (Rental)
Loose/Moveable items (Chairs, Tables, Sofas, Fridges, Racks).
*   **Desc:** Item Name + "- Rental" (e.g., "Bar Stool - Rental").
*   **Finish:** Standard text: "Selected from the standard range and subject to availability".
*   **UOM:** UNIT or NOS.

### Section F: AV (Audio Visual)
*   **Desc:** Item Name + "- Rental" (e.g., "65 inch TV - Rental").
*   **LED Walls:** Calculate size (L * H). Finish: "P 2.6 LED".
*   **UOM:** UNIT.

## 2. JSON Structure Definitions
Return **only** the JSON array. Do not include markdown formatting or conversational text.

**JSON Key Definitions:**
*   section_code: "A", "B", "C", "D", "E", or "F".
*   item_no: E.g., "A.1", "B.3".
*   description: The item name.
*   dimensions: String format " LmL * WmW * HmH". If N/A, use empty string.
*   finishes: The material/construction spec.
*   quantity: Number (Float or Integer).
*   uom: "SQM", "LM", "UNIT", "NOS".

## 3. Input Handling
If the input PDF contains specific text lists (e.g., "Furniture List: 10 chairs"), prioritize that count. If only images are provided, estimate counts visually.
## 4. Dimentions
if the Dimentions are provided in the drawings for each item, or it's written in the text, make sure to use the provided dimentions.
`.trim();

export async function getDrawingExtractionPrompt(): Promise<string> {
  try {
    const stored = await getPromptByKey("drawing-extraction");
    const content = stored?.content?.trim();
    return content && content.length > 0 ? content : DRAWING_EXTRACTION_PROMPT;
  } catch (error) {
    console.error("[prompts] Failed to load drawing prompt, falling back to default:", error);
    return DRAWING_EXTRACTION_PROMPT;
  }
}

export async function parseJsonFromMessage(message: string): Promise<unknown> {
  const arrayMatch = message.match(/\[[\s\S]*\]/);
  const objectMatch = message.match(/\{[\s\S]*\}/);
  const jsonMatch = arrayMatch?.[0] ?? objectMatch?.[0];
  if (!jsonMatch) {
    throw new Error("OpenAI response did not include JSON");
  }
  return JSON.parse(jsonMatch);
}

function toOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toString() : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return String(value);
}

export function toItemsArray(payload: unknown): ExtractedItem[] {
  const items = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === "object" && "items" in (payload as Record<string, unknown>))
      ? (payload as Record<string, unknown>).items
      : null;
  if (!Array.isArray(items)) return [];

  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((record) => {
      const sectionCode =
        toOptionalString((record as Record<string, unknown>).section_code) ??
        toOptionalString((record as Record<string, unknown>).sectionCode) ??
        toOptionalString((record as Record<string, unknown>).section);
      const itemNo =
        toOptionalString((record as Record<string, unknown>).item_no) ??
        toOptionalString((record as Record<string, unknown>).itemNo) ??
        toOptionalString(record.item_number);
      const dimensions =
        toOptionalString((record as Record<string, unknown>).dimensions) ?? toOptionalString(record.size);
      const finishes =
        toOptionalString((record as Record<string, unknown>).finishes) ??
        toOptionalString((record as Record<string, unknown>).finish);
      const unit = toOptionalString(record.unit ?? (record as Record<string, unknown>).uom);

      return {
        section_code: sectionCode,
        section_name: toOptionalString((record as Record<string, unknown>).section_name ?? (record as Record<string, unknown>).sectionName),
        item_no: itemNo,
        item_number: itemNo ?? toOptionalString(record.item_number),
        item_type: toOptionalString(record.item_type),
        description: toOptionalString(record.description),
        capacity: toOptionalString(record.capacity),
        dimensions,
        size: dimensions ?? toOptionalString(record.size),
        quantity: toOptionalString(record.quantity),
        finishes,
        unit,
        remarks: toOptionalString(record.remarks),
        unit_price: toOptionalString(record.unit_price),
        total_price: toOptionalString(record.total_price),
        location: toOptionalString(record.location),
        unit_manhour: toOptionalString(record.unit_manhour),
        total_manhour: toOptionalString(record.total_manhour),
        full_description: toOptionalString(record.full_description ?? finishes),
      };
    });
}

function structuredItemsToAttributeMap(items: ExtractedItem[]): AttributeMap {
  return items.reduce<AttributeMap>((acc, item, index) => {
    const label = item.item_number || item.item_no || item.description || `Item ${index + 1}`;

    const normalizedSize = item.dimensions ?? item.size;

    const parts: string[] = [];
    if (item.section_code) parts.push(`Section ${item.section_code}`);
    if (item.item_type) parts.push(`[${item.item_type}]`);
    if (item.description) parts.push(item.description);
    if (item.capacity) parts.push(`Capacity: ${item.capacity}`);
    if (normalizedSize) parts.push(`Size: ${normalizedSize}`);
    if (item.quantity || item.unit) {
      parts.push(`Qty: ${item.quantity ?? ""}${item.unit ? ` ${item.unit}` : ""}`.trim());
    }
    if (item.finishes) parts.push(`Finishes: ${item.finishes}`);
    if (item.full_description) parts.push(item.full_description);

    acc[label] = parts.filter(Boolean).join(" | ") || "—";
    return acc;
  }, {});
}

type ExtractAttributesOptions = {
  promptOverride?: string;
  systemPromptOverride?: string;
};

export async function extractAttributesWithOpenAI(
  rawText: string,
  fileName: string,
  options?: ExtractAttributesOptions
): Promise<{ attributes: AttributeMap; items: ExtractedItem[]; totalPrice?: string; rawContent?: string }> {
  const trimmed = rawText.replace(/\s+/g, " ");
  const prompt = options?.promptOverride ?? await getDrawingExtractionPrompt();
  const systemPrompt = options?.systemPromptOverride ?? DRAWING_SYSTEM_PROMPT;
  const client = getOpenAiClient();
  const response = await client.chat.completions.create({
    model: "gpt-5.2", // drawings extractor should use the latest OpenAI model
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: `${prompt}\n\nBuild document name: ${fileName}\n\n${trimmed}`,
      },
    ],
    temperature: 0,
    max_completion_tokens: 8000, // Increased to handle large documents with many attributes
  });

  const choice = response.choices?.[0];
  const rawMessage = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason;

  // Check if the response was truncated
  if (finishReason === 'length') {
    throw new Error("The document is too large. OpenAI response was truncated. Please increase max_completion_tokens or split the document.");
  }
  const parsed = await parseJsonFromMessage(rawMessage);
  const items = toItemsArray(parsed);
  const attributes = structuredItemsToAttributeMap(items);

  return { attributes, items, totalPrice: undefined, rawContent: rawMessage };
}

