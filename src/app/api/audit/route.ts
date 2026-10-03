import { handle, json } from '@/lib/http';
import { listAudit } from '@/lib/service';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return handle(req, async (ctx, actor) => {
    const referralId = new URL(req.url).searchParams.get('referral') ?? undefined;
    return json({ entries: await listAudit(ctx, actor, { referralId }) });
  });
}
