import { config } from "../../config";
import { ExtractedItem } from "../../types/build";
import { DRAWING_SYSTEM_PROMPT, extractAttributesWithOpenAI, getDrawingExtractionPrompt, parseJsonFromMessage, toItemsArray } from "../parsing/openaiExtractor";
import { getOpenAiClient } from "./client";

export type ComparisonStatus =
    | "match_exact"
    | "match_quantity_diff"
    | "match_unit_diff"
    | "match_size_diff"
    | "missing_in_boq"
    | "missing_in_drawing"
    | "no_match";

export interface ComparisonRow {
    drawing_item?: ExtractedItem | null;
    boq_item?: ExtractedItem | null;
    status: ComparisonStatus;
    note?: string;
}

interface ComparisonResponse {
    comparisons?: ComparisonRow[];
    parsed_boq?: ExtractedItem[];
    matches?: ComparisonRow[];
    result?: ComparisonRow[];
}

interface BoqPayload {
    text?: string;
    imageBase64?: string;
    imageExt?: string;
    fileName?: string;
}

function tryParseJson(content: string): ComparisonResponse {
    try {
        const parsed = JSON.parse(content) as any;
        if (Array.isArray(parsed)) {
            return { comparisons: parsed as ComparisonRow[] };
        }
        return parsed as ComparisonResponse;
    } catch {
        // fallback: extract first JSON object
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                const parsed = JSON.parse(match[0]) as any;
                if (Array.isArray(parsed)) return { comparisons: parsed as ComparisonRow[] };
                return parsed as ComparisonResponse;
            } catch {
                return {};
            }
        }
        return {};
    }
}

const BOQ_STRICT_GUARDRAILS = `
STRICT BOQ EXTRACTION RULES:
- Use ONLY the information explicitly present in the BOQ file.
- Do NOT invent, infer, or assume any item, quantity, unit, finish, size, dimensions, or section.
- If a field is missing, leave it empty.
- Preserve section_code / item_no if given; do not fabricate section codes.
- Return the exact same JSON structure as the drawings extraction (array of items with section_code, item_no, description, finishes, dimensions, quantity, unit, etc.).
- Never add explanatory text outside the JSON.
`.trim();

