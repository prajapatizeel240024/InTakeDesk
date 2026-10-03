import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '../src/lib/session';
import { loadConfig } from './helpers';

const config = loadConfig();
const secret = 'test-secret-0123456789';

describe('demo sessions', () => {
  it('takes the role from the YAML, not from the cookie', () => {
    expect(verifySession(signSession('marcus', secret), config, secret)).toEqual({ userId: 'marcus', name: 'Marcus Hale', role: 'billing' });
  });

  it('rejects a cookie edited to name someone else', () => {
    const forged = signSession('marcus', secret).replace(/^marcus/, 'priya');
    expect(verifySession(forged, config, secret)).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    expect(verifySession(signSession('priya', 'some-other-secret-123'), config, secret)).toBeNull();
  });

  it('rejects a properly signed cookie for someone who is not in the YAML', () => {
    expect(verifySession(signSession('mallory', secret), config, secret)).toBeNull();
  });

  it('rejects junk', () => {
    for (const token of ['', 'priya', '.abc', 'priya.']) expect(verifySession(token, config, secret)).toBeNull();
  });
});
