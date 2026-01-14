import path from "path";
import * as XLSX from "xlsx";

export interface ElectricalTotals {
  totalPrice: number;
  manhour: number;
}

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const priceSheetPath = path.join(projectRoot, "data", "Pricing Sheet.xlsx");
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

let cachedTotals: { data: ElectricalTotals; loadedAt: number } | null = null;

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}



function findElectricalSheet(workbook: XLSX.WorkBook): XLSX.WorkSheet | undefined {
  // Handle common typos/variants: "Elecrical ", "Elecrical", "Electrical"
  const target = "elecrical";
  const matchName = workbook.SheetNames.find((name) => {
    const normalized = name.trim().toLowerCase();
    return normalized === target || normalized.startsWith(target);
  });
  if (matchName) return workbook.Sheets[matchName];
  const fallbackNames = ["Elecrical ", "Elecrical", "Electrical"];
  for (const name of fallbackNames) {
    const sheet = workbook.Sheets[name];
    if (sheet) return sheet;
  }
  return undefined;
}

function firstNumeric(values: Array<unknown>): number | null {
  for (const v of values) {
    const n = toNumber(v);
    if (n !== null) return n;
  }
  return null;
}

export function calculateProjectCost(
  A2: number,
  I4: number,
  J4: number,
  K4: number,
  C5: number,
  C6: number,
  C7: number,
  C8: number,
  C9: number,
  C10: number,
  C11: number,
  C12: number,
  C13: number,
  C14: number,
  C15: number,
  C16: number,
  C17: number,
  C18: number,
  C19: number,
  C20: number,
  C21: number,
  C22: number,
  C23: number,
  C24: number,
  C25: number
): { totalPrice: number; totalManhours: number } {
  // Grouping Quantities
  const stPwr1_5Qty = C5 + C6;
  const stPwr1Qty = C24;
  const stSigQty = C7 + C8 + C9 + C10 + C25;

  const dtPwrQty = C11 + C12 + C13;
  const dtSigQty = C14 + C15 + C16 + C17 + C18 + C19 + C20 + C21 + C22;

  const fpPwrQty = C25; // reuse last as placeholder if needed
  const fpSigQty = C23;

  // Conduit Runs
  const runsSt1_5 = stPwr1_5Qty;
  const runsSt1 = stPwr1Qty + Math.ceil(stSigQty / 2);

  const runsDt1 = dtPwrQty + Math.ceil(dtSigQty / 2);
  const runsFp1 = fpPwrQty + Math.ceil(fpSigQty / 2);

  // Lengths
  const MULT = 1.5;

  const lenPwrCable =
    MULT * ((stPwr1_5Qty + stPwr1Qty) * I4 + dtPwrQty * J4 + fpPwrQty * K4);

  const lenSigCable = MULT * (stSigQty * I4 + dtSigQty * J4 + fpSigQty * K4);

  const lenCond1_5 = MULT * runsSt1_5 * I4;

  const lenCond1 = MULT * (runsSt1 * I4 + runsDt1 * J4 + runsFp1 * K4);

  // Costs
  const pricePwrCable = lenPwrCable * 16;
  const priceSigCable = Math.ceil(lenSigCable / 305) * 1000;
  const priceCond1_5 = lenCond1_5 * 30;
  const priceCond1 = lenCond1 * 20;

  const boxesSt = (runsSt1_5 + runsSt1) * (Math.ceil((I4 * MULT) / 10) + 1);
  const boxesDt = runsDt1 * (Math.ceil((J4 * MULT) / 10) + 1);
  const boxesFp = runsFp1 * (Math.ceil((K4 * MULT) / 10) + 1);

  const priceBoxes = (boxesSt + boxesDt + boxesFp) * 50;

  const baseTotalPrice = pricePwrCable + priceSigCable + priceCond1_5 + priceCond1 + priceBoxes;
  const totalTanks = Math.max(0, Number.isFinite(A2) ? A2 : 0);
  const tanksAdjustment =
    totalTanks === 1 ? -200 : totalTanks === 2 ? 0 : totalTanks >= 3 ? 200 * (totalTanks - 2) : 0;

  const totalPrice = baseTotalPrice + tanksAdjustment;
  const totalManhours = lenCond1_5 + lenCond1;

  return { totalPrice, totalManhours };
}

export async function loadElectricalTotals(): Promise<ElectricalTotals> {
  const now = Date.now();
  if (cachedTotals && now - cachedTotals.loadedAt < CACHE_MS) {
    return cachedTotals.data;
  }

  const workbook = XLSX.readFile(priceSheetPath);
  const sheet = findElectricalSheet(workbook);
  if (!sheet) {
    throw new Error("Sheet 'Elecrical' not found in Pricing Sheet.xlsx");
  }

  // Read as 2D array to reliably find column positions
  const matrix = XLSX.utils.sheet_to_json<Array<unknown>>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  });

  if (!matrix.length) {
    return { totalPrice: 0, manhour: 0 };
  }

  const headerRow = (matrix[0] || []) as Array<unknown>;
  const normalizeHeader = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const totalPriceCol = headerRow.findIndex((h) => /total\s*price/.test(normalizeHeader(h)));
  const manhourCol = headerRow.findIndex((h) => /(man\s*hour|manhour|mh)/.test(normalizeHeader(h)));

  let totalPrice: number | null = null;
  let manhour: number | null = null;

  for (const row of matrix.slice(1)) {
    const arr = row as Array<unknown>;
    if (totalPrice === null && totalPriceCol >= 0) {
      totalPrice = toNumber(arr[totalPriceCol]);
    }
    if (manhour === null) {
      if (manhourCol >= 0) {
        manhour = toNumber(arr[manhourCol]);
      } else if (totalPriceCol >= 0) {
        // Fallback: cell next to total price
        manhour = toNumber(arr[totalPriceCol + 1]);
      }
    }
    if (totalPrice !== null && manhour !== null) break;
  }

  // Fallback: scan all cells if still missing
  if (totalPrice === null || manhour === null) {
    const objectRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: true,
    });
    if (totalPrice === null) {
      totalPrice = firstNumeric(objectRows.map((r) => (r as any)["Total Price"]));
    }
    if (manhour === null) {
      manhour = firstNumeric(objectRows.map((r) => (r as any)["Manhour"]));
    }
  }

  const data: ElectricalTotals = {
    totalPrice: totalPrice ?? 0,
    manhour: manhour ?? 0,
  };
  cachedTotals = { data, loadedAt: now };
  return data;
}
