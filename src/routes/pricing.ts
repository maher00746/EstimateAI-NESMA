import { Router } from "express";
import type { Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth";
import { getPricing, upsertPricing } from "../modules/storage/pricingRepository";
import { listProjects } from "../modules/storage/projectRepository";
import { listProjectItems } from "../modules/storage/projectItemRepository";
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

/** Normalize for search: trim, lower case */
function normSearch(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

const SEARCH_BLOCKS_MAX = 500;
const SEARCH_BLOCKS_PAGE_SIZE_DEFAULT = 5;

/** Search blocks from other projects by block code and/or text (main item description). */
router.get("/search-blocks", async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = getUserId(req);
    const projectId = String(req.query.projectId ?? "").trim();
    const blockCode = normSearch(String(req.query.blockCode ?? ""));
    const text = normSearch(String(req.query.text ?? ""));
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? String(SEARCH_BLOCKS_PAGE_SIZE_DEFAULT)), 10) || SEARCH_BLOCKS_PAGE_SIZE_DEFAULT));

    if (!projectId) {
      return res.status(400).json({ message: "projectId is required" });
    }
    if (!blockCode && !text) {
      return res.status(200).json({ blocks: [], total: 0 });
    }

    const projects = await listProjects(userId);
    const otherProjects = projects.filter((p) => String(p._id) !== projectId);
    const blocks: Array<{
      projectId: string;
      projectName: string;
      itemId: string;
      description: string;
      subitems: Array<{ description: string; code: string; qty: string; thickness: number | null }>;
    }> = [];

    for (const proj of otherProjects) {
      if (blocks.length >= SEARCH_BLOCKS_MAX) break;
      const pid = String(proj._id);
      const [items, pricing] = await Promise.all([
        listProjectItems(userId, pid),
        getPricing(userId, pid),
      ]);
      const pricedItems = items.filter((item) => String(item.item_code ?? "").trim() !== "ITEM");
      const subItemsByItemId = (pricing?.subItemsByItemId ?? {}) as Record<
        string,
        Array<{ code?: string; description?: string; qty?: string; thickness?: number | null }>
      >;
      const blockCodeByItemId = (pricing?.blockCodeByItemId ?? {}) as Record<string, string>;

      for (const item of pricedItems) {
        if (blocks.length >= SEARCH_BLOCKS_MAX) break;
        const itemId = String(item._id);
        const subs = subItemsByItemId[itemId];
        if (!Array.isArray(subs) || subs.length === 0) continue;

        const mainDesc = String(item.description ?? "").trim();
        const blockCodeVal = normSearch(blockCodeByItemId[itemId] ?? "");

        const matchBlockCode = !blockCode || blockCodeVal === blockCode;
        const matchText = !text || mainDesc.toLowerCase().includes(text);
        if (!matchBlockCode || !matchText) continue;

        blocks.push({
          projectId: pid,
          projectName: proj.name ?? "Unnamed",
          itemId,
          description: mainDesc || "—",
          subitems: subs.map((s) => ({
            description: String(s.description ?? "").trim() || "—",
            code: String(s.code ?? "").trim() || "—",
            qty: String(s.qty ?? "").trim() || "—",
            thickness: s.thickness != null && Number.isFinite(s.thickness) ? s.thickness : null,
          })),
        });
      }
    }

    const total = blocks.length;
    const start = (page - 1) * pageSize;
    const pageBlocks = blocks.slice(start, start + pageSize);
    res.status(200).json({ blocks: pageBlocks, total });
  } catch (error) {
    next(error);
  }
});

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
        blockCodeByItemId: {},
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
      blockCodeByItemId: record.blockCodeByItemId ?? {},
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
      blockCodeByItemId = {},
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
      blockCodeByItemId: typeof blockCodeByItemId === "object" && blockCodeByItemId ? blockCodeByItemId : {},
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
      blockCodeByItemId: saved.blockCodeByItemId ?? {},
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
