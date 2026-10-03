'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FieldView } from '@/lib/access';
import { Redacted } from './Redacted';

type Draft = string | string[];

function toDraft(field: FieldView): Draft {
  const v = field.value;
  if (field.type === 'multi_enum') return Array.isArray(v) ? v.map(String) : [];
  if (field.type === 'code_list') return Array.isArray(v) ? v.join(', ') : '';
  if (field.type === 'boolean') return v === true ? 'yes' : v === false ? 'no' : '';
  return v === null || v === undefined ? '' : String(v);
}

function Badge({ field, threshold }: { field: FieldView; threshold: number }) {
  if (field.access !== 'full' || field.source === null) return null;
  if (field.source === 'human') return <span className="badge checked">Entered by staff</span>;
  if (field.verified) return <span className="badge checked">Checked by staff</span>;
  if (field.confidence === null) return null;
  const low = field.confidence < threshold;
  return (
    <span className={low ? 'badge low' : 'badge'} title="How sure the AI was about this value">
      AI {Math.round(field.confidence * 100)}%
    </span>
  );
}

function Editor({ field, draft, setDraft }: { field: FieldView; draft: Draft; setDraft: (d: Draft) => void }) {
  const id = `edit-${field.key}`;
  const label = (
    <label htmlFor={id} className="sr-only">
      {field.label}
    </label>
  );
  switch (field.type) {
    case 'enum':
    case 'boolean': {
      const options = field.type === 'boolean' ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] : (field.options ?? []);
      return (
        <>
          {label}
          <select id={id} value={draft as string} onChange={(e) => setDraft(e.target.value)}>
            <option value="">Not stated</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      );
    }
    case 'multi_enum':
      return (
        <fieldset className="checks" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="sr-only">{field.label}</legend>
          {(field.options ?? []).map((o) => {
            const list = draft as string[];
            return (
              <label key={o.value}>
                <input
                  type="checkbox"
                  checked={list.includes(o.value)}
                  onChange={(e) => setDraft(e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value))}
                />
                {o.label}
              </label>
            );
          })}
        </fieldset>
      );
    case 'date':
      return (
        <>
          {label}
          <input id={id} type="date" value={draft as string} onChange={(e) => setDraft(e.target.value)} />
        </>
      );
    case 'text':
      return (
        <>
          {label}
          <textarea id={id} value={draft as string} onChange={(e) => setDraft(e.target.value)} />
        </>
      );
    default:
      return (
        <>
          {label}
          <input
            id={id}
            value={draft as string}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={field.type === 'code_list' ? 'Codes separated by commas' : undefined}
            className={field.mono ? 'mono' : undefined}
          />
        </>
      );
  }
}

export function FieldRow({ referralId, field, threshold }: { referralId: string; field: FieldView; threshold: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(field));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/referrals/${referralId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'That change was not saved.');
        return;
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError('That change was not saved. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const flag = field.flag;
  const unset = field.display === '—';
  return (
    <div className={flag ? `field flag-${flag.kind}` : 'field'}>
      <div className="label">{field.label}</div>
      <div className={unset ? 'value unset' : 'value'}>
        {field.access === 'masked' ? (
          <Redacted text={field.display} />
        ) : (
          <span className={field.mono && !unset ? 'mono' : undefined}>{unset ? 'Not on the referral' : field.display}</span>
        )}
      </div>
      <div className="meta">
        <Badge field={field} threshold={threshold} />
        {field.editable && !editing && flag?.kind === 'review' && (
          <button className="btn small" type="button" disabled={busy} onClick={() => void save({ verify: [field.key] })}>
            Looks right
          </button>
        )}
        {field.editable && !editing && (
          <button
            className="btn quiet small"
            type="button"
            onClick={() => {
              setDraft(toDraft(field));
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>

      {flag?.kind === 'invalid' && flag.message && <div className="note problem">{flag.message}</div>}
      {flag?.kind === 'missing' && <div className="note missing">Required, and not on the referral.</div>}
      {flag?.kind === 'review' && !editing && <div className="note">The AI wasn&apos;t sure about this one. Check it against the fax.</div>}
      {field.evidence && !editing && <div className="evidence">From the fax: &ldquo;{field.evidence}&rdquo;</div>}

      {editing && (
        <form
          className="edit-row"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ set: { [field.key]: draft } });
          }}
        >
          <Editor field={field} draft={draft} setDraft={setDraft} />
          <button className="btn small" type="submit" disabled={busy}>
            Save
          </button>
          <button className="btn quiet small" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && <div className="note problem">{error}</div>}
    </div>
  );
}
