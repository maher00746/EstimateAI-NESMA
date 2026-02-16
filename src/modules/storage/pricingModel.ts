import mongoose, { Schema } from "mongoose";

export interface PricingDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  percentage: string;
  idleText: string;
  poRate: string;
  mpHourlyRate: string;
  subItemsByItemId: Record<string, unknown>;
  autoRowQtyByItemId: Record<string, unknown>;
  qtyOverrideByItemId: Record<string, unknown>;
  collapsedByItemId: Record<string, unknown>;
  completedByItemId: Record<string, unknown>;
  blockCodeByItemId: Record<string, unknown>;
  updatedAt: Date;
  createdAt: Date;
}

const PricingSchema = new Schema<PricingDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    projectId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "Project" },
    percentage: { type: String, default: "10" },
    idleText: { type: String, default: "idle time" },
    poRate: { type: String, default: "8" },
    mpHourlyRate: { type: String, default: "0" },
    subItemsByItemId: { type: Schema.Types.Mixed, default: {} },
    autoRowQtyByItemId: { type: Schema.Types.Mixed, default: {} },
    qtyOverrideByItemId: { type: Schema.Types.Mixed, default: {} },
    collapsedByItemId: { type: Schema.Types.Mixed, default: {} },
    completedByItemId: { type: Schema.Types.Mixed, default: {} },
    blockCodeByItemId: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

PricingSchema.index({ userId: 1, projectId: 1 }, { unique: true });

export const PricingModel =
  mongoose.models.Pricing ?? mongoose.model<PricingDocument>("Pricing", PricingSchema);
