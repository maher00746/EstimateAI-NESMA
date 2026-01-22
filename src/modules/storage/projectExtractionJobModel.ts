import mongoose, { Schema } from "mongoose";

export type ProjectExtractJobStatus = "queued" | "processing" | "done" | "failed";

export type ProjectExtractJobStage = "queued" | "processing" | "gemini" | "finalizing";

export interface ProjectExtractJobDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  fileId: mongoose.Types.ObjectId;
  idempotencyKey: string;
  status: ProjectExtractJobStatus;
  stage?: ProjectExtractJobStage;
  message?: string;
  error?: { message: string; details?: unknown };
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectExtractJobSchema = new Schema<ProjectExtractJobDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    projectId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "Project" },
    fileId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "ProjectFile" },
    idempotencyKey: { type: String, required: true },
    status: { type: String, required: true, index: true },
    stage: { type: String },
    message: { type: String },
    error: { type: Schema.Types.Mixed, default: null },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true }
);

ProjectExtractJobSchema.index(
  { projectId: 1, fileId: 1, idempotencyKey: 1 },
  { unique: true }
);

ProjectExtractJobSchema.index({ projectId: 1, status: 1 });

export const ProjectExtractJobModel =
  mongoose.models.ProjectExtractJob ??
  mongoose.model<ProjectExtractJobDocument>("ProjectExtractJob", ProjectExtractJobSchema);

export type { ProjectExtractJobDocument };
