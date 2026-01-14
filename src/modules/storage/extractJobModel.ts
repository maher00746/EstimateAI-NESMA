import mongoose, { Schema } from "mongoose";

export type ExtractJobStatus = "queued" | "processing" | "done" | "failed";

export type ExtractJobStage =
  | "queued"
  | "landingai-parse"
  | "landingai-extract"
  | "gemini"
  | "finalizing";

export type ExtractJobFile = {
  originalName: string;
  storedPath: string;
  storedName: string;
};

export interface ExtractJobDocument extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  idempotencyKey: string;
  status: ExtractJobStatus;
  stage?: ExtractJobStage;
  message?: string;
  files: ExtractJobFile[];
  result?: unknown; // { files: [...] } payload when done
  error?: { message: string; details?: unknown };
  startedAt?: Date;
  finishedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ExtractJobSchema = new Schema<ExtractJobDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    idempotencyKey: { type: String, required: true },
    status: { type: String, required: true, index: true },
    stage: { type: String },
    message: { type: String },
    files: {
      type: [
        {
          originalName: { type: String, required: true },
          storedPath: { type: String, required: true },
          storedName: { type: String, required: true },
        },
      ],
      default: [],
    },
    result: { type: Schema.Types.Mixed, default: null },
    error: {
      type: Schema.Types.Mixed,
      default: null,
    },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    // TTL cleanup: delete job documents after expiry.
    // Mongo TTL indexes require a Date field.
    expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true }
);

// Enforce idempotency per-user.
ExtractJobSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });

export const ExtractJobModel =
  mongoose.models.ExtractJob ?? mongoose.model<ExtractJobDocument>("ExtractJob", ExtractJobSchema);

