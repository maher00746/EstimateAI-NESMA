import fs from "fs/promises";
import path from "path";
import { config } from "../../config";

type LandingParseResult = {
  markdown: string;
  raw: unknown;
  debug?: {
    endpointUsed?: string;
    jobId?: string;
    jobPollUrlUsed?: string;
    outputUrl?: string;
    responsePreview?: string;
    attempts?: Array<{
      url: string;
      method: string;
      status?: number;
      error?: string;
      responsePreview?: string;
    }>;
  };
};

function mimeTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

async function fetchJsonOrText(url: string, init: RequestInit): Promise<{ json?: any; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LandingAI request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { text };
  }
}

async function fetchWithDebug(
  url: string,
  init: RequestInit
): Promise<{ json?: any; text: string; status: number; ok: boolean }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  return { json, text, status: res.status, ok: res.ok };
}

function extractMarkdownFromPayload(payload: any): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload.markdown === "string") return payload.markdown;
  if (payload.data && typeof payload.data.markdown === "string") return payload.data.markdown;
  return "";
}

async function downloadOutputUrl(outputUrl: string): Promise<string> {
  const res = await fetch(outputUrl);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return extractMarkdownFromPayload(json) || text;
  } catch {
    return text;
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function pollJobForMarkdown(
  jobId: string,
  timeoutMs = 120000
): Promise<{ markdown: string; raw: unknown; debug?: LandingParseResult["debug"] }> {
  const base = config.landingAiBaseUrl;
  const jobUrls = [
    `${base}/ade/parse/jobs/${encodeURIComponent(jobId)}`,
    `${base}/ade/v1/parse/jobs/${encodeURIComponent(jobId)}`,
  ];

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let lastErr: unknown = null;
    for (const url of jobUrls) {
      try {
        const { json } = await fetchJsonOrText(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${config.landingAiApiKey}` },
        });
        const status = String(json?.status ?? json?.state ?? "").toLowerCase();
        if (status === "completed" || status === "complete" || status === "succeeded" || status === "success") {
          const md = extractMarkdownFromPayload(json);
          if (md)
            return {
              markdown: md,
              raw: json,
              debug: {
                jobId,
                jobPollUrlUsed: url,
                responsePreview: JSON.stringify(json).slice(0, 6000),
              },
            };
          if (typeof json?.output_url === "string" && json.output_url) {
            const downloaded = await downloadOutputUrl(json.output_url);
            return {
              markdown: downloaded,
              raw: json,
              debug: {
                jobId,
                jobPollUrlUsed: url,
                outputUrl: json.output_url,
                responsePreview: JSON.stringify(json).slice(0, 6000),
              },
            };
          }
          return {
            markdown: "",
            raw: json,
            debug: {
              jobId,
              jobPollUrlUsed: url,
              responsePreview: JSON.stringify(json).slice(0, 6000),
            },
          };
        }
        if (status === "failed" || status === "error") {
          throw new Error(`LandingAI parse job failed: ${JSON.stringify(json?.failure_reason ?? json?.error ?? json).slice(0, 800)}`);
        }
      } catch (err) {
        lastErr = err;
        continue;
      }
    }
    if (lastErr) {
      // keep polling; sometimes job endpoint lags
    }
    await sleep(1500);
  }
  throw new Error("LandingAI parse job timeout");
}

/**
 * Parse a PDF/image with LandingAI ADE and return Markdown.
 *
 * We try the synchronous parse endpoint first (if supported), then fall back to job polling.
 */
export async function parseWithLandingAiToMarkdown(params: {
  filePath: string;
  fileName: string;
}): Promise<LandingParseResult> {
  if (!config.landingAiApiKey) {
    return { markdown: "", raw: null };
  }

  const buffer = await fs.readFile(params.filePath);
  const mimeType = mimeTypeFromFileName(params.fileName);

  const form = new FormData();
  // LandingAI ADE Parse expects multipart `document` (or `document_url`) plus `model`
  form.append("document", new Blob([buffer], { type: mimeType }), params.fileName);
  form.append("model", config.landingAiParseModel);

  const base = config.landingAiBaseUrl;

  // LandingAI ADE Parse endpoint
  const parseUrls = [`${base}/ade/parse`];

  const attempts: NonNullable<LandingParseResult["debug"]>["attempts"] = [];

  let lastError: unknown = null;
  for (const url of parseUrls) {
    try {
      const resp = await fetchWithDebug(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.landingAiApiKey}` },
        body: form,
      });
      attempts.push({
        url,
        method: "POST",
        status: resp.status,
        responsePreview: (resp.text || "").slice(0, 2000),
      });

      if (!resp.ok) {
        throw new Error(`LandingAI request failed (${resp.status}): ${(resp.text || "").slice(0, 500)}`);
      }

      const json = resp.json;
      const text = resp.text;

      // If response is JSON, attempt to pull markdown directly.
      const md = extractMarkdownFromPayload(json);
      if (md)
        return {
          markdown: md,
          raw: json,
          debug: {
            endpointUsed: url,
            responsePreview: JSON.stringify(json).slice(0, 6000),
            attempts,
          },
        };

      // Some responses return job_id for async jobs.
      const jobId = json?.job_id ?? json?.jobId ?? json?.id;
      if (jobId) {
        const polled = await pollJobForMarkdown(String(jobId));
        return {
          markdown: polled.markdown,
          raw: polled.raw,
          debug: {
            endpointUsed: url,
            jobId: String(jobId),
            jobPollUrlUsed: polled.debug?.jobPollUrlUsed,
            outputUrl: polled.debug?.outputUrl,
            responsePreview: polled.debug?.responsePreview,
            attempts,
          },
        };
      }

      // If we got text but no JSON markdown field, return raw text.
      if (text && text.trim())
        return {
          markdown: text,
          raw: json ?? text,
          debug: {
            endpointUsed: url,
            responsePreview: (typeof json === "object" ? JSON.stringify(json) : String(text)).slice(0, 6000),
            attempts,
          },
        };
      return {
        markdown: "",
        raw: json ?? text,
        debug: {
          endpointUsed: url,
          responsePreview: (typeof json === "object" ? JSON.stringify(json) : String(text)).slice(0, 6000),
          attempts,
        },
      };
    } catch (err) {
      lastError = err;
      attempts.push({
        url,
        method: "POST",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  const finalErr = lastError instanceof Error ? lastError : new Error("LandingAI parse failed");
  (finalErr as any).attempts = attempts;
  throw finalErr;
}

