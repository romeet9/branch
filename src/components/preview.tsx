"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { RenderMessage, StatusMessage } from "@/lib/render-protocol";

export type Snapshotter = (name: string) => Promise<string>;
export type FrameStatus = { status: "ready"; width: number; height: number; radius: number } | { status: "error"; message: string };

/** Transparent room the renderer leaves around the component (shadows). */
export const FRAME_PAD = 16;

/**
 * One design rendered in the sandboxed /render iframe at 1:1. The iframe
 * resizes to exactly the component it renders; the canvas zoom does the
 * scaling. Pointer events are off so the canvas keeps pan/zoom/drag.
 */
export const Frame = memo(function Frame({
  id,
  code,
  theme,
  onStatus,
  registerSnapshot,
}: {
  id: string;
  code: string;
  theme: "light" | "dark";
  onStatus?: (s: FrameStatus) => void;
  registerSnapshot?: (fn: Snapshotter) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const pending = useRef<((html: string) => void) | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent<StatusMessage>) => {
      if (e.source !== frame.current?.contentWindow) return;
      const msg = e.data;
      if (msg?.type === "branch:hello") setLoaded(true);
      if (msg?.type === "branch:snapshot-result" && msg.id === id) {
        pending.current?.(msg.html);
        pending.current = null;
      }
      if (msg?.type === "branch:status" && msg.id === id) {
        if (msg.status === "ready") {
          setSize((s) => (s && s.w === msg.width && s.h === msg.height ? s : { w: msg.width, h: msg.height }));
          statusRef.current?.({ status: "ready", width: msg.width, height: msg.height, radius: msg.radius ?? 0 });
        } else {
          statusRef.current?.({ status: "error", message: msg.message });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  useEffect(() => {
    if (!loaded) return;
    const msg: RenderMessage = { type: "branch:render", id, code, theme };
    frame.current?.contentWindow?.postMessage(msg, "*");
  }, [loaded, id, code, theme]);

  useEffect(() => {
    registerSnapshot?.(
      (name) =>
        new Promise<string>((resolve, reject) => {
          const win = frame.current?.contentWindow;
          if (!win) return reject(new Error("The frame isn't ready yet."));
          pending.current = resolve;
          const msg: RenderMessage = { type: "branch:snapshot", id, name };
          win.postMessage(msg, "*");
          setTimeout(() => {
            if (pending.current === resolve) {
              pending.current = null;
              reject(new Error("Couldn't read the rendered design."));
            }
          }, 5000);
        }),
    );
  }, [id, registerSnapshot]);

  // Before the first measurement, lay out wide so the component can take its natural width.
  const w = size?.w ?? 1200;
  const h = size?.h ?? 200;
  return (
    <iframe
      ref={frame}
      src="/render"
      title={`Design ${id}`}
      sandbox="allow-scripts allow-same-origin"
      tabIndex={-1}
      className="pointer-events-none block border-0 bg-transparent"
      style={{ width: w, height: h, colorScheme: theme, visibility: size ? "visible" : "hidden" }}
    />
  );
});
