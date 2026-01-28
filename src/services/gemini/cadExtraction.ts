import path from "path";
import { MediaResolution } from "@google/genai";
import { config } from "../../config";
import { getGeminiClient } from "./client";

export type CadExtractionBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type CadExtractionItem = {
  item_code: string;
  description: string;
  notes: string;
  box: CadExtractionBox;
};

function mimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function waitForFileReady(
  ai: ReturnType<typeof getGeminiClient>,
  fileName: string,
  maxWaitMs = 120000
): Promise<void> {
  const startTime = Date.now();
  const pollIntervalMs = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    const file = await ai.files.get({ name: fileName });
    const state = (file as any).state;
    if (state === "ACTIVE") return;
    if (state === "FAILED") {
      throw new Error(`File processing failed: ${(file as any).error?.message || "Unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timeout waiting for file to be ready after ${maxWaitMs}ms`);
}

const CAD_EXTRACTION_PROMPT = `You are a Senior Estimate Engineer and Quantity Surveyor performing a detailed takeoff from construction drawings. Your goal is to extract ONLY the items that are required for the Bill of Quantities (BOQ) and client estimation.

**Input Analysis Strategy:**
1.  **Scan Strategy:** Systematically scan the page (e.g., Title Block -> General Notes -> Plan Views -> Section Details).
2.  **BOQ-Only Capture:** Capture ONLY content that contributes to quantity takeoff or cost estimation (materials, measurable dimensions, levels/elevations tied to quantities, specification notes that affect quantities, and space/area identifiers that define measurable scope).
3.  **Include Area/Space Items:** Extract names/labels of measurable spaces or components such as villas, parks, terraces, rooms, zones, plots, and any area tag with its associated size or quantity (e.g., "VILLA A", "PARK", "TERRACE", "AREA 120 m²", "PLOT 05").
4.  **Ignore Non-BOQ:** Do NOT capture administrative metadata, drawing numbers, revision tables, sheet titles, consultant logos, coordinate grids, north arrows, scale bars, or any text that does not affect quantities or cost.
5.  **Context Awareness:** Associate labels with their leaders/arrows to understand what they point to.

**COORDINATE SYSTEM INSTRUCTIONS (CRITICAL):**
1.  **Normalization:** Return coordinates as Normalized values between 0.0 and 1.0 relative to the page size.
2.  **Origin:** (0.0, 0.0) is the Top-Left corner.
3.  **Axes:** 
    *   'left' (x_min) and 'right' (x_max) correspond to the horizontal axis.
    *   'top' (y_min) and 'bottom' (y_max) correspond to the vertical axis.
4.  **Tightness:** The box must tightly wrap the text pixels. Do not include white space around the text.

**Field Mapping Instructions (Strictly follow your output schema):**

**Box-First Visual Line Mode (Critical):**
1.  For each distinct text element, locate the **tight bounding box first**.
2.  Only after the box is located, read the text **inside that box**.
3.  Do not infer or reconstruct text that is outside the box. If unclear, mark it in "notes".

*   **"box"**: 
    *   The normalized bounding box { left, top, right, bottom }.

*   **"item_code"**: 
    *   If the text is a material specification with a code (e.g., "PV 02", "ST-01", "PB 03"), extract **only** that code here.
    *   If the item is a Dimension, set this to "DIMENSION".
    *   If the item is a Level/Elevation, set this to "LEVEL".
    *   If the item is a General Note or Title Block info, set this to "NOTE" or "META".
    *   *Never leave this null/empty.*

*   **"description"**: 
    *   **For Materials:** Extract the full description text (e.g., "100MM THICK LAYER OF CRUSHED STONE..."). Combine multi-line text into a single string.
    *   **For Dimensions:** Extract the numeric value and unit (e.g., "4200", "150 mm", "R300").
    *   **For Levels:** Extract the full marker text (e.g., "FGL +0.45 R.L").
    *   **For Notes:** Extract the full note text (e.g., "ALL DIMENSIONS IN MILLIMETERS").

*   **"notes"**: 
    *   Use this field for context or uncertainty.
    *   Example: "Located in Section 1", "Vertical text", "Uncertain text due to blur", or "Connected via leader line".
    *   If no specific note is needed, use "N/A".

**Execution Rules:**
1.  **Completeness:** If a BOQ-relevant material description spans 5 lines, capture all 5 lines in the "description" field.
2.  **Accuracy:** Distinguish between similar numbers (e.g., 6 vs 8, 5 vs S). If ambiguous, flag it in the "notes" field.
3.  **Grouping:** If a specific BOQ callout consists of a code ("PV 02") and a description ("100MM STONE"), return them as a SINGLE object where possible, or two tightly associated objects.
4.  Scan the document from Top-Left to Bottom-Right.
5.  Pay special attention to **rotated text** (vertical dimensions).
6.  Extract numbers, units, and leader lines precisely when they are BOQ-related.
7.  If a space/area label appears without a numeric size nearby, still extract the label as a BOQ item and note "Area size not shown" in "notes".
8.  If text is inside a table or title block, extract ONLY the BOQ-relevant content, not the table borders or unrelated metadata.
9.  **Dimension Association (Critical):** If a dimension is clearly linked to a named item/space/material (by proximity, shared leader line, or same callout), INCLUDE the dimension value inside that item's "description" and DO NOT emit a separate "DIMENSION" item for it. Only emit standalone "DIMENSION" items when the dimension is not clearly tied to any specific BOQ item.

Begin the extraction. Capture ONLY distinct BOQ-related text elements and numerical values on the page. If it is not related to BOQ or estimation, ignore it.`;

const CAD_EXTRACTION_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      item_code: { type: "string" },
      description: { type: "string" },
      notes: { type: "string" },
      box: {
        type: "object",
        additionalProperties: false,
        properties: {
          left: { type: "number", description: "x_min (0 to 1)" },
          top: { type: "number", description: "y_min (0 to 1)" },
          right: { type: "number", description: "x_max (0 to 1)" },
          bottom: { type: "number", description: "y_max (0 to 1)" },
        },
        required: ["left", "top", "right", "bottom"],
      },
    },
    required: ["item_code", "description", "notes", "box"],
  },
};

