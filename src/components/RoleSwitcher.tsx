'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

export interface DemoUser {
  id: string;
  name: string;
  roleLabel: string;
}

/** Switches the demo user. The server signs a cookie naming the user; the role always comes from the YAML. */
export function RoleSwitcher({ users, current, large = false }: { users: DemoUser[]; current: string | null; large?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function pick(userId: string) {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (res.ok) startTransition(() => router.refresh());
  }

  return (
    <div className={large ? 'switcher large' : 'switcher'} role="group" aria-label="Who is at the desk">
      {users.map((u) => (
        <button key={u.id} type="button" aria-pressed={u.id === current} disabled={pending} onClick={() => void pick(u.id)}>
          <span>{u.name}</span>
          <small>{u.roleLabel}</small>
        </button>
      ))}
    </div>
  );
}
