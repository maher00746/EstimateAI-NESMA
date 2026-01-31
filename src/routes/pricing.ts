import { Router } from "express";
import type { Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth";
import { getPricing, upsertPricing } from "../modules/storage/pricingRepository";
import {
  suggestProductivityForPricing,
  ProductivitySuggestBlock,
  ProductivitySuggestItem,
} from "../services/openai/productivitySuggest";

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
        qtyOverrideByItemId: {},
        collapsedByItemId: {},
        completedByItemId: {},
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
      qtyOverrideByItemId: record.qtyOverrideByItemId ?? {},
      collapsedByItemId: record.collapsedByItemId ?? {},
      completedByItemId: record.completedByItemId ?? {},
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
      qtyOverrideByItemId = {},
      collapsedByItemId = {},
      completedByItemId = {},
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
      qtyOverrideByItemId: typeof qtyOverrideByItemId === "object" && qtyOverrideByItemId ? qtyOverrideByItemId : {},
      collapsedByItemId: typeof collapsedByItemId === "object" && collapsedByItemId ? collapsedByItemId : {},
      completedByItemId: typeof completedByItemId === "object" && completedByItemId ? completedByItemId : {},
    });
    res.status(200).json({
      percentage: saved.percentage ?? "10",
      idleText: saved.idleText ?? "idle time",
      poRate: saved.poRate ?? "8",
      mpHourlyRate: saved.mpHourlyRate ?? "0",
      subItemsByItemId: saved.subItemsByItemId ?? {},
      autoRowQtyByItemId: saved.autoRowQtyByItemId ?? {},
      qtyOverrideByItemId: saved.qtyOverrideByItemId ?? {},
      collapsedByItemId: saved.collapsedByItemId ?? {},
      completedByItemId: saved.completedByItemId ?? {},
      updatedAt: saved.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/suggest-productivity", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { blocks, productivityItems } = req.body ?? {};
    if (!Array.isArray(blocks) || !Array.isArray(productivityItems)) {
      return res.status(400).json({ message: "blocks and productivityItems must be arrays" });
    }

    const normalizedItems: ProductivitySuggestItem[] = productivityItems
      .filter((item: unknown) => item && typeof item === "object")
      .map((item: any) => ({
        id: String(item.id ?? "").trim(),
        description: String(item.description ?? "").trim(),
      }))
      .filter((item) => item.id && item.description);

    const normalizedBlocks: ProductivitySuggestBlock[] = blocks
      .filter((block: unknown) => block && typeof block === "object")
      .map((block: any) => ({
        blockId: String(block.blockId ?? "").trim(),
        itemCode: String(block.itemCode ?? "").trim(),
        description: String(block.description ?? "").trim(),
        qty: String(block.qty ?? "").trim(),
        drawingDetails: Array.isArray(block.drawingDetails)
          ? block.drawingDetails.map((detail: unknown) => String(detail ?? "").trim()).filter(Boolean)
          : [],
        scheduleCodes: Array.isArray(block.scheduleCodes)
          ? block.scheduleCodes.map((code: unknown) => String(code ?? "").trim()).filter(Boolean)
          : [],
      }))
      .filter((block) => block.blockId && block.description);

    if (normalizedItems.length === 0) {
      return res.status(400).json({ message: "No valid productivityItems supplied" });
    }
    if (normalizedBlocks.length === 0) {
      return res.status(400).json({ message: "No valid blocks supplied" });
    }

    const response = await suggestProductivityForPricing(normalizedBlocks, normalizedItems);
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
});

export default router;