const DRAWING_DETAILS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      item_name: { type: "string" },
      details: { type: "string" },
      box: {
        type: "object",
        additionalProperties: false,
        properties: {
          left: { type: "number", description: "x_min (0 to 1)" },
          top: { type: "number", description: "y_min (0 to 1)" },
          right: { type: "number", description: "x_max (0 to 1)" },
          bottom: { type: "number", description: "y_max (0 to 1)" },
        },
        required: ["left", "top", "right", "bottom"],
      },
    },
    required: ["item_name", "details", "box"],
  },
};

const buildScheduleList = (items: string[]): string => {
  const trimmed = items.map((item) => item.trim()).filter(Boolean);
  if (trimmed.length === 0) return "- (no schedule items provided)";
  return trimmed.map((item) => `- ${item}`).join("\n");
};

const buildDrawingDetailsPrompt = (scheduleItems: string[]): string => `You are a senior MEP estimation engineer and estimation manager. Your task is to extract BOQ-relevant details from the drawings ONLY for the schedule CODES listed below.

Schedule item CODES only (use these exact values; do not infer missing codes):
${buildScheduleList(scheduleItems)}

Instructions:
1. Extract details for the listed items.each extracted detail/text from the drawings should be related to the items.
2. If an item is mentioned without useful BOQ details, omit it entirely.
3. Capture details that are required to build the BOQ for the item (materials, layers, thicknesses, steps, dimensions, specifications, quantities, or installation notes).
4. Some details may not include the item code in the text. If the detail clearly belongs to a specific item (by proximity, leader lines, layering, callouts, or section context) in general the related details positions are closed to the item, on the same level vertically, or required to impliment the item later, assign it to that item.
5. Do NOT repeat the same detail for the same item. If a detail is duplicated, return it only once.
6. Return a JSON array of objects. Each object must include:
   - item_name: the schedule item CODE (exactly as listed, or the closest match).
   - details: the extracted BOQ-relevant detail text.
   - box: normalized bounding box { left, top, right, bottom } for the extracted detail text.
7. Use normalized coordinates between 0.0 and 1.0 with origin at top-left. The box must tightly wrap the text.
8. If multiple distinct details exist for the same item, return multiple objects with the same item_name.

Return JSON only, with no additional prose.`;

