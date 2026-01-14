import path from "path";
import * as XLSX from "xlsx";

export type PriceListRow = Record<string, string | number>;

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const priceSheetPath = path.join(projectRoot, "data", "Pricing Sheet.xlsx");
const PRICE_LIST_CACHE_MS = 5 * 60 * 1000; // 5 minutes

type CacheKey = "clean" | "raw";

type SheetCacheKey = `${CacheKey}:${string}`;

const priceListCache: Partial<Record<SheetCacheKey, { data: PriceListRow[]; loadedAt: number }>> = {};

interface LoadPriceListOptions {
    /**
     * When true (default) header names are trimmed and newlines are replaced.
     * When false, headers are kept exactly as they appear in the sheet.
     */
    cleanHeaders?: boolean;
}

function normaliseHeaders(headers: Array<string | number | null | undefined>, cleanHeaders: boolean): string[] {
    return headers.map((header, idx) => {
        const base = header === null || header === undefined ? "" : typeof header === "string" ? header : String(header);
        if (!cleanHeaders) return base || `col_${idx + 1}`;
        const cleaned = base.replace(/\r?\n/g, " ").trim();
        return cleaned || `col_${idx + 1}`;
    });
}

export async function loadPriceList(options: LoadPriceListOptions = {}, sheetName = "Price List"): Promise<PriceListRow[]> {
    const cleanHeaders = options.cleanHeaders !== false;
    const cacheKey: SheetCacheKey = `${cleanHeaders ? "clean" : "raw"}:${sheetName}`;
    const now = Date.now();

    const cached = priceListCache[cacheKey];
    if (cached && now - cached.loadedAt < PRICE_LIST_CACHE_MS) {
        return cached.data;
    }

    const workbook = XLSX.readFile(priceSheetPath);
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
        throw new Error(`Sheet '${sheetName}' not found in Pricing Sheet.xlsx`);
    }

    const rows = XLSX.utils.sheet_to_json<Array<string | number | null | undefined>>(sheet, {
        header: 1,
        defval: "",
        raw: true,
    });

    const [rawHeaders = [], ...dataRows] = rows;
    const headers = normaliseHeaders(rawHeaders, cleanHeaders);

    const data = dataRows
        .filter((row) => Array.isArray(row) && row.some((cell) => cell !== "" && cell !== null && cell !== undefined))
        .map((row) => {
            const obj: PriceListRow = {};
            headers.forEach((key, idx) => {
                const cell = (row as Array<string | number | null | undefined>)[idx];
                if (cell === null || cell === undefined) {
                    obj[key] = "";
                } else if (typeof cell === "number") {
                    obj[key] = cell;
                } else {
                    // Preserve the cell text as-is (no trimming) when requested by the caller.
                    obj[key] = String(cell);
                }
            });
            return obj;
        });

    priceListCache[cacheKey] = { data, loadedAt: now };
    return data;
}


