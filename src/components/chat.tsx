"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Button, Tag, cn } from "@greenloom-ai/weft";
import {
  RiArrowDownSLine,
  RiArrowUpLine,
  RiCheckboxCircleFill,
  RiCloseLine,
  RiDeleteBinLine,
  RiLayoutRightLine,
  RiFileCopyLine,
  RiRefreshLine,
  RiRobot2Line,
  RiSparkling2Line,
  RiThumbDownLine,
  RiThumbUpLine,
} from "@remixicon/react";
import { MODELS, type IterNode, type Model, type Queued, type Step, type Turn } from "@/lib/types";

// ------------------------------------------------------------------ helpers

const secs = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const modelName = (m: Model) => MODELS.find((x) => x.id === m)?.name ?? m;

export function useNow(active: boolean, every = 1000) {
  // Starts at 0 (no Date.now() while prerendering); turns only exist after mount anyway.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    if (!active) return () => clearTimeout(first);
    const t = setInterval(tick, every);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [active, every]);
  return now;
}

type Phase = { state: "thinking" | "working" | "done" | "error" | "stopped"; label: string; meta: string };

/** What a turn is doing right now, in one line (Claude Code style). */
export function phaseOf(t: Turn, nodes: IterNode[], now: number): Phase {
  const took = secs((t.endedAt ?? now) - t.createdAt);
  if (t.status === "error") return { state: "error", label: "Couldn’t finish", meta: `after ${took}` };
  if (t.status === "stopped") return { state: "stopped", label: "Stopped", meta: took };
  if (t.status === "done") return { state: "done", label: `Designed ${plural(t.nodeIds.length, "iteration")}`, meta: took };
  const running = t.steps.find((s) => s.status === "running");
  const meta = `${took} · esc to stop`;
  if (t.resultAt) {
    const fixing = t.nodeIds.some((id) => nodes.find((n) => n.id === id)?.status === "fixing");
    return { state: "working", label: fixing ? "Fixing a render error…" : "Rendering on the canvas…", meta };
  }
  if (running) return { state: "working", label: `${running.verb === "Read" ? "Reading" : running.verb === "Searched" ? "Searching" : running.verb} ${running.target}…`, meta };
  if (t.steps.length) return { state: "working", label: `Writing ${plural(t.count, "variant")}…`, meta };
  return { state: "thinking", label: "Thinking…", meta };
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function Glyph({ className }: { className?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <span className={cn("inline-block w-3 text-center font-mono leading-none", className)}>{FRAMES[i]}</span>;
}

export function StatusLine({ phase, className }: { phase: Phase; className?: string }) {
  const busy = phase.state === "thinking" || phase.state === "working";
  return (
    <span className={cn("type-body-xs flex min-w-0 items-center gap-1.5", className)}>
      {busy ? (
        <Glyph className="text-action-primary" />
      ) : phase.state === "done" ? (
        <RiCheckboxCircleFill className="size-3 shrink-0 text-feedback-positive-foreground" />
      ) : (
        <span className={cn("size-1.5 shrink-0 rounded-full", phase.state === "error" ? "bg-feedback-negative-foreground" : "bg-content-muted-foreground")} />
      )}
      <span className={cn("truncate", busy ? "branch-shimmer" : phase.state === "error" ? "text-feedback-negative-foreground" : "text-content-muted-foreground")}>
        {phase.label}
      </span>
      <span className="shrink-0 text-content-muted-foreground opacity-70">{phase.meta}</span>
    </span>
  );
}


/** Icon on a rail with a connector to the next row (Chain of Thought look). */
function RailRow({ marker, last, children }: { marker: React.ReactNode; last?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <div className="flex w-3.5 shrink-0 flex-col items-center">
        <div className="flex h-4 items-center">{marker}</div>
        {!last && <div className="w-px flex-1 bg-line-border" />}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !last && "pb-2")}>{children}</div>
    </div>
  );
}
function Marker({ state }: { state: "done" | "active" | "pending" | "error" }) {
  if (state === "done") return <RiCheckboxCircleFill className="size-3.5 text-feedback-positive-foreground" />;
  if (state === "active") return <Glyph className="text-[11px] text-action-primary" />;
  if (state === "error") return <span className="size-2 rounded-full bg-feedback-negative-foreground" />;
  return <span className="size-2.5 rounded-full border border-dashed border-content-muted-foreground" />;
}

