import { Router } from "express";
import type { Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  getProductivityRates,
  upsertProductivityRates,
} from "../modules/storage/productivityRatesRepository";

const router = Router();

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

export default router;