export async function extractBoqWithOpenAI(boqPayload: BoqPayload): Promise<{ items: ExtractedItem[]; rawContent: string }> {
    const client = getOpenAiClient();
    const prompt = await getDrawingExtractionPrompt();
    const strictPrompt = `${prompt}\n\n${BOQ_STRICT_GUARDRAILS}`;

    // Reuse the same OpenAI extraction logic/prompt used for drawings
    if (boqPayload.text) {
        const result = await extractAttributesWithOpenAI(boqPayload.text, boqPayload.fileName ?? "BOQ", {
            promptOverride: strictPrompt,
        });
        return { items: result.items, rawContent: result.rawContent ?? "" };
    }

    if (boqPayload.imageBase64 && boqPayload.imageExt) {
        const messages: Array<{ role: "system" | "user"; content: any }> = [
            { role: "system", content: DRAWING_SYSTEM_PROMPT },
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `${strictPrompt}\n\nBuild document name: ${boqPayload.fileName ?? "BOQ"}`,
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:image/${boqPayload.imageExt};base64,${boqPayload.imageBase64}`,
                        },
                    },
                ],
            },
        ];

        const response = await client.chat.completions.create({
            model: "gpt-5.2",
            messages,
            temperature: 0,
            max_completion_tokens: 8000,
        });

        const rawMessage = response.choices?.[0]?.message?.content ?? "";
        const parsed = await parseJsonFromMessage(rawMessage);
        const items = toItemsArray(parsed);
        return { items, rawContent: rawMessage };
    }

    // Fallback: nothing to process
    return { items: [], rawContent: "" };
}

export async function compareItemListsWithOpenAI(
    drawingItems: ExtractedItem[],
    boqPayload: BoqPayload
): Promise<{ comparisons: ComparisonRow[]; parsedBoq: ExtractedItem[]; rawContent: string }> {
    const client = getOpenAiClient();

    const basePrompt = `
You are a senior estimation engineer. First extract BOQ items using ONLY the provided BOQ content. Do NOT invent any data. Keep fields empty when not present. Use the same structure/fields as drawing extraction: section_code, item_no, item_number, description, finishes, dimensions, size, quantity, unit (UOM), capacity, full_description.

Statuses:
- "match_exact": same item with matching quantity and unit.
- "match_quantity_diff": item matches but quantity differs.
- "match_unit_diff": item matches but unit differs.
- "match_size_diff": item matches but dimentions/size differs.
- "missing_in_boq": item exists in drawings but not in BOQ.
- "missing_in_drawing": item exists in BOQ but not in drawings.
- "no_match": no confident match found.

Rules:
- Extract BOQ items faithfully from the provided BOQ content. Do NOT infer missing values.
- Match on description/finishes/dimensions/size/capacity semantics, tolerant to wording differences.
- Pair the most relevant items (drawing vs BOQ) even when quantities differ.
- Add a short note for any status other than match_exact.
- Output JSON only in this shape:
{
  "comparisons": [
    {
      "drawing_item": { ... },
      "boq_item": { ... },
      "status": "match_exact" | "match_quantity_diff" | "match_unit_diff" | "match_size_diff" | "missing_in_boq" | "missing_in_drawing" | "no_match",
      "note": "short note"
    }
  ],
  "parsed_boq": [ { ...boq items you extracted with only the provided info... } ]
}

Drawing items:
${JSON.stringify(drawingItems).slice(0, 6000)}
  `.trim();

    const messages: Array<
        | { role: "system"; content: string }
        | { role: "user"; content: string | any }
    > = [{ role: "system", content: "Return only JSON and follow the specified schema." }];

    if (boqPayload.imageBase64 && boqPayload.imageExt) {
        console.log("[compare-boq] Sending image to OpenAI", {
            drawingItems: drawingItems.length,
            imageExt: boqPayload.imageExt,
            imageBytes: Math.round((boqPayload.imageBase64.length * 3) / 4),
        });
        messages.push({
            role: "user",
            content: [
                { type: "text", text: `${basePrompt}\n\nUse this BOQ image to extract and compare.` },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/${boqPayload.imageExt};base64,${boqPayload.imageBase64}`,
                    },
                },
            ],
        });
    } else {
        console.log("[compare-boq] Sending text to OpenAI", {
            drawingItems: drawingItems.length,
            boqTextLength: boqPayload.text?.length ?? 0,
        });
        messages.push({
            role: "user",
            content: `${basePrompt}\n\nBOQ content:\n${boqPayload.text ?? ""}`.slice(0, 32000),
        });
    }

    try {
        const response = await client.chat.completions.create({
            model: config.openAiModel,
            messages,
            temperature: 0,
            max_completion_tokens: 1500,
            response_format: { type: "json_object" },
        });

        const content =
            response.choices?.[0]?.message?.content ??
            JSON.stringify(response) ??
            "{}";
        console.log("[compare-boq] OpenAI raw content:", content);

        const parsed = tryParseJson(content);
        const comparisons = parsed.comparisons ?? parsed.matches ?? parsed.result ?? [];
        const parsedBoq = parsed.parsed_boq ?? [];

        return { comparisons, parsedBoq, rawContent: content };
    } catch (err: any) {
        console.error("[compare-boq] OpenAI error:", err?.message || err);
        if (err?.response) {
            console.error("[compare-boq] OpenAI error response:", err.response);
        }
        return { comparisons: [], parsedBoq: [], rawContent: "" };
    }
}

