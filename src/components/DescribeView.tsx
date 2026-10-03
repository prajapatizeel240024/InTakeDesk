'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function DescribeView({ examples }: { examples: string[] }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  async function build(text: string) {
    const value = text.trim();
    if (!value || busy) return;
    setPrompt(value);
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch('/api/views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: value }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrors([data.error ?? 'The view could not be built.', ...(data.details ?? [])]);
        return;
      }
      router.push(`/views/${data.view.slug}`);
    } catch {
      setErrors(['The view could not be built. Check your connection and try again.']);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="ask-title">
      <h2 id="ask-title">Make a view</h2>
      <p>Describe the list you need. Claude writes it as a view config, it is checked against the YAML and your role, and it opens as a new screen.</p>
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          void build(prompt);
        }}
      >
        <label htmlFor="ask-input" className="sr-only">
          Describe a view
        </label>
        <input
          id="ask-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Show me Medicare referrals missing a signed order"
          maxLength={300}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Building…' : 'Build view'}
        </button>
      </form>
      <div className="examples">
        {examples.map((ex) => (
          <button key={ex} type="button" disabled={busy} onClick={() => void build(ex)}>
            {ex}
          </button>
        ))}
      </div>
      {errors.length > 0 && (
        <ul className="error" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
