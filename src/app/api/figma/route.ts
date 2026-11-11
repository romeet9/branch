import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runClaude } from "@/lib/claude";

export const maxDuration = 300;

const Body = z.object({
  html: z.string().min(1),
  fileKey: z.string().regex(/^[0-9a-zA-Z]{22,128}$/).optional(),
  name: z.string().default("Branch iteration"),
});

/**
 * Sends a rendered iteration to Figma as editable layers.
 * Claude Code (with your Figma MCP) asks Figma for a one-time upload URL via
 * html_to_figma; this route then posts the HTML to it.
 * With no fileKey, Claude creates a "Branch" design file in your drafts first;
 * the client remembers the returned key and reuses it.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message : String(e);
    return Response.json({ error: msg }, { status: 400 });
  }

  try {
    const id = randomUUID();
    const label = body.name.replace(/"/g, "'");
    const target = body.fileKey
      ? `First call create_session with fileKey "${body.fileKey}" and description "Branch: import ${label}".`
      : `First call whoami and take the key of the user's first plan. Call create_new_file with fileName "Branch", editorType "design" and that planKey. Then call create_session with the new file's key and description "Branch: import ${label}".`;
    const { uploadUrl, fileKey } = await runClaude<{ uploadUrl: string; fileKey: string }>({
      prompt: `Use the Figma MCP. ${target} Then call html_to_figma with that fileKey, the sessionId from create_session, promptId "${id}" and cssSelector "[data-branch-design]". Don't upload anything yourself. Reply with the single-use upload URL it returns and the fileKey you used.`,
      schema: {
        type: "object",
        properties: {
          uploadUrl: { type: "string", description: "The single-use URL html_to_figma returned" },
          fileKey: { type: "string", description: "The Figma file key the design goes into" },
        },
        required: ["uploadUrl", "fileKey"],
        additionalProperties: false,
      },
      allowedTools:
        "mcp__plugin_figma_figma__whoami mcp__plugin_figma_figma__create_new_file mcp__plugin_figma_figma__create_session mcp__plugin_figma_figma__html_to_figma",
      effort: "low",
      timeoutMs: 180_000,
    });
    if (!/^https:\/\//.test(uploadUrl)) throw new Error("Figma didn't return an upload URL.");

    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "text/html" },
      body: body.html,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Figma rejected the upload (${res.status}): ${text.slice(0, 200)}`);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    const url =
      (data.url as string) ??
      (data.fileUrl as string) ??
      text.match(/https:\/\/www\.figma\.com\/design\/[^\s"']+/)?.[0] ??
      `https://www.figma.com/design/${fileKey}`;
    return Response.json({ url, fileKey, raw: data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json(
      {
        error: /html_to_figma|create_session|create_new_file|whoami|mcp/i.test(msg)
          ? `${msg} (Is the Figma MCP connected in Claude Code? Check with \`claude mcp list\`.)`
          : msg,
      },
      { status: 500 },
    );
  }
}
