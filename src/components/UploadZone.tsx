'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

interface Item {
  key: string;
  name: string;
  state: 'reading' | 'done' | 'error';
  id?: string;
  refNo?: string;
  statusLabel?: string;
  statusTone?: string;
  message?: string;
}

export function UploadZone() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const update = (key: string, next: Partial<Item>) => setItems((list) => list.map((it) => (it.key === key ? { ...it, ...next } : it)));

  async function send(files: FileList | null) {
    if (!files?.length) return;
    const batch = Array.from(files).map((file) => ({ file, key: crypto.randomUUID() }));
    setItems((list) => [...batch.map(({ file, key }) => ({ key, name: file.name, state: 'reading' as const })), ...list].slice(0, 8));
    await Promise.all(
      batch.map(async ({ file, key }) => {
        if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
          update(key, { state: 'error', message: 'Only PDF referrals can be uploaded.' });
          return;
        }
        const body = new FormData();
        body.append('file', file);
        try {
          const res = await fetch('/api/referrals', { method: 'POST', body });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Upload failed.');
          const r = data.referral;
          update(key, {
            state: 'done',
            id: r.id,
            refNo: r.refNo,
            statusLabel: r.statusLabel,
            statusTone: r.statusTone,
            message: data.duplicate ? 'Already in the queue' : r.nextAction,
          });
        } catch (err) {
          update(key, { state: 'error', message: err instanceof Error ? err.message : 'Upload failed.' });
        }
      }),
    );
    router.refresh();
  }

  return (
    <section className="panel" aria-labelledby="upload-title">
      <h2 id="upload-title">Add referrals</h2>
      <p>Drop faxed referral PDFs. Claude reads each one and fills in the record.</p>
      <div
        className={over ? 'drop over' : 'drop'}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files);
        }}
      >
        <strong>Drop PDFs here</strong>
        <span className="muted small">or click to choose files, up to 10 MB each</span>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          void send(e.target.files);
          e.target.value = '';
        }}
      />
      {items.length > 0 && (
        <ul className="uploads" aria-live="polite">
          {items.map((it) => (
            <li key={it.key}>
              <span className="name">{it.name}</span>
              {it.state === 'reading' && <span className="muted small">Reading…</span>}
              {it.state === 'error' && <span className="error">{it.message}</span>}
              {it.state === 'done' && (
                <>
                  <Link href={`/referrals/${it.id}`} className="mono" title={it.message}>
                    {it.refNo}
                  </Link>
                  <span className={`status tone-${it.statusTone ?? 'slate'}`}>{it.statusLabel}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
