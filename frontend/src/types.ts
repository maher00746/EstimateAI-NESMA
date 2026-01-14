export interface AttributeValue {
  value: string;
  price?: string;
}

export type EstimateStep = "upload" | "review" | "compare" | "finalize" | "pricing" | "estimate";

export interface ExtractedItem {
  landing_ai_id?: string | null;
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

export type InstallationLocation = "riyadh" | "remote";

export interface InstallationInputs {
  workers: string;
  engineers: string;
  supervisors: string;
  location: InstallationLocation;
}

// Support both old format (string) and new format (object with value and price)
export type AttributeMap = Record<string, string | AttributeValue>;

export type ItemSource = "drawing" | "boq" | "manual";

export interface BuildSummary {
  id: string;
  requestId: string;
  originalName: string;
  createdAt: string;
  attributes: AttributeMap;
  totalPrice?: string;
  link_to_file: string;
}

export interface CandidateMatch {
  id: string;
  fileName?: string;
  filePath?: string;
  metadata?: Record<string, unknown>;
  attributes: AttributeMap;
  score?: number;
}

export type ComparisonStatus =
  | "match_exact"
  | "match_quantity_diff"
  | "match_unit_diff"
  | "match_size_diff"
  | "missing_in_boq"
  | "missing_in_drawing"
  | "no_match";

export interface BoqComparisonRow {
  drawing_item?: ExtractedItem | null;
  boq_item?: ExtractedItem | null;
  status: ComparisonStatus;
  note?: string;
}

export interface BoqCompareResponse {
  boqItems: ExtractedItem[];
  comparisons: BoqComparisonRow[];
  rawContent?: string;
}

export interface DraftFinalizeItem {
  item: ExtractedItem;
  source: ItemSource;
}

export interface DraftEstimateState {
  activeEstimateStep: EstimateStep;
  reviewStepActive: boolean;
  extractedFiles: Array<{ fileName: string; items: ExtractedItem[]; totalPrice?: string }>;
  boqResults: { boqItems: ExtractedItem[]; comparisons: BoqComparisonRow[] };
  comparisonSelections: Record<number, "drawing" | "boq" | "">;
  comparisonChecked: Record<number, boolean>;
  selectedDrawingRows?: Record<string, boolean>;
  selectedBoqRows?: Record<string, boolean>;
  finalizeItems: DraftFinalizeItem[];
  pricingSelections: Array<{ source: ItemSource; item: ExtractedItem }>;
  pricingMatchOptions?: Record<number, PriceMapping[]>;
  pricingMatchChoice?: Record<number, number>;
  selectedBoqFileName?: string;
  electricalItems?: Array<{ item: string; price: string; qty: string }>;
  installationItems?: Array<{ item: string; price: string; qty: string }>;
  venueItems?: Array<{ item: string; price: string; qty: string }>;
  atgRow?: {
    description: string;
    qty: string;
    unit: string;
    unitPrice: string;
    totalPrice: string;
    unitManhour: string;
    totalManhour: string;
  };
  electricalRow?: {
    description: string;
    qty: string;
    unit: string;
    unitPrice: string;
    totalPrice: string;
    unitManhour: string;
    totalManhour: string;
  };
  electricalInputs?: Record<string, string>;
  installationInputs?: InstallationInputs;
}

export interface EstimateDraftMeta {
  id: string;
  name: string;
  step: EstimateStep;
  updatedAt: string;
  createdAt: string;
}

export interface EstimateDraft extends EstimateDraftMeta {
  state: DraftEstimateState;
}

export interface PriceListRow {
  [key: string]: string | number;
}

export interface PriceMapping {
  item_index: number;
  price_list_index: number;
  unit_price?: string | number;
  unit_manhour?: string | number;
  price_row?: Record<string, string | number>;
  note?: string;
}

export interface AtgTotals {
  totalSellingPrice: number | string;
  totalManhour: number | string;
}

export interface ElectricalTotals {
  totalPrice: number | string;
  manhour: number | string;
}

export interface ElectricalCalcRequest {
  a2?: number;
  x: number;
  y: number;
  z: number;
  cValues: Array<number>;
}

export interface ElectricalCalcResponse {
  totalPrice: number;
  totalManhours: number;
}

