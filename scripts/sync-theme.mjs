// Copies Weft's Tailwind theme next to the studio CSS (Turbopack's Tailwind step
// doesn't resolve the package import). Runs before dev and build.
import { readFileSync, writeFileSync } from "node:fs";
const src = "node_modules/@greenloom-ai/weft/dist/theme.css";
const css = readFileSync(src, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^@source[^\n]*\n/m, '@source "../../../node_modules/@greenloom-ai/weft/dist";\n');
writeFileSync("src/app/(studio)/weft-theme.css", "/* Generated from @greenloom-ai/weft by scripts/sync-theme.mjs. Don't edit. */\n" + css);
