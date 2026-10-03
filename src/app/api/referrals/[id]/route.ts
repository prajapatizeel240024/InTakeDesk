import type { ReferralView } from '@/lib/access';
import { handle, json, readJson } from '@/lib/http';
import { ServiceError, assignOwner, getReferral, scheduleReferral, updateFields } from '@/lib/service';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  return handle(req, async (ctx, actor) => json({ referral: await getReferral(ctx, actor, (await params).id) }));
}

/** Body can carry any of: set (field values), verify (field keys), owner, schedule (YYYY-MM-DD). Each checks its own permission. */
export async function PATCH(req: Request, { params }: Params) {
  return handle(req, async (ctx, actor) => {
    const { id } = await params;
    const body = await readJson(req);
    let view: ReferralView | null = null;

    if (body.set !== undefined || body.verify !== undefined) {
      const set = body.set && typeof body.set === 'object' && !Array.isArray(body.set) ? (body.set as Record<string, unknown>) : undefined;
      const verify = Array.isArray(body.verify) ? body.verify.map(String) : undefined;
      view = await updateFields(ctx, actor, id, { set, verify });
    }
    if (body.owner !== undefined) view = await assignOwner(ctx, actor, id, body.owner ? String(body.owner) : null);
    if (body.schedule !== undefined) view = await scheduleReferral(ctx, actor, id, String(body.schedule));

    if (!view) throw new ServiceError('Nothing to change.', 400);
    return json({ referral: view });
  });
}