export async function extractCadBoqItemsWithGemini(params: {
  filePath: string;
  fileName: string;
}): Promise<{ items: CadExtractionItem[]; rawText: string }> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const ai = getGeminiClient();
  const mimeType = mimeTypeFromFileName(params.fileName);

  console.log("[Gemini CAD] Uploading file:", {
    fileName: params.fileName,
    mimeType,
    model: config.geminiModel,
  });

  const uploaded = await ai.files.upload({
    file: params.filePath,
    config: {
      mimeType,
      displayName: params.fileName,
    },
  });

  if ((uploaded as any).state === "PROCESSING") {
    await waitForFileReady(ai, uploaded.name!);
  }

  const requestPayload = {
    model: config.geminiModel,
    contents: [
      { fileData: { fileUri: uploaded.uri, mimeType } },
      { text: CAD_EXTRACTION_PROMPT },
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: CAD_EXTRACTION_SCHEMA,
      thinkingConfig: {
        thinkingBudget: Number.isFinite(config.geminiThinkingBudget) ? config.geminiThinkingBudget : 16384,
      },
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      maxOutputTokens: 65536,
      temperature: 0.1,
    },
  };

  let response: unknown;
  try {
    response = await ai.models.generateContent(requestPayload);
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    console.error("[Gemini CAD] generateContent failed", {
      message: err.message,
      cause: err.cause,
      model: config.geminiModel,
      mimeType,
      fileUri: uploaded.uri,
      responseMimeType: "application/json",
      mediaResolution: "high",
    });
    throw error;
  }

  const text = String((response as any)?.text ?? "").trim();
  if (!text) {
    return { items: [], rawText: "" };
  }

  let parsed: CadExtractionItem[] = [];
  try {
    const maybe = JSON.parse(text);
    if (Array.isArray(maybe)) {
      parsed = maybe as CadExtractionItem[];
    }
  } catch {
    parsed = [];
  }

  return { items: parsed, rawText: text };
}

export async function extractDrawingDetailsWithGemini(params: {
  filePath: string;
  fileName: string;
  scheduleItems: string[];
}): Promise<{ items: CadExtractionItem[]; rawText: string }> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const ai = getGeminiClient();
  const mimeType = mimeTypeFromFileName(params.fileName);
  const prompt = buildDrawingDetailsPrompt(params.scheduleItems);

  console.log("[Gemini Drawing] Uploading file:", {
    fileName: params.fileName,
    mimeType,
    model: config.geminiModel,
  });

  const uploaded = await ai.files.upload({
    file: params.filePath,
    config: {
      mimeType,
      displayName: params.fileName,
    },
  });

  if ((uploaded as any).state === "PROCESSING") {
    await waitForFileReady(ai, uploaded.name!);
  }

  const requestPayload = {
    model: config.geminiModel,
    contents: [
      { fileData: { fileUri: uploaded.uri, mimeType } },
      { text: prompt },
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: DRAWING_DETAILS_SCHEMA,
      thinkingConfig: {
        thinkingBudget: Number.isFinite(config.geminiThinkingBudget) ? config.geminiThinkingBudget : 16384,
      },
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      maxOutputTokens: 65536,
      temperature: 0.1,
    },
  };

  let response: unknown;
  try {
    response = await ai.models.generateContent(requestPayload);
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    console.error("[Gemini Drawing] generateContent failed", {
      message: err.message,
      cause: err.cause,
      model: config.geminiModel,
      mimeType,
      fileUri: uploaded.uri,
      responseMimeType: "application/json",
    });
    throw error;
  }

  const text = String((response as any)?.text ?? "").trim();
  if (!text) {
    return { items: [], rawText: "" };
  }

  type DrawingDetailItem = {
    item_name: string;
    details: string;
    box: CadExtractionBox;
  };
  let parsed: DrawingDetailItem[] = [];
  try {
    const maybe = JSON.parse(text);
    if (Array.isArray(maybe)) {
      parsed = maybe as DrawingDetailItem[];
    }
  } catch {
    parsed = [];
  }

  const seen = new Set<string>();
  const mapped: CadExtractionItem[] = parsed
    .filter((item) => {
      const key = `${(item.item_name || "ITEM").trim().toLowerCase()}|${(item.details || "")
        .trim()
        .toLowerCase()}`;
      if (!key || key.endsWith("|")) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({
      item_code: item.item_name || "ITEM",
      description: item.details || "N/A",
      notes: "",
      box: item.box,
    }));

  return { items: mapped, rawText: text };
}
