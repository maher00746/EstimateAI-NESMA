import { config } from "../../config";

type LandingExtractResult = {
  extraction: unknown;
  raw: unknown;
  debug?: {
    endpointUsed?: string;
    responsePreview?: string;
  };
};

// NOTE: Keep keys exactly as provided by user (including spaces).
const LANDING_AI_BOQ_SCHEMA = {
  title: "Exhibition Booth Bill of Quantities (BOQ) Extraction Schema",
  description:
    "Schema for extracting detailed information about various components (BOQ items) of an exhibition booth from a markdown document.",
  type: "object",
  properties: {
    boq_items: {
      title: "BOQ Items",
      description:
        "A list of individual components or items found in the exhibition booth, each with its specific details. for Dimensions, length is always bigger than width, when many dimensions are presented for a single item, get the dimensions of the envelope (surrounding box, or max dimensions)",
      type: "array",
      items: {
        title: "BOQ Item",
        description: "Details for a single Bill of Quantities item.",
        type: "object",
        properties: {
          name: {
            title: "Item Name",
            description: "The name or title of the BOQ item (e.g., 'Display Podium 1', 'Main Wall System').",
            type: "string",
            nullable: true,
          },
          description: {
            title: "Item Description",
            description: "A detailed textual description of the BOQ item.",
            type: "string",
            nullable: true,
          },
          finishes: {
            title: "Finishes",
            description: "Describes the materials, colors, or aesthetic treatments of the item (e.g., 'dark grey', 'red acrylic', 'textured metal').",
            type: "string",
            nullable: true,
          },
          quantity: {
            title: "Quantity",
            description: "The number of sets or units of this item.",
            type: "integer",
            nullable: true,
          },
          "total width": {
            type: "string",
            nullable: true,
            description: "if there are many width dimensions, choose the correct one.",
          },
          "total length": {
            type: "string",
            nullable: true,
            description: "if there are many length dimensions, choose the correct one",
          },
          "total  depth": {
            type: "string",
            nullable: true,
            description: "if there are many depth dimensions, choose the correct one",
          },
          "total  height": {
            type: "string",
            nullable: true,
            description: "if there are many height dimensions, choose the correct one (with the vertical line)",
          },
        },
        required: ["name", "description", "finishes", "quantity", "total width", "total length", "total  depth", "total  height"],
      },
    },
  },
  required: ["boq_items"],
} as const;

function safeMdName(sourceFileName: string): string {
  const base = sourceFileName.replace(/\.[^/.]+$/, "");
  return `${base || "document"}.md`;
}

export async function extractBoqItemsWithLandingAi(params: {
  markdown: string;
  sourceFileName: string;
}): Promise<LandingExtractResult> {
  if (!config.landingAiApiKey) {
    return { extraction: null, raw: null };
  }
  const md = (params.markdown || "").trim();
  if (!md) {
    return { extraction: null, raw: null };
  }

  const form = new FormData();
  // ADE Extract expects multipart `markdown` (file) plus `schema` (json) plus optional `model`
  form.append("markdown", new Blob([md], { type: "text/markdown" }), safeMdName(params.sourceFileName));
  // IMPORTANT: LandingAI expects `schema` as a string field (not an uploaded file)
  form.append("schema", JSON.stringify(LANDING_AI_BOQ_SCHEMA));
  form.append("model", config.landingAiExtractModel);

  const url = `${config.landingAiBaseUrl}/ade/extract`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.landingAiApiKey}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LandingAI extract failed (${res.status}): ${text.slice(0, 800)}`);
  }

  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const extraction = (json && (json.extraction ?? json.data?.extraction ?? json.result ?? json)) ?? null;

  return {
    extraction,
    raw: json ?? text,
    debug: {
      endpointUsed: url,
      responsePreview: (typeof json === "object" ? JSON.stringify(json) : String(text)).slice(0, 6000),
    },
  };
}

