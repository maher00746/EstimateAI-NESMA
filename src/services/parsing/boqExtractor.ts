import path from "path";
import fs from "fs/promises";
import xlsx from "xlsx";
import { ExtractedItem } from "../../types/build";
import { extractTextFromPdf, extractTextFromDocx, extractTextFromTxt } from "./textExtractor";

const EXCEL_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function normalizeHeader(header: string): string {
    return header.trim().toLowerCase();
}

function pickColumn(headers: string[], candidates: string[]): string | undefined {
    return headers.find((h) => candidates.includes(normalizeHeader(h)));
}

function coerceString(val: unknown): string {
    if (val === undefined || val === null) return "";
    if (typeof val === "number") return String(val);
    return String(val).trim();
}

function extractTableFromWorksheet(worksheet: xlsx.WorkSheet): ExtractedItem[] {
    const rows = xlsx.utils.sheet_to_json<(string | number | null)[]>({
        header: 1,
        defval: "",
        raw: false,
        blankrows: false,
    });
    if (!rows.length) return [];

    const descKeywords = ["description", "item", "name", "scope", "material"];
    const qtyKeywords = ["qty", "quantity", "qnty", "q'ty"];
    const unitKeywords = ["unit", "uom"];
    const itemNoKeywords = ["item no", "item#", "item no.", "no", "item"];
    const sizeKeywords = ["size", "dimension", "diameter"];
    const capacityKeywords = ["capacity"];

    const normalize = (v: unknown) => coerceString(v).toLowerCase();

    const findHeaderIndex = () => {
        for (let i = 0; i < rows.length; i++) {
            const norm = rows[i].map(normalize);
            const hasDesc = norm.some((c) => descKeywords.includes(c));
            const hasQty = norm.some((c) => qtyKeywords.includes(c));
            const hasUnit = norm.some((c) => unitKeywords.includes(c));
            if (hasDesc && (hasQty || hasUnit)) return i;
        }
        return -1;
    };

    const headerIdx = findHeaderIndex();
    if (headerIdx === -1) return [];
    const header = rows[headerIdx].map(normalize);

    const findCol = (keywords: string[]) =>
        header.findIndex((h) => keywords.includes(h));

    const descCol = findCol(descKeywords);
    const qtyCol = findCol(qtyKeywords);
    const unitCol = findCol(unitKeywords);
    const itemCol = findCol(itemNoKeywords);
    const sizeCol = findCol(sizeKeywords);
    const capCol = findCol(capacityKeywords);

    if (descCol === -1) return [];

    const items: ExtractedItem[] = [];
    let emptyStreak = 0;

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const values = row.map(coerceString);
        const filled = values.filter(Boolean).length;
        if (filled === 0) {
            emptyStreak += 1;
            if (emptyStreak >= 3) break; // assume table ended
            continue;
        }
        emptyStreak = 0;

        const description = values[descCol] || "";
        const quantity = qtyCol !== -1 ? values[qtyCol] : "";
        const unit = unitCol !== -1 ? values[unitCol] : "";
        const item_number = itemCol !== -1 ? values[itemCol] : "";
        const size = sizeCol !== -1 ? values[sizeCol] : "";
        const capacity = capCol !== -1 ? values[capCol] : "";

        // Heuristic: require description or quantity to treat as item
        if (!description && !quantity) continue;
        items.push({
            item_number: item_number || undefined,
            description: description || undefined,
            quantity: quantity || undefined,
            unit: unit || undefined,
            size: size || undefined,
            capacity: capacity || undefined,
            full_description: [description, size, capacity, quantity && unit ? `${quantity} ${unit}` : quantity || unit].filter(Boolean).join(" | "),
        });
    }

    return items;
}

function extractFromWorksheet(fileName: string, worksheet: xlsx.WorkSheet): ExtractedItem[] {
    const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "" });
    if (rows.length === 0) return [];

    const headers = Object.keys(rows[0]).map(normalizeHeader);
    const headerMap = Object.keys(rows[0]).reduce<Record<string, string>>((acc, key, idx) => {
        acc[normalizeHeader(key)] = Object.keys(rows[0])[idx];
        return acc;
    }, {});

    const descriptionHeader = pickColumn(headers, ["description", "item", "name", "scope", "material"]) || Object.keys(rows[0])[0];
    const qtyHeader = pickColumn(headers, ["qty", "quantity", "qnty", "q'ty"]);
    const unitHeader = pickColumn(headers, ["unit", "uom"]);
    const itemNumberHeader = pickColumn(headers, ["item no", "item#", "item no.", "no", "item"]);

    return rows
        .map((row) => {
            const nonEmptyFields = Object.values(row).filter((v) => coerceString(v)).length;
            // Heuristic: skip rows that look like notes or standalone text (only one filled cell)
            if (nonEmptyFields <= 1) return null;

            const description = coerceString(row[headerMap[normalizeHeader(descriptionHeader)] ?? descriptionHeader]);
            const quantity = qtyHeader ? coerceString(row[headerMap[normalizeHeader(qtyHeader)] ?? qtyHeader]) : "";
            const unit = unitHeader ? coerceString(row[headerMap[normalizeHeader(unitHeader)] ?? unitHeader]) : "";
            const item_number = itemNumberHeader ? coerceString(row[headerMap[normalizeHeader(itemNumberHeader)] ?? itemNumberHeader]) : undefined;

            if (!description && !quantity && !unit) return null;

            return {
                item_number,
                description,
                quantity,
                unit,
                full_description: description,
            } as ExtractedItem;
        })
        .filter((row): row is ExtractedItem => Boolean(row));
}

async function extractBoqFromExcel(filePath: string, fileName: string): Promise<{ items: ExtractedItem[]; rawContent: string }> {
    const workbook = xlsx.readFile(filePath);
    const items: ExtractedItem[] = [];
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        const tableItems = extractTableFromWorksheet(sheet);
        if (tableItems.length) {
            items.push(...tableItems);
        } else {
            items.push(...extractFromWorksheet(fileName, sheet));
        }
    }
    return { items, rawContent: "" };
}

export async function parseBoqFile(filePath: string, originalName: string): Promise<{ items: ExtractedItem[]; rawContent?: string }> {
    const ext = path.extname(originalName).toLowerCase();

    if (EXCEL_EXTENSIONS.has(ext)) {
        return extractBoqFromExcel(filePath, originalName);
    }

    // For non-Excel, return empty (local extraction only)
    return { items: [], rawContent: "" };
}

