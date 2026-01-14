import path from "path";
import { config } from "../../config";
import { getGeminiClient } from "./client";
import { MediaResolution } from "@google/genai";
import { parseWithLandingAiToMarkdown } from "../landingai/parseToMarkdown";
import { extractBoqItemsWithLandingAi } from "../landingai/extractBoq";
import { getPromptByKey } from "../../modules/storage/promptRepository";

function mimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

const SYSTEM_INSTRUCTION = `You are an expert architectural drawing reader and transcription assistant. You specialize in reading technical drawings, floor plans, elevations, and booth/stand designs. You can read dimension lines, annotations, and measurements with perfect accuracy.`;

function buildPrompt(): string {
  return `**Role:** You are a Senior Estimation Engineer for an exhibition stand building company.
**Task:** Parse the provided architectural drawings/renders and generate a Bill of Quantities (BOQ).
**Output Format:** A strict JSON Array of Objects.

## 1. Estimation Methodology & Rules
You must strictly follow these engineering assumptions derived from company standards. Do not merely describe the image; translate it into construction line items.

### Section A: Flooring (Mandatory)
Regardless of the drawing details, every booth must have these foundational items calculated based on the total booth area (L * D), get these dimensions from flooring of the booth, the dimention that you don't find, try to calculate it based on proportionality.
1.  **Raised Platform:** Always A.1.
    *   *Desc:* "Raised platform"
    *   *Finish:* "Wooden structure, MDF, Plywood framing"
    *   *Dim:* Total Area (Lm * Wm * 0.10mH)
    *   *UOM:* SQM
2.  **Floor Finish:** A.2 or A.4 (Sequence).
    *   *Finish:* Detect from render. If wood look: "Glossy finish laminate". If fabric: "Galaxy grade Carpet".
    *   *Dim:* Total Area (Lm * Dm * 0.10mH)
    *   *UOM:* SQM
3.  **Plastic Protection:** Always the last item in Section A.
    *   *Desc:* "Plastic protection"
    *   *Finish:* "Consumables"
    *   *Dim:* Total Area (Lm * Dm * 0.10mH)
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
*   landing_ai_id: String UUID from LandingAI chunk id, or null if not found.


## 3. Input Handling
If the input PDF contains specific text lists (e.g., "Furniture List: 10 chairs"), prioritize that count. If only images are provided, estimate counts visually.
## 4. Dimensions
if the Dimensions are provided in the drawings for each item, or it's written in the text, make sure to use the provided dimensions.
## Additional OCR/Parse Reference (if provided)
You may also receive a \"LandingAI parsed Markdown\" and/or a \"LandingAI parsed JSON\" (contains chunks with stable ids + per-chunk markdown + grounding boxes).

Use LandingAI ONLY to:
1) **Attach landing_ai_id**: If an extracted item is clearly present in LandingAI (same item/annotation), set landing_ai_id to the matching LandingAI chunk id. If you cannot confidently match, set landing_ai_id to null.
2) **Prefer LandingAI dimensions when matched**: If landing_ai_id is not null and the LandingAI chunk markdown contains explicit dimensions, copy those dimensions EXACTLY into the item's dimensions field (do not re-calculate), if many Dimensions are provided, use the maximum value for each dimension (the envilop of the item). If LandingAI has no dimensions for that chunk, keep the best dimensions you can verify from the PDF.

Do not invent anything.

Start transcribing now. Be thorough - every dimension matters.`;
}

async function resolveGeminiDrawingPrompt(): Promise<{ prompt: string; source: "db" | "default" }> {
  // Reuse the same DB prompt mechanism already exposed at /prompts/drawing-extraction
  // If the prompt exists in DB, prefer it; otherwise fall back to the built-in prompt.
  const key = "drawing-extraction";
  try {
    const stored = await getPromptByKey(key);
    const content = stored?.content;
    if (typeof content === "string" && content.trim()) {
      return { prompt: content, source: "db" };
    }
  } catch {
    // fail soft: if DB is unavailable or query fails, just use default prompt
  }
  return { prompt: buildPrompt(), source: "default" };
}

/**
 * Wait for an uploaded file to finish processing.
 * Gemini files go through PROCESSING state before becoming ACTIVE.
 */
async function waitForFileReady(
  ai: ReturnType<typeof getGeminiClient>,
  fileName: string,
  maxWaitMs = 120000
): Promise<void> {
  const startTime = Date.now();
  const pollIntervalMs = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const file = await ai.files.get({ name: fileName });
      const state = (file as any).state;

      if (state === "ACTIVE") {
        return; // File is ready
      }
      if (state === "FAILED") {
        throw new Error(`File processing failed: ${(file as any).error?.message || "Unknown error"}`);
      }
      // Still PROCESSING, wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } catch (err: any) {
      // If it's a "not found" or transient error, keep waiting
      if (err.message?.includes("FAILED")) throw err;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  throw new Error(`Timeout waiting for file to be ready after ${maxWaitMs}ms`);
}

