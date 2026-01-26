import mongoose, { Schema } from "mongoose";

export type ProjectFileType = "drawing" | "boq" | "schedule";
export type ProjectFileStatus = "pending" | "processing" | "ready" | "failed";

export interface ProjectFileDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  originalName: string;
  storedPath: string;
  storedName: string;
  fileType: ProjectFileType;
  status: ProjectFileStatus;
  boqSheetStatus?: Array<{
    sheetName: string;
    status: ProjectFileStatus;
    error?: string;
    parts?: Array<{
      index: number;
      status: ProjectFileStatus;
      error?: string;
    }>;
  }> | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectFileSchema = new Schema<ProjectFileDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    projectId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "Project" },
    originalName: { type: String, required: true },
    storedPath: { type: String, required: true },
    storedName: { type: String, required: true },
    fileType: { type: String, required: true, index: true },
    status: { type: String, required: true, index: true },
    boqSheetStatus: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

ProjectFileSchema.index({ projectId: 1, createdAt: 1 });

export const ProjectFileModel =
  mongoose.models.ProjectFile ?? mongoose.model<ProjectFileDocument>("ProjectFile", ProjectFileSchema);

export type { ProjectFileDocument };
