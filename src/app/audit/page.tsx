import { redirect } from 'next/navigation';
import { Notice } from '@/components/Notice';
import { actorName, auditDetail, describeAudit } from '@/lib/audit-text';
import { getContext } from '@/lib/context';
import { formatDateTime } from '@/lib/format';
import { ServiceError, listAudit } from '@/lib/service';
import { currentActor } from '@/lib/session-server';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const ctx = await getContext();
  const { config } = ctx;
  const actor = await currentActor(config);
  if (!actor) redirect('/');

  let entries;
  try {
    entries = await listAudit(ctx, actor, { limit: 300 });
  } catch (err) {
    if (err instanceof ServiceError) return <Notice title="You can't read the audit log" body={err.message} />;
    throw err;
  }

  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <p>Every view and change, allowed or denied, newest first. It records which fields were touched, never their values, and it can only be added to.</p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">Referral</th>
              <th scope="col">Fields</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className={e.outcome === 'denied' ? 'denied-row' : undefined}>
                <td className="mono">{formatDateTime(e.at)}</td>
                <td>
                  {actorName(config, e.actor)}
                  <br />
                  <span className="muted small">{config.roles[e.role]?.label ?? e.role}</span>
                </td>
                <td>
                  {e.outcome === 'denied' && <span className="denied">Denied: </span>}
                  {describeAudit(config, e)}
                </td>
                <td className="mono">{e.refNo ?? ''}</td>
                <td className="fields-cell">{e.fields.join(', ')}</td>
                <td className="small muted">{auditDetail(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
