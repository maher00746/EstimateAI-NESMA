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

const CAD_EXTRACTION_PROMPT = `You are a Senior Estimate Engineer and Quantity Surveyor performing a detailed forensic takeoff from construction drawings. Your goal is to digitize every single annotation, dimension, and specification for a Bill of Quantities (BOQ).

**Input Analysis Strategy:**
1.  **Scan Strategy:** Systematically scan the page (e.g., Title Block -> General Notes -> Plan Views -> Section Details).
2.  **Detail Capture:** Do not ignore small text, vertical text, or text inside hatch patterns. Capture everything.
3.  **Context Awareness:** Associate labels with their leaders/arrows to understand what they point to.

**COORDINATE SYSTEM INSTRUCTIONS (CRITICAL):**
1.  **Normalization:** Return coordinates as Normalized values between 0.0 and 1.0 relative to the page size.
2.  **Origin:** (0.0, 0.0) is the Top-Left corner.
3.  **Axes:** 
    *   'left' (x_min) and 'right' (x_max) correspond to the horizontal axis.
    *   'top' (y_min) and 'bottom' (y_max) correspond to the vertical axis.
4.  **Tightness:** The box must tightly wrap the text pixels. Do not include white space around the text.

**Field Mapping Instructions (Strictly follow your output schema):**

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

*   **"box"**: 
    *   The normalized bounding box { left, top, right, bottom }.

**Execution Rules:**
1.  **Completeness:** If a material description spans 5 lines, capture all 5 lines in the "description" field.
2.  **Accuracy:** Distinguish between similar numbers (e.g., 6 vs 8, 5 vs S). If ambiguous, flag it in the "notes" field.
3.  **Grouping:** If a specific callout consists of a code ("PV 02") and a description ("100MM STONE"), return them as a SINGLE object where possible, or two tightly associated objects.
4.  Scan the document from Top-Left to Bottom-Right.
5.  Pay special attention to **rotated text** (vertical dimensions).
6.  Extract numbers, units, and leader lines precisely.
7.  If text is inside a table or title block, extract the content, not the table borders.

Begin the extraction. Capture every distinct text element and numerical value on the page.`;

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
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
      maxOutputTokens: 65536,
      temperature: 0.1,
    },
  };

  let response: unknown;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await ai.models.generateContent(requestPayload);
      break;
    } catch (error) {
      const err = error as Error & { cause?: unknown };
      console.error(`[Gemini CAD] generateContent failed (attempt ${attempt}/${maxAttempts})`, {
        message: err.message,
        cause: err.cause,
        model: config.geminiModel,
        mimeType,
        fileUri: uploaded.uri,
        responseMimeType: "application/json",
        mediaResolution: "high",
      });
      if (attempt === maxAttempts) {
        throw error;
      }
      const delayMs = 800 * attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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
