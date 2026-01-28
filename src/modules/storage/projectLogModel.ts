import mongoose, { Schema } from "mongoose";

export type ProjectLogLevel = "info" | "warning" | "error";

export interface ProjectLogDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  fileId?: mongoose.Types.ObjectId | null;
  level: ProjectLogLevel;
  message: string;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectLogSchema = new Schema<ProjectLogDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    projectId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "Project" },
    fileId: { type: Schema.Types.ObjectId, default: null, index: true, ref: "ProjectFile" },
    level: { type: String, required: true },
    message: { type: String, required: true },
  },
  { timestamps: true }
);

ProjectLogSchema.index({ projectId: 1, createdAt: -1 });

export const ProjectLogModel =
  mongoose.models.ProjectLog ?? mongoose.model<ProjectLogDocument>("ProjectLog", ProjectLogSchema);
