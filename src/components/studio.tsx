"use client";

import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  getBezierPath,
  Handle,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  Badge,
  Button,
  ButtonGroup,
  Divider,
  SkeletonLoader,
  Spinner,
  TabItem,
  TabList,
  Tabs,
  Tag,
  TextInput,
  Textarea,
  cn,
} from "@greenloom-ai/weft";
import {
  RiAddLine,
  RiArrowUpLine,
  RiCursorLine,
  RiDeleteBinLine,
  RiEditLine,
  RiInformationLine,
  RiExternalLinkLine,
  RiFigmaLine,
  RiFileCopyLine,
  RiFullscreenLine,
  RiGitBranchLine,
  RiHand,
  RiLayoutGridLine,
  RiMoonLine,
  RiLayoutRightLine,
  RiSubtractLine,
  RiSunLine,
} from "@remixicon/react";
import { FRAME_PAD, Frame, type FrameStatus, type Snapshotter } from "./preview";
import type { DsConfig } from "@/lib/ds-config";

// ------------------------------------------------------------------ model

import type { IterNode, Model, Queued, Theme, Turn } from "@/lib/types";
import { describeTool, runGenerate } from "@/lib/generate-client";
import { ChatPanel } from "./chat";

const STORAGE_KEY = "branch:canvas:v5";
const FIGMA_KEY = "branch:figma-file";
const THEME_KEY = "branch:theme";
const PLACEHOLDER = { w: 320, h: 200 };
const GAP_X = 200;
const GAP_Y = 96;
const PRIMARY = "var(--color-action-primary)";
const uid = () => Math.random().toString(36).slice(2, 10);
/** Canvas footprint. Error and generating frames get room for their tile even if the design is tiny. */
const sizeOf = (n: IterNode) => {
  const s = n.size ?? PLACEHOLDER;
  return n.status === "error" || n.status === "generating" ? { w: Math.max(s.w, 300), h: Math.max(s.h, 176) } : s;
};

function loadState(): { nodes: IterNode[]; turns: Turn[]; manual: boolean } {
  const empty: { nodes: IterNode[]; turns: Turn[]; manual: boolean } = { nodes: [], turns: [], manual: false };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as typeof empty | null;
    if (!raw) return empty;
    return {
      manual: raw.manual,
      turns: (raw.turns ?? []).map((t) => {
        const base = { ...t, steps: t.steps ?? [], model: t.model ?? ("claude-opus-5-5" as Model) };
        return t.status === "working" && !t.frozen ? { ...base, status: "error" as const, error: "Interrupted.", endedAt: Date.now() } : base;
      }),
      nodes: raw.nodes.map((n) => ({
        ...n,
        figma: n.figma?.state === "sending" ? undefined : n.figma,
        ...(n.frozen
          ? {}
          : n.status === "generating" || n.status === "fixing"
            ? { status: "error" as const, error: "Interrupted. Try again." }
            : n.status === "ready"
              ? { status: "rendering" as const }
              : {}),
      })),
    };
  } catch {
    return empty;
  }
}

