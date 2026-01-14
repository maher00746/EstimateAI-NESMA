import { config } from "../../config";
import { AttributeMap, AttributeValue } from "../../types/build";

export interface AirweaveSearchResult extends Record<string, unknown> {
    id?: string;
    score?: number;
    metadata?: Record<string, unknown>;
    source?: string;
}

interface AirweaveSearchPayload {
    query: string;
    retrieval_strategy: "hybrid";
    limit: number;
    expand_query: false;
    rerank: false;
    interpret_filters: false;
    generate_answer: false;
}

interface AirweaveSearchResponsePayload {
    results: AirweaveSearchResult[];
    completion?: string | null;
}

// Helper to extract value from attribute (handles both old and new format)
function getAttributeValueOnly(attr: string | AttributeValue): string {
    if (typeof attr === 'string') {
        return attr;
    }
    return attr.value;
}

function formatAttributeQuery(attributes: AttributeMap): string {
    const entries = Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
        return "PC build attributes";
    }
    const formatted = entries.map(([key, value]) => `- ${key}: ${getAttributeValueOnly(value)}`);
    return `Uploaded attributes:\n\n${formatted.join("\n")}`;
}

export async function searchAirweaveByAttributes(
    attributes: AttributeMap,
    limit = 5
): Promise<AirweaveSearchResponsePayload> {
    if (!config.airweaveApiKey) {
        throw new Error("AIRWEAVE_API_KEY is not configured");
    }
    if (!config.airweaveCollectionId) {
        throw new Error("AIRWEAVE_COLLECTION_ID is not configured");
    }

    const sanitizedBase = config.airweaveBaseUrl.replace(/\/+$/, "");
    const url = `${sanitizedBase}/collections/${config.airweaveCollectionId}/search`;

    const payload: AirweaveSearchPayload = {
        query: formatAttributeQuery(attributes),
        retrieval_strategy: "hybrid",
        limit,
        expand_query: false,
        rerank: false,
        interpret_filters: false,
        generate_answer: false,
    };

    console.log("=== AIRWEAVE REQUEST ===");
    console.log("URL:", url);
    console.log("Payload:", JSON.stringify(payload, null, 2));
    console.log("========================");

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-API-Key": config.airweaveApiKey,
    };
    if (config.airweaveOrganizationId) {
        headers["X-Organization-ID"] = config.airweaveOrganizationId;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Airweave search failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as AirweaveSearchResponsePayload;
    return data;
}

