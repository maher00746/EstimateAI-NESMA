import mongoose, { Schema } from "mongoose";

export interface ProjectComparisonDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  results: Array<{
    item_code: string;
    result: "matched" | "mismatch";
    reason: string;
  }>;
  stats?: {
    scheduleCodes: number;
    boqItems: number;
    drawingItems: number;
    comparableItems: number;
    chunks: number;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectComparisonSchema = new Schema<ProjectComparisonDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    projectId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "Project" },
    results: [
      {
        item_code: { type: String, required: true },
        result: { type: String, required: true },
        reason: { type: String, default: "" },
      },
    ],
    stats: {
      scheduleCodes: { type: Number },
      boqItems: { type: Number },
      drawingItems: { type: Number },
      comparableItems: { type: Number },
      chunks: { type: Number },
    },
  },
  { timestamps: true }
);

ProjectComparisonSchema.index({ userId: 1, projectId: 1 }, { unique: true });

export const ProjectComparisonModel =
  mongoose.models.ProjectComparison ??
  mongoose.model<ProjectComparisonDocument>("ProjectComparison", ProjectComparisonSchema);

export type { ProjectComparisonDocument };
