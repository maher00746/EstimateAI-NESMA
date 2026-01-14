import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { getPromptByKey, upsertPrompt } from "../modules/storage/promptRepository";
import { DRAWING_EXTRACTION_PROMPT, getDrawingExtractionPrompt } from "../services/parsing/openaiExtractor";

const router = Router();
const DRAWING_PROMPT_KEY = "drawing-extraction";

router.get("/drawing-extraction", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stored = await getPromptByKey(DRAWING_PROMPT_KEY);
    const prompt = stored?.content?.trim() ? stored.content : DRAWING_EXTRACTION_PROMPT;
    res.status(200).json({
      key: DRAWING_PROMPT_KEY,
      prompt,
      updatedAt: stored?.updatedAt ?? null,
      isDefault: !stored,
    });
  } catch (error) {
    next(error);
  }
});

router.put("/drawing-extraction", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { prompt } = req.body ?? {};
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ message: "prompt is required" });
    }
    const saved = await upsertPrompt(DRAWING_PROMPT_KEY, prompt);
    const resolvedPrompt = await getDrawingExtractionPrompt();
    res.status(200).json({
      key: DRAWING_PROMPT_KEY,
      prompt: resolvedPrompt,
      updatedAt: saved.updatedAt,
      isDefault: false,
    });
  } catch (error) {
    next(error);
  }
});

export default router;


