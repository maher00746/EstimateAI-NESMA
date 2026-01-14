import mongoose, { Schema } from "mongoose";

export interface PromptDocument extends mongoose.Document {
  key: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

const PromptSchema = new Schema<PromptDocument>(
  {
    key: { type: String, required: true, unique: true, index: true },
    content: { type: String, required: true },
  },
  {
    timestamps: true,
  }
);

export const PromptModel =
  mongoose.models.Prompt ?? mongoose.model<PromptDocument>("Prompt", PromptSchema);


