import path from "path";
import xlsx from "xlsx";
import { config } from "../../config";
import { getOpenAiClient } from "../openai/client";

export type BoqExtractionItem = {
  item_code: string;
  description: string;
  notes: string;
  metadata: {
    sheetName: string;
    category?: string;
    subcategory?: string;
    rowIndex: number;
    chunkIndex?: number;
    chunkCount?: number;
    fields: Record<string, string>;
  };
};

type BoqSheetItem = {
  item_key: string;
  description: string;
  notes: string;
  quantity: string;
  unit: string;
  rate: string;
  amount: string;
  category: string;
  subcategory: string;
  rowIndex: number;
};

const EXCEL_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);

const BOQ_SHEET_PROMPT = `You are a Senior Quantity Surveyor. You will receive rows from a BOQ Excel sheet.

Task:
- Identify BOQ item rows, category rows, and notes/instructions/details rows.
- Track categories as they appear in the sheet, then attach them to subsequent items.
- Include the rows that are notes/instructions/details that relate to an item or a group of items. The rows are in order, so return the row that contains any details or instructions as it is, as a separate row,
- Ignore ONLY irrelevant rows (e.g., headers with column titles or unrelated noise).
- Do NOT invent, reformat, or calculate anything.
- Preserve the exact text from the cells (including punctuation and spacing).
- Output JSON ONLY that matches the schema.

Rules:
1) Input rows are in order. Keep the output in the same order (CRITICAL), each extracted item should be in the same order as input.
2) A category row is usually a text-only row. Use its exact text as category.
3) A BOQ item row contains an item key (e.g., A, B, C ,1, 2 ..) and a description. It may also include quantity, unit, rate, and amount.
4) A notes/instructions/details rows are rows that contain notes/instructions/details that relate to an item or a group of items, they don't have qty or unit, just description,Don't drop them.
4) If a field is missing in the row, return an empty string for that field.
5) Do NOT include category-only or subcategory-only rows in the output; they only set context for the following items.
6) Do NOT return empty rows in the output (no description)

Return only a JSON object with this shape:
{
  "items": [
    {
      "item_key": "",
      "description": "",
      "notes": "",
      "quantity": "",
      "unit": "",
      "rate": "",
      "amount": "",
      "category": "",
      "rowIndex": 0
    }
  ]
}`;

const BOQ_SHEET_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      item_key: { type: "string" },
      description: { type: "string" },
      notes: { type: "string" },
      quantity: { type: "string" },
      unit: { type: "string" },
      rate: { type: "string" },
      amount: { type: "string" },
      category: { type: "string" },
      subcategory: { type: "string" },
      rowIndex: { type: "number" },
    },
    required: ["item_key", "description", "notes", "quantity", "unit", "rate", "amount", "category", "subcategory", "rowIndex"],
  },
};

function coerceCell(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "";
  return String(val);
}

function trimTrailingEmptyCells(cells: string[]): string[] {
  let lastIdx = cells.length - 1;
  while (lastIdx >= 0 && String(cells[lastIdx] ?? "").trim() === "") {
    lastIdx -= 1;
  }
  return cells.slice(0, lastIdx + 1);
}

function normalizeRows(
  rows: Array<{ rowIndex: number; row: Array<unknown> }>
): Array<{ rowIndex: number; cells: string[] }> {
  return rows
    .map((entry) => {
      const cells = Array.from({ length: entry.row?.length ?? 0 }, (_, col) => coerceCell(entry.row?.[col]));
      return { rowIndex: entry.rowIndex, cells: trimTrailingEmptyCells(cells) };
    })
    .filter((entry) => entry.cells.some((cell) => String(cell).trim() !== ""));
}

function stripEmptyColumns(rows: Array<{ rowIndex: number; cells: string[] }>): Array<{ rowIndex: number; cells: string[] }> {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  if (maxCols === 0) return rows;
  const nonEmptyCols = new Array<boolean>(maxCols).fill(false);
  rows.forEach((row) => {
    row.cells.forEach((cell, colIdx) => {
      if (String(cell).trim() !== "") {
        nonEmptyCols[colIdx] = true;
      }
    });
  });
  const keepIndices = nonEmptyCols
    .map((keep, idx) => (keep ? idx : -1))
    .filter((idx) => idx >= 0);
  if (keepIndices.length === maxCols) return rows;
  return rows.map((row) => ({
    rowIndex: row.rowIndex,
    cells: keepIndices.map((idx) => row.cells[idx] ?? ""),
  }));
}

