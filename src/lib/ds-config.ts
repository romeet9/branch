import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

/** What `npm run connect` (or the Connect form) wrote about the connected Storybook. */
export type DsConfig = {
  name: string;
  version: string;
  sourceDir: string;
  storybookUrl?: string;
  components: number;
  stories: number;
  hasAgentDocs: boolean;
  themeFile?: string | null;
  connectedAt: string;
};

export const CONFIG_PATH = path.join(process.cwd(), "branch.config.json");
export const DOCS_DIR = path.join(process.cwd(), "ds-docs");

export function readDsConfig(): DsConfig | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as DsConfig;
  } catch {
    return null;
  }
}

export function themeCssPath(cfg: DsConfig | null) {
  if (!cfg?.themeFile) return null;
  return path.join(process.cwd(), "node_modules", cfg.name, cfg.themeFile.replace(/^\.\//, ""));
}
