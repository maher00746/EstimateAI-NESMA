import { Router } from "express";
import type { Express, Request, Response, NextFunction } from "express";
import fs from "fs/promises";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "../config";
import { AuthRequest } from "../middleware/auth";
import {
  createProject,
  findProjectById,
  listProjects,
  updateProjectName,
  updateProjectStatus,
} from "../modules/storage/projectRepository";
import {
  createProjectFiles,
  findProjectFileById,
  listProjectFiles,
  removeProjectFile,
  updateProjectFileStatus,
} from "../modules/storage/projectFileRepository";
import {
  createProjectItem,
  deleteProjectItem,
  listProjectItems,
  listProjectItemsByFile,
  updateProjectItem,
} from "../modules/storage/projectItemRepository";
import { upsertProjectExtractJob } from "../modules/storage/projectExtractionJobRepository";
import { createProjectLog, listProjectLogs } from "../modules/storage/projectLogRepository";
import { ProjectFileModel } from "../modules/storage/projectFileModel";
import { ProjectExtractJobModel } from "../modules/storage/projectExtractionJobModel";
import { ProjectItemModel } from "../modules/storage/projectItemModel";
import { ProjectLogModel } from "../modules/storage/projectLogModel";
import { ProjectModel } from "../modules/storage/projectModel";
import { ProjectComparisonModel, type ProjectComparisonDocument } from "../modules/storage/projectComparisonModel";
import { compareProjectItemsWithOpenAI, BoqCompareGroup, DrawingCompareGroup, CompareResult } from "../services/openai/projectCompare";

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (_req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSize },
});

const projectUpload = upload.fields([
  { name: "drawings", maxCount: 20 },
  { name: "schedule", maxCount: 20 },
  { name: "boq", maxCount: 1 },
]);

const router = Router();

async function syncProjectStatusByJobs(userId: string, projectId: string): Promise<"finalized" | "analyzing"> {
  const pending = await ProjectExtractJobModel.countDocuments({
    projectId,
    status: { $in: ["queued", "processing"] },
  }).exec();
  const status = pending === 0 ? "finalized" : "analyzing";
  await updateProjectStatus(userId, projectId, status);
  return status;
}

function getUserId(req: AuthRequest): string {
  const user = req.user;
  if (!user?._id) throw new Error("User not found");
  return String(user._id);
}

const normalizeKey = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildCodeMatcher = (code: string): RegExp | null => {
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length < 2) return null;
  const tokens = trimmed.split(/[\s-]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const joined = tokens.map(escapeRegex).join("[\\s-]*");
  return new RegExp(`(^|[^A-Z0-9])${joined}(?=$|[^A-Z0-9])`);
};

const findBoqField = (fields: Record<string, string> | undefined, candidates: string[]): string => {
  if (!fields) return "";
  const key = Object.keys(fields).find((fieldKey) => candidates.includes(normalizeKey(fieldKey)));
  return key ? String(fields[key] ?? "") : "";
};

const extractScheduleCodes = (items: Array<{ item_code?: string; metadata?: { fields?: Record<string, string> } | null }>): string[] => {
  const codes = new Set<string>();
  items.forEach((item) => {
    const baseCode = String(item.item_code ?? "").trim();
    if (baseCode && baseCode.toUpperCase() !== "ITEM") {
      codes.add(baseCode);
    }
    const fields = item.metadata?.fields ?? {};
    Object.entries(fields).forEach(([key, value]) => {
      const normalized = normalizeKey(key);
      if (normalized.includes("code")) {
        const candidate = String(value ?? "").trim();
        if (candidate) codes.add(candidate);
      }
    });
  });
  return Array.from(codes.values());
};

