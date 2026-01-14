import app from "./app";
import { config } from "./config";
import { ensureDirectoryExists } from "./utils/fs";
import { initMongo } from "./config/mongo";

async function start() {
    await ensureDirectoryExists(config.uploadDir);
    await ensureDirectoryExists(config.staticDir);
    await initMongo();
    app.listen(config.port, () => {
        console.log(`Server listening on http://localhost:${config.port}`);
    });
}

start().catch((error) => {
    console.error("Failed to start server", error);
    process.exit(1);
});

