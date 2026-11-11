import { readFile } from "node:fs/promises";
import { z } from "zod";
import { streamClaude, type ClaudeEvent } from "@/lib/claude";
import { DOCS_DIR, readDsConfig, themeCssPath } from "@/lib/ds-config";

export const maxDuration = 300;

const RequestSchema = z.object({
  prompt: z.string().default(""),
  count: z.number().int().min(1).max(4).default(2),
  parent: z
    .object({ code: z.string(), prompt: z.string().optional(), title: z.string().optional() })
    .optional(),
  repair: z.object({ code: z.string(), error: z.string() }).optional(),
  model: z.enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]).optional(),
});

const variant = {
  type: "object",
  properties: {
    title: { type: "string", description: "2–3 word name for this direction, sentence case" },
    kind: {
      type: "string",
      description:
        "What the design is, as one or two words in Title Case, e.g. Card, Button, Badge, Form, Table, Modal, Empty state, Section, Page",
    },
    rationale: { type: "string", description: "One sentence: what this direction does differently" },
    code: { type: "string", description: "The complete TSX module" },
  },
  required: ["title", "kind", "rationale", "code"],
  additionalProperties: false,
};
const outputSchema = {
  type: "object",
  properties: { variants: { type: "array", items: variant, minItems: 1, maxItems: 4 } },
  required: ["variants"],
  additionalProperties: false,
};
type Out = { variants: { title: string; kind: string; rationale: string; code: string }[] };

async function tokens(theme: string | null) {
  if (!theme) return "";
  try {
    const css = await readFile(theme, "utf8");
    const colors = [...new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]))].filter(
      (t) => !/^(weft|zinc|green|red|amber|blue)-/.test(t),
    );
    const type = [...new Set([...css.matchAll(/@utility (type-[a-z0-9-]+)/g)].map((m) => m[1]))];
    return `\nColour tokens (bg-*, text-*, border-*): ${colors.join(", ")}\nType utilities: ${type.join(", ")}\n`;
  } catch {
    return "";
  }
}

function systemPrompt(pkg: string, tokenList: string) {
  return `You are a product designer who designs by writing React with one design system: ${pkg}.

Your working directory holds that design system's agent docs. Before writing code, read SKILL.md, then read the doc of every component you use (references/components/<Name>.md, or references/types.d.ts if that's what exists). Use the exact props from the docs. Never guess a prop.

Each design is ONE complete TSX module:
- \`export default function Design()\`, no props.
- Imports only from 'react', '${pkg}' and '@remixicon/react'.
- Self-contained realistic mock data. No fetch, no timers, no storage.
- The root element IS the design (the card, the button group, the form…). No page wrapper: no min-h-screen, no page background, no outer padding or centring. It's shown on a canvas like a Figma frame.
- Give the root a fixed width that suits it, using the width scale (w-72, w-80, w-96, w-md, w-lg, w-xl, w-2xl, w-3xl, w-5xl). A lone button or badge can size to its content.
- Use a design-system component whenever one exists. Style layout only with Tailwind utilities on the design system's tokens (below) and the 4px spacing scale. No hex codes, no arbitrary values like p-[13px], no inline colour styles, no default Tailwind palette (it's switched off).
- Follow every rule in SKILL.md (copy style, one primary button per view, and so on).
${tokenList}
Answer only with the structured output.`;
}

export async function POST(req: Request) {
  const cfg = readDsConfig();
  if (!cfg) {
    return Response.json({ error: "Connect a Storybook first (npm run connect -- <path>)." }, { status: 400 });
  }
  let body: z.infer<typeof RequestSchema>;
  try {
    body = RequestSchema.parse(await req.json());
  } catch (e) {
    return Response.json({ error: `Bad request: ${String(e)}` }, { status: 400 });
  }

  const sys = systemPrompt(cfg.name, await tokens(themeCssPath(cfg)));
  let prompt: string;
  if (body.repair) {
    prompt = `This design failed to render.\n\n<error>\n${body.repair.error}\n</error>\n\n<code>\n${body.repair.code}\n</code>\n\nFix it with the smallest change; keep the design, copy and layout. Re-check the props of every component involved against its doc. Return exactly 1 variant.`;
  } else if (body.parent) {
    prompt = `Current design${body.parent.title ? ` ("${body.parent.title}")` : ""}${
      body.parent.prompt ? `, made from "${body.parent.prompt}"` : ""
    }:\n\n<code>\n${body.parent.code}\n</code>\n\nIterate on it: ${body.prompt}\n\nReturn ${body.count} variants. Each applies the request in a clearly different direction (not small tweaks of each other) and keeps what the request doesn't ask to change.`;
  } else {
    prompt = `Design this: ${body.prompt}\n\nReturn ${body.count} variants, each a clearly different direction.`;
  }

  // Stream newline-delimited JSON: Claude Code's live steps, then the result.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        const { output, usagePct } = await streamClaude<Out>(
          {
            prompt,
            schema: outputSchema,
            systemPrompt: sys,
            tools: "Read,Glob,Grep",
            allowedTools: "Read Glob Grep",
            noMcp: true,
            cwd: DOCS_DIR,
            model: body.model,
            effort: body.repair ? "low" : "medium",
          },
          (e: ClaudeEvent) => send(e),
          req.signal,
        );
        if (usagePct != null) send({ t: "usage", pct: usagePct });
        send({ t: "result", variants: output.variants.slice(0, body.repair ? 1 : body.count) });
      } catch (e) {
        send({ t: "error", message: e instanceof Error ? e.message : String(e) });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
