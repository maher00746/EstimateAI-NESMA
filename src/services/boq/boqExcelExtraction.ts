import path from "path";
import xlsx from "xlsx";

export type BoqExtractionItem = {
  item_code: string;
  description: string;
  notes: string;
  metadata: {
    sheetName: string;
    category?: string;
    subcategory?: string;
    rowIndex: number;
    fields: Record<string, string>;
  };
};

const EXCEL_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const HEADER_KEYWORDS = [
  "item",
  "item no",
  "item number",
  "item code",
  "code",
  "description",
  "desc",
  "unit",
  "uom",
  "qty",
  "quantity",
  "rate",
  "price",
  "unit price",
  "amount",
  "total",
  "remarks",
  "remark",
  "notes",
  "note",
  "category",
  "subcategory",
  "section",
  "division",
];

const ITEM_CODE_HEADERS = ["item no", "item number", "item code", "code", "no", "item"];
const DESCRIPTION_HEADERS = ["description", "desc", "item", "name", "scope", "material"];
const NOTES_HEADERS = ["remarks", "remark", "notes", "note", "spec", "specification"];
const QTY_HEADERS = ["qty", "quantity", "q'ty", "qnty"];
const UNIT_HEADERS = ["unit", "uom", "unit of measure"];
const CATEGORY_HEADERS = ["category", "section", "division"];
const SUBCATEGORY_HEADERS = ["subcategory", "sub-category", "sub section", "subsection", "sub division"];
const COMMON_UNITS = new Set([
  "m",
  "m2",
  "m3",
  "mm",
  "cm",
  "km",
  "ft",
  "in",
  "kg",
  "ton",
  "t",
  "nos",
  "no",
  "pc",
  "pcs",
  "ea",
  "each",
  "set",
  "lot",
  "l",
  "ls",
  "hr",
  "day",
]);

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function coerceString(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "";
  return String(val).trim();
}