function isRowEmpty(row: Array<unknown>): boolean {
  return row.every((cell) => String(coerceCell(cell)).trim() === "");
}

function splitRowsByEmptyRows(
  rows: Array<{ rowIndex: number; row: Array<unknown> }>,
  maxRowsPerChunk: number
): Array<Array<{ rowIndex: number; row: Array<unknown> }>> {
  if (rows.length === 0) return [];
  const chunks: Array<Array<{ rowIndex: number; row: Array<unknown> }>> = [];
  let startIdx = 0;
  let i = 0;
  let emptyStreak = 0;
  let lastSeparatorStart = -1;
  let lastSeparatorEnd = -1;

  while (i < rows.length) {
    if (isRowEmpty(rows[i].row)) {
      emptyStreak += 1;
      if (emptyStreak === 2) {
        lastSeparatorStart = i - 1;
      }
      if (emptyStreak >= 2) {
        lastSeparatorEnd = i;
      }
    } else {
      emptyStreak = 0;
    }

    const currentSize = i - startIdx + 1;
    if (currentSize >= maxRowsPerChunk && lastSeparatorStart >= startIdx) {
      chunks.push(rows.slice(startIdx, lastSeparatorStart));
      startIdx = lastSeparatorEnd + 1;
      emptyStreak = 0;
      lastSeparatorStart = -1;
      lastSeparatorEnd = -1;
      i = startIdx;
      continue;
    }

    i += 1;
  }

  if (startIdx < rows.length) {
    chunks.push(rows.slice(startIdx));
  }

  return chunks;
}

