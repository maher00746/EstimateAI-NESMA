import mongoose from "mongoose";
import { config } from "./index";

export async function initMongo(): Promise<void> {
  mongoose.set("strictQuery", false);
  
  // Parse the base URI without query params
  const baseUri = config.mongoUri.split('?')[0];
  
  // Connect with explicit options to avoid malformed write concern
  await mongoose.connect(baseUri, {
    w: 'majority',
    wtimeoutMS: 2500,
  });
  
  console.log("MongoDB connected");
}

