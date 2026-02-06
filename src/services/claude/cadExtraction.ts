import path from "path";
import fs from "fs";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { config } from "../../config";
import { getClaudeClient, FILES_API_BETA } from "./client";

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
  box?: CadExtractionBox | null;
  thickness?: number | null;
};

export type FileUploadResult = {
  fileId: string;
  fileName: string;
  mimeType: string;
};

type MimeType = "application/pdf" | "image/png" | "image/jpeg" | "image/webp" | "image/gif";

function mimeTypeFromFileName(fileName: string): MimeType {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/pdf"; // Default to PDF for CAD files
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Upload a file to Claude's Files API.
 * Returns the file_id for use in subsequent messages.
 */
export async function uploadFileToClaude(params: {
  filePath: string;
  fileName: string;
  onProgress?: (stage: "uploading" | "uploaded") => void;
}): Promise<FileUploadResult> {
  const client = getClaudeClient();
  const mimeType = mimeTypeFromFileName(params.fileName);

  console.log("[Claude CAD] Uploading file:", {
    fileName: params.fileName,
    mimeType,
  });

  params.onProgress?.("uploading");

  const fileStream = fs.createReadStream(params.filePath);
  const uploaded = await client.beta.files.upload({
    file: await toFile(fileStream, params.fileName, { type: mimeType }),
    betas: [FILES_API_BETA],
  });

  console.log("[Claude CAD] File uploaded:", {
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
 * Call this after extraction is complete to clean up.
 */
export async function deleteFileFromClaude(fileId: string): Promise<void> {
  const client = getClaudeClient();
  try {
    await client.beta.files.delete(fileId, { betas: [FILES_API_BETA] });
    console.log("[Claude CAD] File deleted:", fileId);
  } catch (error) {
    // Log but don't throw - file cleanup is not critical
    console.warn("[Claude CAD] Failed to delete file:", fileId, error);
  }
}

const buildScheduleList = (items: string[]): string => {
  const trimmed = items.map((item) => item.trim()).filter(Boolean);
  if (trimmed.length === 0) return "- (no schedule items provided)";
  return trimmed.map((item) => `- ${item}`).join("\n");
};


const buildDrawingDetailsPrompt = (scheduleItems: string[]): string => `You are an expert Quantity Surveyor and Estimation Engineer. Your task is to extract Bill of Quantities (BOQ) data from architectural construction details ONLY for the schedule CODES listed below.

Schedule item CODES only (use these exact values; do not infer missing codes):
${buildScheduleList(scheduleItems)}

**The Goal:** 
Extract ALL component details and sub-layers for each Item Code (e.g., PV-02, ST-01) that will be used in the BOQ estimation process. Do NOT miss any detail that may be required for cost estimation.

**How to read the drawing (CRITICAL):**
1.  **Locate Item Codes:** Find all labels with codes like PV-XX, PB-XX, ST-XX.
2.  **Trace the Arrows/Lines:** Look closely at the leader lines and arrows pointing from text blocks to identify which details belong to which item code.
    *   Text blocks are often stacked vertically.
    *   If a text block has an arrow pointing to the same section as an Item Code, it belongs to that Item Code.
    *   Multiple text blocks often describe different layers of the same assembly (e.g., Stone -> Base -> Subgrade). You MUST capture ALL layers related to that code.
    *   Details may be linked to items by: arrows, leader lines, proximity, or being positioned close to the item.
3.  CRITICAL: **Extract ALL Details:** Don't miss ANY detail (text block) that is required for the BOQ estimation. Do NOT miss any component layer or material specification, if you're not sure to which item it belongs, assign it to the closest item.
4.  **Extract each text block as it is:** Do not change, merge, or split text blocks. Each block is a single detail.
5.  CRITICAL: **Extract Thickness:** If a thickness value is explicitly stated in the detail text (e.g., "100MM", "150 MM", "50mm"), extract it as a numeric value in millimeters.
6.  CRITICAL: if the detail is duplicated but belongs to different item codes, extract it for EACH item code it belongs to.

**IMPORTANT RULES:**
*   Do not hallucinate. Only include text blocks that are visible on the drawing. If in doubt, include it and attach it to the closest item code.
*   For thickness: ONLY provide a value if the thickness is explicitly mentioned in the detail. If no thickness is stated, set thickness to null.
*   Thickness MUST be returned as a NUMBER in MILLIMETERS (e.g., 100, 150, 50), not as a string with units.

**OUTPUT FORMAT:**
Return your response as a JSON array. Each object must have exactly these fields:
- item_name (string): The item code (e.g., "PV-02", "ST-01")
- description (string): The full component description EXACTLY as it appears in the drawing
- thickness (number | null): The thickness in MM as a number, ONLY if explicitly stated in the detail. Set to null if no thickness is mentioned.

Example output format:
[
  {
    "item_name": "PV-02",
    "description": "150 MM AGGREGATE ROAD BASE",
    "thickness": 150
  },
  {
    "item_name": "PV-02",
    "description": "COMPACTED SUBGRADE",
    "thickness": null
  }
]

Return ONLY the JSON array, no other text.`;

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
 * Extract drawing details using Claude's Files API.
 * This function is used for schedule-based extraction where specific codes are provided.
 */
export async function extractDrawingDetailsWithClaude(params: {
  filePath: string;
  fileName: string;
  scheduleItems: string[];
  onProgress?: (stage: "uploading" | "uploaded" | "extracting" | "done") => void;
}): Promise<{ items: CadExtractionItem[]; rawText: string; fileId: string }> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const client = getClaudeClient();
  const mimeType = mimeTypeFromFileName(params.fileName);
  const prompt = buildDrawingDetailsPrompt(params.scheduleItems);

  // Step 1: Upload the file
  const uploaded = await uploadFileToClaude({
    filePath: params.filePath,
    fileName: params.fileName,
    onProgress: params.onProgress,
  });

  params.onProgress?.("extracting");

  // Step 2: Send extraction request
  console.log("[Claude Drawing] Sending extraction request:", {
    model: config.claudeModel,
    fileId: uploaded.fileId,
    mimeType,
    scheduleItemCount: params.scheduleItems.length,
  });

  let response: Anthropic.Beta.Messages.BetaMessage;
  // Use 30 minute timeout for long document processing
  const requestTimeout = 30 * 60 * 1000;

  try {
    // Use streaming to handle long-running requests (avoids 10min timeout error)
    const contentBlocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [
      buildFileContentBlock(uploaded.fileId, mimeType),
      { type: "text", text: prompt },
    ];
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
      {
        role: "user",
        content: contentBlocks,
      },
    ];
    const thinking: Anthropic.Beta.Messages.BetaThinkingConfigParam = {
      type: "enabled",
      budget_tokens: config.claudeThinkingBudget,
    };
    const streamParams = {
      model: config.claudeModel,
      max_tokens: config.claudeMaxTokens,
      temperature: 1,
      thinking,
      messages,
      betas: [FILES_API_BETA],
    };

    const stream = client.beta.messages.stream(streamParams, { timeout: requestTimeout });

    // Collect the final message from the stream
    response = await stream.finalMessage();
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    console.error("[Claude Drawing] Extraction failed", {
      message: err.message,
      cause: err.cause,
      model: config.claudeModel,
      fileId: uploaded.fileId,
      mimeType,
    });
    // Clean up the uploaded file on error
    await deleteFileFromClaude(uploaded.fileId);
    throw error;
  }

  // Step 3: Parse response
  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text.trim() : "";

  if (!text) {
    params.onProgress?.("done");
    return { items: [], rawText: "", fileId: uploaded.fileId };
  }

  // Extract JSON from response
  let jsonText = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1].trim();
  }

  type DrawingDetailItem = {
    item_name: string;
    description: string;
    thickness?: number | null;
  };

  let parsed: DrawingDetailItem[] = [];
  try {
    const maybe = JSON.parse(jsonText);
    if (Array.isArray(maybe)) {
      parsed = maybe as DrawingDetailItem[];
    }
  } catch (parseError) {
    console.warn("[Claude Drawing] Failed to parse JSON response:", parseError);
    parsed = [];
  }

  // Deduplicate and map to standard format
  const seen = new Set<string>();
  const mapped: CadExtractionItem[] = parsed
    .filter((item) => {
      const key = `${(item.item_name || "ITEM").trim().toLowerCase()}|${(item.description || "")
        .trim()
        .toLowerCase()}`;
      if (!key || key.endsWith("|")) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({
      item_code: item.item_name || "ITEM",
      description: item.description || "N/A",
      notes: "",
      thickness: typeof item.thickness === "number" ? item.thickness : null,
    }));

  params.onProgress?.("done");

  console.log("[Claude Drawing] Extraction complete:", {
    itemCount: mapped.length,
    fileId: uploaded.fileId,
  });

  return { items: mapped, rawText: text, fileId: uploaded.fileId };
}

/**
 * Extract drawing details using a pre-uploaded file ID.
 * Use this when the file has already been uploaded to Claude's Files API.
 */
export async function extractDrawingDetailsWithClaudeFileId(params: {
  fileId: string;
  fileName: string;
  scheduleItems: string[];
  onProgress?: (stage: "extracting" | "done") => void;
}): Promise<{ items: CadExtractionItem[]; rawText: string }> {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const client = getClaudeClient();
  const mimeType = mimeTypeFromFileName(params.fileName);
  const prompt = buildDrawingDetailsPrompt(params.scheduleItems);

  params.onProgress?.("extracting");

  console.log("[Claude Drawing] Sending extraction request with existing file:", {
    model: config.claudeModel,
    fileId: params.fileId,
    mimeType,
    scheduleItemCount: params.scheduleItems.length,
  });

  let response: Anthropic.Beta.Messages.BetaMessage;
  // Use 30 minute timeout for long document processing
  const requestTimeout = 30 * 60 * 1000;

  try {
    // Use streaming to handle long-running requests (avoids 10min timeout error)
    const contentBlocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [
      buildFileContentBlock(params.fileId, mimeType),
      { type: "text", text: prompt },
    ];
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
      {
        role: "user",
        content: contentBlocks,
      },
    ];
    const thinking: Anthropic.Beta.Messages.BetaThinkingConfigParam = {
      type: "enabled",
      budget_tokens: config.claudeThinkingBudget,
    };
    const streamParams = {
      model: config.claudeModel,
      max_tokens: config.claudeMaxTokens,
      temperature: 1,
      thinking,
      messages,
      betas: [FILES_API_BETA],
    };

    const stream = client.beta.messages.stream(streamParams, { timeout: requestTimeout });

    // Collect the final message from the stream
    response = await stream.finalMessage();
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    console.error("[Claude Drawing] Extraction failed", {
      message: err.message,
      cause: err.cause,
      model: config.claudeModel,
      fileId: params.fileId,
      mimeType,
    });
    throw error;
  }

  // Parse response
  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text.trim() : "";

  if (!text) {
    params.onProgress?.("done");
    return { items: [], rawText: "" };
  }

  // Extract JSON from response
  let jsonText = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1].trim();
  }

  type DrawingDetailItem = {
    item_name: string;
    description: string;
    thickness?: number | null;
  };

  let parsed: DrawingDetailItem[] = [];
  try {
    const maybe = JSON.parse(jsonText);
    if (Array.isArray(maybe)) {
      parsed = maybe as DrawingDetailItem[];
    }
  } catch (parseError) {
    console.warn("[Claude Drawing] Failed to parse JSON response:", parseError);
    parsed = [];
  }

  // Deduplicate and map to standard format
  const seen = new Set<string>();
  const mapped: CadExtractionItem[] = parsed
    .filter((item) => {
      const key = `${(item.item_name || "ITEM").trim().toLowerCase()}|${(item.description || "")
        .trim()
        .toLowerCase()}`;
      if (!key || key.endsWith("|")) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({
      item_code: item.item_name || "ITEM",
      description: item.description || "N/A",
      notes: "",
      thickness: typeof item.thickness === "number" ? item.thickness : null,
    }));

  params.onProgress?.("done");

  console.log("[Claude Drawing] Extraction complete:", {
    itemCount: mapped.length,
    fileId: params.fileId,
  });

  return { items: mapped, rawText: text };
}
