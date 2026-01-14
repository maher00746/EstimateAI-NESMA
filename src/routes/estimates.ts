import { Router } from "express";
import type { Express } from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import xlsx from "xlsx";
import PDFDocument from "pdfkit";
import { config } from "../config";
import { ingestBuild } from "../modules/ingestion/ingestionService";
import { findBuildById, listHistoricalBuilds, getTotalBuildCount, saveBuild } from "../modules/storage/buildRepository";
import { parseDocument } from "../services/parsing/parsingPipeline";
import { searchAirweaveByAttributes } from "../services/airweave/searchService";
import {
  rankMatchesWithOpenAI,
  RankerCandidate,
  RankedMatch,
} from "../services/openai/matchRanker";
import { AttributeMap, AttributeValue, ExtractedItem } from "../types/build";
import { compareItemListsWithOpenAI, comparePreExtractedLists, extractBoqWithOpenAI } from "../services/openai/boqComparer";
import { enrichBoqItemsWithOpenAI } from "../services/openai/boqEnricher";
import { extractTextFromPdf, extractTextFromDocx, extractTextFromTxt } from "../services/parsing/textExtractor";
import { parseBoqFile } from "../services/parsing/boqExtractor";
import { loadPriceList } from "../services/pricing/priceList";
import { loadAtgTotals } from "../services/pricing/atgSheet";
import { loadElectricalTotals, calculateProjectCost } from "../services/pricing/electricalSheet";
import { mapItemsToPriceList } from "../services/openai/priceMapper";
import { generateDrawingMarkdownWithGemini } from "../services/gemini/drawingMarkdown";
import { parseWithLandingAiToMarkdown } from "../services/landingai/parseToMarkdown";
import { ExtractJobModel } from "../modules/storage/extractJobModel";
import { kickOffExtractJob } from "../services/extraction/extractJobProcessor";
import { AuthRequest } from "../middleware/auth";

interface CandidateSummary {
  id: string;
  fileName?: string;
  filePath?: string;
  attributeText: string;
  attributes: AttributeMap;
  metadata?: Record<string, unknown>;
  score?: number;
}

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (_req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSize },
});

const matchUpload = upload.fields([
  { name: "buildFiles", maxCount: 10 },
  { name: "buildFile", maxCount: 1 },
]);

const router = Router();

// LandingAI parse endpoint: returns raw ADE parse JSON + markdown grounding info.
// This is used by the optional "visual review" UI; it does not affect existing flows.
router.post("/landingai/parse", matchUpload, async (req, res, next) => {
  try {
    const fileFields = (req.files ?? {}) as Record<string, unknown>;
    const multiFiles = Array.isArray((fileFields as any).buildFiles)
      ? ((fileFields as any).buildFiles as Express.Multer.File[])
      : [];
    const singleFile = Array.isArray((fileFields as any).buildFile)
      ? ((fileFields as any).buildFile as Express.Multer.File[])[0]
      : (req as any).file as Express.Multer.File | undefined;

    const files = multiFiles.length > 0 ? multiFiles : singleFile ? [singleFile] : [];
    if (files.length === 0) {
      return res.status(400).json({ message: "At least one buildFile is required" });
    }

    const parsedFiles = await Promise.all(
      files.map(async (file) => {
        const parsed = await parseWithLandingAiToMarkdown({
          filePath: file.path,
          fileName: file.originalname,
        });
        return {
          fileName: file.originalname,
          markdown: parsed.markdown || "",
          raw: parsed.raw ?? null,
          debug: parsed.debug ?? null,
        };
      })
    );

    res.status(200).json({ files: parsedFiles });
  } catch (error) {
    next(error);
  }
});

