import mongoose, { Schema } from "mongoose";
import { BuildDocument, AttributeMap } from "../../types/build";

const BuildSchema = new Schema<BuildDocument>(
  {
    requestId: { type: String, required: true, unique: true },
    originalName: { type: String, required: true },
    filePath: { type: String, required: true },
    attributes: { type: Schema.Types.Mixed as unknown as AttributeMap, default: {} },
    totalPrice: { type: String },
  },
  {
    timestamps: true,
  }
);

export const BuildModel = mongoose.models.Build ?? mongoose.model<BuildDocument>("Build", BuildSchema);

