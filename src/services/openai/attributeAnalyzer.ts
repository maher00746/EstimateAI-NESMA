import { config } from "../../config";
import { extractJsonPayload, getOpenAiClient } from "./client";

export interface OpenAIAttributeAnalysis {
  attributes: Record<string, string>;
  totalPrice?: string;
  rawResponse: string;
}

export async function analyzeAttributesWithOpenAI(rawText: string): Promise<OpenAIAttributeAnalysis> {
  const client = getOpenAiClient();
  const prompt = `
You are an analytical assistant that extracts every attribute from a PC build document. 
The user will provide the raw text from a specification. Your response MUST be a single JSON object that looks like:
{
  "attributes": { "<attribute name>": "<value>", ... },
  "totalPrice": "<value including currency>"
}

Use normalized keys (always title case). Include the total price even if derived from a "Budget" or "Total" label. If the document doesn't provide a price, omit the field.
Do not add commentary outside the JSON. Here is the document:
${rawText}
  `.trim();

  const response = await client.chat.completions.create({
    model: config.openAiModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "You translate PC build documents into structured attribute maps.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content ?? "";
  const payload = extractJsonPayload(content);
  if (!payload) {
    throw new Error("Unable to parse OpenAI response");
  }

  const parsed = JSON.parse(payload) as {
    attributes?: Record<string, string>;
    totalPrice?: string;
  };

  return {
    attributes: parsed.attributes ?? {},
    totalPrice: parsed.totalPrice,
    rawResponse: content,
  };
}

