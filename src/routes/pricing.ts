import { Router } from "express";
import type { Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth";
import { getPricing, upsertPricing } from "../modules/storage/pricingRepository";

const router = Router();

function getUserId(req: AuthRequest): string {
  const user = req.user;
  if (!user?._id) throw new Error("User not found");
  return String(user._id);
}

router.get("/:projectId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) {
      return res.status(400).json({ message: "projectId is required" });
    }
    const record = await getPricing(userId, projectId);
    if (!record) {
      return res.status(200).json({
        percentage: "10",
        idleText: "idle time",
        poRate: "8",
        mpHourlyRate: "0",
        subItemsByItemId: {},
        autoRowQtyByItemId: {},
        updatedAt: null,
      });
    }
    res.status(200).json({
      percentage: record.percentage ?? "10",
      idleText: record.idleText ?? "idle time",
      poRate: record.poRate ?? "8",
      mpHourlyRate: record.mpHourlyRate ?? "0",
      subItemsByItemId: record.subItemsByItemId ?? {},
      autoRowQtyByItemId: record.autoRowQtyByItemId ?? {},
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.put("/:projectId", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projectId = String(req.params.projectId || "").trim();
    if (!projectId) {
      return res.status(400).json({ message: "projectId is required" });
    }
    const {
      percentage = "10",
      idleText = "idle time",
      poRate = "8",
      mpHourlyRate = "0",
      subItemsByItemId = {},
      autoRowQtyByItemId = {},
    } = req.body ?? {};
    if (typeof percentage !== "string" || typeof idleText !== "string" || typeof poRate !== "string" || typeof mpHourlyRate !== "string") {
      return res.status(400).json({ message: "percentage, idleText, poRate, mpHourlyRate must be strings" });
    }
    const saved = await upsertPricing(userId, projectId, {
      percentage,
      idleText,
      poRate,
      mpHourlyRate,
      subItemsByItemId: typeof subItemsByItemId === "object" && subItemsByItemId ? subItemsByItemId : {},
      autoRowQtyByItemId: typeof autoRowQtyByItemId === "object" && autoRowQtyByItemId ? autoRowQtyByItemId : {},
    });
    res.status(200).json({
      percentage: saved.percentage ?? "10",
      idleText: saved.idleText ?? "idle time",
      poRate: saved.poRate ?? "8",
      mpHourlyRate: saved.mpHourlyRate ?? "0",
      subItemsByItemId: saved.subItemsByItemId ?? {},
      autoRowQtyByItemId: saved.autoRowQtyByItemId ?? {},
      updatedAt: saved.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