// ------------------------------------------------------------------ turn pieces

type StepState = "done" | "active" | "pending" | "error";

function taskItems(t: Turn) {
  const started = !!t.thinkingAt || t.steps.length > 0 || !!t.resultAt;
  const toolsActive = t.steps.some((s) => s.status === "running");
  const rendered = t.status === "done";
  const failed = t.status === "error" || t.status === "stopped";
  const items: { label: string; state: StepState; tools?: boolean }[] = [
    { label: "Read the request", state: started || failed ? "done" : "active" },
    { label: "Read Weft docs", state: toolsActive ? "active" : t.steps.length || t.resultAt ? "done" : "pending", tools: true },
    { label: `Write ${plural(t.count, "variant")}`, state: t.resultAt ? "done" : started && !toolsActive ? "active" : "pending" },
    { label: "Render on the canvas", state: rendered ? "done" : t.resultAt ? "active" : "pending" },
  ];
  if (failed) {
    const i = items.findIndex((x) => x.state === "active");
    if (i >= 0) items[i].state = "error";
  }
  return { items, done: items.filter((x) => x.state === "done").length, failed };
}

const stepTime = (s: Step, now: number) => {
  const d = ((s.endedAt ?? now) - s.startedAt) / 1000;
  return `${d < 1 ? d.toFixed(1) : Math.round(d)}s`;
};

/** Tool calls as small mono lines; last 4 unless expanded. */
function ToolList({ steps: all, now }: { steps: Step[]; now: number }) {
  const [showAll, setShowAll] = useState(false);
  if (!all.length) return null;
  const hidden = showAll ? 0 : Math.max(0, all.length - 4);
  const steps = all.slice(hidden);
  return (
    <div className="flex flex-col gap-0.5">
      {hidden > 0 && (
        <button onClick={() => setShowAll(true)} className="type-body-xs self-start text-content-muted-foreground hover:text-surface-foreground">
          Show {hidden} earlier
        </button>
      )}
      {steps.map((s) => (
        <span key={s.id} className={cn("flex items-center gap-1 font-mono text-[10px]", s.status === "error" ? "text-feedback-negative-foreground" : "text-content-muted-foreground")}>
          <span className="truncate">
            {s.verb} {s.target}
          </span>
          {s.status === "running" ? <Glyph className="text-[11px] text-action-primary" /> : <span className="shrink-0">· {s.status === "error" ? "failed" : stepTime(s, now)}</span>}
        </span>
      ))}
    </div>
  );
}

function Steps({ t, now }: { t: Turn; now: number }) {
  const { items } = taskItems(t);
  return (
    <div className="pl-0.5">
      {items.map((it, i) => (
        <RailRow key={it.label} marker={<Marker state={it.state} />} last={i === items.length - 1}>
          <span
            className={cn(
              "type-body-xs",
              it.state === "pending" && "text-content-muted-foreground",
              it.state === "active" && "branch-shimmer",
              it.state === "error" && "text-feedback-negative-foreground",
            )}
          >
            {it.label}
            {it.state === "active" ? "…" : ""}
          </span>
          {it.tools && it.state !== "pending" && <ToolList steps={t.steps} now={now} />}
        </RailRow>
      ))}
    </div>
  );
}

