import { readFileSync } from "node:fs";
import type { Metadata } from "next";
import { readDsConfig, themeCssPath } from "@/lib/ds-config";

export const metadata: Metadata = { title: "Branch renderer" };

/**
 * Root layout for the sandboxed renderer (it does NOT load the studio's CSS).
 * Generated designs use Tailwind classes we can't know at build time, so the
 * in-browser Tailwind v4 compiler (public/tw-browser.js) compiles them live
 * against the connected design system's own theme.
 */
function loadTheme() {
  const p = themeCssPath(readDsConfig());
  if (!p) return "";
  try {
    // Strip comments: the browser compiler skips its own `@import "tailwindcss"`
    // when the text mentions one, and Weft's theme mentions it in a comment.
    const theme = readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^@source[^\n]*\n/m, "");
    return theme;
  } catch {
    return "";
  }
}
const theme = loadTheme();

export default function RenderLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&family=Instrument+Sans:wght@400..700&display=swap"
        />
        <style type="text/tailwindcss" dangerouslySetInnerHTML={{ __html: theme }} />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/tw-browser.js" />
      </head>
      <body className="text-surface-foreground font-sans antialiased" style={{ background: "transparent", margin: 0 }}>{children}</body>
    </html>
  );
}
