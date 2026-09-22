import { loadEnvFile } from "node:process";
import path from "node:path";

export function loadLocalEnv(filePath = path.join(process.cwd(), ".env.local")) {
  try {
    loadEnvFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

loadLocalEnv();
