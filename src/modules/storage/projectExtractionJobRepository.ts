import { Types } from "mongoose";
import {
  ProjectExtractJobDocument,
  ProjectExtractJobModel,
  ProjectExtractJobStatus,
} from "./projectExtractionJobModel";

export async function upsertProjectExtractJob(params: {
  userId: string;
  projectId: string;
  fileId: string;
  idempotencyKey: string;
  status?: ProjectExtractJobStatus;
}): Promise<ProjectExtractJobDocument> {
  if (
    !Types.ObjectId.isValid(params.userId) ||
    !Types.ObjectId.isValid(params.projectId) ||
    !Types.ObjectId.isValid(params.fileId)
  ) {
    throw new Error("Invalid project, file, or user id");
  }
  const updated = await ProjectExtractJobModel.findOneAndUpdate(
    {
      userId: params.userId,
      projectId: params.projectId,
      fileId: params.fileId,
      idempotencyKey: params.idempotencyKey,
    },
    {
      $setOnInsert: {
        status: params.status ?? "queued",
        stage: "queued",
        message: "Queued",
      },
    },
    { new: true, upsert: true }
  ).exec();
  if (!updated) {
    throw new Error("Failed to create extraction job");
  }
  return updated;
}

export async function listProjectExtractJobs(
  userId: string,
  projectId: string
): Promise<ProjectExtractJobDocument[]> {
  if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(projectId)) return [];
  return ProjectExtractJobModel.find({ userId, projectId }).sort({ createdAt: 1 }).exec();
}
