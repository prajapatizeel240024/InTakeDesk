import crypto from 'node:crypto';
import type { Config } from './config';
import type { Actor } from './types';

export const SESSION_COOKIE = 'intake_session';

const DEV_SECRET = 'intake-desk-dev-secret-not-for-deploys';
let warned = false;

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (!warned) {
    warned = true;
    console.warn('[intake-desk] SESSION_SECRET is missing or short, so a dev secret is in use. Set it before you deploy.');
  }
  return DEV_SECRET;
}

function mac(userId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`intake-desk:${userId}`).digest('base64url');
}

/** The cookie names a user and is signed. It never carries a role. */
export function signSession(userId: string, secret = sessionSecret()): string {
  return `${userId}.${mac(userId, secret)}`;
}

/** Returns the actor, with the role read from config/intake.yaml, or null if the cookie is missing, forged or stale. */
export function verifySession(token: string | null | undefined, config: Config, secret = sessionSecret()): Actor | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(userId, secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const user = config.users[userId];
  if (!user || !config.roles[user.role]) return null;
  return { userId, name: user.name, role: user.role };
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function actorFromRequest(req: Request, config: Config): Actor | null {
  return verifySession(readCookie(req.headers.get('cookie'), SESSION_COOKIE), config);
}