export async function comparePreExtractedLists(
    drawingItems: ExtractedItem[],
    boqItems: ExtractedItem[]
): Promise<{ comparisons: ComparisonRow[]; rawContent: string }> {
    const client = getOpenAiClient();

    // Simplify items - only include essential fields
    const simplifiedDrawing = drawingItems.map((item, idx) => ({
        idx: idx,
        desc: item.description || item.full_description || "",
        finishes: item.finishes || "",
        dimensions: item.dimensions || item.size || "",
        qty: item.quantity || "",
        unit: item.unit || "",
        size: item.size || "",
        capacity: item.capacity || "",
        section: item.section_code || item.section_name || "",
        item_no: item.item_no || item.item_number || ""
    }));

    const simplifiedBoq = boqItems.map((item, idx) => ({
        idx: idx,
        desc: item.description || item.full_description || "",
        finishes: item.finishes || "",
        dimensions: item.dimensions || item.size || "",
        qty: item.quantity || "",
        unit: item.unit || "",
        size: item.size || "",
        capacity: item.capacity || "",
        section: item.section_code || item.section_name || "",
        item_no: item.item_no || item.item_number || ""
    }));

    console.log("[compare-lists] Input data lengths:", {
        drawingItems: drawingItems.length,
        boqItems: boqItems.length,
    });

    const prompt = `
You are a senior estimator. Compare Drawing vs BOQ items and match semantically equivalent items (synonyms, abbreviations, plural/singular). Start from BOQ items and find the best matching drawing item (one-to-one). Do NOT invent any data; only use the provided fields. Keep fields empty if missing.

Matching rules:
- Treat common synonyms as equivalent:
  - Ball Valve ~ BV; Check Valve ~ CV; Gate Valve ~ GV; Butterfly Valve ~ BFV; Valve abbreviations map to full names.
  - Filling Point ~ Filling Station ~ Fueling Point ~ Fuel Dispenser inlet; Fuel Pump ~ Dispenser (if context suggests).
  - Pipe ~ Piping ~ Line ~ Supply Pipe ~ Carbon steel pipe; Hose ~ Flexible Hose.
- Normalize sizes: consider "1 inch" = 1" = Ø1 = DN25 ≈ 25mm; 2" ≈ 50mm; 3" ≈ 80mm; 4" ≈ 100mm. Prefer matches with same size/capacity; if one side lacks size, match on description/capacity.
- Normalize units/qty text case-insensitively. If description/size match but qty differs -> match_quantity_diff. If unit differs -> match_unit_diff.
- Consider finishes, dimensions, section codes, and item numbers when they help disambiguate matches.
- Only mark missing_in_drawing when no reasonable semantic match exists for a BOQ item. Only mark missing_in_boq when a drawing item has no BOQ counterpart.

Status codes:
- match_exact: same item, size/capacity aligns, qty & unit match (inch vs mm allowed via normalization).
- match_quantity_diff: item matches but quantity differs.
- match_unit_diff: item matches but unit differs.
- match_size_diff: item matches but size differs.
- missing_in_boq: exists in drawing, not in BOQ.
- missing_in_drawing: exists in BOQ, not in drawing.

Return JSON: {"comparisons": [{"drawing_idx": 0, "boq_idx": 0, "status": "match_exact", "note": ""}]}

Drawing (idx, desc, qty, unit, size, capacity):
${JSON.stringify(simplifiedDrawing)}

BOQ (idx, desc, qty, unit, size, capacity):
${JSON.stringify(simplifiedBoq)}

Return complete comparison for all items.`.trim();

    console.log("[compare-lists] Full prompt length:", prompt.length);

    try {
        console.log("[compare-lists] Calling OpenAI with model:", config.openAiModel);

        const response = await client.chat.completions.create({
            model: config.openAiModel,
            messages: [
                { role: "system", content: "Return only JSON and follow the specified schema." },
                { role: "user", content: prompt },
            ],
            temperature: 0,
            max_completion_tokens: 4000,
            response_format: { type: "json_object" },
        });

        console.log("[compare-lists] OpenAI response received");
        console.log("[compare-lists] Response structure:", {
            hasChoices: !!response.choices,
            choicesLength: response.choices?.length,
            hasFirstChoice: !!response.choices?.[0],
            hasMessage: !!response.choices?.[0]?.message,
            hasContent: !!response.choices?.[0]?.message?.content,
            finishReason: response.choices?.[0]?.finish_reason,
            usage: response.usage,
        });

        const content = response.choices?.[0]?.message?.content;

        if (!content) {
            console.error("[compare-lists] EMPTY CONTENT - Full response:", JSON.stringify(response, null, 2));
            return { comparisons: [], rawContent: JSON.stringify(response, null, 2) };
        }

        console.log("[compare-lists] OpenAI raw content (first 1000 chars):", content.slice(0, 1000));
        console.log("[compare-lists] OpenAI content length:", content.length);

        const parsed = tryParseJson(content);
        const rawComparisons = parsed.comparisons ?? parsed.matches ?? parsed.result ?? [];

        console.log("[compare-lists] Parsed comparisons count:", rawComparisons.length);

        if (rawComparisons.length === 0) {
            console.warn("[compare-lists] ZERO COMPARISONS - Parsed object:", JSON.stringify(parsed, null, 2));
        }

        // Map indices back to full items
        const comparisons: ComparisonRow[] = rawComparisons.map((comp: any) => {
            const drawingIdx = comp.drawing_idx ?? comp.drawing_index;
            const boqIdx = comp.boq_idx ?? comp.boq_index;

            return {
                drawing_item: drawingIdx !== null && drawingIdx !== undefined ? drawingItems[drawingIdx] : null,
                boq_item: boqIdx !== null && boqIdx !== undefined ? boqItems[boqIdx] : null,
                status: comp.status || "no_match",
                note: comp.note || ""
            };
        });

        return { comparisons, rawContent: content };
    } catch (err: any) {
        console.error("[compare-lists] OpenAI API call FAILED");
        console.error("[compare-lists] Error name:", err?.name);
        console.error("[compare-lists] Error message:", err?.message);
        console.error("[compare-lists] Error code:", err?.code);
        console.error("[compare-lists] Error type:", err?.type);
        console.error("[compare-lists] Error status:", err?.status);

        if (err?.response) {
            console.error("[compare-lists] Error response data:", JSON.stringify(err.response.data, null, 2));
        }

        if (err?.error) {
            console.error("[compare-lists] Error details:", JSON.stringify(err.error, null, 2));
        }

        // Return the error information for debugging
        return {
            comparisons: [],
            rawContent: JSON.stringify({
                error: err?.message,
                code: err?.code,
                type: err?.type,
                status: err?.status,
                details: err?.error || err?.response?.data
            }, null, 2)
        };
    }
}

