import path from "path";
import { MediaResolution } from "@google/genai";
import { config } from "../../config";
import { getGeminiClient } from "../gemini/client";

export type ScheduleExtractionItem = {
  item_code: string;
  description: string;
  notes: string;
  fields: Record<string, string>;
};

const SCHEDULE_EXTRACTION_PROMPT = `You are a senior quantity surveyor. Extract a complete schedule of items from the provided document.

Important: The schedule is provided in TABLE/ROW format. Treat each row as a separate item entry.
You MUST preserve the original row order. Do NOT merge, reorder, or combine rows.

Scope:
- Capture all schedule items including paving, furniture, fittings, equipment, finishes, and any listed components.
- Do NOT miss details such as dimensions, sizes, materials, quantities, locations, or notes.
- Preserve the exact wording and numeric values found in the document.

Output:
- Return JSON only.
- Structure: { "items": [ { ... } ] }.
- Each item is one row from the table. Keep the output array in the same order as the table rows.
- Always include a field named "CODE" for each row to represent the item name or code.
- Use clear snake_case keys and include fields exactly as they appear in the source (e.g., CODE, item_name, description, dimensions, quantity, unit, location, notes).
- If a field is not present for an item, use an empty string.
- Do not invent values or assumptions.`;

const SCHEDULE_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
  required: ["items"],
};

function normalizeFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function normalizeFields(record: Record<string, unknown>): Record<string, string> {
  return Object.entries(record).reduce<Record<string, string>>((acc, [key, value]) => {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return acc;
    acc[normalizedKey] = normalizeFieldValue(value);
    return acc;
  }, {});
}

function pickFirstField(fields: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = fields[key];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function pickFirstFieldCaseInsensitive(fields: Record<string, string>, keys: string[]): string {
  const map = new Map(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = map.get(key.toLowerCase());
    if (value && value.trim()) return value.trim();
  }
  return "";
}

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

export async function extractScheduleItemsWithGemini(params: {
  filePath: string;
  fileName: string;
}): Promise<{ items: ScheduleExtractionItem[]; rawContent: string }> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const ai = getGeminiClient();
  const mimeType = mimeTypeFromFileName(params.fileName);

  console.log("[Gemini Schedule] Uploading file:", {
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
      { text: SCHEDULE_EXTRACTION_PROMPT },
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: SCHEDULE_EXTRACTION_SCHEMA,
      thinkingConfig: {
        thinkingBudget: Number.isFinite(config.geminiThinkingBudget) ? config.geminiThinkingBudget : 16384,
      },
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
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
      console.error(`[Gemini Schedule] generateContent failed (attempt ${attempt}/${maxAttempts})`, {
        message: err.message,
        cause: err.cause,
        model: config.geminiModel,
        mimeType,
        fileUri: uploaded.uri,
        responseMimeType: "application/json",
      });
      if (attempt === maxAttempts) {
        throw error;
      }
      const delayMs = 800 * attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const rawContent = String((response as any)?.text ?? "").trim();
  let parsedItems: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(rawContent);
    parsedItems = Array.isArray((parsed as any)?.items) ? ((parsed as any).items as Array<Record<string, unknown>>) : [];
  } catch {
    parsedItems = [];
  }

  const items: ScheduleExtractionItem[] = parsedItems.map((record) => {
    const fields = normalizeFields(record ?? {});
    const codeValue = pickFirstFieldCaseInsensitive(fields, ["code", "item_code", "itemcode", "item", "item_name", "name"]);
    if (!fields.CODE) {
      fields.CODE = codeValue || "";
    }
    const item_code = fields.CODE || "ITEM";
    const description = pickFirstField(fields, [
      "description",
      "details",
      "item_description",
      "specification",
      "specifications",
    ]);
    const notes = pickFirstField(fields, ["notes", "note", "remarks", "remark"]);
    return {
      item_code: item_code || "ITEM",
      description: description || item_code || "N/A",
      notes: notes || "N/A",
      fields,
    };
  });

  return { items, rawContent };
}
