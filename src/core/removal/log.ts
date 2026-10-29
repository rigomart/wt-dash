import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendLog(logPath: string, value: object) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(value) + "\n");
}
