import mongoose, { Schema } from "mongoose";

export type ProjectItemSource = "cad" | "manual" | "boq";

export type CadBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export interface ProjectItemDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  fileId: mongoose.Types.ObjectId;
  source: ProjectItemSource;
  item_code: string;
  description: string;
  notes: string;
  box?: CadBox | null;
  metadata?: {
    sheetName?: string;
    category?: string;
    subcategory?: string;
    rowIndex?: number;
    fields?: Record<string, string>;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const CadBoxSchema = new Schema<CadBox>(
  {
    left: { type: Number, required: true },
    top: { type: Number, required: true },
    right: { type: Number, required: true },
    bottom: { type: Number, required: true },
  },
  { _id: false }
);

const ProjectItemSchema = new Schema<ProjectItemDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    projectId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "Project" },
    fileId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "ProjectFile" },
    source: { type: String, required: true },
    item_code: { type: String, required: true },
    description: { type: String, required: true },
    notes: { type: String, required: true },
    box: { type: CadBoxSchema, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

ProjectItemSchema.index({ projectId: 1, fileId: 1 });

export const ProjectItemModel =
  mongoose.models.ProjectItem ?? mongoose.model<ProjectItemDocument>("ProjectItem", ProjectItemSchema);

export type { ProjectItemDocument };
