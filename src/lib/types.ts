export type Status = "generating" | "fixing" | "rendering" | "ready" | "error";
export type FigmaState = { state: "sending" } | { state: "sent"; url: string } | { state: "failed"; error: string };
export type Theme = "light" | "dark";
export type Model = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";

export type IterNode = {
  id: string;
  parentId: string | null;
  ver: string;
  title: string;
  kind?: string;
  prompt: string;
  rationale?: string;
  code?: string;
  status: Status;
  error?: string;
  repaired: boolean;
  figma?: FigmaState;
  /** Claude's pick among sibling iterations; shown as a status under the frame. */
  recommended?: boolean;
  pos: { x: number; y: number };
  size?: { w: number; h: number };
  /** The design's own corner radius (reported by the renderer). */
  radius?: number;
  /** Demo nodes keep their status (generating / fixing / error) instead of resolving. */
  frozen?: boolean;
  createdAt: number;
};

/** One Claude Code tool call, as shown in the chat's tool rail. */
export type Step = {
  id: string;
  verb: string;
  target: string;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt?: number;
};

/** One prompt in the chat and everything Claude did for it. */
export type Turn = {
  id: string;
  prompt: string;
  parentId?: string | null;
  parentVer?: string;
  count: number;
  model: Model;
  nodeIds: string[];
  status: "working" | "done" | "error" | "stopped";
  error?: string;
  steps: Step[];
  thinkingAt?: number;
  thinkingMs?: number;
  resultAt?: number;
  endedAt?: number;
  usagePct?: number;
  feedback?: "up" | "down";
  /** Canvas before this prompt ran, for Restore. */
  checkpoint?: IterNode[];
  /** Demo turns keep showing as in progress. */
  frozen?: boolean;
  createdAt: number;
};

export type Queued = { id: string; prompt: string; parentId: string | null; count: number; model: Model };

export const MODELS: { id: Model; name: string; note: string }[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", note: "Best design quality · ~1 min" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "Faster, still strong · ~30s" },
  { id: "claude-haiku-5-5", name: "Haiku 5.5", note: "Quick drafts · ~10s" },
];
