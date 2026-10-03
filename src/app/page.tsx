import Link from 'next/link';
import { DescribeView } from '@/components/DescribeView';
import { Notice } from '@/components/Notice';
import { QueueTable } from '@/components/QueueTable';
import { RoleSwitcher } from '@/components/RoleSwitcher';
import { UploadZone } from '@/components/UploadZone';
import { accessLevel, can } from '@/lib/access';
import { getContext } from '@/lib/context';
import { ServiceError, listQueue, listViews } from '@/lib/service';
import { currentActor } from '@/lib/session-server';

export const dynamic = 'force-dynamic';

const EXAMPLES = ['Medicare referrals missing a signed order', 'Referrals waiting on a member ID', 'Ready to schedule, oldest first'];

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await getContext();
  const { config } = ctx;
  const actor = await currentActor(config);

  if (!actor) {
    const users = Object.entries(config.users).map(([id, u]) => ({ id, name: u.name, roleLabel: config.roles[u.role]?.label ?? u.role }));
    return (
      <div className="welcome">
        <h1>Who is at the desk?</h1>
        <p>Pick a demo user. All three see the same referrals, but each role sees different fields, and the server enforces it.</p>
        <RoleSwitcher users={users} current={null} large />
      </div>
    );
  }

  const { status } = await searchParams;
  const active = status && config.statuses[status] ? status : undefined;
  let queue;
  try {
    queue = await listQueue(ctx, actor, { status: active });
  } catch (err) {
    if (err instanceof ServiceError) return <Notice title="You can't see the queue" body={err.message} />;
    throw err;
  }
  const views = await listViews(ctx, actor);
  const role = config.roles[actor.role];
  const limited = config.fields.some((f) => accessLevel(f, actor.role) !== 'full');
  const canUpload = can(config, actor.role, 'upload');
  const canAsk = can(config, actor.role, 'create_view');

  return (
    <>
      <div className="page-head">
        <h1>Referral queue</h1>
        <p>
          Signed in as {actor.name}, {role.label} role.
          {limited ? ' Some fields are masked or left out for this role.' : ' This role sees every field.'}
        </p>
      </div>

      <nav className="tabs" aria-label="Filter by status">
        <Link href="/" aria-current={active ? undefined : 'page'}>
          All<span className="count">{queue.total}</span>
        </Link>
        {Object.entries(config.statuses).map(([key, s]) => (
          <Link key={key} href={`/?status=${key}`} aria-current={active === key ? 'page' : undefined}>
            {s.label}
            <span className="count">{queue.counts[key] ?? 0}</span>
          </Link>
        ))}
      </nav>

      {(canUpload || canAsk) && (
        <div className={canUpload && canAsk ? 'tools' : 'tools single'}>
          {canUpload && <UploadZone />}
          {canAsk && <DescribeView examples={EXAMPLES} />}
        </div>
      )}

      {views.length > 0 && (
        <div className="saved-views">
          <span className="muted">Saved views:</span>
          {views.map((v) => (
            <Link key={v.slug} href={`/views/${v.slug}`}>
              {v.title}
            </Link>
          ))}
        </div>
      )}

      <QueueTable
        columns={queue.columns}
        rows={queue.rows}
        emptyText={active ? 'Nothing in this status right now.' : 'No referrals yet. Drop a referral PDF to start.'}
      />
    </>
  );
}
