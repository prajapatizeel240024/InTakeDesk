export function LockIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size * 1.1} viewBox="0 0 10 11" aria-hidden="true">
      <rect x="1" y="5" width="8" height="6" rx="1" fill="currentColor" />
      <path d="M3 5V3.6a2 2 0 0 1 4 0V5" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

/** How a masked value looks everywhere: a hatched bar. The real value was never sent to the browser. */
export function Redacted({ text }: { text: string }) {
  return (
    <span className="redacted" title="Masked for your role">
      <LockIcon />
      {text}
      <span className="sr-only"> (masked for your role)</span>
    </span>
  );
}
