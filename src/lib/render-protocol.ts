/** postMessage protocol between the studio and the sandboxed /render iframe. */
export type RenderMessage =
  | { type: "branch:render"; id: string; code: string; theme: "light" | "dark" }
  | { type: "branch:snapshot"; id: string; name: string };

export type StatusMessage =
  | { type: "branch:hello" }
  | { type: "branch:status"; id: string; status: "ready"; height: number; width: number; radius: number }
  | { type: "branch:status"; id: string; status: "error"; message: string }
  | { type: "branch:snapshot-result"; id: string; html: string };
