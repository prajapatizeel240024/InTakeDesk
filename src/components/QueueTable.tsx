import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ColumnView, RowView } from '@/lib/access';
import { Redacted } from './Redacted';
import { Status } from './Status';

export function QueueTable({ columns, rows, emptyText }: { columns: ColumnView[]; rows: RowView[]; emptyText: string }) {
  if (!rows.length) {
    return (
      <div className="table-wrap">
        <p className="empty">{emptyText}</p>
      </div>
    );
  }
  const linkColumn = columns.find((c) => c.key === 'patient_name')?.key ?? columns[0]?.key;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((c) => {
                const cell = row.cells[c.key];
                let content: ReactNode = cell.masked ? (
                  <Redacted text={cell.text} />
                ) : c.key === 'status' ? (
                  <Status label={cell.text} tone={cell.tone} />
                ) : (
                  <span className={cell.mono ? 'mono' : undefined}>{cell.text}</span>
                );
                if (c.key === linkColumn) {
                  content = (
                    <Link className="row-link" href={`/referrals/${row.id}`}>
                      {content}
                    </Link>
                  );
                }
                return (
                  <td key={c.key} className={c.key === 'next_action' ? 'next' : undefined}>
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