function kindOf(n: IterNode) {
  if (n.kind) return n.kind;
  const m = n.code?.match(/import\s*\{\s*([A-Z]\w*)/);
  return m?.[1] ?? "Design";
}

/** Tidy tree layout: subtrees as blocks, parents level with the middle of their children. */
function tidy(nodes: IterNode[]): IterNode[] {
  const kids = new Map<string | null, IterNode[]>();
  for (const n of nodes) {
    const k = n.parentId && nodes.some((p) => p.id === n.parentId) ? n.parentId : null;
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => a.ver.localeCompare(b.ver, undefined, { numeric: true }));
  const height = new Map<string, number>();
  const h = (n: IterNode): number => {
    const ch = kids.get(n.id) ?? [];
    const sub = ch.reduce((s, c) => s + h(c), 0) + Math.max(0, ch.length - 1) * GAP_Y;
    const v = Math.max(sizeOf(n).h, sub);
    height.set(n.id, v);
    return v;
  };
  const pos = new Map<string, { x: number; y: number }>();
  const place = (n: IterNode, x: number, top: number) => {
    const total = height.get(n.id)!;
    pos.set(n.id, { x, y: top + (total - sizeOf(n).h) / 2 });
    const ch = kids.get(n.id) ?? [];
    const sub = ch.reduce((s, c) => s + height.get(c.id)!, 0) + Math.max(0, ch.length - 1) * GAP_Y;
    let y = top + (total - sub) / 2;
    for (const c of ch) {
      place(c, x + sizeOf(n).w + GAP_X, y);
      y += height.get(c.id)! + GAP_Y;
    }
  };
  let top = 0;
  for (const r of kids.get(null) ?? []) {
    h(r);
    place(r, 0, top);
    top += height.get(r.id)! + GAP_Y * 2;
  }
  return nodes.map((n) => ({ ...n, pos: pos.get(n.id) ?? n.pos }));
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}
type Variants = { variants: { title: string; kind?: string; rationale: string; code: string }[] };
const fileKeyOf = (s: string) =>
  s.match(/figma\.com\/(?:design|file)\/([0-9a-zA-Z]{22,128})/)?.[1] ?? (/^[0-9a-zA-Z]{22,128}$/.test(s.trim()) ? s.trim() : null);

// ------------------------------------------------------------------ canvas node

type DesignData = {
  node: IterNode;
  theme: Theme;
  onStatus: (id: string, s: FrameStatus) => void;
  registerSnapshot: (id: string, fn: Snapshotter) => void;
  onIterate: (id: string) => void;
  onFigma: (id: string) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onEditPrompt: (id: string) => void;
};
type DesignNodeT = Node<DesignData, "design">;

/** On-screen gap between a design and its ring, in px, at every zoom. */
const RING_GAP = 4;

/**
 * A ring concentric with the design: its radius is the design's own radius plus
 * the gap, so the gap is even all round (the old ring reused the card radius and
 * pinched at the corners).
 */
function Ring({ zoom, radius, color, width, dashed, className }: { zoom: number; radius: number; color: string; width: number; dashed?: boolean; className?: string }) {
  const gap = RING_GAP / zoom;
  return (
    <div
      className={cn("pointer-events-none absolute", className)}
      style={{ inset: -gap, borderRadius: radius + gap, border: `${width / zoom}px ${dashed ? "dashed" : "solid"} ${color}` }}
    />
  );
}

/** Dashed border drawn in SVG so the dashes can march. */
function Ants({ w, h, radius, color, slow }: { w: number; h: number; radius: number; color: string; slow?: boolean }) {
  return (
    <svg className="pointer-events-none absolute inset-0 overflow-visible" width={w} height={h}>
      <rect
        x={0.5}
        y={0.5}
        width={Math.max(0, w - 1)}
        height={Math.max(0, h - 1)}
        rx={Math.max(0, radius - 0.5)}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeDasharray="4 2"
        className={slow ? "branch-ants-slow" : "branch-ants"}
      />
    </svg>
  );
}

const DesignNode = memo(function DesignNode({ data, selected }: NodeProps<DesignNodeT>) {
  const { node: n, theme } = data;
  const zoom = useStore((s) => s.transform[2]);
  const { w, h } = sizeOf(n);
  const generating = n.status === "generating";
  const fixing = n.status === "fixing";
  const failed = n.status === "error";
  const busy = generating || fixing;
  const radius = n.radius ?? 14;
  const [copied, setCopied] = useState<"code" | "error" | null>(null);
  // A new frame scales in from its left edge as its connector arrives (children wait for the line).
  const [enter] = useState(() => generating);
  const f = n.figma;
  const onFrameStatus = useCallback((s: FrameStatus) => data.onStatus(n.id, s), [data, n.id]);
  const onRegister = useCallback((fn: Snapshotter) => data.registerSnapshot(n.id, fn), [data, n.id]);
  const copy = async (what: "code" | "error") => {
    const text = what === "code" ? n.code : n.error;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1200);
  };
  // Labels keep their on-screen size at every zoom, like Figma frame names.
  // They sit a fixed 8px (on screen) above the ring, which itself is 4px outside the design.
  const lift = (RING_GAP + 8) / zoom;
  const small = w < 300 || h < 200;
  const tags = (
    <span className="flex items-center gap-1">
      {generating && <Spinner accessibilityLabel="Designing" />}
      {f?.state === "sent" && (
        <a
          href={f.url}
          target="_blank"
          rel="noreferrer"
          title="In Figma · open the file"
          aria-label="In Figma"
          className="nodrag grid size-5 place-items-center rounded text-content-muted-foreground hover:bg-content-muted hover:text-surface-foreground"
        >
          <RiFigmaLine className="size-3.5" />
        </a>
      )}
      {fixing ? (
        <span className="flex items-center gap-1.5">
          <span className="branch-marker size-1.5 rounded-[1px] bg-feedback-notice-foreground" />
          <span className="type-body-xs text-content-muted-foreground">Fixing a render error</span>
        </span>
      ) : failed ? (
        <span className="flex items-center gap-1.5">
          <span className="branch-marker-slow size-1.5 rounded-[1px] bg-feedback-negative-foreground" />
          <span className="type-body-xs text-content-muted-foreground">Failed</span>
        </span>
      ) : (
        <Badge size="small" color={selected ? "primary" : "neutral"}>
          {generating ? "…" : kindOf(n)}
        </Badge>
      )}
    </span>
  );
  const label = { transform: `scale(${1 / zoom})`, transformOrigin: "bottom left", marginBottom: lift } as const;
  const tag = { transform: `scale(${1 / zoom})`, transformOrigin: "bottom right", marginBottom: lift } as const;
  const foot = { transform: `scale(${1 / zoom})`, transformOrigin: "top right", marginTop: lift } as const;
  const [reason, ...rest] = (n.error ?? "").split(/\n|(?<=\.)\s/);

  return (
    <div className={cn("group relative", enter && "branch-node-in")} style={{ width: w, height: h, ...(enter && n.parentId ? { animationDelay: "300ms" } : {}) }}>
      <Handle type="target" position={Position.Left} className="!pointer-events-none !opacity-0" />
      <Handle type="source" position={Position.Right} className="!pointer-events-none !opacity-0" />

      {/* recommended: a status line under the frame, bottom right (same marker style as Failed / Fixing) */}
      {n.recommended && !failed && !fixing && !generating && (
        <div className="absolute right-0 top-full z-10 flex items-center gap-1.5 whitespace-nowrap" style={foot}>
          <span className="size-1.5 rounded-[1px] bg-action-primary" />
          <span className="type-body-xs text-content-muted-foreground">Recommended</span>
        </div>
      )}

      {/* label (Figma-style): one row as wide as the frame on screen. The title truncates with "…" as you zoom out
          and fills back in as you zoom in; the status/kind tags drop out when there's no room for them. */}
      <div
        className="type-body-xs absolute bottom-full left-0 z-10 flex items-center gap-2 overflow-hidden whitespace-nowrap"
        style={{ ...label, width: w * zoom }}
      >
        <span className={cn("shrink-0 font-medium", selected ? "text-action-link" : "text-surface-foreground")}>{n.ver}</span>
        <span className="min-w-0 flex-1 truncate text-content-muted-foreground">{generating ? "Designing…" : n.title}</span>
        {w * zoom >= 150 && <span className="shrink-0">{tags}</span>}
      </div>

      {/* ambient edge light while a frame is being designed: green + yellow hugging the frame's edges, slowly turning */}
      {generating && (
        <div className="branch-ambient pointer-events-none absolute -inset-1 z-0" aria-hidden style={{ borderRadius: radius + 4 }}>
          {/* soft glow: the ring, blurred */}
          <div className="absolute inset-0" style={{ filter: "blur(10px)", opacity: 0.8 }}>
            <div className="branch-edge-ring absolute inset-0" style={{ borderRadius: radius + 4, padding: 5 }} />
          </div>
          {/* crisp edge */}
          <div className="branch-edge-ring absolute inset-0" style={{ borderRadius: radius + 4, padding: 1.5 }} />
        </div>
      )}

      {/* the design */}
      {n.code && !(failed && !n.size) && (
        <div className={cn("absolute", (fixing || failed) && "invisible")} style={{ left: -FRAME_PAD, top: -FRAME_PAD }}>
          <Frame id={n.id} code={n.code} theme={theme} onStatus={onFrameStatus} registerSnapshot={onRegister} />
        </div>
      )}

      {/* generating: skeleton in the design's footprint */}
      {generating && (
        <div className="absolute inset-0 overflow-hidden bg-surface-card" style={{ borderRadius: radius }}>
          <div className="flex h-full flex-col gap-3 p-4">
            <SkeletonLoader shape="text" lines={2} />
            <SkeletonLoader height={36} width="55%" />
            <SkeletonLoader shape="text" lines={3} />
            <div className="mt-auto">
              <SkeletonLoader height={32} />
            </div>
          </div>
        </div>
      )}

      {/* fixing: the error card in yellow, with a dot pattern instead of the error's 45° stripes */}
      {fixing && (
        <div className="branch-state-in absolute inset-0 overflow-hidden bg-feedback-notice-background-subtle" style={{ borderRadius: radius }}>
          <Ants w={w} h={h} radius={radius} color="var(--color-feedback-notice-foreground)" />
          <div
            className="branch-dots absolute inset-0"
            style={{
              backgroundImage: "radial-gradient(color-mix(in srgb, var(--color-feedback-notice-foreground) 45%, transparent) 1px, transparent 1.5px)",
              backgroundSize: "8px 8px",
            }}
          />
          <div
            className={cn(
              "absolute flex flex-col bg-surface-card",
              small ? "inset-x-2 top-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2" : "inset-x-[11px] bottom-3.5 gap-2.5 rounded-[10px] px-4 py-3.5",
            )}
          >
            <span className="type-body-sm-medium text-surface-foreground">{small ? "Fixing…" : `Fixing ${n.ver}…`}</span>
            <span className={cn("type-body-xs text-content-muted-foreground", !small && "line-clamp-3")}>
              {small ? "Try 1 of 1" : "It crashed while rendering. Claude is trying one fix · try 1 of 1."}
            </span>
          </div>
        </div>
      )}

      {/* error: calm footprint (card + hatch + dashed border) with a caption; actions live in the selection toolbar */}
      {failed && (
        <div className="branch-state-in absolute inset-0 overflow-hidden bg-surface-card" style={{ borderRadius: radius }}>
          <Ants w={w} h={h} radius={radius} color="var(--color-action-destructive)" slow />
          <div
            className="branch-stripes absolute inset-y-0 left-0 -right-4"
            style={{ backgroundImage: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-feedback-negative-foreground) 28%, transparent) 0 1px, transparent 1px 8px)" }}
          />
          <div
            className={cn(
              "absolute flex flex-col bg-surface-card",
              small ? "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2" : "bottom-3.5 left-[11px] gap-2.5 rounded-[10px] px-4 py-3.5",
            )}
            style={small ? undefined : { maxWidth: w - 22 }}
          >
            <span className="type-body-sm-medium text-surface-foreground">
              {small ? (n.code ? "Didn’t render" : "Couldn’t design") : n.code ? `${n.ver} didn’t render` : `Couldn’t design ${n.ver}`}
            </span>
            <span className={cn("type-body-xs text-content-muted-foreground", !small && "line-clamp-3")}>
              {small ? "Select for options" : [reason || "Something went wrong.", ...rest].join(" ")}
            </span>
          </div>
        </div>
      )}

      {/* ring: one element that eases between hover, selected and generating (blurs in on hover) */}
      <Ring
        zoom={zoom}
        radius={radius}
        width={selected ? 1.5 : 1}
        dashed={generating && !selected}
        color={selected ? (failed ? "var(--color-action-destructive)" : fixing ? "var(--color-feedback-notice-foreground)" : "var(--color-action-primary)") : failed ? "var(--color-action-destructive)" : fixing ? "var(--color-feedback-notice-foreground)" : "var(--color-line-input)"}
        className={cn(
          "transition-[opacity,filter,border-color,border-width] duration-200 ease-out",
          selected || generating ? "opacity-100 blur-none" : "opacity-0 blur-[2px] group-hover:opacity-100 group-hover:blur-none",
        )}
      />

      <NodeToolbar isVisible={selected} position={Position.Bottom} offset={14}>
        <div className="flex items-center gap-1 rounded-xl border border-line-border bg-surface-popover p-1 shadow-mid-raised">
          {failed ? (
            <>
              <Button variant="secondary" size="small" onClick={() => data.onRetry(n.id)}>
                Retry
              </Button>
              <Button variant="ghost" size="small" icon={RiEditLine} onClick={() => data.onEditPrompt(n.id)}>
                Edit prompt
              </Button>
              <Divider orientation="vertical" className="h-5" />
              <Button variant="ghost" size="small" icon={RiInformationLine} isDisabled={!n.error} onClick={() => copy("error")}>
                {copied === "error" ? "Copied" : "Details"}
              </Button>
            </>
          ) : (<>
          <Button variant="ghost" size="small" icon={RiGitBranchLine} isDisabled={!n.code || busy} onClick={() => data.onIterate(n.id)}>
            Iterate
          </Button>
          {f?.state === "sent" ? (
            <Button variant="secondary" size="small" icon={RiExternalLinkLine} href={f.url} target="_blank" rel="noreferrer">
              Open in Figma
            </Button>
          ) : (
            <Button variant="ghost" size="small" icon={RiFigmaLine} isLoading={f?.state === "sending"} isDisabled={n.status !== "ready"} onClick={() => data.onFigma(n.id)}>
              {f?.state === "failed" ? "Retry Figma" : "Send to Figma"}
            </Button>
          )}
          <Button variant="ghost" size="small" icon={RiFileCopyLine} isDisabled={!n.code} onClick={() => copy("code")}>
            {copied === "code" ? "Copied" : "Copy code"}
          </Button>
          <Divider orientation="vertical" className="h-5" />
          <Button variant="ghost" size="small" icon={RiDeleteBinLine} accessibilityLabel="Delete" onClick={() => data.onDelete(n.id)} />
          </>)}
        </div>
        {f?.state === "failed" && (
          <div className="type-body-xs mt-1 max-w-80 rounded-md bg-feedback-negative-background-subtle px-2 py-1 font-mono text-feedback-negative-foreground">{f.error}</div>
        )}
      </NodeToolbar>
    </div>
  );
});

