import path from "path";
import fs from "fs/promises";
import { extractTextFromDocx, extractTextFromPdf, extractTextFromTxt } from "./textExtractor";
import { AttributeMap, ExtractedItem } from "../../types/build";
import { extractAttributesWithOpenAI } from "./openaiExtractor";

export async function parseDocument(filePath: string): Promise<{
  attributes: AttributeMap;
  items: ExtractedItem[];
  totalPrice?: string;
}> {
  const extension = path.extname(filePath).toLowerCase();
  let rawText = "";

  // Extract text from the document (only used for OpenAI processing)
  if (extension === ".pdf") {
    rawText = await extractTextFromPdf(filePath);
  } else if (extension === ".docx") {
    rawText = await extractTextFromDocx(filePath);
  } else if (extension === ".txt") {
    rawText = await extractTextFromTxt(filePath);
  } else {
    rawText = await fs.readFile(filePath, "utf-8");
  }

  // Use ONLY OpenAI to extract attributes with prices
  const openAIResult = await extractAttributesWithOpenAI(rawText, path.basename(filePath));
  
  if (!openAIResult.attributes || Object.keys(openAIResult.attributes).length === 0) {
    throw new Error("Failed to extract attributes from the document");
  }

  return {
    attributes: openAIResult.attributes,
    items: openAIResult.items,
    totalPrice: openAIResult.totalPrice,
  };
}

