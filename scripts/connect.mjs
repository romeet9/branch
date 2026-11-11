// Connects Branch to a Storybook design-system project on this machine.
// Usage: npm run connect -- <path to the repo or package> [storybook url]
//
// It finds the package that has a .storybook folder, packs and installs it,
// copies its agent docs (a Claude Code skill folder with SKILL.md) for Claude
// to read, and records everything in branch.config.json.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , srcArg, storybookUrl] = process.argv;
if (!srcArg) {
  console.error("Usage: npm run connect -- <path to your design system repo> [storybook url]");
  process.exit(1);
}
const root = path.resolve(srcArg.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
if (!existsSync(root)) fail(`Folder not found: ${root}`);

const skip = new Set(["node_modules", ".git", "dist", "storybook-static", ".next"]);
function walk(dir, depth, visit) {
  if (depth < 0) return;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (skip.has(e)) continue;
    const p = path.join(dir, e);
    let s; try { s = statSync(p); } catch { continue; }
    visit(p, e, s);
    if (s.isDirectory()) walk(p, depth - 1, visit);
  }
}
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
const step = (m) => console.log(`• ${m}`);

// 1. The package with a .storybook folder
let pkgDir = existsSync(path.join(root, ".storybook")) && existsSync(path.join(root, "package.json")) ? root : null;
if (!pkgDir) walk(root, 3, (p, e, s) => { if (!pkgDir && e === ".storybook" && s.isDirectory() && existsSync(path.join(path.dirname(p), "package.json"))) pkgDir = path.dirname(p); });
if (!pkgDir) fail("No Storybook found (looked for a .storybook folder next to a package.json).");
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
step(`Storybook package: ${pkg.name}@${pkg.version}  (${path.relative(root, pkgDir) || "."})`);

// 2. Theme CSS (Tailwind v4 theme the components are styled with)
const exp = pkg.exports ?? {};
const themeKey = ["./theme.css", "./tailwind.css", "./styles.css"].find((k) => exp[k]);
const themeFile = themeKey ? (typeof exp[themeKey] === "string" ? exp[themeKey] : exp[themeKey].default) : null;
if (!themeFile) console.warn("! No theme.css export found; layout classes may render unstyled.");
const built = existsSync(path.join(pkgDir, (pkg.module ?? pkg.main ?? "dist/index.js").replace(/^\.\//, "")));
if (!built) { step("Building the package…"); execSync("npm run build", { cwd: pkgDir, stdio: "inherit" }); }

// 3. Stories
let stories = 0;
walk(pkgDir, 6, (p, e) => { if (/\.stories\.(t|j)sx?$/.test(e) && !e.startsWith("_")) stories++; });
step(`${stories} story files`);

// 4. Agent docs: a skill folder with SKILL.md + references/
let skillDir = null;
walk(root, 6, (p, e) => { if (!skillDir && e === "SKILL.md" && existsSync(path.join(path.dirname(p), "references"))) skillDir = path.dirname(p); });
rmSync("ds-docs", { recursive: true, force: true });
let components = 0;
if (skillDir) {
  cpSync(skillDir, "ds-docs", { recursive: true });
  const refs = path.join("ds-docs", "references", "components");
  components = existsSync(refs) ? readdirSync(refs).filter((f) => f.endsWith(".md")).length : 0;
  step(`Agent docs: ${path.relative(root, skillDir)} (${components} component docs)`);
} else {
  // No agent docs: give Claude the type definitions instead.
  const dts = path.join(pkgDir, (pkg.types ?? "dist/index.d.ts").replace(/^\.\//, ""));
  mkdirSync("ds-docs/references", { recursive: true });
  if (existsSync(dts)) cpSync(dts, "ds-docs/references/types.d.ts");
  writeFileSync("ds-docs/SKILL.md", `# ${pkg.name}\n\nNo agent docs were found. Read references/types.d.ts for every exported component and its props before using it.\n`);
  step("No agent docs found; using the package's type definitions");
}

// 5. Pack + install (works for private registries too: nothing is downloaded)
mkdirSync("vendor", { recursive: true });
// Keep Weft: Branch's own UI is built with it, whatever design system is connected.
for (const f of readdirSync("vendor")) if (f.endsWith(".tgz") && !f.startsWith("greenloom-ai-weft-")) rmSync(path.join("vendor", f));
step("Packing the package…");
const tgz = execSync(`npm pack --pack-destination "${path.resolve("vendor")}"`, { cwd: pkgDir }).toString().trim().split("\n").pop();
step("Installing…");
execSync(`npm i "./vendor/${tgz}"`, { stdio: "inherit" });
cpSync("node_modules/@tailwindcss/browser/dist/index.global.js", "public/tw-browser.js");

// 6. The renderer imports the design system through src/ds
mkdirSync("src/ds", { recursive: true });
writeFileSync("src/ds/index.ts", `// Written by npm run connect. The connected design system.\nexport * from ${JSON.stringify(pkg.name)};\nexport const DS_NAME = ${JSON.stringify(pkg.name)};\n`);

writeFileSync("branch.config.json", JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  sourceDir: root,
  storybookUrl: storybookUrl || undefined,
  themeFile,
  components,
  stories,
  hasAgentDocs: !!skillDir,
  connectedAt: new Date().toISOString(),
}, null, 2) + "\n");
console.log(`✓ Connected ${pkg.name}. Restart the app (npm run dev) to load it.`);
