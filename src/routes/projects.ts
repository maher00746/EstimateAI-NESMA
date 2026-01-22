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
  { name: "boq", maxCount: 1 },
]);

const router = Router();

function getUserId(req: AuthRequest): string {
  const user = req.user;
  if (!user?._id) throw new Error("User not found");
  return String(user._id);
}

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
      const boqFiles = Array.isArray((fileFields as any).boq)
        ? ((fileFields as any).boq as Express.Multer.File[])
        : [];

      if (drawings.length === 0 && boqFiles.length === 0) {
        return res.status(400).json({ message: "At least one file is required" });
      }

      const filesToCreate = [
        ...drawings.map((file) => ({
          originalName: file.originalname,
          storedPath: file.path,
          storedName: path.basename(file.path),
          fileType: "drawing" as const,
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

      res.status(200).json({
        project: {
          id: project._id,
          name: project.name,
          status: project.status,
        },
        files: createdFiles.map((file) => ({
          id: file._id,
          fileNo: createdFiles.findIndex((entry) => String(entry._id) === String(file._id)) + 1,
          fileName: file.originalName,
          fileUrl: `/files/${file.storedName}`,
          storedName: file.storedName,
          fileType: file.fileType,
          status: file.status,
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
        if (file.fileType !== "drawing" && file.fileType !== "boq") return false;
        if (!hasFileIds && requestedFileIds.length === 0) return true;
        return requestedFileIds.includes(String(file._id));
      });

      if (targetFiles.length === 0) {
        return res.status(200).json({ jobs: [] });
      }

      const jobs = await Promise.all(
        targetFiles.map(async (file) => {
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
        message: `Extraction started for ${targetFiles.length} file(s).`,
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
      if (file.fileType !== "drawing" && file.fileType !== "boq") {
        return res.status(400).json({ message: "Only drawing or BOQ files can be retried" });
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

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

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
          files: payload.files.map((file) => ({ id: file.id, status: file.status, updatedAt: file.updatedAt })),
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
      const { item_code, description, notes, box } = req.body ?? {};
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
      });
      res.status(200).json({
        id: item._id,
        fileId: item.fileId,
        source: item.source,
        item_code: item.item_code,
        description: item.description,
        notes: item.notes,
        box: item.box ?? null,
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
      const { item_code, description, notes, box } = req.body ?? {};
      const updated = await updateProjectItem({
        userId,
        projectId,
        itemId,
        updates: {
          ...(item_code ? { item_code } : {}),
          ...(description ? { description } : {}),
          ...(notes ? { notes } : {}),
          ...(box ? { box } : {}),
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
