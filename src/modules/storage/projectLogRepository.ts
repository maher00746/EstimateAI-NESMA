import { Types } from "mongoose";
import { ProjectLogDocument, ProjectLogLevel, ProjectLogModel } from "./projectLogModel";

export async function createProjectLog(params: {
  userId: string;
  projectId: string;
  fileId?: string | null;
  level?: ProjectLogLevel;
  message: string;
}): Promise<ProjectLogDocument> {
  if (!Types.ObjectId.isValid(params.userId) || !Types.ObjectId.isValid(params.projectId)) {
    throw new Error("Invalid project or user id");
  }
  const fileId =
    params.fileId && Types.ObjectId.isValid(params.fileId) ? params.fileId : null;
  const log = new ProjectLogModel({
    userId: params.userId,
    projectId: params.projectId,
    fileId,
    level: params.level ?? "info",
    message: params.message,
  });
  return log.save();
}

export async function listProjectLogs(params: {
  userId: string;
  projectId: string;
  limit?: number;
}): Promise<ProjectLogDocument[]> {
  if (!Types.ObjectId.isValid(params.userId) || !Types.ObjectId.isValid(params.projectId)) {
    return [];
  }
  const limit = Math.min(params.limit ?? 50, 200);
  return ProjectLogModel.find({ userId: params.userId, projectId: params.projectId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .exec();
}
