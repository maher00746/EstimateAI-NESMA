import path from "path";
import { config } from "../../config";
import { ExtractJobModel } from "../../modules/storage/extractJobModel";
import { parseDocument } from "../parsing/parsingPipeline";
import { generateDrawingMarkdownWithGemini } from "../gemini/drawingMarkdown";

function nowPlusHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export async function kickOffExtractJob(jobId: string): Promise<void> {
  // Run in background; don't block request thread.
  setImmediate(() => {
    void processExtractJob(jobId);
  });
}

export async function processExtractJob(jobId: string): Promise<void> {
  // Atomically claim the job so multiple instances won't process twice.
  const claimed = await ExtractJobModel.findOneAndUpdate(
    { _id: jobId, status: "queued" },
    { status: "processing", stage: "queued", startedAt: new Date(), message: "Starting…" },
    { new: true }
  ).exec();

  if (!claimed) {
    return; // already processing/done/failed or does not exist
  }

  try {
    const files = Array.isArray(claimed.files) ? claimed.files : [];
    const parsedFiles = [];

    for (const file of files) {
      // 1) Gemini markdown review (internally calls LandingAI parse + extract before Gemini)
      let geminiMarkdown = "";
      let geminiDebug: unknown = null;
      try {
        const geminiResp = await generateDrawingMarkdownWithGemini({
          filePath: file.storedPath,
          fileName: file.originalName,
          onStage: async (stage) => {
            const msg =
              stage === "landingai-parse"
                ? "Reading the drawing…"
                : stage === "landingai-extract"
                  ? "Extracting key details…"
                  : "Analyzing the drawing…";
            await ExtractJobModel.updateOne(
              { _id: claimed._id },
              { stage, message: msg }
            ).exec();
          },
        });
        geminiMarkdown = geminiResp.markdown || "";
        geminiDebug = (geminiResp as any).debug ?? null;
      } catch (err) {
        // Keep going; job can still return partial results
        geminiDebug = { error: err instanceof Error ? err.message : String(err) };
      }

      // 2) Drawings extraction (OpenAI JSON items) - behind flag (kept as-is)
      await ExtractJobModel.updateOne(
        { _id: claimed._id },
        { stage: "finalizing", message: "Finalizing results…" }
      ).exec();

      const parsed = config.enableDrawingsExtraction
        ? await parseDocument(file.storedPath)
        : { attributes: {}, items: [], totalPrice: undefined as string | undefined };

      parsedFiles.push({
        fileName: file.originalName,
        link_to_file: `/files/${path.basename(file.storedPath)}`,
        attributes: parsed.attributes,
        items: parsed.items,
        totalPrice: parsed.totalPrice,
        markdown: geminiMarkdown,
        geminiDebug,
      });
    }

    const result = { files: parsedFiles };

    await ExtractJobModel.updateOne(
      { _id: claimed._id },
      {
        status: "done",
        stage: "finalizing",
        message: "Completed",
        result,
        error: null,
        finishedAt: new Date(),
        // Keep job around for 24 hours
        expiresAt: nowPlusHours(24),
      }
    ).exec();
  } catch (err) {
    await ExtractJobModel.updateOne(
      { _id: claimed._id },
      {
        status: "failed",
        message: "Failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        finishedAt: new Date(),
        expiresAt: nowPlusHours(24),
      }
    ).exec();
  }
}