async function generatePDFFromAttributes(
  attributes: AttributeMap,
  totalPrice: string | undefined,
  fileName: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const pdfPath = path.join(config.uploadDir, `${timestamp}-${safeName}.pdf`);

    const doc = new PDFDocument({ margin: 50 });
    const writeStream = require('fs').createWriteStream(pdfPath);

    doc.pipe(writeStream);

    // Header - Bold H1 size in center
    doc.fontSize(28)
      .font('Helvetica-Bold')
      .text('PC BUILD COST ESTIMATE', { align: 'center' });

    doc.moveDown(1.5);

    // Description paragraph
    doc.fontSize(10)
      .font('Helvetica')
      .text(
        'This estimate is issued by NovaCore Technologies in response to the component selection provided by Customer X. The configuration outlined below is based on the exact parts chosen by the customer. This document serves as an official cost estimate under Request ID REQ-2025-0193. All selected components are listed with their specifications and corresponding prices. This estimate reflects current market pricing and the total cost for assembling the requested system.',
        { align: 'justify', lineGap: 2 }
      );

    doc.moveDown(2);

    // Table setup
    const tableTop = doc.y;
    const colPart = 50;
    const colSpec = 180;
    const colPrice = 450;
    const rowHeight = 25;
    let currentY = tableTop;

    // Table header
    doc.fontSize(11)
      .font('Helvetica-Bold')
      .fillColor('#000000');

    // Header background
    doc.rect(colPart, currentY, 512, rowHeight).fill('#e0e0e0');

    // Header text
    doc.fillColor('#000000')
      .text('Part', colPart + 5, currentY + 8, { width: 120 })
      .text('Specification', colSpec + 5, currentY + 8, { width: 260 })
      .text('Price (USD)', colPrice + 5, currentY + 8, { width: 100 });

    currentY += rowHeight;

    // Table rows
    doc.fontSize(9).font('Helvetica');

    Object.entries(attributes).forEach(([key, value], index) => {
      // Check if we need a new page
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
      }

      // Alternate row colors
      if (index % 2 === 0) {
        doc.rect(colPart, currentY, 512, rowHeight).fill('#f9f9f9');
      }

      // Extract value and price
      let specText = '';
      let priceText = '—';

      if (typeof value === 'string') {
        specText = value;
      } else {
        specText = value.value || '—';
        priceText = value.price || '—';
      }

      // Draw text
      doc.fillColor('#000000')
        .font('Helvetica-Bold')
        .text(key, colPart + 5, currentY + 8, { width: 120 })
        .font('Helvetica')
        .text(specText, colSpec + 5, currentY + 8, { width: 260 })
        .text(priceText, colPrice + 5, currentY + 8, { width: 100 });

      currentY += rowHeight;
    });

    // Total row
    doc.rect(colPart, currentY, 512, rowHeight).fill('#d0d0d0');

    doc.fillColor('#000000')
      .fontSize(11)
      .font('Helvetica-Bold')
      .text('TOTAL', colPart + 5, currentY + 8, { width: 120 })
      .text('', colSpec + 5, currentY + 8, { width: 260 })
      .text(totalPrice || '—', colPrice + 5, currentY + 8, { width: 100 });

    doc.end();

    writeStream.on('finish', () => resolve(pdfPath));
    writeStream.on('error', reject);
  });
}

const toAttributeMap = (value: unknown): AttributeMap => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).reduce<AttributeMap>((acc, [key, payload]) => {
      if (payload === null || payload === undefined) return acc;

      // Check if payload is an object with value and price properties
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
        const obj = payload as Record<string, unknown>;
        if ('value' in obj) {
          acc[key] = {
            value: String(obj.value || ""),
            price: obj.price ? String(obj.price) : undefined,
          };
        } else {
          acc[key] = String(payload);
        }
      } else {
        acc[key] = String(payload);
      }
      return acc;
    }, {});
  }
  return {};
};

const extractPayloadAttributes = (payload: Record<string, unknown> | undefined): AttributeMap => {
  const attributes: AttributeMap = {};
  if (!payload) {
    return attributes;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith("attributes.") && typeof value !== "object") {
      const [, attrKey] = key.split(".");
      if (attrKey) {
        attributes[attrKey] = String(value);
      }
    } else if (key === "attributes" && typeof value === "object" && value !== null) {
      Object.entries(value as Record<string, unknown>).forEach(([attrKey, attrValue]) => {
        if (attrValue !== null && attrValue !== undefined) {
          attributes[attrKey] = String(attrValue);
        }
      });
    }
  }
  return attributes;
};

