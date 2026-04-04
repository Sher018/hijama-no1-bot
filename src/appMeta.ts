import { readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "./paths.js";

/** Версия из package.json рядом с процессом (в контейнере Amvera — корень /app). */
export function getAppVersion(): string {
  try {
    const pkgPath = path.join(projectRoot(), "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
