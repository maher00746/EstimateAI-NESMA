import { Types } from "mongoose";
import { ProjectDocument, ProjectModel, ProjectStatus } from "./projectModel";

export async function listProjects(userId: string): Promise<ProjectDocument[]> {
  if (!Types.ObjectId.isValid(userId)) return [];
  return ProjectModel.find({ userId }).sort({ updatedAt: -1 }).exec();
}

export async function findProjectById(
  userId: string,
  projectId: string
): Promise<ProjectDocument | null> {
  if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(projectId)) return null;
  return ProjectModel.findOne({ _id: projectId, userId }).exec();
}

export async function createProject(params: {
  userId: string;
  name: string;
  status?: ProjectStatus;
}): Promise<ProjectDocument> {
  if (!Types.ObjectId.isValid(params.userId)) {
    throw new Error("Invalid user id");
  }
  const project = new ProjectModel({
    userId: params.userId,
    name: params.name,
    status: params.status ?? "in_progress",
  });
  return project.save();
}

export async function updateProjectStatus(
  userId: string,
  projectId: string,
  status: ProjectStatus
): Promise<ProjectDocument | null> {
  if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(projectId)) return null;
  return ProjectModel.findOneAndUpdate(
    { _id: projectId, userId },
    { status },
    { new: true }
  ).exec();
}

export async function updateProjectName(
  userId: string,
  projectId: string,
  name: string
): Promise<ProjectDocument | null> {
  if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(projectId)) return null;
  return ProjectModel.findOneAndUpdate(
    { _id: projectId, userId },
    { name: name.trim() },
    { new: true }
  ).exec();
}