router.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projects = await listProjects(userId);
    res.status(200).json(
      projects.map((project) => ({
        id: project._id,
        name: project.name,
        status: project.status,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      }))
    );
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const name = String(req.body?.name || "").trim();
    const resolvedName = name || `Project ${new Date().toLocaleString()}`;
    const project = await createProject({ userId, name: resolvedName });
    await createProjectLog({
      userId,
      projectId: String(project._id),
      message: `Project created: ${project.name}.`,
    });
    res.status(200).json({
      id: project._id,
      name: project.name,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:projectId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const project = await findProjectById(userId, req.params.projectId);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    res.status(200).json({
      id: project._id,
      name: project.name,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/:projectId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projectId = req.params.projectId;
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ message: "name is required" });
    }
    const updated = await updateProjectName(userId, projectId, name);
    if (!updated) {
      return res.status(404).json({ message: "Project not found" });
    }
    await createProjectLog({
      userId,
      projectId,
      message: `Project renamed to: ${updated.name}.`,
    });
    res.status(200).json({
      id: updated._id,
      name: updated.name,
      status: updated.status,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:projectId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projectId = req.params.projectId;
    const project = await findProjectById(userId, projectId);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    await Promise.all([
      ProjectFileModel.deleteMany({ userId, projectId }).exec(),
      ProjectExtractJobModel.deleteMany({ userId, projectId }).exec(),
      ProjectItemModel.deleteMany({ userId, projectId }).exec(),
      ProjectLogModel.deleteMany({ userId, projectId }).exec(),
    ]);
    await ProjectModel.deleteOne({ _id: projectId, userId }).exec();

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.post(
  "/:projectId/files",
  projectUpload,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const project = await findProjectById(userId, req.params.projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      const fileFields = (req.files ?? {}) as Record<string, unknown>;
      const drawings = Array.isArray((fileFields as any).drawings)
        ? ((fileFields as any).drawings as Express.Multer.File[])
        : [];
      const scheduleFiles = Array.isArray((fileFields as any).schedule)
        ? ((fileFields as any).schedule as Express.Multer.File[])
        : [];
      const boqFiles = Array.isArray((fileFields as any).boq)
        ? ((fileFields as any).boq as Express.Multer.File[])
        : [];

      if (drawings.length === 0 && scheduleFiles.length === 0 && boqFiles.length === 0) {
        return res.status(400).json({ message: "At least one file is required" });
      }

      const filesToCreate = [
        ...drawings.map((file) => ({
          originalName: file.originalname,
          storedPath: file.path,
          storedName: path.basename(file.path),
          fileType: "drawing" as const,
        })),
        ...scheduleFiles.map((file) => ({
          originalName: file.originalname,
          storedPath: file.path,
          storedName: path.basename(file.path),
          fileType: "schedule" as const,
        })),
        ...boqFiles.map((file) => ({
          originalName: file.originalname,
          storedPath: file.path,
          storedName: path.basename(file.path),
          fileType: "boq" as const,
        })),
      ];

      const createdFiles = await createProjectFiles({
        userId,
        projectId: String(project._id),
        files: filesToCreate,
      });

      await Promise.all(
        createdFiles.map((file) =>
          createProjectLog({
            userId,
            projectId: String(project._id),
            fileId: String(file._id),
            message: `Uploaded ${file.fileType} file: ${file.originalName}.`,
          })
        )
      );

      const projectStatus = await syncProjectStatusByJobs(userId, String(project._id));

      res.status(200).json({
        project: {
          id: project._id,
          name: project.name,
          status: projectStatus,
        },
        files: createdFiles.map((file) => ({
          id: file._id,
          fileNo: createdFiles.findIndex((entry) => String(entry._id) === String(file._id)) + 1,
          fileName: file.originalName,
          fileUrl: `/files/${file.storedName}`,
          storedName: file.storedName,
          fileType: file.fileType,
          status: file.status,
          claudeFileId: (file as any).claudeFileId ?? null,
          extractionStage: (file as any).extractionStage ?? null,
          boqSheetStatus: file.boqSheetStatus ?? null,
          createdAt: file.createdAt,
          updatedAt: file.updatedAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/:projectId/extractions/start",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const projectId = req.params.projectId;
      const project = await findProjectById(userId, projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      const idempotencyKey = String(req.get("Idempotency-Key") || randomUUID());
      const files = await listProjectFiles(userId, projectId);
      const requestBody = req.body ?? {};
      const hasFileIds = Object.prototype.hasOwnProperty.call(requestBody, "fileIds");
      const requestedFileIds = Array.isArray(requestBody.fileIds)
        ? requestBody.fileIds.map((id: unknown) => String(id))
        : [];
      const targetFiles = files.filter((file) => {
        if (file.fileType !== "drawing" && file.fileType !== "boq" && file.fileType !== "schedule") return false;
        if (!hasFileIds && requestedFileIds.length === 0) return true;
        return requestedFileIds.includes(String(file._id));
      });

      if (targetFiles.length === 0) {
        return res.status(200).json({ jobs: [] });
      }

      const isInitialRequest =
        hasFileIds && requestedFileIds.length > 0 && targetFiles.length === files.length;
      const scheduleFiles = targetFiles.filter((file) => file.fileType === "schedule");
      const drawingFiles = targetFiles.filter((file) => file.fileType === "drawing");
      const boqFiles = targetFiles.filter((file) => file.fileType === "boq");
      const scheduleItemCount = await ProjectItemModel.countDocuments({
        userId,
        projectId,
        source: "schedule",
      }).exec();
      const scheduleReady =
        scheduleItemCount > 0 ||
        (scheduleFiles.length > 0 && scheduleFiles.every((file) => file.status === "ready"));
      const filesToQueue = [...boqFiles, ...scheduleFiles];
      const blockedDrawings = drawingFiles.filter(() => !scheduleReady);

      if (blockedDrawings.length > 0) {
        if (isInitialRequest) {
          await Promise.all(
            blockedDrawings.map((file) =>
              createProjectLog({
                userId,
                projectId,
                fileId: String(file._id),
                message: `Drawing extraction will start after schedule extraction completes.`,
              })
            )
          );
        } else {
          await Promise.all(
            blockedDrawings.map(async (file) => {
              await updateProjectFileStatus(userId, projectId, String(file._id), "failed");
              await createProjectLog({
                userId,
                projectId,
                fileId: String(file._id),
                level: "warning",
                message: "Schedule extraction is required before drawing extraction. Upload schedule files and retry.",
              });
            })
          );
        }
      }

      if (scheduleReady) {
        filesToQueue.push(...drawingFiles);
      }

      if (filesToQueue.length === 0) {
        return res.status(200).json({ jobs: [] });
      }

      const jobs = await Promise.all(
        filesToQueue.map(async (file) => {
          const job = await upsertProjectExtractJob({
            userId,
            projectId,
            fileId: String(file._id),
            idempotencyKey,
          });
          if (file.status !== "ready") {
            await updateProjectFileStatus(userId, projectId, String(file._id), "pending");
          }
          await createProjectLog({
            userId,
            projectId,
            fileId: String(file._id),
            message: `Queued extraction for ${file.originalName}.`,
          });
          return {
            id: job._id,
            fileId: job.fileId,
            status: job.status,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
          };
        })
      );

      await updateProjectStatus(userId, projectId, "analyzing");
      await createProjectLog({
        userId,
        projectId,
        message: `Extraction started for ${filesToQueue.length} file(s).`,
      });

      res.status(200).json({ jobs });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/:projectId/files/:fileId/retry",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const { projectId, fileId } = req.params;
      const file = await findProjectFileById(userId, projectId, fileId);
      if (!file) {
        return res.status(404).json({ message: "File not found" });
      }
      if (file.fileType !== "drawing" && file.fileType !== "boq" && file.fileType !== "schedule") {
        return res.status(400).json({ message: "Only drawing, schedule, or BOQ files can be retried" });
      }
      if (file.fileType === "drawing") {
        const scheduleItemCount = await ProjectItemModel.countDocuments({
          userId,
          projectId,
          source: "schedule",
        }).exec();
        if (scheduleItemCount === 0) {
          return res.status(400).json({ message: "Upload and process schedule files before retrying drawings." });
        }
      }
      if (file.status !== "failed") {
        return res.status(400).json({ message: "File is not in failed state" });
      }

      const idempotencyKey = String(req.get("Idempotency-Key") || randomUUID());
      const job = await upsertProjectExtractJob({
        userId,
        projectId,
        fileId: String(file._id),
        idempotencyKey,
      });

      await updateProjectFileStatus(userId, projectId, String(file._id), "pending");
      await updateProjectStatus(userId, projectId, "analyzing");
      await createProjectLog({
        userId,
        projectId,
        fileId: String(file._id),
        message: `Retry extraction queued for ${file.originalName}.`,
      });

      res.status(200).json({
        id: job._id,
        fileId: job.fileId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/:projectId/files", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projectId = req.params.projectId;
    const project = await findProjectById(userId, projectId);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    const files = await listProjectFiles(userId, projectId);
    res.status(200).json(
      files.map((file, index) => ({
        id: file._id,
        fileNo: index + 1,
        fileName: file.originalName,
        fileUrl: `/files/${file.storedName}`,
        storedName: file.storedName,
        fileType: file.fileType,
        status: file.status,
        claudeFileId: (file as any).claudeFileId ?? null,
        extractionStage: (file as any).extractionStage ?? null,
        boqSheetStatus: file.boqSheetStatus ?? null,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      }))
    );
  } catch (error) {
    next(error);
  }
});

router.delete(
  "/:projectId/files/:fileId",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const { projectId, fileId } = req.params;
      const project = await findProjectById(userId, projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      const file = await findProjectFileById(userId, projectId, fileId);
      if (!file) {
        return res.status(404).json({ message: "File not found" });
      }

      await Promise.all([
        ProjectExtractJobModel.deleteMany({ userId, projectId, fileId }).exec(),
        ProjectItemModel.deleteMany({ userId, projectId, fileId }).exec(),
        ProjectLogModel.deleteMany({ userId, projectId, fileId }).exec(),
        removeProjectFile(userId, projectId, fileId),
      ]);

      if (file.storedPath) {
        await fs.rm(file.storedPath, { force: true });
      }

      await createProjectLog({
        userId,
        projectId,
        fileId,
        message: `File deleted: ${file.originalName}.`,
      });

      await syncProjectStatusByJobs(userId, projectId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

router.post("/:projectId/compare", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projectId = req.params.projectId;
    const project = await findProjectById(userId, projectId);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    const force = String(req.query.force ?? req.body?.force ?? "").toLowerCase();
    const shouldForce = force === "1" || force === "true" || force === "yes";

    if (!shouldForce) {
      const cached = await ProjectComparisonModel.findOne({ userId, projectId })
        .lean<ProjectComparisonDocument>()
        .exec();
      if (cached?.results?.length) {
        return res.status(200).json({
          results: cached.results,
          stats: cached.stats ?? null,
          cached: true,
          updatedAt: cached.updatedAt,
        });
      }
    }

    const items = await ProjectItemModel.find({ userId, projectId }).exec();
    const scheduleItems = items.filter((item) => item.source === "schedule");
    const boqItems = items.filter((item) => item.source === "boq");
    const drawingItems = items.filter((item) => item.source === "cad");

    const scheduleCodes = extractScheduleCodes(scheduleItems);
    const codeMatchers = scheduleCodes
      .map((code) => ({ code, matcher: buildCodeMatcher(code) }))
      .filter((entry) => entry.matcher !== null) as Array<{ code: string; matcher: RegExp }>;

    const boqGroupMap = new Map<string, BoqCompareGroup>();
    boqItems.forEach((item) => {
      const itemCode = String(item.item_code ?? "").trim();
      if (!itemCode || itemCode.toUpperCase() === "ITEM") return;
      const description = String(item.description ?? "").trim();
      if (!description) return;
      const matchedCodes = codeMatchers
        .filter(({ matcher }) => matcher.test(description.toUpperCase()))
        .map(({ code }) => code);
      if (matchedCodes.length === 0) return;

      const fields = (item.metadata?.fields ?? {}) as Record<string, string>;
      const qty = findBoqField(fields, ["qty", "quantity", "q'ty", "qnty"]);
      const unit = findBoqField(fields, ["unit", "uom", "unit of measure"]);

      matchedCodes.forEach((code) => {
        const entry = boqGroupMap.get(code) ?? { item_code: code, entries: [] };
        entry.entries.push({
          description,
          qty,
          unit,
        });
        boqGroupMap.set(code, entry);
      });
    });

    const boqGroups = Array.from(boqGroupMap.values());
    const drawingGroupMap = new Map<string, DrawingCompareGroup>();
    drawingItems.forEach((item) => {
      const code = String(item.item_code ?? "").trim();
      if (!code || code.toUpperCase() === "ITEM") return;
      const detail = [item.description, item.notes]
        .filter((value) => value && String(value).trim() && String(value).trim().toUpperCase() !== "N/A")
        .join(" • ");
      if (!detail.trim()) return;
      const group = drawingGroupMap.get(code) ?? { item_code: code, details: [] };
      if (!group.details.includes(detail)) {
        group.details.push(detail);
      }
      drawingGroupMap.set(code, group);
    });
    const drawingGroups = Array.from(drawingGroupMap.values());

    const statsPayload = {
      scheduleCodes: scheduleCodes.length,
      boqItems: boqItems.length,
      drawingItems: drawingItems.length,
      comparableItems: boqGroups.length,
      chunks: 0,
    };

    if (boqGroups.length === 0) {
      await ProjectComparisonModel.findOneAndUpdate(
        { userId, projectId },
        { results: [], stats: statsPayload },
        { new: true, upsert: true }
      ).exec();
      return res.status(200).json({
        results: [],
        stats: statsPayload,
        cached: false,
      });
    }

    const shouldSplit = boqGroups.length > 30;
    const chunks = shouldSplit
      ? [boqGroups.slice(0, Math.ceil(boqGroups.length / 2)), boqGroups.slice(Math.ceil(boqGroups.length / 2))]
      : [boqGroups];
    statsPayload.chunks = chunks.length;

    const normalizeCompareResult = (value: string): "matched" | "mismatch" => {
      const normalized = value.trim().toLowerCase();
      if (normalized === "mismatch" || normalized === "mismatched") return "mismatch";
      return "matched";
    };

    const resultsByCode = new Map<string, CompareResult>();
    await Promise.all(
      chunks.map(async (chunk) => {
        const codes = new Set(chunk.map((entry) => entry.item_code));
        const relevantDrawings = drawingGroups.filter((entry) => codes.has(entry.item_code));
        const response = await compareProjectItemsWithOpenAI(chunk, relevantDrawings);
        response.results.forEach((result) => {
          if (result?.item_code) {
            resultsByCode.set(result.item_code, {
              item_code: result.item_code,
              result: normalizeCompareResult(result.result ?? ""),
              reason: result.reason ?? "",
            });
          }
        });
      })
    );

    const orderedResults = boqGroups.map((group) => {
      const existing = resultsByCode.get(group.item_code);
      if (existing) return existing;
      return { item_code: group.item_code, result: "matched", reason: "" };
    });

    await ProjectComparisonModel.findOneAndUpdate(
      { userId, projectId },
      { results: orderedResults, stats: statsPayload },
      { new: true, upsert: true }
    ).exec();

    res.status(200).json({
      results: orderedResults,
      stats: statsPayload,
      cached: false,
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  "/:projectId/stream",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const projectId = req.params.projectId;
      const project = await findProjectById(userId, projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      let lastFingerprint = "";
      let closed = false;

      const buildPayload = async () => {
        const [files, items, logs] = await Promise.all([
          listProjectFiles(userId, projectId),
          listProjectItems(userId, projectId),
          listProjectLogs({ userId, projectId, limit: 10 }),
        ]);
        const fileIndex = new Map(
          files.map((file, idx) => [String(file._id), { fileNo: idx + 1, fileName: file.originalName }])
        );
        const payload = {
          files: files.map((file, index) => ({
            id: file._id,
            fileNo: index + 1,
            fileName: file.originalName,
            fileUrl: `/files/${file.storedName}`,
            storedName: file.storedName,
            fileType: file.fileType,
            status: file.status,
            claudeFileId: (file as any).claudeFileId ?? null,
            extractionStage: (file as any).extractionStage ?? null,
            boqSheetStatus: file.boqSheetStatus ?? null,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt,
          })),
          items: items.map((item) => {
            const meta = fileIndex.get(String(item.fileId));
            return {
              id: item._id,
              fileId: item.fileId,
              fileNo: meta?.fileNo ?? null,
              fileName: meta?.fileName ?? null,
              source: item.source,
              item_code: item.item_code,
              description: item.description,
              notes: item.notes,
              box: item.box ?? null,
              thickness: item.thickness ?? null,
              productivityRateId: item.productivityRateId ?? null,
              metadata: item.metadata ?? null,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            };
          }),
          logs: logs.map((log) => {
            const meta = log.fileId ? fileIndex.get(String(log.fileId)) : null;
            return {
              id: log._id,
              level: log.level,
              message: log.message,
              fileId: log.fileId ?? null,
              fileNo: meta?.fileNo ?? null,
              fileName: meta?.fileName ?? null,
              createdAt: log.createdAt,
            };
          }),
        };
        const fingerprint = JSON.stringify({
          files: payload.files.map((file) => ({
            id: file.id,
            status: file.status,
            extractionStage: file.extractionStage,
            updatedAt: file.updatedAt
          })),
          items: payload.items.map((item) => item.id),
          logs: payload.logs.map((log) => log.id),
        });
        return { payload, fingerprint };
      };

      const sendUpdate = async () => {
        if (closed) return;
        try {
          const { payload, fingerprint } = await buildPayload();
          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            res.write(`event: project-update\n`);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          } else {
            res.write(`: heartbeat\n\n`);
          }
        } catch (err) {
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ message: "Stream error" })}\n\n`);
        }
      };

      const interval = setInterval(() => {
        void sendUpdate();
      }, 3000);

      req.on("close", () => {
        closed = true;
        clearInterval(interval);
      });

      await sendUpdate();
    } catch (error) {
      next(error);
    }
  }
);

router.get("/:projectId/items", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projectId = req.params.projectId;
    const project = await findProjectById(userId, projectId);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    const [items, files] = await Promise.all([
      listProjectItems(userId, projectId),
      listProjectFiles(userId, projectId),
    ]);
    const fileIndex = new Map(
      files.map((file, idx) => [String(file._id), { fileNo: idx + 1, fileName: file.originalName }])
    );
    res.status(200).json(
      items.map((item) => {
        const fileMeta = fileIndex.get(String(item.fileId));
        return {
          id: item._id,
          fileId: item.fileId,
          fileNo: fileMeta?.fileNo ?? null,
          fileName: fileMeta?.fileName ?? null,
          source: item.source,
          item_code: item.item_code,
          description: item.description,
          notes: item.notes,
          box: item.box ?? null,
          thickness: item.thickness ?? null,
          productivityRateId: item.productivityRateId ?? null,
          metadata: item.metadata ?? null,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get(
  "/:projectId/files/:fileId/items",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const { projectId, fileId } = req.params;
      const file = await findProjectFileById(userId, projectId, fileId);
      if (!file) {
        return res.status(404).json({ message: "File not found" });
      }
      const items = await listProjectItemsByFile(userId, projectId, fileId);
      res.status(200).json(
        items.map((item) => ({
          id: item._id,
          fileId: item.fileId,
          source: item.source,
          item_code: item.item_code,
          description: item.description,
          notes: item.notes,
          box: item.box ?? null,
          thickness: item.thickness ?? null,
          productivityRateId: item.productivityRateId ?? null,
          metadata: item.metadata ?? null,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        }))
      );
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/:projectId/files/:fileId/items",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const { projectId, fileId } = req.params;
      const file = await findProjectFileById(userId, projectId, fileId);
      if (!file) {
        return res.status(404).json({ message: "File not found" });
      }
      const { item_code, description, notes, box, thickness, productivityRateId } = req.body ?? {};
      if (!item_code || !description || !notes) {
        return res.status(400).json({ message: "item_code, description, and notes are required" });
      }
      const item = await createProjectItem({
        userId,
        projectId,
        fileId,
        source: "manual",
        item_code,
        description,
        notes,
        box: box ?? null,
        thickness: typeof thickness === "number" ? thickness : null,
        productivityRateId: productivityRateId ?? null,
      });
      res.status(200).json({
        id: item._id,
        fileId: item.fileId,
        source: item.source,
        item_code: item.item_code,
        description: item.description,
        notes: item.notes,
        box: item.box ?? null,
        thickness: item.thickness ?? null,
        productivityRateId: item.productivityRateId ?? null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:projectId/items/:itemId",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const { projectId, itemId } = req.params;
      const { item_code, description, notes, box, thickness, productivityRateId } = req.body ?? {};
      const updated = await updateProjectItem({
        userId,
        projectId,
        itemId,
        updates: {
          ...(item_code ? { item_code } : {}),
          ...(description ? { description } : {}),
          ...(notes ? { notes } : {}),
          ...(box ? { box } : {}),
          ...(thickness !== undefined ? { thickness: typeof thickness === "number" ? thickness : null } : {}),
          ...(productivityRateId !== undefined ? { productivityRateId: productivityRateId || null } : {}),
        },
      });
      if (!updated) {
        return res.status(404).json({ message: "Item not found" });
      }
      res.status(200).json({
        id: updated._id,
        fileId: updated.fileId,
        source: updated.source,
        item_code: updated.item_code,
        description: updated.description,
        notes: updated.notes,
        box: updated.box ?? null,
        thickness: updated.thickness ?? null,
        productivityRateId: updated.productivityRateId ?? null,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  "/:projectId/items/:itemId",
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const { projectId, itemId } = req.params;
      await deleteProjectItem({ userId, projectId, itemId });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

export default router;
