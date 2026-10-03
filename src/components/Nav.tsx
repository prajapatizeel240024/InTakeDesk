'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Nav({ showAudit }: { showAudit: boolean }) {
  const path = usePathname();
  const queueActive = path === '/' || path.startsWith('/referrals') || path.startsWith('/views');
  return (
    <nav className="nav" aria-label="Main">
      <Link href="/" aria-current={queueActive ? 'page' : undefined}>
        Queue
      </Link>
      {showAudit && (
        <Link href="/audit" aria-current={path.startsWith('/audit') ? 'page' : undefined}>
          Audit log
        </Link>
      )}
    </nav>
  );
}
