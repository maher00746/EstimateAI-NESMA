import type {
  BuildSummary,
  AttributeMap,
  ExtractedItem,
  BoqCompareResponse,
  EstimateDraft,
  EstimateDraftMeta,
  DraftEstimateState,
  EstimateStep,
  PriceListRow,
  PriceMapping,
  AtgTotals,
  ElectricalTotals,
  ElectricalCalcRequest,
  ElectricalCalcResponse,
} from "../types";

const API_BASE = "";

// Get token from localStorage
function getToken(): string | null {
  return localStorage.getItem("auth_token");
}

// Create headers with auth token if available
function createHeaders(includeAuth = true): HeadersInit {
  const headers: HeadersInit = {};
  if (includeAuth) {
    const token = getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }
  return headers;
}

async function safeFetch(
  input: RequestInfo,
  init?: RequestInit,
  includeAuth = true
): Promise<any> {
  const authHeaders = createHeaders(includeAuth);
  const initHeaders = init?.headers || {};

  // Convert HeadersInit to a plain object for easier manipulation
  const headersObj: Record<string, string> = {};

  // Add auth headers
  if (authHeaders instanceof Headers) {
    authHeaders.forEach((value, key) => {
      headersObj[key] = value;
    });
  } else if (Array.isArray(authHeaders)) {
    authHeaders.forEach(([key, value]) => {
      headersObj[key] = value;
    });
  } else {
    Object.assign(headersObj, authHeaders);
  }

  // Add init headers
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => {
      headersObj[key] = value;
    });
  } else if (Array.isArray(initHeaders)) {
    initHeaders.forEach(([key, value]) => {
      headersObj[key] = value;
    });
  } else {
    Object.assign(headersObj, initHeaders);
  }

  // Don't override Content-Type if it's FormData
  if (!(init?.body instanceof FormData)) {
    if (!headersObj["Content-Type"] && !headersObj["content-type"]) {
      headersObj["Content-Type"] = "application/json";
    }
  }

  const response = await fetch(input, {
    ...init,
    headers: headersObj,
  });

  if (!response.ok) {
    // Handle 401 Unauthorized - token expired or invalid
    if (response.status === 401) {
      localStorage.removeItem("auth_token");
      // Trigger a custom event that the app can listen to
      window.dispatchEvent(new CustomEvent("auth:logout"));
    }
    const text = await response.text();
    let errorMessage = text || "Request failed";
    try {
      const json = JSON.parse(text);
      errorMessage = json.message || errorMessage;
    } catch {
      // Keep the text as is
    }
    throw new Error(errorMessage);
  }
  return response.json();
}

export interface PaginatedResponse {
  data: BuildSummary[];
  totalCount: number;
  page: number;
  limit: number;
  totalPages: number;
}

export async function fetchKnowledgeBase(limit = 10, page = 1): Promise<PaginatedResponse> {
  return safeFetch(`${API_BASE}/api/estimates/history?limit=${limit}&page=${page}`);
}

export async function fetchStats(): Promise<{ totalBuilds: number }> {
  return safeFetch(`${API_BASE}/api/estimates/stats`);
}

export async function uploadEstimate(file: File): Promise<BuildSummary> {
  const data = new FormData();
  data.append("buildFile", file);
  return safeFetch(`${API_BASE}/api/estimates/upload`, {
    method: "POST",
    body: data,
  });
}

export async function uploadMultipleEstimates(files: File[]): Promise<{ uploaded: number; builds: BuildSummary[] }> {
  const data = new FormData();
  files.forEach(file => data.append("buildFiles", file));
  return safeFetch(`${API_BASE}/api/estimates/upload-multiple`, {
    method: "POST",
    body: data,
  });
}

interface MatchPayload {
  file?: File;
  files?: File[];
  buildId?: string;
  limit?: number;
}

export interface CandidateMatch {
  id: string;
  fileName?: string;
  filePath?: string;
  metadata?: Record<string, unknown>;
  attributes: Record<string, string>;
  score?: number;
}

export interface AirweaveMatchResponse {
  referenceBuildId?: string;
  attributes: Record<string, string>;
  totalPrice?: string;
  matches: CandidateMatch[];
  completion?: string | null;
}

export async function requestMatches(payload: MatchPayload): Promise<AirweaveMatchResponse> {
  const data = new FormData();
  if (payload.files && payload.files.length > 0) {
    payload.files.forEach((file) => data.append("buildFiles", file));
  } else if (payload.file) {
    data.append("buildFile", payload.file);
  }
  if (payload.buildId) {
    data.append("buildId", payload.buildId);
  }
  data.append("limit", String(payload.limit ?? 4));
  return safeFetch(`${API_BASE}/api/estimates/match`, {
    method: "POST",
    body: data,
  });
}

export interface ExtractedFile {
  fileName: string;
  link_to_file?: string;
  attributes: AttributeMap;
  items: ExtractedItem[];
  totalPrice?: string;
  markdown?: string;
  geminiDebug?: any;
}

export interface ExtractResponse {
  files: ExtractedFile[];
}

export async function extractEstimates(files: File[], idempotencyKey: string): Promise<{ jobId: string; status: string } | ExtractResponse> {
  const data = new FormData();
  files.forEach((file) => data.append("buildFiles", file));
  return safeFetch(`${API_BASE}/api/estimates/extract`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: data,
  });
}

