import type { Dispatch, SetStateAction } from "react";
import type { KeyValueRow } from "../domain/types.ts";

export function emptyRow(): KeyValueRow {
  return { id: Date.now() + Math.random(), name: "", value: "", enabled: true };
}

export function KeyValueTable({
  rows,
  setRows,
  label,
}: {
  rows: KeyValueRow[];
  setRows: Dispatch<SetStateAction<KeyValueRow[]>>;
  label: string;
}) {
  function updateRow(id: number, field: keyof KeyValueRow, value: string | boolean) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  return (
    <div className="key-value-table">
      <div className="table-labels"><span /><span>Key</span><span>Value</span><span /></div>
      {rows.map((row) => (
        <div className="key-value-row" key={row.id}>
          <input checked={row.enabled} onChange={(event) => updateRow(row.id, "enabled", event.target.checked)} type="checkbox" aria-label={`Enable ${row.name || label}`} />
          <input value={row.name} onChange={(event) => updateRow(row.id, "name", event.target.value)} placeholder={`${label} name`} aria-label={`${label} name`} />
          <input value={row.value} onChange={(event) => updateRow(row.id, "value", event.target.value)} placeholder="Value" aria-label={`${label} value`} />
          <button type="button" className="row-remove" onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))} aria-label={`Remove ${label}`}>×</button>
        </div>
      ))}
      <button className="add-row" type="button" onClick={() => setRows((current) => [...current, emptyRow()])}>+ Add {label.toLowerCase()}</button>
    </div>
  );
}
