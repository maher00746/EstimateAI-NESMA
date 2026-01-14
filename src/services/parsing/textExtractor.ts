import fs from "fs/promises";
import mammoth from "mammoth";

type PdfParserInstance = {
  getText: () => Promise<{ text?: string }>;
  destroy: () => Promise<void>;
};

type PdfParserConstructor = new (options: { data: Buffer }) => PdfParserInstance;

let cachedPdfParser: PdfParserConstructor | null = null;

function resolvePdfParseClass(): PdfParserConstructor {
  if (cachedPdfParser) return cachedPdfParser;
  const pkg = require("pdf-parse");
  const PdfParseClass =
    (pkg && typeof pkg.PDFParse === "function"
      ? pkg.PDFParse
      : typeof pkg.default === "function"
      ? pkg.default
      : null) as unknown as PdfParserConstructor | null;

  if (!PdfParseClass) {
    throw new Error("pdf-parse module did not expose a parser class");
  }

  cachedPdfParser = PdfParseClass;
  return cachedPdfParser;
}

export async function extractTextFromPdf(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const ParserClass = resolvePdfParseClass();
  const parser = new ParserClass({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  return result.text ?? "";
}

export async function extractTextFromDocx(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value ?? "";
}

export async function extractTextFromTxt(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  return content;
}

