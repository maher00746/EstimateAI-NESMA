import dotenv from "dotenv";
import path from "path";

dotenv.config();

const rootDir = path.resolve(__dirname, "..", "..");

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/estimateai",
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? path.join(rootDir, "uploads", "raw")),
  staticDir: path.resolve(process.env.STATIC_DIR ?? path.join(rootDir, "uploads", "raw")),
  maxFileSize: 60 * 1024 * 1024, // 60MB per file
  openAiKey: process.env.OPENAI_API_KEY ?? "",
  openAiModel: "gpt-5.2",
  // Drawings extraction (OpenAI JSON items) is intentionally disabled by default for now.
  // Keep the code path available behind this flag so we can re-enable later without deleting code.
  enableDrawingsExtraction: (process.env.ENABLE_DRAWINGS_EXTRACTION ?? "false").toLowerCase() === "true",

  // Gemini (Markdown review of drawing files)
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  // Use gemini-3-pro-preview for best document understanding (latest as of Jan 2026)
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3-pro-preview",
  // Higher thinking budget for complex visual analysis of architectural drawings
  geminiThinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 16384),

  // LandingAI ADE Parse (PDF -> Markdown) to improve Gemini transcription accuracy
  landingAiApiKey: process.env.LANDINGAI_API_KEY ?? "",
  landingAiBaseUrl: (process.env.LANDINGAI_BASE_URL ?? "https://api.va.landing.ai/v1").replace(/\/+$/, ""),
  landingAiParseModel: process.env.LANDINGAI_PARSE_MODEL ?? "dpt-2-latest",
  // LandingAI ADE Extract (Markdown -> Structured JSON)
  landingAiExtractModel: process.env.LANDINGAI_EXTRACT_MODEL ?? "extract-latest",
  airweaveBaseUrl: (process.env.AIRWEAVE_BASE_URL ?? "https://api.airweave.ai").replace(/\/+$/, ""),
  airweaveApiKey: process.env.AIRWEAVE_API_KEY ?? "",
  airweaveCollectionId: process.env.AIRWEAVE_COLLECTION_ID ?? "",
  airweaveOrganizationId: process.env.AIRWEAVE_ORGANIZATION_ID ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "your-secret-key-change-in-production",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
};