export async function generateDrawingMarkdownWithGemini(params: {
  filePath: string;
  fileName: string;
  onStage?: (stage: "landingai-parse" | "landingai-extract" | "gemini") => void | Promise<void>;
}): Promise<{ markdown: string; rawText: string; debug?: any }> {
  // Fail soft: if Gemini isn't configured, return empty markdown so the app continues to work.
  if (!config.geminiApiKey) {
    console.warn("[Gemini] GEMINI_API_KEY not set, skipping markdown generation");
    return { markdown: "", rawText: "" };
  }

  const ai = getGeminiClient();
  const mimeType = mimeTypeFromFileName(params.fileName);

  // Optional: parse the PDF with LandingAI first, then provide its markdown alongside the PDF to Gemini.
  let landingMarkdown = "";
  let landingDebug: any = null;
  let landingRaw: any = null;
  let landingExtraction: any = null;
  let landingExtractionDebug: any = null;
  let landingExtractionRaw: any = null;
  if (mimeType === "application/pdf" && config.landingAiApiKey) {
    try {
      await params.onStage?.("landingai-parse");
      console.log(`[LandingAI] Parsing PDF to markdown: ${params.fileName}`);
      const parsed = await parseWithLandingAiToMarkdown({ filePath: params.filePath, fileName: params.fileName });
      landingMarkdown = (parsed.markdown || "").trim();
      landingDebug = parsed.debug ?? null;
      landingRaw = parsed.raw ?? null;
      console.log(`[LandingAI] Parsed markdown length: ${landingMarkdown.length}`);

      // New step: use LandingAI ADE Extract (multipart/form-data) to get structured BOQ items from markdown.
      if (landingMarkdown) {
        try {
          await params.onStage?.("landingai-extract");
          console.log(`[LandingAI] Extracting BOQ items from markdown: ${params.fileName}`);
          const extracted = await extractBoqItemsWithLandingAi({
            markdown: landingMarkdown,
            sourceFileName: params.fileName,
          });
          landingExtraction = extracted.extraction ?? null;
          landingExtractionRaw = extracted.raw ?? null;
          landingExtractionDebug = extracted.debug ?? null;
          console.log(
            `[LandingAI] Extraction done. Has extraction: ${landingExtraction ? "yes" : "no"}`
          );
        } catch (err) {
          landingExtractionDebug = {
            error: err instanceof Error ? err.message : String(err),
          };
          landingExtractionRaw = null;
          landingExtraction = null;
          console.error("[LandingAI] Extract failed (continuing without it):", err);
        }
      }
    } catch (err) {
      landingDebug = {
        error: err instanceof Error ? err.message : String(err),
        attempts: (err as any)?.attempts ?? null,
      };
      landingRaw = null;
      console.error("[LandingAI] Parse failed (continuing without it):", err);
    }
  }

  await params.onStage?.("gemini");
  console.log(`[Gemini] Uploading file: ${params.fileName} (${mimeType})`);

  // Upload file so we can pass the full binary (PDF/images) to Gemini.
  const uploaded = await ai.files.upload({
    file: params.filePath,
    config: {
      mimeType,
      displayName: params.fileName,
    },
  });

  console.log(`[Gemini] File uploaded: ${uploaded.name}, state: ${(uploaded as any).state}`);

  // Wait for the file to finish processing (especially important for PDFs)
  if ((uploaded as any).state === "PROCESSING") {
    console.log("[Gemini] Waiting for file processing to complete...");
    await waitForFileReady(ai, uploaded.name!);
    console.log("[Gemini] File ready");
  }

  console.log(`[Gemini] Generating content with model: ${config.geminiModel}`);

  const resolvedPrompt = await resolveGeminiDrawingPrompt();

  const geminiRequest = {
    model: config.geminiModel,
    contents: [
      { fileData: { fileUri: uploaded.uri, mimeType } },
      ...(landingExtractionRaw
        ? [
          {
            text:
              "LandingAI extraction JSON (BOQ items extracted from the LandingAI parsed Markdown; reference only; do not invent):\n\n" +
              (() => {
                try {
                  return JSON.stringify(landingExtractionRaw).slice(0, 200000);
                } catch {
                  return "";
                }
              })(),
          },
        ]
        : []),
      { text: resolvedPrompt.prompt },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      thinkingConfig: {
        thinkingBudget: Number.isFinite(config.geminiThinkingBudget) ? config.geminiThinkingBudget : 16384,
      },
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
      temperature: 0,
      maxOutputTokens: 65536,
    },
  };

  const response = await ai.models.generateContent({
    ...geminiRequest,
  });

  const text = (response as any)?.text ?? "";

  if (!text) {
    console.warn("[Gemini] Empty response received");
  } else {
    console.log(`[Gemini] Received ${text.length} characters`);
  }

  return {
    markdown: String(text || ""),
    rawText: String(text || ""),
    debug: {
      landingAi: {
        enabled: !!config.landingAiApiKey && mimeType === "application/pdf",
        markdownLength: landingMarkdown.length,
        markdownPreview: landingMarkdown.slice(0, 4000),
        debug: landingDebug,
        raw: landingRaw,
        extraction: landingExtraction,
        extractionDebug: landingExtractionDebug,
        extractionRaw: landingExtractionRaw,
      },
      geminiRequest: {
        // Avoid logging huge payloads; include a safe summary for browser console.
        model: geminiRequest.model,
        file: { mimeType, fileUri: uploaded.uri },
        config: geminiRequest.config,
        promptSource: resolvedPrompt.source,
        textParts: geminiRequest.contents
          .filter((p: any) => typeof p?.text === "string")
          .map((p: any) => ({
            length: (p.text as string).length,
            preview: (p.text as string).slice(0, 1200),
          })),
      },
    },
  };
}