function detectHeaderRow(rows: Array<Array<string>>): number {
  let bestIdx = -1;
  let bestScore = 0;
  const scanLimit = Math.min(rows.length, 40);
  for (let i = 0; i < scanLimit; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const normalized = row.map((cell) => normalizeHeader(coerceString(cell)));
    const nonEmpty = normalized.filter(Boolean).length;
    if (nonEmpty < 2) continue;
    const keywordMatches = normalized.filter((cell) => HEADER_KEYWORDS.includes(cell)).length;
    const score = keywordMatches * 2 + Math.min(nonEmpty, 6);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function buildHeaders(row: Array<string>): string[] {
  const headers: string[] = [];
  for (let i = 0; i < row.length; i += 1) {
    const raw = coerceString(row[i]);
    headers.push(raw || `Column ${i + 1}`);
  }
  return headers;
}

function pickColumnIndex(headers: string[], candidates: string[]): number {
  const normalized = headers.map((h) => normalizeHeader(h));
  return normalized.findIndex((h) => candidates.includes(h));
}

function isNumeric(value: string): boolean {
  if (!value) return false;
  const cleaned = value.replace(/[, ]+/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(cleaned);
}

function normalizeUnit(value: string): string {
  return normalizeHeader(value)
    .replace(/\u00b2/g, "2")
    .replace(/\u00b3/g, "3")
    .replace(/\s+/g, "")
    .replace(/\./g, "");
}

function isPlausibleUnit(value: string): boolean {
  if (!value) return false;
  const unit = normalizeUnit(value);
  return COMMON_UNITS.has(unit);
}

type ColumnStats = {
  nonEmpty: number;
  numeric: number;
  unit: number;
};

function computeColumnStats(rows: Array<Array<string>>, startRow: number, colCount: number): ColumnStats[] {
  const stats: ColumnStats[] = Array.from({ length: colCount }, () => ({
    nonEmpty: 0,
    numeric: 0,
    unit: 0,
  }));
  const scanLimit = Math.min(rows.length, startRow + 200);
  for (let r = startRow; r < scanLimit; r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < colCount; c += 1) {
      const value = coerceString(row[c]);
      if (!value) continue;
      stats[c].nonEmpty += 1;
      if (isNumeric(value)) stats[c].numeric += 1;
      if (isPlausibleUnit(value)) stats[c].unit += 1;
    }
  }
  return stats;
}

export function extractBoqItemsFromExcel(params: {
  filePath: string;
  fileName: string;
}): { items: BoqExtractionItem[]; rawContent: string } {
  const ext = path.extname(params.fileName).toLowerCase();
  if (!EXCEL_EXTENSIONS.has(ext)) {
    throw new Error("Unsupported BOQ file type. Please upload an Excel or CSV file.");
  }

  const workbook = xlsx.readFile(params.filePath, { cellDates: false, raw: false });
  const items: BoqExtractionItem[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = xlsx.utils.sheet_to_json<Array<string>>(sheet, {
      header: 1,
      defval: "",
      raw: false,
      blankrows: false,
    });
    if (!rows.length) continue;

    const headerRowIndex = detectHeaderRow(rows);
    const headerRow = headerRowIndex >= 0 ? rows[headerRowIndex] : rows[0];
    const headers = buildHeaders(headerRow);
    const maxCols = Math.max(...rows.map((row) => row.length));
    for (let i = headers.length; i < maxCols; i += 1) {
      headers.push(`Column ${i + 1}`);
    }
    const itemCodeIdx = pickColumnIndex(headers, ITEM_CODE_HEADERS);
    const descriptionIdx = pickColumnIndex(headers, DESCRIPTION_HEADERS);
    const notesIdx = pickColumnIndex(headers, NOTES_HEADERS);
    let qtyIdx = pickColumnIndex(headers, QTY_HEADERS);
    let unitIdx = pickColumnIndex(headers, UNIT_HEADERS);
    const categoryIdx = pickColumnIndex(headers, CATEGORY_HEADERS);
    const subcategoryIdx = pickColumnIndex(headers, SUBCATEGORY_HEADERS);

    let currentCategory = "";
    let currentSubcategory = "";
    const startRow = headerRowIndex >= 0 ? headerRowIndex + 1 : 1;
    const stats = computeColumnStats(rows, startRow, headers.length);

    const MIN_NON_EMPTY = 6;
    const NUMERIC_RATIO = 0.6;
    const UNIT_RATIO = 0.6;

    const numericRatio = (idx: number) =>
      stats[idx].nonEmpty > 0 ? stats[idx].numeric / stats[idx].nonEmpty : 0;
    const unitRatio = (idx: number) =>
      stats[idx].nonEmpty > 0 ? stats[idx].unit / stats[idx].nonEmpty : 0;

    if (qtyIdx >= 0 && (stats[qtyIdx].nonEmpty < MIN_NON_EMPTY || numericRatio(qtyIdx) < NUMERIC_RATIO)) {
      qtyIdx = -1;
    }
    if (unitIdx >= 0 && (stats[unitIdx].nonEmpty < MIN_NON_EMPTY || unitRatio(unitIdx) < UNIT_RATIO)) {
      unitIdx = -1;
    }

    if (qtyIdx < 0) {
      let bestIdx = -1;
      let bestScore = 0;
      stats.forEach((stat, idx) => {
        if (stat.nonEmpty < MIN_NON_EMPTY) return;
        const ratio = numericRatio(idx);
        if (ratio >= NUMERIC_RATIO && ratio > bestScore) {
          bestScore = ratio;
          bestIdx = idx;
        }
      });
      qtyIdx = bestIdx;
    }

    if (unitIdx < 0) {
      let bestIdx = -1;
      let bestScore = 0;
      stats.forEach((stat, idx) => {
        if (stat.nonEmpty < MIN_NON_EMPTY) return;
        const ratio = unitRatio(idx);
        if (ratio >= UNIT_RATIO && ratio > bestScore) {
          bestScore = ratio;
          bestIdx = idx;
        }
      });
      unitIdx = bestIdx;
    }

    for (let rowIndex = startRow; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || [];
      const values = headers.map((_, idx) => coerceString(row[idx]));
      const filledIndices = values
        .map((value, idx) => (value ? idx : -1))
        .filter((idx) => idx >= 0);
      if (filledIndices.length === 0) continue;

      const rowFields: Record<string, string> = {};
      headers.forEach((header, idx) => {
        const value = values[idx];
        if (value) rowFields[header] = value;
      });

      const rowCategory = categoryIdx >= 0 ? values[categoryIdx] : "";
      const rowSubcategory = subcategoryIdx >= 0 ? values[subcategoryIdx] : "";
      if (rowCategory) {
        currentCategory = rowCategory.trim();
        currentSubcategory = "";
      }
      if (rowSubcategory) {
        currentSubcategory = rowSubcategory.trim();
      }

      const itemCodeCandidate = itemCodeIdx >= 0 ? values[itemCodeIdx] : "";
      const descriptionCandidate =
        (descriptionIdx >= 0 ? values[descriptionIdx] : "") ||
        rowFields[headers.find((header) => rowFields[header]) || ""] ||
        "";
      const quantityCandidate = qtyIdx >= 0 ? values[qtyIdx] : "";
      const unitCandidate = unitIdx >= 0 ? values[unitIdx] : "";
      const notes = notesIdx >= 0 ? values[notesIdx] : "";

      const hasItemFields = Boolean(itemCodeCandidate || descriptionCandidate);
      const qtyHasValue = qtyIdx >= 0 && Boolean(quantityCandidate);
      const unitHasValue = unitIdx >= 0 && Boolean(unitCandidate);
      const hasQty = qtyIdx >= 0 ? isNumeric(quantityCandidate) : false;
      const hasUnit = unitIdx >= 0 ? isPlausibleUnit(unitCandidate) : false;

      if (!itemCodeCandidate && !qtyHasValue && !unitHasValue) {
        const label = values[filledIndices[0]].trim();
        if (!label) continue;
        if (!currentCategory || currentSubcategory) {
          currentCategory = label;
          currentSubcategory = "";
        } else {
          currentSubcategory = label;
        }
        continue;
      }

      if (!currentCategory && !currentSubcategory) continue;
      if (!hasItemFields) continue;
      if (qtyIdx >= 0 && qtyHasValue && !hasQty) continue;
      if (unitIdx >= 0 && unitHasValue && !hasUnit) continue;

      const item_code =
        itemCodeCandidate ||
        rowFields[headers[0]] ||
        `ITEM-${rowIndex + 1}`;
      const description = descriptionCandidate;

      items.push({
        item_code: item_code || `ITEM-${rowIndex + 1}`,
        description: description || "N/A",
        notes: notes || "N/A",
        metadata: {
          sheetName,
          category: currentCategory || undefined,
          subcategory: currentSubcategory || undefined,
          rowIndex,
          fields: rowFields,
        },
      });
    }
  }

  return { items, rawContent: "" };
}
