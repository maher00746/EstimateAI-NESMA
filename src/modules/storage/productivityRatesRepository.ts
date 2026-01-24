import { Types } from "mongoose";
import { ProductivityRatesDocument, ProductivityRatesModel } from "./productivityRatesModel";

export interface ProductivityRatesPayload {
  factor: string;
  blocks: unknown[];
}

export async function getProductivityRates(userId: string): Promise<ProductivityRatesDocument | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  return ProductivityRatesModel.findOne({ userId }).exec();
}

export async function upsertProductivityRates(
  userId: string,
  payload: ProductivityRatesPayload
): Promise<ProductivityRatesDocument> {
  if (!Types.ObjectId.isValid(userId)) {
    throw new Error("Invalid user id");
  }
  const updated = await ProductivityRatesModel.findOneAndUpdate(
    { userId },
    { factor: payload.factor, blocks: payload.blocks },
    { new: true, upsert: true }
  ).exec();
  if (!updated) {
    throw new Error("Failed to save productivity rates");
  }
  return updated;
}
