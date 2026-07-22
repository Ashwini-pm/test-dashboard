"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Col = { key: string; label: string; kind: "text" | "select" };
type Row = Record<string, string | null>;

// Stage tab table: fixed identity columns + the stage's bifurcation columns,
// with a filter under EVERY column header (text search or value dropdown).
export default function StageTable({
  columns,
  rows,
  initial,
}: {
  columns: Col[];
  rows: Row[];
  initial: Record<string, string>;
}) {
  const [filters, setFilters] = useState<Record<string, string>>(initial);

  const options = useMemo(() => {
    const o: Record<string, string[]> = {};
    for (const c of columns) {
      if (c.kind !== "select") continue;
      o[c.key] = Array.from(new Set(rows.map((r) => r[c.key] ?? "-"))).sort();
    }
    return o;
  }, [columns, rows]);

  const filtered = rows.filter((r) =>
    columns.every((c) => {
      const f = (filters[c.key] ?? "").trim();
      if (!f) return true;
      const v = r[c.key] ?? "-";
      if (c.kind === "select") return f === "__blank__" ? v === "" : v === f;
      return v.toLowerCase().includes(f.toLowerCase());
    })
  );

  const set = (k: string, v: string) => setFilters((p) => ({ ...p, [k]: v }));

  return (
    <>
      <div className="stage-count">
        <b className="tnum">{filtered.length.toLocaleString("en-IN")}</b> of{" "}
        {rows.length.toLocaleString("en-IN")} students
        {Object.values(filters).some((v) => v?.trim()) ? (
          <button className="clear-filters" onClick={() => setFilters({})}>
            clear filters ✕
          </button>
        ) : null}
      </div>
      <div className="stage-table-wrap">
        <table className="list stage-table">
          <thead>
            <tr>
              <th className="sno">S.No.</th>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
            <tr className="filter-row">
              <th className="sno" />
              {columns.map((c) => (
                <th key={c.key}>
                  {c.kind === "select" ? (
                    <select value={filters[c.key] ?? ""} onChange={(e) => set(c.key, e.target.value)}>
                      <option value="">All</option>
                      {(options[c.key] ?? []).map((v) => (
                        <option key={v || "__blank__"} value={v || "__blank__"}>
                          {v || "(blank)"}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={filters[c.key] ?? ""}
                      onChange={(e) => set(c.key, e.target.value)}
                      placeholder="Filter…"
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} style={{ textAlign: "center", padding: 24, color: "#8a93a0" }}>
                  no students match the filters
                </td>
              </tr>
            ) : (
              filtered.map((r, i) => (
                <tr key={r.lead_id}>
                  <td className="sno tnum">{i + 1}</td>
                  {columns.map((c) =>
                    c.key === "name" ? (
                      <td key={c.key}>
                        <Link
                          href={`/leads/${encodeURIComponent(r.lead_id ?? "")}`}
                          style={{ fontWeight: 600, textDecoration: "none" }}
                        >
                          {r.name || "(unnamed)"}
                        </Link>
                      </td>
                    ) : (
                      <td key={c.key} className={c.key === "phone" ? "tnum" : r[c.key] === "✓" ? "tick" : undefined}>
                        {r[c.key] ?? "-"}
                      </td>
                    )
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
