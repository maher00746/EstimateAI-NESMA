import { Document, Types } from "mongoose";

export interface AttributeValue {
  value: string;
  price?: string;
}

export interface ExtractedItem {
  section_code?: string;
  section_name?: string;
  item_no?: string;
  item_number?: string;
  item_type?: string;
  description?: string;
  capacity?: string;
  dimensions?: string;
  size?: string;
  quantity?: string;
  finishes?: string;
  unit?: string;
  remarks?: string;
  unit_price?: string;
  total_price?: string;
  location?: string;
  unit_manhour?: string;
  total_manhour?: string;
  full_description?: string;
}

// Support both old format (string) and new format (object with value and price)
export type AttributeMap = Record<string, string | AttributeValue>;

export interface BuildDocument extends Document {
  _id: Types.ObjectId;
  requestId: string;
  createdAt: Date;
  updatedAt: Date;
  originalName: string;
  filePath: string;
  attributes: AttributeMap;
  totalPrice?: string;
}

