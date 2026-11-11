import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";

export const maxDuration = 300;

const Body = z.object({ path: z.string().min(1), storybookUrl: z.string().optional() });

/** Runs scripts/connect.mjs for a local Storybook project. */
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return Response.json({ error: "Give the folder of your Storybook project." }, { status: 400 });
  }
  const args = [path.join(process.cwd(), "scripts/connect.mjs"), body.path];
  if (body.storybookUrl) args.push(body.storybookUrl);
  return new Promise<Response>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (code) =>
      resolve(Response.json({ ok: code === 0, log }, { status: code === 0 ? 200 : 500 })),
    );
  });
}