const nodeTypes = { design: DesignNode };

/**
 * Connector. Clean at rest; motion only where something is happening:
 * - branch: the line grows out of the parent's port (the port pops) and lands on the child as it scales in
 * - working: a soft comet (glow head + fading tail) travels parent -> child, green while designing, yellow while fixing
 * - done: one brighter pulse runs the line, then it settles to its rest colour
 * - error: the line snaps back toward the parent, leaving a static red dashed line
 * - lineage: edges above the selected frame glow green, tracing down from the root
 * Every stroke and dot keeps its on-screen size at every zoom (widths are divided by zoom).
 */
type EdgeStatus = IterNode["status"];
type EdgeData = { ports?: boolean; status?: EdgeStatus; lineage?: number; hot?: boolean };
const NOTICE = "var(--color-feedback-notice-foreground)";
const DESTRUCTIVE = "var(--color-action-destructive)";
const isBusy = (s?: EdgeStatus) => s === "generating" || s === "fixing";

const DotEdge = memo(function DotEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data }: EdgeProps) {
  const zoom = useStore((s) => s.transform[2]);
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const d = (data ?? {}) as EdgeData;
  const status = d.status;
  const color = (style?.stroke as string) ?? "var(--color-line-input)";
  const width = Number(style?.strokeWidth ?? 1.5);
  const flow = status === "generating" ? PRIMARY : status === "fixing" ? NOTICE : null;

  // A freshly branched child (it mounts while generating) gets the full branching moment.
  const [fresh, setFresh] = useState(() => status === "generating");
  // One-shot effects on status transitions (derived during render, React's "previous value" pattern).
  const [prev, setPrev] = useState(status);
  const [fx, setFx] = useState<{ kind: "done" | "snap"; key: number } | null>(null);
  if (status !== prev) {
    setPrev(status);
    const key = (fx?.key ?? 0) + 1;
    if (status === "error" && prev !== "error") setFx({ kind: "snap", key });
    else if (isBusy(prev) && !isBusy(status)) setFx({ kind: "done", key });
  }
  const clearFx = () => setFx(null);

  const port = {
    r: 3 / zoom,
    fill: color,
    stroke: "var(--color-content-muted)",
    strokeWidth: 1.5 / zoom,
    className: cn("branch-port transition-opacity duration-150", d.ports ? "opacity-100" : "opacity-0"),
  };
  const ring = (cx: number, cy: number, c: string, delay = "0ms", onEnd?: () => void) => (
    <circle cx={cx} cy={cy} r={4 / zoom} fill="none" stroke={c} strokeWidth={1.5 / zoom} className="branch-port-ring pointer-events-none" style={{ animationDelay: delay }} onAnimationEnd={onEnd} />
  );

  return (
    <>
      {/* lineage glow: a soft green underlay that traces down from the root to the selected frame */}
      {d.lineage !== undefined && (
        <path
          d={path}
          pathLength={1}
          fill="none"
          stroke={PRIMARY}
          strokeOpacity={0.2}
          strokeWidth={7 / zoom}
          strokeLinecap="round"
          className="branch-edge-trace pointer-events-none"
          style={{ animationDelay: `${d.lineage * 90}ms` }}
        />
      )}

      {/* the line itself; a new one grows out of the parent (dashed error lines skip it: pathLength would break their dashes) */}
      {/* every connector is a dotted line that runs parent → child: grey at rest, green while the child is
          being designed, yellow while it's being fixed. A failed child's line stops, in red. */}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={16}
        className={status === "error" ? undefined : "branch-edge-march"}
        style={
          {
            ...style,
            stroke: flow ?? color,
            strokeWidth: (flow ? width + 0.5 : width) / zoom,
            strokeLinecap: "round",
            strokeDasharray: `${4 / zoom} ${6 / zoom}`,
            "--period": `${10 / zoom}px`,
            animationDuration: status === "fixing" ? "0.45s" : flow ? "0.6s" : "1.2s",
            transition: "stroke 240ms ease-out",
          } as CSSProperties
        }
      />

      {/* done: one bright pulse runs the line, the line flashes and settles, the child's port pops */}
      {fx?.kind === "done" && (
        <g key={fx.key}>
          <path d={path} fill="none" stroke={PRIMARY} strokeWidth={2 / zoom} className="branch-edge-flash pointer-events-none" />
          {ring(targetX, targetY, PRIMARY, "560ms", clearFx)}
        </g>
      )}

      {/* error: the line snaps back toward the parent in red, leaving the dashed line behind */}
      {fx?.kind === "snap" && (
        <g key={fx.key}>
          <path d={path} pathLength={1} fill="none" stroke={DESTRUCTIVE} strokeWidth={2.5 / zoom} strokeLinecap="round" strokeDasharray="1 2" className="branch-edge-snap pointer-events-none" onAnimationEnd={clearFx} />
          {ring(targetX, targetY, DESTRUCTIVE)}
        </g>
      )}

      {/* branching: the parent's port pops as the line leaves it, and rings again where it lands */}
      {fresh && (
        <g className="pointer-events-none">
          <circle cx={sourceX} cy={sourceY} r={3.5 / zoom} fill={PRIMARY} className="branch-port-pop" />
          {ring(sourceX, sourceY, PRIMARY)}
          {ring(targetX, targetY, PRIMARY, "380ms", () => setFresh(false))}
        </g>
      )}

      <circle cx={sourceX} cy={sourceY} {...port} />
      <circle cx={targetX} cy={targetY} {...port} />
    </>
  );
});
const edgeTypes = { dot: DotEdge };

