export function Status({ label, tone }: { label: string; tone?: string }) {
  return <span className={`status tone-${tone ?? 'slate'}`}>{label}</span>;
}
