import { Types } from "mongoose";
import { ProjectItemDocument, ProjectItemModel } from "./projectItemModel";

export async function listProjectItems(userId: string, projectId: string): Promise<ProjectItemDocument[]> {
  if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(projectId)) return [];
  return ProjectItemModel.find({ userId, projectId }).sort({ createdAt: 1 }).exec();
}

export async function listProjectItemsByFile(
  userId: string,
  projectId: string,
  fileId: string
): Promise<ProjectItemDocument[]> {
  if (
    !Types.ObjectId.isValid(userId) ||
    !Types.ObjectId.isValid(projectId) ||
    !Types.ObjectId.isValid(fileId)
  ) {
    return [];
  }
  return ProjectItemModel.find({ userId, projectId, fileId }).sort({ createdAt: 1 }).exec();
}

export async function createProjectItem(params: {
  userId: string;
  projectId: string;
  fileId: string;
  source: "cad" | "manual" | "boq" | "schedule";
  item_code: string;
  description: string;
  notes: string;
  box?: { left: number; top: number; right: number; bottom: number } | null;
  metadata?: {
    sheetName?: string;
    sheetIndex?: number;
    category?: string;
    subcategory?: string;
    rowIndex?: number;
    chunkIndex?: number;
    chunkCount?: number;
    fields?: Record<string, string>;
  } | null;
}): Promise<ProjectItemDocument> {
  if (
    !Types.ObjectId.isValid(params.userId) ||
    !Types.ObjectId.isValid(params.projectId) ||
    !Types.ObjectId.isValid(params.fileId)
  ) {
    throw new Error("Invalid project, file, or user id");
  }
  const doc = new ProjectItemModel({
    userId: params.userId,
    projectId: params.projectId,
    fileId: params.fileId,
    source: params.source,
    item_code: params.item_code,
    description: params.description,
    notes: params.notes,
    box: params.box ?? null,
    metadata: params.metadata ?? null,
  });
  return doc.save();
}

export async function updateProjectItem(params: {
  userId: string;
  projectId: string;
  itemId: string;
  updates: Partial<{
    item_code: string;
    description: string;
    notes: string;
    box: { left: number; top: number; right: number; bottom: number } | null;
  }>;
}): Promise<ProjectItemDocument | null> {
  if (
    !Types.ObjectId.isValid(params.userId) ||
    !Types.ObjectId.isValid(params.projectId) ||
    !Types.ObjectId.isValid(params.itemId)
  ) {
    return null;
  }
  return ProjectItemModel.findOneAndUpdate(
    { _id: params.itemId, userId: params.userId, projectId: params.projectId },
    params.updates,
    { new: true }
  ).exec();
}

export async function deleteProjectItem(params: {
  userId: string;
  projectId: string;
  itemId: string;
}): Promise<void> {
  if (
    !Types.ObjectId.isValid(params.userId) ||
    !Types.ObjectId.isValid(params.projectId) ||
    !Types.ObjectId.isValid(params.itemId)
  ) {
    return;
  }
  await ProjectItemModel.findOneAndDelete({
    _id: params.itemId,
    userId: params.userId,
    projectId: params.projectId,
  }).exec();
}