/** Working turn: one compact progress card. */
function WorkCard({ t, nodes, now }: { t: Turn; nodes: IterNode[]; now: number }) {
  const [open, setOpen] = useState(false);
  const { done } = taskItems(t);
  return (
    <div className="flex flex-col gap-1.5">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded text-left">
        <StatusLine phase={phaseOf(t, nodes, now)} className="flex-1" />
        <span className="shrink-0 font-mono text-[10px] text-content-muted-foreground">{done}/4</span>
        <RiArrowDownSLine className={cn("size-3.5 shrink-0 text-content-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      <div className="h-0.5 overflow-hidden rounded-full bg-content-muted">
        <div className="h-full rounded-full bg-action-primary transition-all duration-500" style={{ width: `${(done / 4) * 100}%` }} />
      </div>
      {open && <Steps t={t} now={now} />}
    </div>
  );
}

/** Done turn: one collapsible summary line. */
function DoneSummary({ t, now }: { t: Turn; now: number }) {
  const [open, setOpen] = useState(false);
  const docs = new Set(t.steps.filter((s) => s.verb === "Read").map((s) => s.target)).size;
  const dur = secs((t.endedAt ?? now) - t.createdAt);
  return (
    <div className="flex flex-col gap-1.5">
      <button onClick={() => setOpen((o) => !o)} className="type-body-xs flex items-center gap-1.5 self-start rounded text-left text-content-muted-foreground hover:text-surface-foreground">
        <RiCheckboxCircleFill className="size-3 shrink-0 text-feedback-positive-foreground" />
        <span>
          Designed {plural(t.count, "iteration")} · {dur}
          {docs > 0 ? ` · ${plural(docs, "doc")}` : ""}
        </span>
        <RiArrowDownSLine className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5">
          {t.thinkingMs != null && t.thinkingMs >= 1000 && <span className="type-body-xs text-content-muted-foreground">Thought for {secs(t.thinkingMs)}</span>}
          <Steps t={t} now={now} />
          <span className="font-mono text-[10px] text-content-muted-foreground">
            {modelName(t.model)} · {dur}
          </span>
        </div>
      )}
    </div>
  );
}