// ------------------------------------------------------------------ studio

export function Studio({ ds }: { ds: DsConfig | null }) {
  if (!ds) return <Connect />;
  return (
    <ReactFlowProvider>
      <Workspace ds={ds} />
    </ReactFlowProvider>
  );
}

type Tool = "move" | "hand";

function Workspace({ ds }: { ds: DsConfig }) {
  const rf = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const [nodes, setNodes] = useState<IterNode[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [manual, setManual] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [chatOpen, setChatOpen] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(2);
  const [theme, setTheme] = useState<Theme>("light");
  const [figmaFile, setFigmaFile] = useState("");
  const [model, setModel] = useState<Model>("claude-opus-5-5");
  const [queue, setQueue] = useState<Queued[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const manualRef = useRef(manual);
  manualRef.current = manual;
  const snapshots = useRef(new Map<string, Snapshotter>());

  useEffect(() => {
    const s = loadState();
    setNodes(s.nodes);
    // A saved demo canvas picks up the latest demo.json (designs, titles, the recommended pick) on load.
    if (s.nodes.some((n) => n.id.startsWith("demo-")))
      fetch("/demo.json")
        .then((r) => r.json())
        .then((demo: { nodes: IterNode[] }) => {
          const byId = new Map(demo.nodes.map((d) => [d.id, d]));
          setNodes((ns) =>
            ns.map((n) => {
              const d = byId.get(n.id);
              return d ? { ...n, code: d.code, title: d.title, kind: d.kind, recommended: d.recommended } : n;
            }),
          );
        })
        .catch(() => {});
    setTurns(s.turns);
    setManual(s.manual);
    try {
      setFigmaFile(localStorage.getItem(FIGMA_KEY) ?? "");
      setTheme(localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
    } catch {}
    setHydrated(true);
    if (s.nodes.length) requestAnimationFrame(() => rf.fitView({ padding: 0.2 }));
  }, [rf]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, turns, manual }));
      localStorage.setItem(FIGMA_KEY, figmaFile);
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [nodes, turns, manual, figmaFile, theme, hydrated]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const patch = useCallback((id: string, p: Partial<IterNode>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...p } : n)));
  }, []);
  const patchTurn = useCallback((id: string, p: Partial<Turn>) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  const from = selected.length === 1 ? nodes.find((n) => n.id === selected[0]) ?? null : null;
  const focusPrompt = () => {
    setChatOpen(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // ---------- generate (one chat turn, streamed)
  const runTurn = useCallback(
    async (job: { prompt: string; parentId: string | null; count: number; model: Model }) => {
      const parent = job.parentId ? nodesRef.current.find((n) => n.id === job.parentId) ?? null : null;
      if (job.parentId && !parent?.code) return;
      const all = nodesRef.current;
      const siblings = all.filter((n) => n.parentId === (parent?.id ?? null)).length;
      const fresh: IterNode[] = Array.from({ length: job.count }, (_, i) => ({
        id: uid(),
        parentId: parent?.id ?? null,
        ver: parent ? `${parent.ver}.${siblings + i + 1}` : `V${siblings + i + 1}`,
        title: "Designing…",
        prompt: job.prompt,
        status: "generating",
        repaired: false,
        pos: { x: 0, y: 0 },
        size: parent?.size,
        radius: parent?.radius,
        createdAt: Date.now(),
      }));
      const turn: Turn = {
        id: uid(),
        prompt: job.prompt,
        parentId: parent?.id ?? null,
        parentVer: parent?.ver,
        count: job.count,
        model: job.model,
        nodeIds: fresh.map((f) => f.id),
        status: "working",
        steps: [],
        checkpoint: all,
        createdAt: Date.now(),
      };
      setTurns((ts) => [...ts, turn]);
      setNodes((ns) => {
        if (!manualRef.current) return tidy([...ns, ...fresh]);
        const placed = [...ns];
        for (const f of fresh) {
          const s = PLACEHOLDER;
          let x = 0;
          let y = 0;
          if (parent) {
            const p = placed.find((n) => n.id === parent.id)!;
            x = p.pos.x + sizeOf(p).w + GAP_X;
            y = p.pos.y;
          } else {
            y = placed.reduce((m, n) => Math.max(m, n.pos.y + sizeOf(n).h + GAP_Y * 2), 0);
          }
          const hit = () => placed.find((n) => x < n.pos.x + sizeOf(n).w && x + s.w > n.pos.x && y < n.pos.y + sizeOf(n).h + GAP_Y && y + s.h + GAP_Y > n.pos.y);
          for (let o = hit(); o; o = hit()) y = o.pos.y + sizeOf(o).h + GAP_Y;
          placed.push({ ...f, pos: { x, y } });
        }
        return placed;
      });
      setTimeout(() => rf.fitView({ nodes: [...fresh, ...(parent ? [parent] : [])].map((n) => ({ id: n.id })), padding: 0.3, duration: 400, maxZoom: 1 }), 50);

      const ac = new AbortController();
      aborts.current.set(turn.id, ac);
      const upd = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === turn.id ? fn(t) : t)));
      try {
        const variants = await runGenerate(
          { prompt: job.prompt, count: job.count, model: job.model, parent: parent ? { code: parent.code, prompt: parent.prompt, title: parent.title } : undefined },
          (e) => {
            const now = Date.now();
            if (e.t === "thinking") upd((t) => (t.thinkingAt ? t : { ...t, thinkingAt: now }));
            if (e.t === "tool")
              upd((t) => ({
                ...t,
                thinkingMs: t.thinkingMs ?? (t.thinkingAt ? now - t.thinkingAt : undefined),
                steps: [...t.steps, { id: e.id, ...describeTool(e.name, e.input), status: "running", startedAt: now }],
              }));
            if (e.t === "tool_done") upd((t) => ({ ...t, steps: t.steps.map((s) => (s.id === e.id ? { ...s, status: e.error ? "error" : "done", endedAt: now } : s)) }));
            if (e.t === "usage") upd((t) => ({ ...t, usagePct: e.pct }));
          },
          ac.signal,
        );
        const now = Date.now();
        upd((t) => ({ ...t, resultAt: now, thinkingMs: t.thinkingMs ?? (t.thinkingAt ? now - t.thinkingAt : undefined) }));
        fresh.forEach((n, i) => {
          const v = variants[i];
          if (v) patch(n.id, { title: v.title, kind: v.kind, rationale: v.rationale, code: v.code, status: "rendering" });
          else patch(n.id, { status: "error", title: "Missing", error: "Claude returned fewer variants." });
        });
      } catch (e) {
        const stopped = ac.signal.aborted;
        const message = stopped ? "Stopped by you." : e instanceof Error ? e.message : String(e);
        fresh.forEach((n) => patch(n.id, { status: "error", title: stopped ? "Stopped" : "Couldn't design", error: message }));
        upd((t) => ({ ...t, status: stopped ? "stopped" : "error", error: message, endedAt: Date.now(), steps: t.steps.map((s) => (s.status === "running" ? { ...s, status: "error", endedAt: Date.now() } : s)) }));
      } finally {
        aborts.current.delete(turn.id);
      }
    },
    [patch, rf],
  );

  const busy = turns.some((t) => t.status === "working" && !t.frozen);
  const submit = useCallback(() => {
    const text = prompt.trim();
    if (!text) return;
    const job = { prompt: text, parentId: selected.length === 1 ? selected[0] : null, count, model };
    setPrompt("");
    if (turnsRef.current.some((t) => t.status === "working" && !t.frozen)) setQueue((q) => [...q, { id: uid(), ...job }]);
    else runTurn(job);
  }, [prompt, selected, count, model, runTurn]);

  // A turn is done once its frames have rendered (or failed).
  useEffect(() => {
    for (const t of turns) {
      if (t.status !== "working" || !t.resultAt || t.frozen) continue;
      const settled = t.nodeIds.every((id) => {
        const n = nodes.find((x) => x.id === id);
        return !n || n.status === "ready" || n.status === "error";
      });
      if (settled) patchTurn(t.id, { status: "done", endedAt: Date.now() });
    }
  }, [turns, nodes, patchTurn]);
  // Send the next queued prompt when Claude is free.
  useEffect(() => {
    if (busy || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    runTurn(next);
  }, [busy, queue, runTurn]);

  const stop = useCallback(() => {
    for (const ac of aborts.current.values()) ac.abort();
  }, []);
  const retryTurn = useCallback(
    (id: string) => {
      const t = turnsRef.current.find((x) => x.id === id);
      if (t) runTurn({ prompt: t.prompt, parentId: t.parentId ?? null, count: t.count, model: t.model });
    },
    [runTurn],
  );
  const restore = useCallback((id: string) => {
    const ts = turnsRef.current;
    const i = ts.findIndex((t) => t.id === id);
    const t = ts[i];
    if (!t?.checkpoint) return;
    if (!confirm("Restore the canvas to this point? Iterations made after it are removed.")) return;
    stop();
    setNodes(t.checkpoint);
    setTurns(ts.slice(0, i));
    setQueue([]);
    setSelected([]);
  }, [stop]);
  const suggest = useCallback(
    (text: string, fromTurn?: string) => {
      const t = fromTurn ? turnsRef.current.find((x) => x.id === fromTurn) : undefined;
      if (t?.nodeIds[0]) setSelected([t.nodeIds[0]]);
      setPrompt(text);
      focusPrompt();
    },
    [],
  );

  // ---------- frame status (size + auto-repair)
  const onStatus = useCallback(
    async (id: string, s: FrameStatus) => {
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node) return;
      if (s.status === "ready") {
        const size = { w: Math.max(1, s.width - FRAME_PAD * 2), h: Math.max(1, s.height - FRAME_PAD * 2) };
        const changed = !node.size || node.size.w !== size.w || node.size.h !== size.h;
        const status = node.frozen ? node.status : ("ready" as const);
        if (changed || node.status !== status || node.radius !== s.radius) {
          setNodes((ns) => {
            const next = ns.map((n) => (n.id === id ? { ...n, size, radius: s.radius, status } : n));
            return changed && !manualRef.current ? tidy(next) : next;
          });
        }
        return;
      }
      if (node.frozen || node.status === "fixing" || node.status === "error") return;
      if (node.repaired || !node.code) return patch(id, { status: "error", error: s.message });
      patch(id, { status: "fixing", error: s.message });
      try {
        const variants = await runGenerate({ repair: { code: node.code, error: s.message }, model: "claude-sonnet-5-5" });
        patch(id, { code: variants[0].code, status: "rendering", repaired: true });
      } catch (e) {
        patch(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [patch],
  );

  const sendToFigma = useCallback(
    async (id: string) => {
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      const fileKey = fileKeyOf(figmaFile) ?? undefined;
      const snap = snapshots.current.get(id);
      if (!snap) return;
      patch(id, { figma: { state: "sending" } });
      try {
        const name = `${n.ver} · ${n.title}`;
        const html = await snap(name);
        const res = await post<{ url: string; fileKey?: string }>("/api/figma", { html, fileKey, name });
        if (res.fileKey && res.fileKey !== fileKey) setFigmaFile(res.fileKey);
        patch(id, { figma: { state: "sent", url: res.url } });
      } catch (e) {
        patch(id, { figma: { state: "failed", error: e instanceof Error ? e.message : String(e) } });
      }
    },
    [figmaFile, patch],
  );

  const deleteNodes = useCallback((ids: string[]) => {
    const all = nodesRef.current;
    const doomed = new Set(ids);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of all) if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) (doomed.add(n.id), (grew = true));
    }
    if (doomed.size > ids.length && !confirm(`Delete ${doomed.size} designs (including what was iterated from them)?`)) return;
    setNodes((ns) => ns.filter((n) => !doomed.has(n.id)));
    setSelected([]);
  }, []);

  /** Error tile → Retry: repair a render error, or re-run the prompt for a failed generation. */
  const retry = useCallback(
    async (id: string) => {
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node) return;
      try {
        if (node.code) {
          patch(id, { status: "fixing", frozen: false });
          const variants = await runGenerate({ repair: { code: node.code, error: node.error ?? "Render failed" }, model: "claude-sonnet-5-5" });
          patch(id, { code: variants[0].code, status: "rendering", repaired: true, error: undefined });
        } else {
          const parent = nodesRef.current.find((n) => n.id === node.parentId);
          patch(id, { status: "generating", frozen: false, error: undefined, title: "Designing…" });
          const variants = await runGenerate({
            prompt: node.prompt,
            count: 1,
            model,
            parent: parent?.code ? { code: parent.code, prompt: parent.prompt, title: parent.title } : undefined,
          });
          const v = variants[0];
          patch(id, { title: v.title, kind: v.kind, rationale: v.rationale, code: v.code, status: "rendering", repaired: false });
        }
      } catch (e) {
        patch(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [patch, model],
  );
  /** Error tile → Edit prompt: back to the composer with the same prompt, from the same parent. */
  const editPrompt = useCallback((id: string) => {
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node) return;
    setSelected(node.parentId ? [node.parentId] : []);
    setPrompt(node.prompt);
    focusPrompt();
  }, []);

  const iterate = useCallback((id: string) => {
    setSelected([id]);
    focusPrompt();
  }, []);
  const focusNode = useCallback(
    (id: string) => {
      setSelected([id]);
      rf.fitView({ nodes: [{ id }], padding: 0.6, duration: 400, maxZoom: 1.2 });
    },
    [rf],
  );
  const registerSnapshot = useCallback((id: string, fn: Snapshotter) => snapshots.current.set(id, fn), []);

  // ---------- React Flow view of the model
  // Keep each React Flow node object stable unless that node changed. Rebuilding
  // every node on each drag step made React Flow re-measure them and drop the
  // edges for a frame (the flicker).
  const handlers = useRef({ onStatus, registerSnapshot, onIterate: iterate, onFigma: sendToFigma, onDelete: (id: string) => deleteNodes([id]), onRetry: retry, onEditPrompt: editPrompt });
  handlers.current = { onStatus, registerSnapshot, onIterate: iterate, onFigma: sendToFigma, onDelete: (id: string) => deleteNodes([id]), onRetry: retry, onEditPrompt: editPrompt };
  const stableHandlers = useMemo(
    () => ({
      onStatus: (id: string, s: FrameStatus) => handlers.current.onStatus(id, s),
      registerSnapshot: (id: string, fn: Snapshotter) => handlers.current.registerSnapshot(id, fn),
      onIterate: (id: string) => handlers.current.onIterate(id),
      onFigma: (id: string) => handlers.current.onFigma(id),
      onDelete: (id: string) => handlers.current.onDelete(id),
      onRetry: (id: string) => handlers.current.onRetry(id),
      onEditPrompt: (id: string) => handlers.current.onEditPrompt(id),
    }),
    [],
  );
  const rfCache = useRef(new Map<string, { src: IterNode; sel: boolean; theme: Theme; node: DesignNodeT }>());
  const rfNodes: DesignNodeT[] = useMemo(() => {
    const cache = rfCache.current;
    const next = nodes.map((n) => {
      const sel = selected.includes(n.id);
      const hit = cache.get(n.id);
      if (hit && hit.src === n && hit.sel === sel && hit.theme === theme) return hit.node;
      const sameData = hit && hit.src.status === n.status && hit.src.code === n.code && hit.src.title === n.title && hit.src.figma === n.figma && hit.src.size === n.size && hit.src.kind === n.kind && hit.src.error === n.error && hit.src.radius === n.radius && hit.src.frozen === n.frozen && hit.theme === theme;
      const node: DesignNodeT = {
        id: n.id,
        type: "design",
        position: n.pos,
        selected: sel,
        width: sizeOf(n).w,
        height: sizeOf(n).h,
        // Without `measured` React Flow treats a moved node as unmeasured and hides its edges for a frame.
        measured: { width: sizeOf(n).w, height: sizeOf(n).h },
        // Moving a node only changes its position; keep the same data object so the frame doesn't re-render.
        data: sameData ? hit.node.data : { node: n, theme, ...stableHandlers },
      };
      cache.set(n.id, { src: n, sel, theme, node });
      return node;
    });
    for (const id of cache.keys()) if (!nodes.some((n) => n.id === id)) cache.delete(id);
    return next;
  }, [nodes, selected, theme, stableHandlers]);
  const rfEdges: Edge[] = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Lineage: every edge above a selected frame, keyed by child id -> depth below the root (for the trace delay).
    const lineage = new Map<string, number>();
    for (const s of selected) {
      const chain: string[] = [];
      let c = byId.get(s);
      for (let guard = 0; c?.parentId && byId.has(c.parentId) && guard < nodes.length; guard++) {
        chain.push(c.id);
        c = byId.get(c.parentId);
      }
      chain.reverse().forEach((id, i) => lineage.set(id, Math.min(lineage.get(id) ?? i, i)));
    }
    return nodes
      .filter((n) => n.parentId && byId.has(n.parentId))
      .map((n) => {
        const depth = lineage.get(n.id);
        const hot = depth !== undefined || selected.includes(n.parentId!);
        const ports = hot || hovered === n.id || hovered === n.parentId;
        return {
          id: `${n.parentId}-${n.id}`,
          source: n.parentId!,
          target: n.id,
          type: "dot",
          style: {
            stroke: n.status === "error" ? "var(--color-action-destructive)" : hot ? PRIMARY : "var(--color-line-input)",
            strokeWidth: hot ? 2 : 1.5,
            ...(n.status === "error" ? { strokeDasharray: "4 4" } : {}),
          },
          // status drives the comet / pulse / snap; lineage drives the green glow
          data: { ports, status: n.status, lineage: depth, hot },
        };
      });
  }, [nodes, selected, hovered]);

  const onNodesChange = useCallback((changes: NodeChange<DesignNodeT>[]) => {
    const ops: string[] = [];
    for (const c of changes) {
      if (c.type === "position" && c.position) {
        const p = c.position;
        setNodes((ns) => ns.map((n) => (n.id === c.id ? { ...n, pos: p } : n)));
        if (c.dragging) setManual(true);
      }
      if (c.type === "select") ops.push(`${c.selected ? "+" : "-"}${c.id}`);
    }
    if (ops.length)
      setSelected((cur) => {
        const s = new Set(cur);
        for (const o of ops) (o[0] === "+" ? s.add(o.slice(1)) : s.delete(o.slice(1)));
        return [...s];
      });
  }, []);

  // ---------- keyboard (Figma-style)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setChatOpen((o) => !o);
        return;
      }
      if (t.closest("input, textarea, select, [contenteditable]")) {
        if (e.key === "Escape") busyRef.current ? stop() : t.blur();
        return;
      }
      if (e.key === "Escape" && busyRef.current) {
        stop();
        return;
      }
      if (e.key === "v" && !mod) setTool("move");
      else if (e.key === "h" && !mod) setTool("hand");
      else if (e.shiftKey && e.code === "Digit1") rf.fitView({ padding: 0.2, duration: 300 });
      else if (e.shiftKey && e.code === "Digit0") rf.zoomTo(1, { duration: 200 });
      else if (mod && (e.key === "=" || e.key === "+")) (e.preventDefault(), rf.zoomIn({ duration: 150 }));
      else if (mod && e.key === "-") (e.preventDefault(), rf.zoomOut({ duration: 150 }));
      else if ((e.key === "Backspace" || e.key === "Delete") && selected.length) deleteNodes(selected);
      else if (e.key === "Escape") setSelected([]);
      else if (e.key === "Enter" || e.key === "/") (e.preventDefault(), focusPrompt());
      else if (mod && e.key === "a") (e.preventDefault(), setSelected(nodesRef.current.map((n) => n.id)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf, selected, deleteNodes, stop]);

  const busyRef = useRef(busy);
  busyRef.current = busy;

  const tidyUp = () => {
    setNodes((ns) => tidy(ns));
    setManual(false);
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 30);
  };

  const loadDemo = async () => {
    try {
      const res = await fetch("/demo.json");
      const demo = (await res.json()) as { nodes: IterNode[]; turns: Turn[]; selected?: string[] };
      const now = Date.now();
      setNodes(tidy(demo.nodes.map((d) => ({ ...d, createdAt: now }))));
      setTurns(demo.turns.map((t, i) => ({ ...t, steps: (t.steps ?? []).map((s) => ({ ...s, startedAt: now - 30000 + i * 3000 + (s.startedAt ?? 0), endedAt: s.endedAt != null ? now - 30000 + i * 3000 + s.endedAt : undefined })), createdAt: now - (t.frozen ? 24000 : 41000), endedAt: t.status === "done" ? now : undefined, thinkingAt: t.thinkingMs ? now - 30000 : undefined })));
      setManual(false);
      setSelected(demo.selected ?? []);
      setTimeout(() => rf.fitView({ padding: 0.2, duration: 400 }), 700);
    } catch {}
  };

  const clearAll = () => {
    if (!confirm("Clear the canvas and the chat?")) return;
    stop();
    setNodes([]);
    setTurns([]);
    setQueue([]);
    setSelected([]);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-background">
      {/* ---------------- canvas ---------------- */}
      <div className="relative min-w-0 flex-1">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onPaneClick={() => setSelected([])}
          onNodeMouseEnter={(_, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(null)}
          colorMode={theme}
          panOnScroll
          panOnScrollSpeed={1}
          zoomOnScroll={false}
          zoomOnPinch
          zoomActivationKeyCode={["Meta", "Control"]}
          panActivationKeyCode="Space"
          panOnDrag={tool === "hand" ? true : [1]}
          selectionOnDrag={tool === "move"}
          nodesDraggable={tool === "move"}
          nodesConnectable={false}
          edgesFocusable={false}
          selectNodesOnDrag={false}
          deleteKeyCode={null}
          multiSelectionKeyCode="Shift"
          minZoom={0.05}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
          className={cn("branch-canvas", tool === "hand" && "branch-hand")}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--color-line-input)" />
        </ReactFlow>

        {/* App panel */}
        <div className="absolute left-4 top-4 flex items-center gap-2 rounded-xl border border-line-border bg-surface-popover px-3 py-2 shadow-low">
          <span className="type-body-sm-medium">Branch</span>
          <Badge size="small" color="primary">
            {`${ds.name.split("/").pop()} ${ds.version}`}
          </Badge>
          {ds.storybookUrl && (
            <Button variant="link" size="xsmall" href={ds.storybookUrl} target="_blank" rel="noreferrer">
              Storybook
            </Button>
          )}
        </div>

        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 pb-24 text-center">
            <div className="type-heading-h2">What should we design?</div>
            <p className="type-body-sm max-w-md text-content-muted-foreground">
              Describe a component in the chat. Claude builds it with your real {ds.name.split("/").pop()} components. Select any
              result to iterate from it.
            </p>
            <div className="pointer-events-auto mt-2">
              <Button variant="secondary" size="small" onClick={loadDemo}>
                Load demo
              </Button>
            </div>
          </div>
        )}



        {/* Bottom toolbar: tools + view only */}
        <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-line-border bg-surface-popover p-1 shadow-mid-raised">
          <Tabs variant="filled" value={tool} onChange={(v) => setTool(v as Tool)}>
            <TabList accessibilityLabel="Canvas tool">
              <TabItem value="move" leading={RiCursorLine}>
                Move
              </TabItem>
              <TabItem value="hand" leading={RiHand}>
                Hand
              </TabItem>
            </TabList>
          </Tabs>
          <Divider orientation="vertical" className="ml-2.5 mr-0.5 h-5 self-center" />
          <Button variant="ghost" size="small" icon={RiLayoutGridLine} accessibilityLabel="Tidy up" onClick={tidyUp} />
          <Button
            variant="ghost"
            size="small"
            icon={RiFullscreenLine}
            accessibilityLabel="Zoom to fit (Shift+1)"
            onClick={() => rf.fitView({ padding: 0.2, duration: 300 })}
          />
          <ButtonGroup variant="secondary" size="small" accessibilityLabel="Zoom">
            <Button icon={RiSubtractLine} accessibilityLabel="Zoom out" onClick={() => rf.zoomOut({ duration: 150 })} />
            <Button onClick={() => rf.zoomTo(1, { duration: 200 })}>{`${Math.round(zoom * 100)}%`}</Button>
            <Button icon={RiAddLine} accessibilityLabel="Zoom in" onClick={() => rf.zoomIn({ duration: 150 })} />
          </ButtonGroup>
          <Divider orientation="vertical" className="ml-2.5 mr-0.5 h-5 self-center" />
          <Button
            variant="ghost"
            size="small"
            icon={theme === "light" ? RiMoonLine : RiSunLine}
            accessibilityLabel={theme === "light" ? "Switch to dark" : "Switch to light"}
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          />
          <Button
            variant="ghost"
            size="small"
            icon={RiLayoutRightLine}
            accessibilityLabel={chatOpen ? "Hide chat (⌘J)" : "Show chat (⌘J)"}
            onClick={() => setChatOpen((o) => !o)}
          />
        </div>
      </div>

      {chatOpen && <ChatPanel
        onHide={() => setChatOpen(false)}
        turns={turns}
        nodes={nodes}
        queue={queue}
        onRemoveQueued={(id) => setQueue((q) => q.filter((x) => x.id !== id))}
        prompt={prompt}
        setPrompt={setPrompt}
        onSubmit={submit}
        onStop={stop}
        count={count}
        setCount={setCount}
        model={model}
        setModel={setModel}
        from={from}
        clearFrom={() => setSelected([])}
        onPick={focusNode}
        onRetryTurn={retryTurn}
        onRestore={restore}
        onFeedback={(id, f) => patchTurn(id, { feedback: f })}
        onSuggest={suggest}
        onClear={clearAll}
        textareaRef={textareaRef}
      />}
    </div>
  );
}

