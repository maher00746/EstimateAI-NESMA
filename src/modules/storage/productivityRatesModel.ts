import mongoose, { Schema } from "mongoose";

export interface ProductivityRatesManpowerRow {
  id: string;
  label: string;
  quantity: string;
}

export interface ProductivityRatesEquipmentRow {
  id: string;
  label: string;
  quantity: string;
  hourlyRate?: string;
  hoursPerDay: string;
  dailyProductivity: string;
  mh?: string;
  rate?: string;
}

export interface ProductivityRatesBlock {
  id: string;
  description: string;
  unit: string;
  hoursPerDay: string;
  dailyProductivity: string;
  manpowerRows: ProductivityRatesManpowerRow[];
  equipmentRows: ProductivityRatesEquipmentRow[];
  manpowerMh?: string;
  manpowerRate?: string;
}

export interface ProductivityRatesDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  factor: string;
  blocks: ProductivityRatesBlock[];
  updatedAt: Date;
  createdAt: Date;
}

const ProductivityRatesManpowerRowSchema = new Schema<ProductivityRatesManpowerRow>(
  {
    id: { type: String, required: true },
    label: { type: String, default: "" },
    quantity: { type: String, default: "" },
  },
  { _id: false }
);

const ProductivityRatesEquipmentRowSchema = new Schema<ProductivityRatesEquipmentRow>(
  {
    id: { type: String, required: true },
    label: { type: String, default: "" },
    quantity: { type: String, default: "" },
    hourlyRate: { type: String, default: "" },
    hoursPerDay: { type: String, default: "" },
    dailyProductivity: { type: String, default: "" },
    mh: { type: String, default: "" },
    rate: { type: String, default: "" },
  },
  { _id: false }
);

const ProductivityRatesBlockSchema = new Schema<ProductivityRatesBlock>(
  {
    id: { type: String, required: true },
    description: { type: String, default: "" },
    unit: { type: String, default: "" },
    hoursPerDay: { type: String, default: "" },
    dailyProductivity: { type: String, default: "" },
    manpowerRows: { type: [ProductivityRatesManpowerRowSchema], default: [] },
    equipmentRows: { type: [ProductivityRatesEquipmentRowSchema], default: [] },
    manpowerMh: { type: String, default: "" },
    manpowerRate: { type: String, default: "" },
  },
  { _id: false }
);

const ProductivityRatesSchema = new Schema<ProductivityRatesDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User", unique: true },
    factor: { type: String, default: "1" },
    blocks: { type: [ProductivityRatesBlockSchema], default: [] },
  },
  { timestamps: true }
);

export const ProductivityRatesModel =
  mongoose.models.ProductivityRates ??
  mongoose.model<ProductivityRatesDocument>("ProductivityRates", ProductivityRatesSchema);

export type { ProductivityRatesDocument };
