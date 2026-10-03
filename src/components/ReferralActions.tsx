'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  referralId: string;
  owner: string | null;
  users: { id: string; name: string }[];
  canAssign: boolean;
  canSchedule: boolean;
  defaultDate: string;
}

export function ReferralActions({ referralId, owner, users, canAssign, canSchedule, defaultDate }: Props) {
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/referrals/${referralId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'That change was not saved.');
      else router.refresh();
    } catch {
      setError('That change was not saved. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!canAssign && !canSchedule) return null;
  return (
    <div className="stack">
      {canAssign && (
        <label className="stack">
          Owner
          <select value={owner ?? ''} disabled={busy} onChange={(e) => void patch({ owner: e.target.value || null })}>
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {canSchedule && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void patch({ schedule: date });
          }}
        >
          <label className="stack">
            Start of care
            <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            Schedule visit
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
