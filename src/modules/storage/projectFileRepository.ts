import { Types } from "mongoose";
import {
  ProjectFileDocument,
  ProjectFileModel,
  ProjectFileStatus,
  ProjectFileType,
} from "./projectFileModel";

export async function createProjectFiles(params: {
  userId: string;
  projectId: string;
  files: Array<{
    originalName: string;
    storedPath: string;
    storedName: string;
    fileType: ProjectFileType;
    status?: ProjectFileStatus;
  }>;
}): Promise<ProjectFileDocument[]> {
  if (!Types.ObjectId.isValid(params.userId) || !Types.ObjectId.isValid(params.projectId)) {
    throw new Error("Invalid project or user id");
  }
  const payload = params.files.map((file) => ({
    userId: params.userId,
    projectId: params.projectId,
    originalName: file.originalName,
    storedPath: file.storedPath,
    storedName: file.storedName,
    fileType: file.fileType,
    status: file.status ?? "pending",
  }));
  return ProjectFileModel.insertMany(payload);
}

export async function listProjectFiles(
  userId: string,
  projectId: string
): Promise<ProjectFileDocument[]> {
  if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(projectId)) return [];
  return ProjectFileModel.find({ userId, projectId }).sort({ createdAt: 1 }).exec();
}

export async function findProjectFileById(
  userId: string,
  projectId: string,
  fileId: string
): Promise<ProjectFileDocument | null> {
  if (
    !Types.ObjectId.isValid(userId) ||
    !Types.ObjectId.isValid(projectId) ||
    !Types.ObjectId.isValid(fileId)
  ) {
    return null;
  }
  return ProjectFileModel.findOne({ _id: fileId, userId, projectId }).exec();
}

export async function updateProjectFileStatus(
  userId: string,
  projectId: string,
  fileId: string,
  status: ProjectFileStatus
): Promise<ProjectFileDocument | null> {
  if (
    !Types.ObjectId.isValid(userId) ||
    !Types.ObjectId.isValid(projectId) ||
    !Types.ObjectId.isValid(fileId)
  ) {
    return null;
  }
  return ProjectFileModel.findOneAndUpdate(
    { _id: fileId, userId, projectId },
    { status },
    { new: true }
  ).exec();
}

export async function removeProjectFile(
  userId: string,
  projectId: string,
  fileId: string
): Promise<ProjectFileDocument | null> {
  if (
    !Types.ObjectId.isValid(userId) ||
    !Types.ObjectId.isValid(projectId) ||
    !Types.ObjectId.isValid(fileId)
  ) {
    return null;
  }
  return ProjectFileModel.findOneAndDelete({ _id: fileId, userId, projectId }).exec();
}