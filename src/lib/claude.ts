import "server-only";
import { spawn } from "node:child_process";

/**
 * Runs Claude Code headlessly (`claude -p`). It authenticates with your Claude
 * Code session: either the login on this machine, or CLAUDE_CODE_OAUTH_TOKEN
 * (from `claude setup-token`) if it's set in .env.local. No API key involved.
 */
export async function runClaude<T>(opts: {
  prompt: string;
  schema: object;
  /** Replaces Claude Code's default system prompt. */
  systemPrompt?: string;
  /** Built-in tools to enable ("" = none). */
  tools?: string;
  /** Tools that run without asking (built-ins or MCP, space separated). */
  allowedTools?: string;
  /** Only load MCP servers from --mcp-config (i.e. none). */
  noMcp?: boolean;
  cwd?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}): Promise<T> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--json-schema",
    JSON.stringify(opts.schema),
    "--model",
    opts.model ?? process.env.BRANCH_MODEL ?? "claude-opus-5-5",
    "--tools",
    opts.tools ?? "",
  ];
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
  if (opts.noMcp) args.push("--strict-mcp-config");

  const bin = process.env.CLAUDE_BIN ?? "claude";
  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude Code took too long and was stopped."));
    }, opts.timeoutMs ?? 300_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? "Claude Code isn't installed or not on PATH. Install it, or set CLAUDE_BIN in .env.local."
            : e.message,
        ),
      );
    });
    child.on("close", () => {
      clearTimeout(timer);
      let data: {
        is_error?: boolean;
        result?: string;
        structured_output?: T;
        subtype?: string;
      };
      try {
        data = JSON.parse(out);
      } catch {
        const hint = /log ?in|auth|token/i.test(err + out)
          ? " Sign in with `claude` once, or run `claude setup-token` and put the token in .env.local as CLAUDE_CODE_OAUTH_TOKEN."
          : "";
        reject(new Error(((err || out).trim().split("\n").pop() || "Claude Code failed.") + hint));
        return;
      }
      if (data.is_error || !data.structured_output) {
        reject(new Error(data.result || `Claude Code stopped (${data.subtype ?? "no output"}).`));
        return;
      }
      resolve(data.structured_output);
    });
    child.stdin.end(opts.prompt);
  });
}

/** Live events from a streaming Claude Code run. */
export type ClaudeEvent =
  | { t: "thinking" }
  | { t: "tool"; id: string; name: string; input: Record<string, unknown> }
  | { t: "tool_done"; id: string; error: boolean };

/**
 * Like runClaude, but streams Claude Code's events (thinking, each tool call and
 * its result) while it works, so the chat can show real steps. Resolves with the
 * structured output and how much of the context window the run used.
 */
export function streamClaude<T>(
  opts: Parameters<typeof runClaude>[0],
  onEvent: (e: ClaudeEvent) => void,
  signal?: AbortSignal,
): Promise<{ output: T; usagePct?: number }> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--json-schema",
    JSON.stringify(opts.schema),
    "--model",
    opts.model ?? process.env.BRANCH_MODEL ?? "claude-opus-5-5",
    "--tools",
    opts.tools ?? "",
  ];
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
  if (opts.noMcp) args.push("--strict-mcp-config");

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const toolIds = new Set<string>();
    let buf = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Claude Code took too long and was stopped.")));
    }, opts.timeoutMs ?? 300_000);
    signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Stopped")));
    });

    const handle = (line: string) => {
      let e: Record<string, any>;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === "assistant") {
        for (const b of e.message?.content ?? []) {
          if (b.type === "thinking") onEvent({ t: "thinking" });
          if (b.type === "tool_use" && b.name !== "StructuredOutput") {
            toolIds.add(b.id);
            onEvent({ t: "tool", id: b.id, name: b.name, input: b.input ?? {} });
          }
        }
      } else if (e.type === "user") {
        for (const b of e.message?.content ?? []) {
          if (b?.type === "tool_result" && toolIds.has(b.tool_use_id)) onEvent({ t: "tool_done", id: b.tool_use_id, error: !!b.is_error });
        }
      } else if (e.type === "result") {
        if (e.is_error || !e.structured_output) {
          finish(() => reject(new Error(e.result || `Claude Code stopped (${e.subtype ?? "no output"}).`)));
          return;
        }
        const u = e.usage ?? {};
        const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const windows = Object.values(e.modelUsage ?? {}).map((m: any) => m?.contextWindow).filter(Boolean) as number[];
        const window = windows[0] ?? 200_000;
        finish(() => resolve({ output: e.structured_output as T, usagePct: used ? Math.min(1, used / window) : undefined }));
      }
    };
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(line);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      finish(() =>
        reject(
          new Error(
            (e as NodeJS.ErrnoException).code === "ENOENT"
              ? "Claude Code isn't installed or not on PATH. Install it, or set CLAUDE_BIN in .env.local."
              : e.message,
          ),
        ),
      ),
    );
    child.on("close", () => {
      if (buf.trim()) handle(buf.trim());
      const hint = /log ?in|auth|token/i.test(err) ? " Sign in with `claude` once, or set CLAUDE_CODE_OAUTH_TOKEN in .env.local." : "";
      finish(() => reject(new Error((err.trim().split("\n").pop() || "Claude Code ended without an answer.") + hint)));
    });
    child.stdin.end(opts.prompt);
  });
}
