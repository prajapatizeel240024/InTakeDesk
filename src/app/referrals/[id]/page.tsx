import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { FieldRow } from '@/components/FieldRow';
import { Notice } from '@/components/Notice';
import { LockIcon, Redacted } from '@/components/Redacted';
import { ReferralActions } from '@/components/ReferralActions';
import { Status } from '@/components/Status';
import { can, type ReferralView } from '@/lib/access';
import { actorName, describeAudit } from '@/lib/audit-text';
import { getContext } from '@/lib/context';
import { formatDate, formatDateTime, todayIso } from '@/lib/format';
import { ServiceError, getReferral, listAudit } from '@/lib/service';
import { currentActor } from '@/lib/session-server';

export const dynamic = 'force-dynamic';

function extractionNote(e: ReferralView['extraction']): string | null {
  if (!e) return null;
  if (e.error) return e.error;
  if (e.model.startsWith('seeded')) return 'Seeded from the answer key for the demo, as if the AI had read it.';
  return `Read by ${e.model} in ${(e.ms / 1000).toFixed(1)} s${e.fallbackUsed ? ', using the fallback model' : ''}.`;
}

function tomorrow(): string {
  const d = new Date(`${todayIso()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export default async function ReferralPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getContext();
  const { config } = ctx;
  const actor = await currentActor(config);
  if (!actor) redirect('/');

  let view: ReferralView;
  try {
    view = await getReferral(ctx, actor, id);
  } catch (err) {
    if (err instanceof ServiceError && err.status === 404) notFound();
    if (err instanceof ServiceError) return <Notice title="You can't open this referral" body={err.message} />;
    throw err;
  }

  const trail = can(config, actor.role, 'view_audit') ? await listAudit(ctx, actor, { referralId: view.id, limit: 8 }) : null;
  const name = view.sections.flatMap((s) => s.fields).find((f) => f.key === 'patient_name');
  const blocked = view.flags.some((f) => f.blocking);
  const users = Object.entries(config.users).map(([uid, u]) => ({ id: uid, name: u.name }));
  const roleLabel = config.roles[actor.role]?.label ?? actor.role;
  const note = extractionNote(view.extraction);

  return (
    <>
      <Link href="/" className="back">
        Back to the queue
      </Link>
      <div className="detail">
        <div>
          <div className="ref-head">
            <h1>{name ? name.access === 'masked' ? <Redacted text={name.display} /> : name.display : 'Patient'}</h1>
            <Status label={view.statusLabel} tone={view.statusTone} />
          </div>
          <p className="muted">
            <span className="mono">{view.refNo}</span>, received {formatDateTime(view.receivedAt)}
          </p>

          {view.nextAction && (
            <div className={blocked ? 'next-action blocked' : 'next-action'}>
              <span>Next action</span>
              <strong>{view.nextAction}</strong>
            </div>
          )}

          {view.sections.map((section) => (
            <section key={section.key} className="section" aria-labelledby={`section-${section.key}`}>
              <h2 id={`section-${section.key}`}>{section.label}</h2>
              {section.fields.map((field) => (
                <FieldRow key={field.key} referralId={view.id} field={field} threshold={config.workflow.review_threshold} />
              ))}
            </section>
          ))}

          {view.hidden.length > 0 && (
            <div className="hidden-list">
              <LockIcon size={12} />
              <span>
                Left out for the {roleLabel} role: {view.hidden.map((h) => h.label).join(', ')}. These fields never leave the server for this
                role.
              </span>
            </div>
          )}
        </div>

        <aside className="rail" aria-label="Referral actions">
          <div className="panel">
            <h2>Open items</h2>
            {view.flags.length ? (
              <ul className="flag-list">
                {view.flags.map((f) => (
                  <li key={f.key}>
                    <span className={f.kind === 'review' ? 'dot review' : 'dot'} aria-hidden="true" />
                    {f.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ok-text">Nothing open.</p>
            )}
          </div>

          <div className="panel">
            <h2>Work it</h2>
            <dl>
              <dt>Owner</dt>
              <dd>{view.ownerName ?? 'Unassigned'}</dd>
              {view.startOfCare && (
                <>
                  <dt>Start of care</dt>
                  <dd>{formatDate(view.startOfCare)}</dd>
                </>
              )}
            </dl>
            <ReferralActions
              referralId={view.id}
              owner={view.owner}
              users={users}
              canAssign={view.permissions.assign}
              canSchedule={view.permissions.schedule && config.workflow.schedule.from.includes(view.status)}
              defaultDate={tomorrow()}
            />
            {!view.permissions.assign && !view.permissions.schedule && <p className="muted small">Your role can read this referral but not work it.</p>}
          </div>

          <div className="panel">
            <h2>Source</h2>
            {view.permissions.viewDocument ? (
              <a className="btn quiet" href={`/api/referrals/${view.id}/document`} target="_blank" rel="noopener noreferrer">
                Open original fax
              </a>
            ) : (
              <p className="muted small">Your role can&apos;t open the original fax.</p>
            )}
            {note && <p className="muted small">{note}</p>}
          </div>

          {trail && (
            <div className="panel">
              <h2>Audit trail</h2>
              <ul className="trail">
                {trail.map((e) => (
                  <li key={e.id}>
                    <span className="when">{formatDateTime(e.at)}</span>
                    <span className={e.outcome === 'denied' ? 'denied' : undefined}>
                      {actorName(config, e.actor)} {describeAudit(config, e)}
                    </span>
                  </li>
                ))}
              </ul>
              <Link href="/audit" className="small">
                Full audit log
              </Link>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
