import mongoose, { Schema } from "mongoose";

export interface ProductivityRatesDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  factor: string;
  blocks: unknown[];
  updatedAt: Date;
  createdAt: Date;
}

const ProductivityRatesSchema = new Schema<ProductivityRatesDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User", unique: true },
    factor: { type: String, default: "1" },
    blocks: { type: Schema.Types.Mixed, default: [] },
  },
  { timestamps: true }
);

export const ProductivityRatesModel =
  mongoose.models.ProductivityRates ??
  mongoose.model<ProductivityRatesDocument>("ProductivityRates", ProductivityRatesSchema);

export type { ProductivityRatesDocument };