export interface ExtractJobStatusResponse {
  jobId: string;
  status: "queued" | "processing" | "done" | "failed";
  stage?: string | null;
  message?: string | null;
  result?: ExtractResponse | null;
  error?: { message: string; details?: unknown } | null;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export async function getExtractJob(jobId: string): Promise<ExtractJobStatusResponse> {
  return safeFetch(`${API_BASE}/api/estimates/extract/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
  });
}

export interface LandingAiParsedFile {
  fileName: string;
  markdown: string;
  raw: unknown;
  debug?: unknown;
}

export interface LandingAiParseResponse {
  files: LandingAiParsedFile[];
}

export async function parseLandingAi(files: File[]): Promise<LandingAiParseResponse> {
  const data = new FormData();
  files.forEach((file) => data.append("buildFiles", file));
  return safeFetch(`${API_BASE}/api/estimates/landingai/parse`, {
    method: "POST",
    body: data,
  });
}

export interface CreateFromTemplatePayload {
  originalName: string;
  attributes: AttributeMap;
  totalPrice?: string;
}

export async function createBuildFromTemplate(payload: CreateFromTemplatePayload): Promise<BuildSummary> {
  return safeFetch(`${API_BASE}/api/estimates/create-from-template`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function compareBoq(extractedItems: ExtractedItem[], boqFile: File): Promise<BoqCompareResponse> {
  const data = new FormData();
  data.append("boqFile", boqFile);
  data.append("extractedItems", JSON.stringify(extractedItems ?? []));
  return safeFetch(`${API_BASE}/api/estimates/compare-boq`, {
    method: "POST",
    body: data,
  });
}

export async function extractBoq(boqFile: File): Promise<{ boqItems: ExtractedItem[]; rawContent?: string }> {
  const data = new FormData();
  data.append("boqFile", boqFile);
  return safeFetch(`${API_BASE}/api/estimates/boq/extract`, {
    method: "POST",
    body: data,
  });
}

export async function compareLists(drawingItems: ExtractedItem[], boqItems: ExtractedItem[]): Promise<BoqCompareResponse & { rawContent?: string }> {
  return safeFetch(`${API_BASE}/api/estimates/compare-lists`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ drawingItems, boqItems }),
  });
}

export async function enrichBoqItems(boqItems: ExtractedItem[]): Promise<{ items: ExtractedItem[]; rawContent?: string }> {
  return safeFetch(`${API_BASE}/api/estimates/boq/enrich`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ boqItems }),
  });
}

export interface DrawingPromptResponse {
  key: string;
  prompt: string;
  updatedAt?: string | null;
  isDefault?: boolean;
}

export async function fetchDrawingPrompt(): Promise<DrawingPromptResponse> {
  return safeFetch(`${API_BASE}/api/prompts/drawing-extraction`);
}

export async function updateDrawingPrompt(prompt: string): Promise<DrawingPromptResponse> {
  return safeFetch(`${API_BASE}/api/prompts/drawing-extraction`, {
    method: "PUT",
    body: JSON.stringify({ prompt }),
  });
}

interface SaveDraftPayload {
  id?: string;
  name: string;
  step: EstimateStep;
  state: DraftEstimateState;
}

export async function saveDraft(payload: SaveDraftPayload): Promise<EstimateDraft> {
  return safeFetch(`${API_BASE}/api/drafts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function listDrafts(): Promise<EstimateDraftMeta[]> {
  return safeFetch(`${API_BASE}/api/drafts`);
}

export async function getDraft(id: string): Promise<EstimateDraft> {
  return safeFetch(`${API_BASE}/api/drafts/${id}`);
}

export async function removeDraft(id: string): Promise<void> {
  await safeFetch(`${API_BASE}/api/drafts/${id}`, { method: "DELETE" });
}

export async function fetchPriceList(sheet?: string): Promise<{ data: PriceListRow[] }> {
  const url = sheet ? `${API_BASE}/api/estimates/price-list?sheet=${encodeURIComponent(sheet)}` : `${API_BASE}/api/estimates/price-list`;
  return safeFetch(url);
}

export async function fetchAtgTotals(): Promise<AtgTotals> {
  return safeFetch(`${API_BASE}/api/estimates/atg`);
}

export async function fetchElectricalTotals(): Promise<ElectricalTotals> {
  return safeFetch(`${API_BASE}/api/estimates/electrical`);
}

export async function calculateElectrical(payload: ElectricalCalcRequest): Promise<ElectricalCalcResponse> {
  return safeFetch(`${API_BASE}/api/estimates/electrical/calculate`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function priceMap(items: ExtractedItem[]): Promise<{ mappings: PriceMapping[]; rawContent: string }> {
  return safeFetch(`${API_BASE}/api/estimates/price-map`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

// Authentication functions
export interface LoginResponse {
  message: string;
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
}

export interface RegisterResponse {
  message: string;
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  return safeFetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  }, false);
}

export async function register(
  username: string,
  email: string,
  password: string
): Promise<RegisterResponse> {
  return safeFetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    body: JSON.stringify({ username, email, password }),
  }, false);
}

export async function verifyToken(token: string): Promise<{ user: { id: string; username: string; email: string } }> {
  return safeFetch(`${API_BASE}/api/auth/verify`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
    },
  }, false);
}

export async function logout(): Promise<{ message: string }> {
  return safeFetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
  });
}

