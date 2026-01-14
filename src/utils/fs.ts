import fs from "fs/promises";

export async function ensureDirectoryExists(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

