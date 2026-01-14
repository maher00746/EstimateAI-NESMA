import path from "path";
import * as XLSX from "xlsx";

export interface AtgTotals {
  totalSellingPrice: number;
  totalManhour: number;
}

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const priceSheetPath = path.join(projectRoot, "data", "Pricing Sheet.xlsx");
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

let cachedTotals: { data: AtgTotals; loadedAt: number } | null = null;

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export async function loadAtgTotals(): Promise<AtgTotals> {
  const now = Date.now();
  if (cachedTotals && now - cachedTotals.loadedAt < CACHE_MS) {
    return cachedTotals.data;
  }

  const workbook = XLSX.readFile(priceSheetPath);
  const sheet = workbook.Sheets["ATG"];
  if (!sheet) {
    throw new Error("Sheet 'ATG' not found in Pricing Sheet.xlsx");
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: true,
  });

  const dataRow =
    rows.find((row) => row["Total Selling Price"] !== undefined || row["Total Manhour"] !== undefined) ||
    rows[0] ||
    {};

  const totalSellingPrice = toNumber(dataRow["Total Selling Price"]) ?? 0;
  const totalManhour = toNumber(dataRow["Total Manhour"]) ?? 0;

  const data: AtgTotals = { totalSellingPrice, totalManhour };
  cachedTotals = { data, loadedAt: now };
  return data;
}

