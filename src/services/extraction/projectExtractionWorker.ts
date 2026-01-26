import { randomUUID } from "crypto";
import { ProjectExtractJobModel } from "../../modules/storage/projectExtractionJobModel";
import { ProjectFileModel } from "../../modules/storage/projectFileModel";
import { ProjectItemModel } from "../../modules/storage/projectItemModel";
import { ProjectModel } from "../../modules/storage/projectModel";
import { upsertProjectExtractJob } from "../../modules/storage/projectExtractionJobRepository";
import { createProjectLog } from "../../modules/storage/projectLogRepository";
import { extractCadBoqItemsWithGemini, extractDrawingDetailsWithGemini } from "../gemini/cadExtraction";
import { extractBoqItemsFromExcel } from "../boq/boqExcelExtraction";
import { extractScheduleItemsWithGemini } from "../openai/scheduleExtraction";

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

async function loadScheduleItemTokens(projectId: string): Promise<string[]> {
  const scheduleItems = await ProjectItemModel.find({
    projectId,
    source: "schedule",
  }).exec();
  const tokens = new Set<string>();
  const candidateKeys = ["CODE"];
  scheduleItems.forEach((item) => {
    const fields = (item.metadata?.fields ?? {}) as Record<string, string>;
    candidateKeys.forEach((key) => {
      const value = String(fields[key] ?? "").trim();
      if (value) tokens.add(value);
    });
  });
  return Array.from(tokens);
}