// ------------------------------------------------------------------ connect

function Connect() {
  const [dir, setDir] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const run = async () => {
    setBusy(true);
    setLog(null);
    const res = await fetch("/api/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dir, storybookUrl: url || undefined }) });
    const data = await res.json().catch(() => ({ ok: false, log: "Connect failed." }));
    setOk(!!data.ok);
    setLog(data.log ?? data.error);
    setBusy(false);
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-content-muted p-6">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-line-border bg-surface-card p-6 shadow-low-raised">
        <div>
          <h1 className="type-heading-h3">Connect your Storybook</h1>
          <p className="type-body-sm mt-1 text-content-muted-foreground">
            Point Branch at the design-system project on this machine (the repo with your .storybook). It installs the package and reads its
            agent docs, so Claude designs with your real components.
          </p>
        </div>
        <TextInput label="Project folder" placeholder="~/code/my-design-system" value={dir} onChange={({ value }) => setDir(value)} />
        <TextInput label="Storybook URL" necessityIndicator="optional" placeholder="https://…chromatic.com" value={url} onChange={({ value }) => setUrl(value)} />
        <Button isFullWidth isLoading={busy} isDisabled={!dir.trim()} onClick={run}>
          Connect
        </Button>
        {log && (
          <pre
            className={cn(
              "type-body-xs max-h-60 overflow-auto rounded-md border p-3 font-mono",
              ok ? "border-line-border bg-content-muted" : "border-feedback-negative-border bg-feedback-negative-background-subtle",
            )}
          >
            {log}
          </pre>
        )}
        {ok && <p className="type-body-sm text-feedback-positive-foreground">Connected. Restart the app (npm run dev) to load it.</p>}
      </div>
    </div>
  );
}
