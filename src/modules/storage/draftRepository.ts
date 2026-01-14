import { Types } from "mongoose";
import { DraftDocument, DraftModel } from "./draftModel";

export interface DraftStatePayload {
  name: string;
  step: string;
  state: Record<string, unknown>;
}

export async function upsertDraft(
  payload: DraftStatePayload & { id?: string }
): Promise<DraftDocument> {
  if (payload.id) {
    if (!Types.ObjectId.isValid(payload.id)) {
      throw new Error("Invalid draft id");
    }
    const updated = await DraftModel.findByIdAndUpdate(
      payload.id,
      {
        name: payload.name,
        step: payload.step,
        state: payload.state,
      },
      { new: true, upsert: true }
    ).exec();
    if (!updated) {
      throw new Error("Failed to save draft");
    }
    return updated;
  }

  const draft = new DraftModel({
    name: payload.name,
    step: payload.step,
    state: payload.state,
  });
  return draft.save();
}

export async function listDrafts(): Promise<DraftDocument[]> {
  return DraftModel.find().sort({ updatedAt: -1 }).exec();
}

export async function findDraftById(id: string): Promise<DraftDocument | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return DraftModel.findById(id).exec();
}

export async function deleteDraft(id: string): Promise<void> {
  if (!Types.ObjectId.isValid(id)) return;
  await DraftModel.findByIdAndDelete(id).exec();
}