// Old Airweave extraction functions removed - now using MongoDB as source of truth


router.post("/upload", upload.single("buildFile"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "buildFile is required" });
    }

    const stored = await ingestBuild(req.file, req.body.requestId);
    res.status(201).json({
      id: stored._id,
      requestId: stored.requestId,
      originalName: stored.originalName,
      attributes: stored.attributes,
      totalPrice: stored.totalPrice,
      link_to_file: `/files/${path.basename(stored.filePath)}`,
      createdAt: stored.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/history", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 10);
    const page = Number(req.query.page ?? 1);
    const skip = (page - 1) * limit;

    const builds = await listHistoricalBuilds({ limit });
    const totalCount = await getTotalBuildCount();

    res.status(200).json({
      data: builds.map((build) => ({
        id: build._id,
        requestId: build.requestId,
        originalName: build.originalName,
        createdAt: build.createdAt,
        attributes: build.attributes,
        totalPrice: build.totalPrice,
        link_to_file: `/files/${path.basename(build.filePath)}`,
      })),
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/stats", async (req, res, next) => {
  try {
    const totalCount = await getTotalBuildCount();
    res.status(200).json({ totalBuilds: totalCount });
  } catch (error) {
    next(error);
  }
});

router.get("/price-list", async (req, res, next) => {
  try {
    const sheet = (req.query.sheet as string | undefined) || "Price List";
    const data = await loadPriceList({}, sheet);
    res.status(200).json({ data });
  } catch (error) {
    next(error);
  }
});

router.get("/atg", async (_req, res, next) => {
  try {
    const data = await loadAtgTotals();
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/electrical", async (_req, res, next) => {
  try {
    const data = await loadElectricalTotals();
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
});

router.post("/electrical/calculate", async (req, res, next) => {
  try {
    const {
      a2 = 0,
      x,
      y,
      z,
      cValues = [],
    } = req.body as {
      a2?: number;
      x: number;
      y: number;
      z: number;
      cValues: Array<number | string>;
    };

    if (x === undefined || y === undefined || z === undefined) {
      return res.status(400).json({ message: "x, y, z are required" });
    }

    const cList = Array.from({ length: 21 }, (_, idx) => {
      const raw = cValues[idx];
      const num = Number(raw ?? 0);
      return Number.isFinite(num) ? num : 0;
    }) as [
        number, number, number, number, number, number, number,
        number, number, number, number, number, number, number,
        number, number, number, number, number, number, number
      ];

    const [
      c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15, c16,
      c17, c18, c19, c20, c21, c22, c23, c24, c25,
    ] = cList;

    const result = calculateProjectCost(
      Number(a2) || 0,
      Number(x) || 0,
      Number(y) || 0,
      Number(z) || 0,
      c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15, c16,
      c17, c18, c19, c20, c21, c22, c23, c24, c25
    );

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/price-map", async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.items) ? (req.body.items as ExtractedItem[]) : [];
    if (!items.length) {
      return res.status(400).json({ message: "items array is required" });
    }

    const result = await mapItemsToPriceList(items);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/create-from-template", async (req, res, next) => {
  try {
    const { originalName, attributes, totalPrice } = req.body;

    if (!originalName) {
      return res.status(400).json({ message: "originalName is required" });
    }

    if (!attributes || typeof attributes !== 'object' || Object.keys(attributes).length === 0) {
      return res.status(400).json({ message: "attributes object is required" });
    }

    // Generate PDF from attributes
    const pdfPath = await generatePDFFromAttributes(attributes, totalPrice, originalName);

    // Save directly to MongoDB (no need to parse the PDF we just created)
    const stored = await saveBuild({
      requestId: randomUUID(),
      originalName: `${originalName}.pdf`,
      filePath: pdfPath,
      attributes: attributes,
      totalPrice: totalPrice || undefined,
    });

    res.status(201).json({
      id: stored._id,
      requestId: stored.requestId,
      originalName: stored.originalName,
      attributes: stored.attributes,
      totalPrice: stored.totalPrice,
      link_to_file: `/files/${path.basename(stored.filePath)}`,
      createdAt: stored.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/upload-multiple", upload.array("buildFiles", 10), async (req, res, next) => {
  try {
    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
      return res.status(400).json({ message: "At least one buildFile is required" });
    }
    const results = await Promise.all(
      req.files.map(file => ingestBuild(file, undefined))
    );
    res.status(201).json({
      uploaded: results.length,
      builds: results.map((result) => ({
        id: result._id,
        requestId: result.requestId,
        originalName: result.originalName,
        createdAt: result.createdAt,
        attributes: result.attributes,
        totalPrice: result.totalPrice,
        link_to_file: `/files/${path.basename(result.filePath)}`,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// Extract-only endpoint: parse files with OpenAI, return attributes, no DB or Airweave
router.post("/extract", matchUpload, async (req, res, next) => {
  try {
    const userId = (req as AuthRequest).user?._id;
    if (!userId) {
      return res.status(401).json({ message: "Authentication required." });
    }

    const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim();
    if (!idempotencyKey) {
      return res.status(400).json({ message: "Idempotency-Key header is required" });
    }

    const fileFields = (req.files ?? {}) as Record<string, unknown>;
    const multiFiles = Array.isArray((fileFields as any).buildFiles)
      ? ((fileFields as any).buildFiles as Express.Multer.File[])
      : [];
    const singleFile = Array.isArray((fileFields as any).buildFile)
      ? ((fileFields as any).buildFile as Express.Multer.File[])[0]
      : (req as any).file as Express.Multer.File | undefined;

    const files = multiFiles.length > 0 ? multiFiles : singleFile ? [singleFile] : [];
    if (files.length === 0) {
      return res.status(400).json({ message: "At least one buildFile is required" });
    }

    // Create or reuse job (idempotency per user)
    try {
      const storedFiles = files.map((f) => ({
        originalName: f.originalname,
        storedPath: f.path,
        storedName: path.basename(f.path),
      }));

      const job = await ExtractJobModel.create({
        userId,
        idempotencyKey,
        status: "queued",
        stage: "queued",
        message: "Queued",
        files: storedFiles,
        result: null,
        error: null,
      });

      // Respond immediately to avoid LB/proxy timeouts, then process in background.
      res.status(202).json({ jobId: job._id, status: job.status });
      await kickOffExtractJob(String(job._id));
      return;
    } catch (err: any) {
      // Duplicate idempotency key -> return existing job status/result
      if (err?.code === 11000) {
        const existing = await ExtractJobModel.findOne({ userId, idempotencyKey }).exec();
        if (!existing) {
          return res.status(409).json({ message: "Duplicate idempotency key" });
        }
        if (existing.status === "done") {
          return res.status(200).json(existing.result ?? { files: [] });
        }
        if (existing.status === "failed") {
          return res.status(409).json({ jobId: existing._id, status: existing.status, error: existing.error });
        }
        return res.status(202).json({ jobId: existing._id, status: existing.status });
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

// Poll extraction job status/result
router.get("/extract/jobs/:jobId", async (req, res, next) => {
  try {
    const userId = (req as AuthRequest).user?._id;
    if (!userId) {
      return res.status(401).json({ message: "Authentication required." });
    }
    const jobId = String(req.params.jobId || "").trim();
    if (!jobId) return res.status(400).json({ message: "jobId is required" });

    const job = await ExtractJobModel.findOne({ _id: jobId, userId }).exec();
    if (!job) return res.status(404).json({ message: "Job not found" });

    res.status(200).json({
      jobId: job._id,
      status: job.status,
      stage: job.stage ?? null,
      message: job.message ?? null,
      result: job.status === "done" ? job.result ?? null : null,
      error: job.status === "failed" ? job.error ?? null : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/match", matchUpload, async (req, res, next) => {
  try {
    const requestedLimit = Number(req.body.limit ?? 5);
    const limit = Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 5);
    let attributes: AttributeMap | undefined;
    let totalPrice: string | undefined;
    let referenceBuildId: string | undefined;
    const fileFields = (req.files ?? {}) as Record<string, unknown>;
    const multiFiles = Array.isArray((fileFields as any).buildFiles)
      ? ((fileFields as any).buildFiles as Express.Multer.File[])
      : [];
    const singleFile = Array.isArray((fileFields as any).buildFile)
      ? ((fileFields as any).buildFile as Express.Multer.File[])[0]
      : (req as any).file as Express.Multer.File | undefined;

    if (req.body.buildId) {
      const existing = await findBuildById(req.body.buildId);
      if (!existing) {
        return res.status(404).json({ message: "Reference build not found" });
      }
      attributes = existing.attributes;
      totalPrice = existing.totalPrice;
      referenceBuildId = existing._id.toString();
    } else if (multiFiles.length > 0) {
      const parsedFiles = await Promise.all(
        multiFiles.map(async (file) => {
          const parsed = await parseDocument(file.path);
          return { file, parsed };
        })
      );
      attributes = parsedFiles.reduce<AttributeMap>((acc, entry) => {
        Object.entries(entry.parsed.attributes).forEach(([key, value]) => {
          const label = `${path.basename(entry.file.originalname)} — ${key}`;
          acc[label] = value;
        });
        return acc;
      }, {});
      totalPrice = parsedFiles.find((entry) => entry.parsed.totalPrice)?.parsed.totalPrice;
    } else if (singleFile) {
      const parsed = await parseDocument(singleFile.path);
      attributes = parsed.attributes;
      totalPrice = parsed.totalPrice;
    } else {
      return res.status(400).json({ message: "buildId or buildFile is required" });
    }

    if (!attributes || Object.keys(attributes).length === 0) {
      return res.status(400).json({ message: "Unable to extract attributes from the document." });
    }

    const airweaveResponse = await searchAirweaveByAttributes(attributes, limit);
    const airweaveResults = airweaveResponse.results ?? [];

    // Extract MongoDB IDs from Airweave results
    const mongoIds: string[] = [];
    for (const result of airweaveResults) {
      const payload = (result.payload as Record<string, unknown> | undefined) ?? {};
      const mongoId = String(payload["_id"] || payload["requestId"] || "");
      if (mongoId) {
        mongoIds.push(mongoId);
      }
    }

    // Fetch full documents from MongoDB
    const mongoBuilds = await Promise.all(
      mongoIds.map(id => findBuildById(id))
    );

    // Filter out nulls and create candidates from MongoDB data
    const candidates: CandidateSummary[] = mongoBuilds
      .filter((build): build is NonNullable<typeof build> => build !== null)
      .map((build) => {
        const candidateId = build._id.toString();

        return {
          id: candidateId,
          fileName: build.originalName,
          attributeText: "", // Will be generated below
          attributes: build.attributes,
          filePath: build.filePath,
          metadata: { mongoDoc: build },
        };
      });

    // Create attribute text WITHOUT prices for OpenAI ranking
    const openAiCandidates: RankerCandidate[] = candidates.map(({ id, attributes }) => {
      const attributeTextWithoutPrices = Object.entries(attributes)
        .map(([key, value]) => {
          // Extract only the value, not the price
          const valueOnly = typeof value === 'string' ? value : value.value;
          return `${key}: ${valueOnly}`;
        })
        .join('\n');

      return {
        id,
        attributeText: attributeTextWithoutPrices || "",
      };
    });

    const ranking = await rankMatchesWithOpenAI(attributes, openAiCandidates);
    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const matches =
      ranking.length > 0
        ? ranking
          .map((entry: RankedMatch) => {
            const candidate = candidateMap.get(entry.id);
            if (!candidate) return null;
            return {
              ...candidate,
              score: entry.score,
            };
          })
          .filter((match): match is CandidateSummary & { score: number } => Boolean(match))
        : candidates.map((candidate) => ({
          ...candidate,
          score: 0,
        }));

    res.status(200).json({
      referenceBuildId,
      attributes,
      totalPrice,
      matches,
      completion: airweaveResponse.completion ?? null,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/compare-boq", upload.single("boqFile"), async (req, res, next) => {
  try {
    return res.status(400).json({ message: "Deprecated. Use /boq/extract then /compare-lists." });
  } catch (error) {
    next(error);
  }
});

router.post("/boq/extract", upload.single("boqFile"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "boqFile is required" });
    }
    const parsed = await parseBoqFile(req.file.path, req.file.originalname);

    // Always attempt OpenAI extraction here so "Review Extraction" gets BOQ results immediately
    let aiItems: ExtractedItem[] = [];
    let aiRaw = "";
    const ext = path.extname(req.file.originalname).toLowerCase();
    try {
      const excelExts = new Set([".xlsx", ".xls", ".csv"]);
      if (excelExts.has(ext)) {
        // Convert Excel/CSV to CSV text for OpenAI
        const workbook = xlsx.readFile(req.file.path);
        const parts: string[] = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          if (!sheet) continue;
          const csv = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
          if (csv.trim()) {
            parts.push(`Sheet: ${sheetName}\n${csv}`);
          }
        }
        const csvText = parts.join("\n\n");
        ({ items: aiItems, rawContent: aiRaw } = await extractBoqWithOpenAI({ text: csvText, fileName: req.file.originalname }));
      } else if (ext === ".pdf") {
        const text = await extractTextFromPdf(req.file.path);
        ({ items: aiItems, rawContent: aiRaw } = await extractBoqWithOpenAI({ text, fileName: req.file.originalname }));
      } else if (ext === ".docx") {
        const text = await extractTextFromDocx(req.file.path);
        ({ items: aiItems, rawContent: aiRaw } = await extractBoqWithOpenAI({ text, fileName: req.file.originalname }));
      } else if (ext === ".txt") {
        const text = await extractTextFromTxt(req.file.path);
        ({ items: aiItems, rawContent: aiRaw } = await extractBoqWithOpenAI({ text, fileName: req.file.originalname }));
      } else if ([".png", ".jpg", ".jpeg"].includes(ext)) {
        const buffer = await fs.readFile(req.file.path);
        const imageBase64 = buffer.toString("base64");
        const imageExt = ext.replace(".", "");
        ({ items: aiItems, rawContent: aiRaw } = await extractBoqWithOpenAI({ imageBase64, imageExt, fileName: req.file.originalname }));
      } else {
        // Fallback: if no structured parse and not a handled type, try text anyway
        try {
          const text = await fs.readFile(req.file.path, "utf-8");
          ({ items: aiItems, rawContent: aiRaw } = await extractBoqWithOpenAI({ text, fileName: req.file.originalname }));
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.error("[boq/extract] OpenAI BOQ extraction failed:", err);
    }

    const items = aiItems.length ? aiItems : parsed.items;
    console.log("[boq/extract] Parsed items:", parsed.items.length, "| AI items:", aiItems.length);
    if (aiRaw) console.log("[boq/extract] AI raw preview:", aiRaw.slice(0, 500));

    res.status(200).json({ boqItems: items, rawContent: aiRaw || parsed.rawContent || "" });
  } catch (error) {
    next(error);
  }
});

router.post("/boq/enrich", async (req, res, next) => {
  try {
    const boqItems = Array.isArray(req.body.boqItems) ? (req.body.boqItems as ExtractedItem[]) : [];
    if (!boqItems.length) {
      return res.status(400).json({ message: "boqItems array is required" });
    }

    const { items, rawContent } = await enrichBoqItemsWithOpenAI(boqItems);
    console.log("[boq/enrich] enriched items count:", items.length);
    if (rawContent) {
      console.log("[boq/enrich] OpenAI response preview:", rawContent.slice(0, 500));
    }
    res.status(200).json({ items, rawContent });
  } catch (error) {
    next(error);
  }
});

router.post("/compare-lists", async (req, res, next) => {
  try {
    const drawingItems = Array.isArray(req.body.drawingItems) ? req.body.drawingItems : [];
    const boqItems = Array.isArray(req.body.boqItems) ? req.body.boqItems : [];

    const { comparisons, rawContent } = await comparePreExtractedLists(
      drawingItems as ExtractedItem[],
      boqItems as ExtractedItem[]
    );

    res.status(200).json({ comparisons, rawContent });
  } catch (error) {
    next(error);
  }
});

export default router;

