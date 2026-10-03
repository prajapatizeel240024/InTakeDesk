import { NextResponse } from 'next/server';
import { getContext } from './context';
import { ServiceError, type Ctx } from './service';
import { actorFromRequest } from './session';
import type { Actor } from './types';

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Resolves the signed-in demo user, runs the handler, and turns service errors into clean JSON. */
export async function handle(req: Request, fn: (ctx: Ctx, actor: Actor) => Promise<Response>): Promise<Response> {
  try {
    const ctx = await getContext();
    const actor = actorFromRequest(req, ctx.config);
    if (!actor) return json({ error: 'Pick a demo user first.' }, 401);
    return await fn(ctx, actor);
  } catch (err) {
    if (err instanceof ServiceError) {
      return json({ error: err.message, ...(err.details ? { details: err.details } : {}) }, err.status);
    }
    console.error(
      JSON.stringify({ event: 'api_error', path: new URL(req.url).pathname, error: err instanceof Error ? err.message : String(err) }),
    );
    return json({ error: 'Something went wrong on the server.' }, 500);
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    throw new ServiceError('Send a JSON body.', 400);
  }
}
