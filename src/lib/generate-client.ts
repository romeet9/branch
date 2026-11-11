export type Variant = { title: string; kind?: string; rationale: string; code: string };
export type GenEvent =
  | { t: "thinking" }
  | { t: "tool"; id: string; name: string; input: Record<string, unknown> }
  | { t: "tool_done"; id: string; error: boolean }
  | { t: "usage"; pct: number };

/** Calls /api/generate and reads its NDJSON stream: live steps, then the variants. */
export async function runGenerate(body: unknown, onEvent?: (e: GenEvent) => void, signal?: AbortSignal): Promise<Variant[]> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.t === "result") return e.variants as Variant[];
      if (e.t === "error") throw new Error(e.message);
      onEvent?.(e as GenEvent);
    }
  }
  throw new Error("Claude Code ended without an answer.");
}

/** "Read" + "Badge.md" from a Claude Code tool call. */
export function describeTool(name: string, input: Record<string, unknown>): { verb: string; target: string } {
  const base = (p: unknown) => String(p ?? "").split("/").pop() || String(p ?? "");
  if (name === "Read") return { verb: "Read", target: base(input.file_path) };
  if (name === "Glob") return { verb: "Searched", target: String(input.pattern ?? "files").replace("**/", "") };
  if (name === "Grep") return { verb: "Searched", target: `for “${String(input.pattern ?? "")}”` };
  return { verb: name, target: "" };
}
