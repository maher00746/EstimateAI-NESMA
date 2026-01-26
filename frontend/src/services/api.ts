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
  CadExtractionItem,
  ProjectSummary,
  ProjectFile,
  ProjectItem,
  ProductivityRatesPayload,
  PricingPayload,
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
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

export interface CadExtractionResponse {
  fileName: string;
  items: CadExtractionItem[];
  rawText?: string;
}

export async function extractCadItems(file: File): Promise<CadExtractionResponse> {
  const data = new FormData();
  data.append("cadFile", file);
  return safeFetch(`${API_BASE}/api/estimates/cad-extraction`, {
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

export async function listProjects(): Promise<ProjectSummary[]> {
  return safeFetch(`${API_BASE}/api/projects`);
}

export async function createProject(name?: string): Promise<ProjectSummary> {
  return safeFetch(`${API_BASE}/api/projects`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function updateProjectName(projectId: string, name: string): Promise<ProjectSummary> {
  return safeFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function removeProject(projectId: string): Promise<void> {
  await safeFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export async function getProductivityRates(): Promise<ProductivityRatesPayload> {
  return safeFetch(`${API_BASE}/api/productivity-rates`);
}

export async function saveProductivityRates(
  payload: Pick<ProductivityRatesPayload, "factor" | "blocks">
): Promise<ProductivityRatesPayload> {
  return safeFetch(`${API_BASE}/api/productivity-rates`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function importProductivityRates(file: File): Promise<ProductivityRatesPayload> {
  const data = new FormData();
  data.append("file", file);
  return safeFetch(`${API_BASE}/api/productivity-rates/import`, {
    method: "POST",
    body: data,
  });
}

export async function getPricing(projectId: string): Promise<PricingPayload> {
  return safeFetch(`${API_BASE}/api/pricing/${encodeURIComponent(projectId)}`);
}

export async function savePricing(projectId: string, payload: PricingPayload): Promise<PricingPayload> {
  return safeFetch(`${API_BASE}/api/pricing/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function retryProjectFile(projectId: string, fileId: string, idempotencyKey: string): Promise<{
  id: string;
  fileId: string;
  status: "queued" | "processing" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
}> {
  return safeFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/retry`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    }
  );
}

export interface UploadProjectFilesResponse {
  project: ProjectSummary;
  files: ProjectFile[];
}

export async function uploadProjectFiles(
  projectId: string,
  drawings: File[],
  scheduleFiles: File[],
  boq?: File | null
): Promise<UploadProjectFilesResponse> {
  const data = new FormData();
  drawings.forEach((file) => data.append("drawings", file));
  scheduleFiles.forEach((file) => data.append("schedule", file));
  if (boq) {
    data.append("boq", boq);
  }
  return safeFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/files`, {
    method: "POST",
    body: data,
  });
}

export interface ProjectExtractionJobResponse {
  jobs: Array<{
    id: string;
    fileId: string;
    status: "queued" | "processing" | "done" | "failed";
    createdAt: string;
    updatedAt: string;
  }>;
}

export async function startProjectExtraction(
  projectId: string,
  idempotencyKey: string,
  fileIds?: string[]
): Promise<ProjectExtractionJobResponse> {
  return safeFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/extractions/start`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: fileIds && fileIds.length > 0 ? JSON.stringify({ fileIds }) : undefined,
  });
}

export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  return safeFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/files`);
}

export async function removeProjectFile(projectId: string, fileId: string): Promise<void> {
  await safeFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" }
  );
}

export async function listProjectItems(projectId: string): Promise<ProjectItem[]> {
  return safeFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/items`);
}

export async function listProjectFileItems(
  projectId: string,
  fileId: string
): Promise<ProjectItem[]> {
  return safeFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/items`
  );
}

export async function addProjectFileItem(
  projectId: string,
  fileId: string,
  payload: Pick<ProjectItem, "item_code" | "description" | "notes" | "box">
): Promise<ProjectItem> {
  return safeFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/items`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export async function updateProjectItem(
  projectId: string,
  itemId: string,
  payload: Partial<Pick<ProjectItem, "item_code" | "description" | "notes" | "box">>
): Promise<ProjectItem> {
  return safeFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    }
  );
}

export async function removeProjectItem(projectId: string, itemId: string): Promise<void> {
  await safeFetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE" }
  );
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