function Reply({ t, nodes, onPick, onRetry, onFeedback }: { t: Turn; nodes: IterNode[]; onPick: (id: string) => void; onRetry: () => void; onFeedback: (f: "up" | "down") => void }) {
  const made = t.nodeIds.map((id) => nodes.find((n) => n.id === id)).filter((n): n is IterNode => !!n);
  const [copied, setCopied] = useState(false);
  if (t.status === "error" || t.status === "stopped")
    return (
      <div className="type-body-xs flex items-baseline gap-2">
        <span className={cn("min-w-0", t.status === "error" ? "text-feedback-negative-foreground" : "text-content-muted-foreground")}>
          {t.status === "stopped" ? "Stopped. Nothing was changed after this point." : t.error}
        </span>
        <button onClick={onRetry} className="shrink-0 font-medium text-action-link hover:underline">
          Retry
        </button>
      </div>
    );
  if (t.status !== "done") return null;
  const summary = made.map((n) => `${n.ver} · ${n.title}${n.rationale ? `: ${n.rationale}` : ""}`).join("\n");
  return (
    <div className="relative">
      <div className="flex flex-col">
        {made.map((n) => (
          <button key={n.id} onClick={() => onPick(n.id)} title={n.rationale} className="type-body-xs flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-content-muted">
            <span className="shrink-0 font-medium">{n.ver}</span>
            <span className="min-w-0 flex-1 truncate text-surface-foreground">{n.title}</span>
          </button>
        ))}
      </div>
      {/* Floats on the right of the summary line above, so it takes no space of its own. */}
      <div className="absolute bottom-full right-0 mb-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/turn:opacity-100">
        <Button
          variant="ghost"
          size="xsmall"
          icon={RiFileCopyLine}
          accessibilityLabel={copied ? "Copied" : "Copy summary"}
          onClick={async () => {
            await navigator.clipboard.writeText(summary);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        />
        <Button variant="ghost" size="xsmall" icon={RiRefreshLine} accessibilityLabel="Run again" onClick={onRetry} />
        <Button variant="ghost" size="xsmall" icon={RiThumbUpLine} accessibilityLabel="Good" className={t.feedback === "up" ? "text-action-primary" : undefined} onClick={() => onFeedback("up")} />
        <Button variant="ghost" size="xsmall" icon={RiThumbDownLine} accessibilityLabel="Not good" className={t.feedback === "down" ? "text-feedback-negative-foreground" : undefined} onClick={() => onFeedback("down")} />
      </div>
    </div>
  );
}

/** A 1px divider at rest; hovering the gap reveals the checkpoint row. */
function Checkpoint({ count, onRestore }: { count: number; onRestore: () => void }) {
  return (
    <div className="group/cp flex min-h-4 items-center">
      <span className="h-px w-full bg-line-border group-hover/cp:hidden" />
      <div className="hidden w-full items-center gap-2 group-hover/cp:flex">
        <span className="h-px flex-1 bg-line-border" />
        <span className="type-body-xs text-content-muted-foreground">Checkpoint · {plural(count, "iteration")}</span>
        <button onClick={onRestore} className="type-body-xs text-action-link hover:underline">
          Restore
        </button>
        <span className="h-px flex-1 bg-line-border" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ composer

function Menu<T extends string | number>({ value, options, onChange, icon: Icon, render }: { value: T; options: { id: T; name: string; note?: string }[]; onChange: (v: T) => void; icon?: typeof RiSparkling2Line; render: (v: T) => string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="type-body-xs flex items-center gap-1 rounded-md px-2 py-1 font-medium text-content-muted-foreground hover:bg-content-muted hover:text-surface-foreground">
        {Icon && <Icon className="size-3.5" />}
        {render(value)}
        <RiArrowDownSLine className="size-3.5" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 min-w-48 rounded-lg border border-line-border bg-surface-popover p-1 shadow-mid-raised">
          {options.map((o) => (
            <button
              key={String(o.id)}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-content-muted", o.id === value && "bg-content-muted")}
            >
              <span className="flex-1">
                <span className="type-body-xs block font-medium">{o.name}</span>
                {o.note && <span className="type-body-xs block text-content-muted-foreground">{o.note}</span>}
              </span>
              {o.id === value && <RiCheckboxCircleFill className="size-3.5 text-action-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ContextRing({ pct }: { pct: number }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const tone = pct > 0.9 ? "text-feedback-negative-foreground" : pct > 0.75 ? "text-feedback-notice-foreground" : "text-content-muted-foreground";
  return (
    <span className={cn("flex items-center gap-1", tone)} title={`The last run used ${Math.round(pct * 100)}% of Claude’s context`}>
      <svg width="14" height="14" viewBox="0 0 14 14" className="-rotate-90">
        <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round" />
      </svg>
      <span className="font-mono text-[10px]">{Math.round(pct * 100)}%</span>
    </span>
  );
}

// ------------------------------------------------------------------ chat panel (docked right)

export function ChatPanel(p: {
  onHide: () => void;
  turns: Turn[];
  nodes: IterNode[];
  queue: Queued[];
  onRemoveQueued: (id: string) => void;
  prompt: string;
  setPrompt: (s: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  count: number;
  setCount: (n: number) => void;
  model: Model;
  setModel: (m: Model) => void;
  from: IterNode | null;
  clearFrom: () => void;
  onPick: (id: string) => void;
  onRetryTurn: (id: string) => void;
  onRestore: (id: string) => void;
  onFeedback: (id: string, f: "up" | "down") => void;
  onSuggest: (text: string, fromTurn?: string) => void;
  onClear: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { textareaRef } = p;
  const active = p.turns.find((t) => t.status === "working");
  const busy = !!active;
  const now = useNow(busy);
  const last = p.turns.at(-1);
  const phase = last ? phaseOf(last, p.nodes, now) : null;
  const usage = [...p.turns].reverse().find((t) => t.usagePct != null)?.usagePct;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [p.turns.length, last?.steps.length, last?.status, p.queue.length]);

  const empty = p.turns.length === 0;
  return (
    <aside className="flex h-full w-[372px] shrink-0 flex-col overflow-hidden border-l border-line-border bg-surface-card">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-line-border px-3 py-2">
        <span className="type-body-xs shrink-0 font-medium">Chat</span>
        {phase && <StatusLine phase={phase} className="min-w-0 flex-1" />}
        {!phase && <span className="flex-1" />}
        {!empty && (
          <Button variant="ghost" size="xsmall" icon={RiDeleteBinLine} accessibilityLabel="Clear chat" onClick={p.onClear} />
        )}
        <Button variant="ghost" size="xsmall" icon={RiLayoutRightLine} accessibilityLabel="Hide chat (⌘J)" onClick={p.onHide} />
      </div>

      {/* transcript */}
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {empty ? (
          <div className="flex flex-1 flex-col justify-end gap-2">
            <p className="type-body-sm text-content-muted-foreground">Describe a component. Claude builds it with your Weft components; select a frame on the canvas to iterate from it.</p>
            <div className="flex flex-wrap gap-1">
              {["A pricing card for the Pro plan", "An empty state for a reports page", "A settings form for notifications", "A KPI row for a finance dashboard"].map((s) => (
                <button key={s} onClick={() => p.onSuggest(s)} className="type-body-xs rounded-full border border-line-border px-2.5 py-1 hover:bg-content-muted">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          p.turns.map((t, i) => (
            <Fragment key={t.id}>
              {i > 0 && t.checkpoint && <Checkpoint count={t.checkpoint.length} onRestore={() => p.onRestore(t.id)} />}
              <div className="group/turn flex flex-col gap-1.5">
                <div className="flex flex-col items-end gap-0.5">
                  <div className="type-body-sm max-w-[280px] rounded-lg bg-content-muted px-3 py-2">{t.prompt}</div>
                  {t.parentVer && <span className="type-body-xs text-[10px] text-content-muted-foreground">on {t.parentVer}</span>}
                </div>
                {t.status === "working" ? <WorkCard t={t} nodes={p.nodes} now={now} /> : t.status === "done" ? <DoneSummary t={t} now={now} /> : null}
                <Reply t={t} nodes={p.nodes} onPick={p.onPick} onRetry={() => p.onRetryTurn(t.id)} onFeedback={(f) => p.onFeedback(t.id, f)} />
              </div>
            </Fragment>
          ))
        )}
        {last?.status === "done" && !busy && !p.prompt.trim() && (
          <div className="flex flex-wrap gap-1">
            {["Try it in dark mode", "Make it more compact"].map((s) => (
              <button key={s} onClick={() => p.onSuggest(s, last.id)} className="type-body-xs rounded-full border border-line-border px-2.5 py-1 hover:bg-content-muted">
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* queue */}
      {p.queue.length > 0 && (
        <div className="mx-2 mb-1 flex flex-col gap-1 rounded-lg bg-content-muted px-3 py-2">
          <span className="type-body-xs font-medium text-content-muted-foreground">Queued · {p.queue.length}</span>
          {p.queue.map((q, i) => (
            <div key={q.id} className="type-body-xs flex items-center gap-2">
              <span className="font-mono text-[10px] text-content-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{q.prompt}</span>
              <button onClick={() => p.onRemoveQueued(q.id)} className="text-content-muted-foreground hover:text-surface-foreground" aria-label="Remove from queue">
                <RiCloseLine className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* composer (AI Elements PromptInput style) */}
      <div className="p-2 pt-1">
        <div className="flex flex-col rounded-xl border border-line-input bg-surface-card shadow-low focus-within:border-action-primary">
          {p.from && (
            <div className="px-2 pt-2">
              <Tag onDismiss={p.clearFrom}>{`${p.from.ver} · ${p.from.title}`}</Tag>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={p.prompt}
            onChange={(e) => p.setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                p.onSubmit();
              }
            }}
            rows={2}
            placeholder={busy ? "Queue a follow-up…" : p.from ? `How should ${p.from.ver} change?` : "Describe a component…"}
            className="type-body-sm max-h-40 min-h-12 resize-none bg-transparent px-3 py-2 text-surface-foreground outline-none placeholder:text-content-muted-foreground"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <Menu value={p.model} options={MODELS.map((m) => ({ id: m.id, name: m.name, note: m.note }))} onChange={p.setModel} icon={RiSparkling2Line} render={(v) => modelName(v)} />
            <Menu value={p.count} options={[1, 2, 3, 4].map((n) => ({ id: n, name: plural(n, "iteration") }))} onChange={p.setCount} render={(v) => `${v}×`} />
            <span className="flex-1" />
            {usage != null && <ContextRing pct={usage} />}
            <span className="w-2" />
            {busy && !p.prompt.trim() ? (
              <button onClick={p.onStop} aria-label="Stop (Esc)" className="grid size-7 place-items-center rounded-full bg-surface-foreground hover:opacity-90">
                <span className="size-2.5 rounded-[2px] bg-surface-card" />
              </button>
            ) : (
              <button
                onClick={p.onSubmit}
                disabled={!p.prompt.trim()}
                aria-label={busy ? "Queue" : "Generate"}
                className="grid size-7 place-items-center rounded-full bg-action-primary text-action-primary-foreground disabled:bg-content-muted disabled:text-content-muted-foreground"
              >
                <RiArrowUpLine className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

