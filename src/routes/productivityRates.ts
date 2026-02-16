import { Router } from "express";
import type { Response, NextFunction, Express } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { AuthRequest } from "../middleware/auth";
import {
  getProductivityRates,
  upsertProductivityRates,
} from "../modules/storage/productivityRatesRepository";
import { config } from "../config";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSize },
});

function getUserId(req: AuthRequest): string {
  const user = req.user;
  if (!user?._id) throw new Error("User not found");
  return String(user._id);
}

router.get("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const record = await getProductivityRates(userId);
    if (!record) {
      return res.status(200).json({ factor: "1", blocks: [], updatedAt: null });
    }
    res.status(200).json({
      factor: record.factor ?? "1",
      blocks: record.blocks ?? [],
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const { factor, blocks } = req.body ?? {};
    if (typeof factor !== "string" || !Array.isArray(blocks)) {
      return res.status(400).json({ message: "factor and blocks are required" });
    }
    const saved = await upsertProductivityRates(userId, { factor, blocks });
    res.status(200).json({
      factor: saved.factor ?? "1",
      blocks: saved.blocks ?? [],
      updatedAt: saved.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

const toStringValue = (value: unknown) => (value === null || value === undefined ? "" : String(value));

const normalizeManpowerRows = (
  rows: unknown,
  blockIndex: number
): { rows: Array<{ id: string; label: string; quantity: string }>; error?: string } => {
  if (!Array.isArray(rows)) {
    return { rows: [], error: `blocks[${blockIndex}].manpowerRows must be an array` };
  }
  const normalized = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return null;
    }
    const data = row as Record<string, unknown>;
    const id = typeof data.id === "string" && data.id.trim() ? data.id : randomUUID();
    return {
      id,
      label: toStringValue(data.label),
      quantity: toStringValue(data.quantity),
    };
  });
  if (normalized.some((row) => row === null)) {
    return { rows: [], error: `blocks[${blockIndex}].manpowerRows must contain objects` };
  }
  return { rows: normalized as Array<{ id: string; label: string; quantity: string }> };
};

const normalizeEquipmentRows = (
  rows: unknown,
  blockIndex: number,
  defaults: { hoursPerDay: string; dailyProductivity: string }
): { rows: Array<{ id: string; label: string; quantity: string; hourlyRate: string; hoursPerDay: string; dailyProductivity: string; mh: string; rate: string }>; error?: string } => {
  if (!Array.isArray(rows)) {
    return { rows: [], error: `blocks[${blockIndex}].equipmentRows must be an array` };
  }
  const normalized = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return null;
    }
    const data = row as Record<string, unknown>;
    const id = typeof data.id === "string" && data.id.trim() ? data.id : randomUUID();
    const rowHours = data.hoursPerDay;
    const rowProductivity = data.dailyProductivity;
    return {
      id,
      label: toStringValue(data.label),
      quantity: toStringValue(data.quantity),
      hourlyRate: toStringValue(data.hourlyRate),
      hoursPerDay:
        rowHours === null || rowHours === undefined || rowHours === ""
          ? defaults.hoursPerDay
          : String(rowHours),
      dailyProductivity:
        rowProductivity === null || rowProductivity === undefined || rowProductivity === ""
          ? defaults.dailyProductivity
          : String(rowProductivity),
      mh: toStringValue(data.mh),
      rate: toStringValue(data.rate),
    };
  });
  if (normalized.some((row) => row === null)) {
    return { rows: [], error: `blocks[${blockIndex}].equipmentRows must contain objects` };
  }
  return {
    rows: normalized as Array<{
      id: string;
      label: string;
      quantity: string;
      hourlyRate: string;
      hoursPerDay: string;
      dailyProductivity: string;
      mh: string;
      rate: string;
    }>,
  };
};

router.post("/import", upload.single("file"), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ message: "file is required" });
    }
    const raw = file.buffer.toString("utf-8").trim();
    if (!raw) {
      return res.status(400).json({ message: "Uploaded file is empty" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(400).json({ message: "Invalid JSON file" });
    }

    const payload = parsed as Record<string, unknown> | unknown[];
    const blocksInput = Array.isArray(payload) ? payload : (payload as Record<string, unknown>)?.blocks;
    if (!Array.isArray(blocksInput)) {
      return res.status(400).json({ message: "JSON must be an array of blocks or an object with a blocks array" });
    }

    const factorValue = Array.isArray(payload) ? "1" : toStringValue((payload as Record<string, unknown>)?.factor ?? "1");
    const normalizedBlocks = [];
    for (let blockIndex = 0; blockIndex < blocksInput.length; blockIndex += 1) {
      const block = blocksInput[blockIndex];
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return res.status(400).json({ message: `blocks[${blockIndex}] must be an object` });
      }
      const data = block as Record<string, unknown>;
      const hoursPerDay = toStringValue(data.hoursPerDay);
      const dailyProductivity = toStringValue(data.dailyProductivity);
      const manpowerResult = normalizeManpowerRows(data.manpowerRows, blockIndex);
      if (manpowerResult.error) {
        return res.status(400).json({ message: manpowerResult.error });
      }
      const equipmentResult = normalizeEquipmentRows(data.equipmentRows, blockIndex, { hoursPerDay, dailyProductivity });
      if (equipmentResult.error) {
        return res.status(400).json({ message: equipmentResult.error });
      }
      normalizedBlocks.push({
        id: typeof data.id === "string" && data.id.trim() ? data.id : randomUUID(),
        code: toStringValue(data.code || String(blockIndex + 1)),
        description: toStringValue(data.description),
        unit: toStringValue(data.unit),
        hoursPerDay,
        dailyProductivity,
        manpowerRows: manpowerResult.rows,
        equipmentRows: equipmentResult.rows,
        manpowerMh: toStringValue(data.manpowerMh),
        manpowerRate: toStringValue(data.manpowerRate),
      });
    }

    const saved = await upsertProductivityRates(userId, { factor: factorValue, blocks: normalizedBlocks });
    res.status(200).json({
      factor: saved.factor ?? "1",
      blocks: saved.blocks ?? [],
      updatedAt: saved.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
