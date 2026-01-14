import { BuildModel } from "./buildModel";
import { AttributeMap, BuildDocument } from "../../types/build";
import { Types } from "mongoose";

interface BuildPayload {
  requestId: string;
  originalName: string;
  filePath: string;
  attributes: AttributeMap;
  totalPrice?: string;
}

export async function saveBuild(payload: BuildPayload): Promise<BuildDocument> {
  const build = new BuildModel(payload);
  return build.save();
}

export async function findBuildById(id: string): Promise<BuildDocument | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return BuildModel.findById(id).exec();
}

export async function findBuildByRequestId(requestId: string): Promise<BuildDocument | null> {
  return BuildModel.findOne({ requestId }).exec();
}

interface ListOptions {
  excludeId?: string;
  limit?: number;
}

export async function listHistoricalBuilds(options: ListOptions = {}): Promise<BuildDocument[]> {
  const query = options.excludeId && Types.ObjectId.isValid(options.excludeId) ? { _id: { $ne: options.excludeId } } : {};
  const cursor = BuildModel.find(query).sort({ createdAt: -1 });
  if (options.limit) {
    cursor.limit(options.limit);
  }
  return cursor.exec();
}

export async function getTotalBuildCount(): Promise<number> {
  return BuildModel.countDocuments().exec();
}

