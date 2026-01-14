import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  deleteDraft,
  findDraftById,
  listDrafts,
  upsertDraft,
} from "../modules/storage/draftRepository";

const router = Router();

router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const drafts = await listDrafts();
    res.status(200).json(
      drafts.map((draft) => ({
        id: draft._id,
        name: draft.name,
        step: draft.step,
        updatedAt: draft.updatedAt,
        createdAt: draft.createdAt,
      }))
    );
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const draft = await findDraftById(req.params.id);
    if (!draft) {
      return res.status(404).json({ message: "Draft not found" });
    }
    res.status(200).json({
      id: draft._id,
      name: draft.name,
      step: draft.step,
      state: draft.state,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, name, step, state } = req.body ?? {};
    if (!name || !step || !state) {
      return res
        .status(400)
        .json({ message: "name, step, and state are required" });
    }
    const saved = await upsertDraft({ id, name, step, state });
    res.status(200).json({
      id: saved._id,
      name: saved.name,
      step: saved.step,
      state: saved.state,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteDraft(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

export default router;

