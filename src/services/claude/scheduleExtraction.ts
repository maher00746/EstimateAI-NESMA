import path from "path";
import fs from "fs";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { config } from "../../config";
import { getClaudeClient, FILES_API_BETA } from "./client";

export type ScheduleExtractionItem = {
  item_code: string;
  description: string;
  notes: string;
  fields: Record<string, string>;
};

type MimeType = "application/pdf" | "image/png" | "image/jpeg" | "image/webp" | "image/gif";

function mimeTypeFromFileName(fileName: string): MimeType {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/pdf"; // Default to PDF for schedule files
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

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
- Always include a field named "CODE" for each row to represent the item name or code (put the code as it is).
- Use clear snake_case keys and include fields exactly as they appear in the source (e.g., item_name, description, dimensions, quantity, unit, location).
- If a field is not present for an item, use an empty string.
- Do not invent values or assumptions.

Return ONLY the JSON object, no other text.`;

/**
 * Build the content block for Claude based on file type.
 */
function buildFileContentBlock(
  fileId: string,
  mimeType: string
): Anthropic.Beta.Messages.BetaContentBlockParam {
  if (isImageMimeType(mimeType)) {
    return {
      type: "image",
      source: {
        type: "file",
        file_id: fileId,
      },
    };
  }
  // PDF and other document types
  return {
    type: "document",
    source: {
      type: "file",
      file_id: fileId,
    },
  };
}

/**
 * Upload a file to Claude's Files API for schedule extraction.
 */
async function uploadScheduleFileToClaude(params: {
  filePath: string;
  fileName: string;
  onProgress?: (stage: "uploading" | "uploaded") => void;
}): Promise<{ fileId: string; fileName: string; mimeType: string }> {
  const client = getClaudeClient();
  const mimeType = mimeTypeFromFileName(params.fileName);

  console.log("[Claude Schedule] Uploading file:", {
    fileName: params.fileName,
    mimeType,
  });

  params.onProgress?.("uploading");

  const fileStream = fs.createReadStream(params.filePath);
  const uploaded = await client.beta.files.upload({
    file: await toFile(fileStream, params.fileName, { type: mimeType }),
    betas: [FILES_API_BETA],
  });

  console.log("[Claude Schedule] File uploaded:", {
    fileId: uploaded.id,
    fileName: uploaded.filename,
    sizeBytes: uploaded.size_bytes,
  });

  params.onProgress?.("uploaded");

  return {
    fileId: uploaded.id,
    fileName: uploaded.filename,
    mimeType: uploaded.mime_type,
  };
}

/**
 * Delete a file from Claude's Files API.
 */
async function deleteScheduleFileFromClaude(fileId: string): Promise<void> {
  const client = getClaudeClient();
  try {
    await client.beta.files.delete(fileId, { betas: [FILES_API_BETA] });
    console.log("[Claude Schedule] File deleted:", fileId);
  } catch (error) {
    // Log but don't throw - file cleanup is not critical
    console.warn("[Claude Schedule] Failed to delete file:", fileId, error);
  }
}

/**
 * Extract schedule items using Claude's Files API.
 */
export async function extractScheduleItemsWithClaude(params: {
  filePath: string;
  fileName: string;
  onProgress?: (stage: "uploading" | "uploaded" | "extracting" | "done") => void;
}): Promise<{ items: ScheduleExtractionItem[]; rawContent: string; fileId: string }> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const client = getClaudeClient();
  const mimeType = mimeTypeFromFileName(params.fileName);

  // Step 1: Upload the file
  const uploaded = await uploadScheduleFileToClaude({
    filePath: params.filePath,
    fileName: params.fileName,
    onProgress: params.onProgress,
  });

  params.onProgress?.("extracting");

  // Step 2: Send extraction request
  console.log("[Claude Schedule] Sending extraction request:", {
    model: config.claudeModel,
    fileId: uploaded.fileId,
    mimeType,
  });

  let response: Anthropic.Beta.Messages.BetaMessage;
  const maxAttempts = 3;
  // Use 30 minute timeout for long document processing
  const requestTimeout = 30 * 60 * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // Use streaming to handle long-running requests (avoids 10min timeout error)
      const stream = client.beta.messages.stream({
        model: config.claudeModel,
        max_tokens: config.claudeMaxTokens,
        messages: [
          {
            role: "user",
            content: [
              buildFileContentBlock(uploaded.fileId, mimeType),
              { type: "text", text: SCHEDULE_EXTRACTION_PROMPT },
            ],
          },
        ],
        betas: [FILES_API_BETA],
      }, { timeout: requestTimeout });

      // Collect the final message from the stream
      response = await stream.finalMessage();
      break;
    } catch (error) {
      const err = error as Error & { cause?: unknown };
      console.error(`[Claude Schedule] Extraction failed (attempt ${attempt}/${maxAttempts})`, {
        message: err.message,
        cause: err.cause,
        model: config.claudeModel,
        fileId: uploaded.fileId,
        mimeType,
      });
      if (attempt === maxAttempts) {
        // Clean up the uploaded file on final error
        await deleteScheduleFileFromClaude(uploaded.fileId);
        throw error;
      }
      const delayMs = 800 * attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Step 3: Parse response
  const textBlock = response!.content.find((block) => block.type === "text");
  const rawContent = textBlock && "text" in textBlock ? textBlock.text.trim() : "";

  // Extract JSON from response (Claude might include markdown code blocks)
  let jsonText = rawContent;
  const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1].trim();
  }

  let parsedItems: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(jsonText);
    parsedItems = Array.isArray((parsed as any)?.items)
      ? ((parsed as any).items as Array<Record<string, unknown>>)
      : [];
  } catch (parseError) {
    console.warn("[Claude Schedule] Failed to parse JSON response:", parseError);
    parsedItems = [];
  }

  // Step 4: Normalize items
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

  params.onProgress?.("done");

  console.log("[Claude Schedule] Extraction complete:", {
    itemCount: items.length,
    fileId: uploaded.fileId,
  });

  return { items, rawContent, fileId: uploaded.fileId };
}

/**
 * Export the delete function for use by the worker for cleanup.
 */
export { deleteScheduleFileFromClaude };
