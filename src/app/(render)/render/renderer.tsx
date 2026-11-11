"use client";

import * as React from "react";
import * as DS from "@/ds";
import * as RemixIcons from "@remixicon/react";
import { transform } from "sucrase";
import type { RenderMessage, StatusMessage } from "@/lib/render-protocol";

const MODULES: Record<string, unknown> = {
  react: React,
  [DS.DS_NAME]: DS,
  "@remixicon/react": RemixIcons,
};

function compile(code: string): React.ComponentType {
  const { code: js } = transform(code, {
    transforms: ["typescript", "jsx", "imports"],
    jsxRuntime: "classic",
    production: true,
  });
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string) => {
    if (name in MODULES) return MODULES[name];
    throw new Error(
      `Can't import "${name}". Designs may only import from react, ${DS.DS_NAME} and @remixicon/react.`,
    );
  };
  new Function("require", "module", "exports", "React", js)(require, module, module.exports, React);
  const Comp = (module.exports.default ?? module.exports.Design) as React.ComponentType | undefined;
  if (typeof Comp !== "function") throw new Error("The design must `export default function Design()`.");
  return Comp;
}

function post(msg: StatusMessage) {
  window.parent.postMessage(msg, "*");
}

/** A self-contained HTML copy of the rendered design, for Figma's html_to_figma. */
function snapshot(root: HTMLElement, name: string) {
  const design = root.firstElementChild as HTMLElement | null;
  design?.setAttribute("data-branch-design", "");
  const css = [...document.querySelectorAll("style")]
    .filter((s) => s.type !== "text/tailwindcss")
    .map((s) => s.textContent ?? "")
    .join("\n");
  const fonts = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map((l) => l.outerHTML)
    .join("");
  const html = `<!doctype html><html lang="en" class="${document.documentElement.className}"><head><meta charset="utf-8"><title>${name.replace(/</g, "")}</title>${fonts}<style>${css}</style></head><body class="${document.body.className}" style="background:transparent">${root.innerHTML}</body></html>`;
  design?.removeAttribute("data-branch-design");
  return html;
}

class Boundary extends React.Component<{ id: string; children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    post({ type: "branch:status", id: this.props.id, status: "error", message: error.message });
  }
  render() {
    if (this.state.error) {
      return <div className="p-6 font-mono text-sm text-feedback-negative-foreground">{this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

export function Renderer() {
  const [job, setJob] = React.useState<{ id: string; seq: number; Comp: React.ComponentType } | null>(null);
  const [compileError, setCompileError] = React.useState<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const jobRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const onMessage = (e: MessageEvent<RenderMessage>) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "branch:snapshot") {
        if (rootRef.current) post({ type: "branch:snapshot-result", id: msg.id, html: snapshot(rootRef.current, msg.name) });
        return;
      }
      if (msg.type !== "branch:render") return;
      document.documentElement.classList.toggle("dark", msg.theme === "dark");
      // Match the iframe element's color-scheme, or the browser paints an opaque backdrop.
      document.documentElement.style.colorScheme = msg.theme;
      jobRef.current = msg.id;
      try {
        const Comp = compile(msg.code);
        setCompileError(null);
        setJob({ id: msg.id, seq: Date.now(), Comp });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setJob(null);
        setCompileError(message);
        post({ type: "branch:status", id: msg.id, status: "error", message });
      }
    };
    const onError = (e: ErrorEvent) => {
      if (jobRef.current) post({ type: "branch:status", id: jobRef.current, status: "error", message: e.message });
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("error", onError);
    post({ type: "branch:hello" });
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("error", onError);
    };
  }, []);

  React.useEffect(() => {
    if (!job || !rootRef.current) return;
    const el = rootRef.current;
    const report = () => {
      const r = el.getBoundingClientRect();
      // The design's own corner radius, so the canvas selection ring can be concentric with it.
      const design = el.firstElementChild as HTMLElement | null;
      const radius = design ? parseFloat(getComputedStyle(design).borderTopLeftRadius) || 0 : 0;
      post({ type: "branch:status", id: job.id, status: "ready", width: Math.ceil(r.width), height: Math.ceil(r.height), radius: Math.min(radius, 999) });
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(report));
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [job]);

  return (
    // Fit-content wrapper: the frame on the canvas is exactly the component,
    // plus FRAME_PAD of transparent room so shadows aren't cut off.
    <div ref={rootRef} style={{ width: "fit-content", padding: 16 }}>
      {compileError && <div className="p-6 font-mono text-sm text-feedback-negative-foreground">{compileError}</div>}
      {job && (
        <Boundary key={job.seq} id={job.id}>
          <job.Comp />
        </Boundary>
      )}
    </div>
  );
}
