import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Notice } from '@/components/Notice';
import { QueueTable } from '@/components/QueueTable';
import { getContext } from '@/lib/context';
import { ServiceError, runView } from '@/lib/service';
import { currentActor } from '@/lib/session-server';

export const dynamic = 'force-dynamic';

export default async function ViewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await getContext();
  const actor = await currentActor(ctx.config);
  if (!actor) redirect('/');

  let result;
  try {
    result = await runView(ctx, actor, slug);
  } catch (err) {
    if (err instanceof ServiceError && err.status === 404) notFound();
    if (err instanceof ServiceError) return <Notice title="You can't run this view" body={err.message} />;
    throw err;
  }
  const { view, queue } = result;

  return (
    <>
      <Link href="/" className="back">
        Back to the queue
      </Link>
      <div className="page-head">
        <h1>{view.title}</h1>
        <p>
          {view.config.description} {queue.rows.length} {queue.rows.length === 1 ? 'referral matches' : 'referrals match'} right now.
        </p>
      </div>
      <div className="view-layout">
        <QueueTable columns={queue.columns} rows={queue.rows} emptyText="No referrals match this view right now." />
        <aside className="panel">
          <h2>The config the agent wrote</h2>
          <p>
            {view.prompt ? <>Asked for &ldquo;{view.prompt}&rdquo;. </> : null}
            It was checked against config/intake.yaml and the role that asked before it was saved.
          </p>
          <pre className="yaml">{view.yaml}</pre>
        </aside>
      </div>
    </>
  );
}
