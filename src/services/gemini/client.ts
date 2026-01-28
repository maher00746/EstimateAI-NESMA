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

/**
 * Reset the cached Gemini client.
 * Call this when connection errors occur to force a fresh client on next use.
 */
export function resetGeminiClient(): void {
  cached = null;
}

/**
 * Check if a given error is a retryable network/connection error.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("socket") ||
    message.includes("aborted") ||
    message.includes("timeout")
  );
}

