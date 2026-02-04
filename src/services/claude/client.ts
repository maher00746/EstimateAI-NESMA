import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config";

let cached: Anthropic | null = null;

/**
 * Get or create a singleton Anthropic client instance.
 */
export function getClaudeClient(): Anthropic {
  if (cached) return cached;
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  cached = new Anthropic({ apiKey: config.anthropicApiKey });
  return cached;
}

/**
 * Reset the cached Claude client.
 * Call this when connection errors occur to force a fresh client on next use.
 */
export function resetClaudeClient(): void {
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
    message.includes("timeout") ||
    message.includes("rate_limit") ||
    message.includes("overloaded")
  );
}

/**
 * Beta header for Files API access.
 */
export const FILES_API_BETA = "files-api-2025-04-14";
