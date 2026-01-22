import { ProjectExtractJobModel } from "../../modules/storage/projectExtractionJobModel";
import { ProjectFileModel } from "../../modules/storage/projectFileModel";
import { ProjectItemModel } from "../../modules/storage/projectItemModel";
import { ProjectModel } from "../../modules/storage/projectModel";
import { createProjectLog } from "../../modules/storage/projectLogRepository";
import { extractCadBoqItemsWithGemini } from "../gemini/cadExtraction";
import { extractBoqItemsFromExcel } from "../boq/boqExcelExtraction";

const POLL_INTERVAL_MS = 2000;
const MAX_CONCURRENCY = 12;
const inFlightJobs = new Set<string>();

async function claimNextJob() {
  return ProjectExtractJobModel.findOneAndUpdate(
    { status: "queued" },
    {
      status: "processing",
      stage: "processing",
      message: "Starting extraction…",
      startedAt: new Date(),
    },
    { new: true, sort: { createdAt: 1 } }
  ).exec();
}

async function updateProjectStatusIfIdle(projectId: string): Promise<void> {
  const pending = await ProjectExtractJobModel.countDocuments({
    projectId,
    status: { $in: ["queued", "processing"] },
  }).exec();
  if (pending === 0) {
    await ProjectModel.updateOne({ _id: projectId }, { status: "finalized" }).exec();
  } else {
    await ProjectModel.updateOne({ _id: projectId }, { status: "analyzing" }).exec();
  }
}

async function processJob(jobId: string): Promise<void> {
  const job = await ProjectExtractJobModel.findById(jobId).exec();
  if (!job) return;

  const file = await ProjectFileModel.findById(job.fileId).exec();
  if (!file) {
    await createProjectLog({
      userId: String(job.userId),
      projectId: String(job.projectId),
      fileId: String(job.fileId),
      level: "error",
      message: "Extraction failed: file not found.",
    });
    await ProjectExtractJobModel.updateOne(
      { _id: job._id },
      {
        status: "failed",
        stage: "finalizing",
        message: "File not found",
        error: { message: "File not found" },
        finishedAt: new Date(),
      }
    ).exec();
    return;
  }

  try {
    await createProjectLog({
      userId: String(job.userId),
      projectId: String(job.projectId),
      fileId: String(job.fileId),
      message: `Starting extraction for ${file.originalName}.`,
    });
    await ProjectFileModel.updateOne({ _id: file._id }, { status: "processing" }).exec();

    let items:
      | Array<{
          userId: typeof job.userId;
          projectId: typeof job.projectId;
          fileId: typeof job.fileId;
          source: "cad" | "boq";
          item_code: string;
          description: string;
          notes: string;
          box: { left: number; top: number; right: number; bottom: number } | null;
          metadata?: {
            sheetName?: string;
            category?: string;
            subcategory?: string;
            rowIndex?: number;
            fields?: Record<string, string>;
          } | null;
        }>
      | [];

    if (file.fileType === "boq") {
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `Extracting BOQ items from ${file.originalName}.`,
      });
      const result = extractBoqItemsFromExcel({
        filePath: file.storedPath,
        fileName: file.originalName,
      });
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `BOQ extraction completed for ${file.originalName}.`,
      });
      await ProjectItemModel.deleteMany({
        projectId: job.projectId,
        fileId: job.fileId,
        source: "boq",
      }).exec();
      items = (result.items || []).map((item) => ({
        userId: job.userId,
        projectId: job.projectId,
        fileId: job.fileId,
        source: "boq" as const,
        item_code: item.item_code || "ITEM",
        description: item.description || "N/A",
        notes: item.notes || "N/A",
        box: null,
        metadata: item.metadata ?? null,
      }));
    } else {
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `Calling Gemini API for ${file.originalName}.`,
      });
      const result = await extractCadBoqItemsWithGemini({
        filePath: file.storedPath,
        fileName: file.originalName,
      });
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `Gemini response received for ${file.originalName}.`,
      });

      await ProjectItemModel.deleteMany({
        projectId: job.projectId,
        fileId: job.fileId,
        source: "cad",
      }).exec();

      items = (result.items || []).map((item) => ({
        userId: job.userId,
        projectId: job.projectId,
        fileId: job.fileId,
        source: "cad" as const,
        item_code: item.item_code || "NOTE",
        description: item.description || "N/A",
        notes: item.notes || "N/A",
        box: item.box ?? null,
      }));
    }

    if (items.length > 0) {
      await ProjectItemModel.insertMany(items);
    }

    await ProjectFileModel.updateOne({ _id: file._id }, { status: "ready" }).exec();
    await createProjectLog({
      userId: String(job.userId),
      projectId: String(job.projectId),
      fileId: String(job.fileId),
      message: `Extraction completed for ${file.originalName} (${items.length} items).`,
    });
    await ProjectExtractJobModel.updateOne(
      { _id: job._id },
      {
        status: "done",
        stage: "finalizing",
        message: "Completed",
        error: null,
        finishedAt: new Date(),
      }
    ).exec();
  } catch (error) {
    await ProjectFileModel.updateOne({ _id: file._id }, { status: "failed" }).exec();
    await createProjectLog({
      userId: String(job.userId),
      projectId: String(job.projectId),
      fileId: String(job.fileId),
      level: "error",
      message: `Extraction failed for ${file.originalName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    await ProjectExtractJobModel.updateOne(
      { _id: job._id },
      {
        status: "failed",
        stage: "finalizing",
        message: "Failed",
        error: { message: error instanceof Error ? error.message : String(error) },
        finishedAt: new Date(),
      }
    ).exec();
  } finally {
    await updateProjectStatusIfIdle(String(job.projectId));
  }
}

export function startProjectExtractionWorker(): void {
  const tick = async () => {
    while (inFlightJobs.size < MAX_CONCURRENCY) {
      const job = await claimNextJob();
      if (!job) return;
      const jobId = String(job._id);
      inFlightJobs.add(jobId);
      processJob(jobId)
        .catch(() => undefined)
        .finally(() => {
          inFlightJobs.delete(jobId);
        });
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}
