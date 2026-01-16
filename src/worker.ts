import { initMongo } from "./config/mongo";
import { startProjectExtractionWorker } from "./services/extraction/projectExtractionWorker";

async function startWorker() {
  await initMongo();
  startProjectExtractionWorker();
  console.log("Project extraction worker started.");
}

startWorker().catch((error) => {
  console.error("Failed to start worker", error);
  process.exit(1);
});
