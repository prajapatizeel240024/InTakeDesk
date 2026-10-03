import Link from 'next/link';

export function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="notice" role="alert">
      <h1>{title}</h1>
      <p>{body}</p>
      <Link href="/">Back to the queue</Link>
    </div>
  );
}