async function queuePendingDrawingsAfterScheduleReady(job: {
  userId: string;
  projectId: string;
}): Promise<void> {
  const scheduleFiles = await ProjectFileModel.find({
    projectId: job.projectId,
    fileType: "schedule",
  }).exec();
  if (scheduleFiles.length === 0) return;
  if (!scheduleFiles.every((file) => file.status === "ready")) return;
  const scheduleItemCount = await ProjectItemModel.countDocuments({
    projectId: job.projectId,
    source: "schedule",
  }).exec();
  if (scheduleItemCount === 0) return;

  const pendingDrawings = await ProjectFileModel.find({
    projectId: job.projectId,
    fileType: "drawing",
    status: "pending",
  }).exec();
  if (pendingDrawings.length === 0) return;

  const idempotencyKey = randomUUID();
  await Promise.all(
    pendingDrawings.map(async (file) => {
      const existingJob = await ProjectExtractJobModel.findOne({
        projectId: job.projectId,
        fileId: file._id,
        status: { $in: ["queued", "processing"] },
      }).exec();
      if (existingJob) return;
      await upsertProjectExtractJob({
        userId: job.userId,
        projectId: job.projectId,
        fileId: String(file._id),
        idempotencyKey,
      });
      await ProjectFileModel.updateOne({ _id: file._id }, { status: "pending" }).exec();
      await createProjectLog({
        userId: job.userId,
        projectId: job.projectId,
        fileId: String(file._id),
        message: `Queued extraction for ${file.originalName} after schedule completed.`,
      });
    })
  );
  await ProjectModel.updateOne({ _id: job.projectId }, { status: "analyzing" }).exec();
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
    if (file.status === "ready") {
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `Skipping extraction for ${file.originalName} (already ready).`,
      });
      await ProjectExtractJobModel.updateOne(
        { _id: job._id },
        {
          status: "done",
          stage: "finalizing",
          message: "Skipped (already ready)",
          error: null,
          finishedAt: new Date(),
        }
      ).exec();
      return;
    }

    await createProjectLog({
      userId: String(job.userId),
      projectId: String(job.projectId),
      fileId: String(job.fileId),
      message: `Starting extraction for ${file.originalName}.`,
    });
    await ProjectFileModel.updateOne({ _id: file._id }, { status: "processing" }).exec();

    type ProjectExtractedItem = {
      userId: typeof job.userId;
      projectId: typeof job.projectId;
      fileId: typeof job.fileId;
      source: "cad" | "boq" | "schedule";
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
    };
    let items: ProjectExtractedItem[] = [];
    let boqInsertedDuringExtraction = false;

    if (file.fileType === "boq") {
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `Extracting BOQ items from ${file.originalName}.`,
      });
      const existingSheetStatus = Array.isArray((file as any).boqSheetStatus)
        ? ((file as any).boqSheetStatus as Array<{
          sheetName: string;
          status: "pending" | "processing" | "ready" | "failed";
          error?: string;
          parts?: Array<{ index: number; status: "pending" | "processing" | "ready" | "failed"; error?: string }>;
        }>)
        : [];
      const failedSheets =
        file.status === "failed"
          ? existingSheetStatus.filter((entry) => entry.status === "failed").map((entry) => entry.sheetName)
          : [];
      const retrySheets = failedSheets.length > 0 ? failedSheets : undefined;
      const retryParts: Record<string, number[]> = {};
      failedSheets.forEach((sheetName) => {
        const entry = existingSheetStatus.find((sheet) => sheet.sheetName === sheetName);
        const failedParts = (entry?.parts ?? []).filter((part) => part.status === "failed").map((part) => part.index);
        if (failedParts.length > 0) {
          retryParts[sheetName] = failedParts;
        }
      });

      if (retrySheets && retrySheets.length > 0) {
        const hasRetryParts = Object.keys(retryParts).length > 0;
        if (hasRetryParts) {
          for (const [sheetName, partIndices] of Object.entries(retryParts)) {
            await ProjectItemModel.deleteMany({
              projectId: job.projectId,
              fileId: job.fileId,
              source: "boq",
              "metadata.sheetName": sheetName,
              "metadata.chunkIndex": { $in: partIndices },
            }).exec();
          }
        } else {
          await ProjectItemModel.deleteMany({
            projectId: job.projectId,
            fileId: job.fileId,
            source: "boq",
            "metadata.sheetName": { $in: retrySheets },
          }).exec();
        }
      } else {
        await ProjectItemModel.deleteMany({
          projectId: job.projectId,
          fileId: job.fileId,
          source: "boq",
        }).exec();
      }

      const collectedItems: ProjectExtractedItem[] = [];
      const sheetStatus = new Map<
        string,
        {
          status: "pending" | "processing" | "ready" | "failed";
          error?: string;
          parts: Map<number, { status: "pending" | "processing" | "ready" | "failed"; error?: string }>;
        }
      >();
      const result = await extractBoqItemsFromExcel({
        filePath: file.storedPath,
        fileName: file.originalName,
        sheetNames: retrySheets,
        retryParts: Object.keys(retryParts).length > 0 ? retryParts : undefined,
        onSheetStage: async ({ sheetName, stage, itemCount, errorMessage, chunkIndex, chunkCount }) => {
          const chunkLabel =
            typeof chunkIndex === "number" && typeof chunkCount === "number" && chunkCount > 1
              ? ` (part ${chunkIndex + 1}/${chunkCount})`
              : "";
          const entry = sheetStatus.get(sheetName) ?? {
            status: "pending" as const,
            parts: new Map<number, { status: "pending" | "processing" | "ready" | "failed"; error?: string }>(),
          };
          if (stage === "calling") {
            entry.status = "processing";
            if (typeof chunkIndex === "number") {
              entry.parts.set(chunkIndex, { status: "processing" });
            }
            sheetStatus.set(sheetName, entry);
            return;
          }
          if (stage === "received") {
            entry.status = "ready";
            if (typeof chunkIndex === "number") {
              entry.parts.set(chunkIndex, { status: "ready" });
            }
            sheetStatus.set(sheetName, entry);
            await createProjectLog({
              userId: String(job.userId),
              projectId: String(job.projectId),
              fileId: String(job.fileId),
              message: `OpenAI response received for BOQ sheet ${sheetName}${chunkLabel} (${itemCount ?? 0} items).`,
            });
            return;
          }
          entry.status = "failed";
          entry.error = errorMessage;
          if (typeof chunkIndex === "number") {
            entry.parts.set(chunkIndex, { status: "failed", error: errorMessage });
          }
          sheetStatus.set(sheetName, entry);
          await createProjectLog({
            userId: String(job.userId),
            projectId: String(job.projectId),
            fileId: String(job.fileId),
            level: "error",
            message: `OpenAI failed for BOQ sheet ${sheetName}${chunkLabel}${errorMessage ? `: ${errorMessage}` : ""}.`,
          });
        },
        onSheetResult: async ({ sheetName, items: sheetItems, chunkIndex, chunkCount }) => {
          const mapped = (sheetItems || []).map((item) => ({
            userId: job.userId,
            projectId: job.projectId,
            fileId: job.fileId,
            source: "boq" as const,
            item_code: item.item_key || "ITEM",
            description: item.description || "N/A",
            notes: item.notes || "N/A",
            box: null,
            metadata: {
              sheetName,
              category: item.category || undefined,
              subcategory: item.subcategory || undefined,
              rowIndex: Number.isFinite(item.rowIndex) ? item.rowIndex : 0,
              chunkIndex: typeof chunkIndex === "number" ? chunkIndex : undefined,
              chunkCount: typeof chunkCount === "number" ? chunkCount : undefined,
              fields: {
                qty: item.quantity || "",
                quantity: item.quantity || "",
                unit: item.unit || "",
                rate: item.rate || "",
                amount: item.amount || "",
              },
            },
          }));
          if (mapped.length > 0) {
            await ProjectItemModel.insertMany(mapped);
            boqInsertedDuringExtraction = true;
          }
          collectedItems.push(...mapped);
        },
      });
      items = collectedItems;

      const existingMap = new Map(
        existingSheetStatus.map((entry) => [entry.sheetName, entry])
      );
      const mergedSheetNames = new Set([
        ...existingSheetStatus.map((entry) => entry.sheetName),
        ...(result.sheetNames || []),
      ]);
      const sheetStatusArray = Array.from(mergedSheetNames).map((sheetName) => {
        const existing = existingMap.get(sheetName);
        const updated = sheetStatus.get(sheetName);
        const partsMap = new Map<number, { index: number; status: "pending" | "processing" | "ready" | "failed"; error?: string }>();
        (existing?.parts ?? []).forEach((part) => {
          partsMap.set(part.index, { index: part.index, status: part.status, error: part.error });
        });
        updated?.parts.forEach((part, index) => {
          partsMap.set(index, { index, status: part.status, error: part.error });
        });
        const parts = Array.from(partsMap.values()).sort((a, b) => a.index - b.index);
        const status = parts.length > 0
          ? parts.some((part) => part.status === "failed") ? "failed" : "ready"
          : (updated?.status ?? existing?.status ?? "ready");
        return {
          sheetName,
          status,
          ...(updated?.error || existing?.error ? { error: updated?.error ?? existing?.error } : {}),
          ...(parts.length > 0 ? { parts } : {}),
        };
      });
      const hasFailedSheets = sheetStatusArray.some((entry) => entry.status === "failed");
      await ProjectFileModel.updateOne(
        { _id: file._id },
        {
          status: hasFailedSheets ? "failed" : "ready",
          boqSheetStatus: sheetStatusArray,
        }
      ).exec();
    } else if (file.fileType === "schedule") {
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `Calling OpenAI for schedule extraction on ${file.originalName}.`,
      });
      const result = await extractScheduleItemsWithGemini({
        filePath: file.storedPath,
        fileName: file.originalName,
      });
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `OpenAI response received for schedule file ${file.originalName} (${result.items.length} items).`,
      });

      await ProjectItemModel.deleteMany({
        projectId: job.projectId,
        fileId: job.fileId,
        source: "schedule",
      }).exec();

      items = (result.items || []).map((item) => {
        const fields = { ...(item.fields ?? {}) };
        if (!fields.item_code) fields.item_code = item.item_code || "";
        if (!fields.description) fields.description = item.description || "";
        if (!fields.notes) fields.notes = item.notes || "";
        return {
          userId: job.userId,
          projectId: job.projectId,
          fileId: job.fileId,
          source: "schedule" as const,
          item_code: item.item_code || "ITEM",
          description: item.description || "N/A",
          notes: item.notes || "N/A",
          box: null,
          metadata: { fields },
        };
      });
    } else {
      const scheduleItems = await loadScheduleItemTokens(String(job.projectId));
      const filteredCodes = scheduleItems.filter((code) => code.length > 0 && code.length <= 80);
      const maxCodes = 300;
      const codesToSend = filteredCodes.length > maxCodes ? filteredCodes.slice(0, maxCodes) : filteredCodes;
      if (codesToSend.length === 0) {
        throw new Error("Schedule extraction is required before drawing extraction.");
      }
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `Sending ${codesToSend.length} schedule code(s) to Gemini for drawing extraction.`,
      });
      if (filteredCodes.length > maxCodes) {
        await createProjectLog({
          userId: String(job.userId),
          projectId: String(job.projectId),
          fileId: String(job.fileId),
          level: "warning",
          message: `Schedule code list truncated from ${filteredCodes.length} to ${maxCodes} items to keep the prompt within limits.`,
        });
      }
      const result = await extractDrawingDetailsWithGemini({
        filePath: file.storedPath,
        fileName: file.originalName,
        scheduleItems: codesToSend,
      });
      await createProjectLog({
        userId: String(job.userId),
        projectId: String(job.projectId),
        fileId: String(job.fileId),
        message: `Data received for ${file.originalName}.`,
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

    if (items.length > 0 && !(file.fileType === "boq" && boqInsertedDuringExtraction)) {
      await ProjectItemModel.insertMany(items);
    }

    if (file.fileType !== "boq") {
      await ProjectFileModel.updateOne({ _id: file._id }, { status: "ready" }).exec();
    }
    if (file.fileType === "schedule") {
      await queuePendingDrawingsAfterScheduleReady({
        userId: String(job.userId),
        projectId: String(job.projectId),
      });
    }
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
      message: `Extraction failed for ${file.originalName}: ${error instanceof Error ? error.message : String(error)
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
