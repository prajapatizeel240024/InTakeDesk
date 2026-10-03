import { handle, json, readJson } from '@/lib/http';
import { createView, listViews } from '@/lib/service';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: Request) {
  return handle(req, async (ctx, actor) => json({ views: await listViews(ctx, actor) }));
}

export async function POST(req: Request) {
  return handle(req, async (ctx, actor) => {
    const body = await readJson(req);
    const view = await createView(ctx, actor, String(body.prompt ?? ''));
    return json({ view }, 201);
  });
}
