import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { RoleSwitcher } from '@/components/RoleSwitcher';
import { can } from '@/lib/access';
import { getContext } from '@/lib/context';
import { currentActor } from '@/lib/session-server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Intake Desk',
  description: 'Referral intake for a home health team. Synthetic data only.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { config } = await getContext();
  const actor = await currentActor(config);
  const users = Object.entries(config.users).map(([id, u]) => ({ id, name: u.name, roleLabel: config.roles[u.role]?.label ?? u.role }));
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <strong>{config.app.name}</strong>
            <span>{config.app.org}, synthetic data</span>
          </Link>
          {actor && <Nav showAudit={can(config, actor.role, 'view_audit')} />}
          <div className="spacer" />
          <RoleSwitcher users={users} current={actor?.userId ?? null} />
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
