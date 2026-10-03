import { cookies } from 'next/headers';
import type { Config } from './config';
import { SESSION_COOKIE, verifySession } from './session';
import type { Actor } from './types';

/** For server components. API routes use actorFromRequest instead. */
export async function currentActor(config: Config): Promise<Actor | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value, config);
}
