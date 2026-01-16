import mongoose, { Schema } from "mongoose";

export type ProjectStatus = "in_progress" | "analyzing" | "finalized";

export interface ProjectDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSchema = new Schema<ProjectDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    name: { type: String, required: true },
    status: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

ProjectSchema.index({ userId: 1, updatedAt: -1 });

export const ProjectModel =
  mongoose.models.Project ?? mongoose.model<ProjectDocument>("Project", ProjectSchema);

export type { ProjectDocument };
