import { GoogleGenAI } from "@google/genai";
import { config } from "../../config";

let cached: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (cached) return cached;
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  cached = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return cached;
}

