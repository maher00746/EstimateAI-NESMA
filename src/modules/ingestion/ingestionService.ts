import { randomUUID } from "crypto";
import { Express } from "express";
import { parseDocument } from "../../services/parsing/parsingPipeline";
import { saveBuild } from "../storage/buildRepository";

export async function ingestBuild(file: Express.Multer.File, requestId?: string) {
  const uid = requestId ?? randomUUID();
  const parsed = await parseDocument(file.path);

  const saved = await saveBuild({
    requestId: uid,
    originalName: file.originalname,
    filePath: file.path,
    attributes: parsed.attributes,
    totalPrice: parsed.totalPrice,
  });

  return saved;
}