async function extractSheetWithOpenAi(params: {
  sheetName: string;
  rows: Array<{ rowIndex: number; cells: string[] }>;
}): Promise<{ items: BoqSheetItem[]; rawText: string }> {
  if (!config.openAiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const client = getOpenAiClient();
  const payloadText = JSON.stringify({ sheetName: params.sheetName, rows: params.rows });
  const prompt = `${BOQ_SHEET_PROMPT}\n\nSheet data (JSON):\n${payloadText}`;

  let response: unknown;
  try {
    response = await client.chat.completions.create({
      model: config.openAiModel,
      messages: [
        { role: "system", content: "Return only JSON and follow the specified schema." },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_completion_tokens: 20000,
      response_format: { type: "json_object" },
    });
  } catch (error) {
    const err = error as Error & { cause?: unknown };
    console.error("[OpenAI BOQ] generateContent failed", {
      message: err.message,
      cause: err.cause,
      model: config.openAiModel,
    });
    throw error;
  }

  const text = String((response as any)?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) {
    return { items: [], rawText: "" };
  }

  let parsed: BoqSheetItem[] = [];
  try {
    const maybe = JSON.parse(text);
    if (Array.isArray(maybe)) {
      parsed = maybe as BoqSheetItem[];
    } else if (Array.isArray((maybe as any)?.items)) {
      parsed = (maybe as any).items as BoqSheetItem[];
    }
  } catch {
    parsed = [];
  }

  return { items: parsed, rawText: text };
}

export async function extractBoqItemsFromExcel(params: {
  filePath: string;
  fileName: string;
  sheetNames?: string[];
  retryParts?: Record<string, number[]>;
  onSheetStage?: (info: {
    sheetName: string;
    stage: "calling" | "received" | "failed";
    itemCount?: number;
    errorMessage?: string;
    chunkIndex?: number;
    chunkCount?: number;
  }) => void | Promise<void>;
  onSheetResult?: (info: {
    sheetName: string;
    items: BoqSheetItem[];
    chunkIndex?: number;
    chunkCount?: number;
  }) => void | Promise<void>;
}): Promise<{ items: BoqExtractionItem[]; rawContent: string; sheetNames: string[] }> {
  const ext = path.extname(params.fileName).toLowerCase();
  if (!EXCEL_EXTENSIONS.has(ext)) {
    throw new Error("Unsupported BOQ file type. Please upload an Excel or CSV file.");
  }

  const workbook = xlsx.readFile(params.filePath, { cellDates: false, raw: false });
  const targetSheets = Array.isArray(params.sheetNames) && params.sheetNames.length > 0
    ? workbook.SheetNames.filter((name) => params.sheetNames?.includes(name))
    : workbook.SheetNames;

  const MAX_ROWS_PER_CHUNK = 350;
  const sheetResults = await Promise.all(
    targetSheets.map(async (sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        return { sheetName, items: [] as BoqSheetItem[], rawText: "" };
      }
      const rows = xlsx.utils.sheet_to_json<Array<unknown>>(sheet, {
        header: 1,
        defval: "",
        raw: false,
        blankrows: true,
      });
      if (!rows.length) {
        return { sheetName, items: [] as BoqSheetItem[], rawText: "" };
      }

      const indexedRows = rows.map((row, rowIndex) => ({ rowIndex, row }));
      const chunks =
        indexedRows.length > MAX_ROWS_PER_CHUNK
          ? splitRowsByEmptyRows(indexedRows, MAX_ROWS_PER_CHUNK)
          : [indexedRows];
      const chunkCount = chunks.length;
      const retryChunkIndices = params.retryParts?.[sheetName];
      const chunkTasks = chunks.map((chunkRows, chunkIndex) => ({ chunkRows, chunkIndex }))
        .filter((chunk) => {
          if (!retryChunkIndices) return true;
          if (retryChunkIndices.length === 0) return true;
          return retryChunkIndices.includes(chunk.chunkIndex);
        });

      const chunkResults: Array<{ partIndex: number; items: BoqSheetItem[]; rawText: string }> = [];
      for (const { chunkRows, chunkIndex } of chunkTasks) {
        const normalized = stripEmptyColumns(normalizeRows(chunkRows));
        await params.onSheetStage?.({ sheetName, stage: "calling", chunkIndex, chunkCount });
        try {
          const extracted = await extractSheetWithOpenAi({ sheetName, rows: normalized });
          await params.onSheetStage?.({
            sheetName,
            stage: "received",
            itemCount: extracted.items?.length ?? 0,
            chunkIndex,
            chunkCount,
          });
          await params.onSheetResult?.({
            sheetName,
            items: extracted.items ?? [],
            chunkIndex,
            chunkCount,
          });
          chunkResults.push({ partIndex: chunkIndex, ...extracted });
        } catch (error) {
          await params.onSheetStage?.({
            sheetName,
            stage: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            chunkIndex,
            chunkCount,
          });
          chunkResults.push({ partIndex: chunkIndex, items: [] as BoqSheetItem[], rawText: "" });
        }
      }

      const orderedChunks = [...chunkResults].sort((a, b) => a.partIndex - b.partIndex);
      const mergedItems = orderedChunks.flatMap((result) => result.items ?? []);
      const mergedRaw = orderedChunks.map((result) => result.rawText).filter(Boolean).join("\n\n");
      return { sheetName, items: mergedItems, rawText: mergedRaw };
    })
  );
  const items: BoqExtractionItem[] = [];

  sheetResults.forEach((result) => {
    const sheetName = result.sheetName;
    (result.items || []).forEach((item) => {
      const fields: Record<string, string> = {
        qty: item.quantity || "",
        quantity: item.quantity || "",
        unit: item.unit || "",
        rate: item.rate || "",
        amount: item.amount || "",
      };
      items.push({
        item_code: item.item_key || "ITEM",
        description: item.description || "",
        notes: item.notes || "",
        metadata: {
          sheetName,
          category: item.category || undefined,
          subcategory: item.subcategory || undefined,
          rowIndex: Number.isFinite(item.rowIndex) ? item.rowIndex : 0,
          fields,
        },
      });
    });
  });

  const rawContent = sheetResults.map((result) => result.rawText).filter(Boolean).join("\n\n");
  return { items, rawContent, sheetNames: targetSheets };
}
