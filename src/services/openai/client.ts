import OpenAI from "openai";
import { config } from "../../config";

let openAiClient: OpenAI | null = null;

export function getOpenAiClient(): OpenAI {
  if (!openAiClient) {
    if (!config.openAiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    openAiClient = new OpenAI({ apiKey: config.openAiKey });
  }
  return openAiClient;
}

export function extractJsonPayload(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.substring(start, end + 1);
}

