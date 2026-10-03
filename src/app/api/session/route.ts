import { NextResponse } from 'next/server';
import { getContext } from '@/lib/context';
import { SESSION_COOKIE, signSession } from '@/lib/session';

/** Signs in as one of the demo users from config/intake.yaml. */
export async function POST(req: Request) {
  const ctx = await getContext();
  let userId: unknown;
  try {
    userId = ((await req.json()) as { userId?: unknown }).userId;
  } catch {
    userId = undefined;
  }
  if (typeof userId !== 'string' || !ctx.config.users[userId]) {
    return NextResponse.json({ error: 'That is not one of the demo users.' }, { status: 400 });
  }
  const https = req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:';
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, signSession(userId), { httpOnly: true, sameSite: 'lax', secure: https, path: '/', maxAge: 60 * 60 * 12 });
  await ctx.store.appendAudit({
    actor: userId,
    role: ctx.config.users[userId].role,
    action: 'sign_in',
    outcome: 'allowed',
    referralId: null,
    fields: [],
    detail: {},
  });
  return res;
}
