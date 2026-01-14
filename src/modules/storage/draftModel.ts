import mongoose, { Schema } from "mongoose";

interface DraftDocument extends mongoose.Document {
  name: string;
  step: string;
  state: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const DraftSchema = new Schema<DraftDocument>(
  {
    name: { type: String, required: true },
    step: { type: String, required: true },
    state: { type: Schema.Types.Mixed, required: true },
  },
  {
    timestamps: true,
  }
);

export const DraftModel =
  mongoose.models.Draft ?? mongoose.model<DraftDocument>("Draft", DraftSchema);

export type { DraftDocument };

