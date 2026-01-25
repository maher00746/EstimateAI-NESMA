import express, { NextFunction, Request, Response } from "express";
import path from "path";
import cors from "cors";
import { config } from "./config";
import estimatesRouter from "./routes/estimates";
import projectsRouter from "./routes/projects";
import promptsRouter from "./routes/prompts";
import authRouter from "./routes/auth";
import productivityRatesRouter from "./routes/productivityRates";
import pricingRouter from "./routes/pricing";
import { authenticate } from "./middleware/auth";

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Public routes (no authentication required)
app.use("/api/auth", authRouter);
app.use("/files", express.static(path.resolve(config.staticDir)));

// Protected routes (authentication required)
app.use("/api/estimates", authenticate, estimatesRouter);
app.use("/api/projects", authenticate, projectsRouter);
app.use("/api/prompts", authenticate, promptsRouter);
app.use("/api/productivity-rates", authenticate, productivityRatesRouter);
app.use("/api/pricing", authenticate, pricingRouter);

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

export default app;

