"use client";

import { useState } from "react";

type Row = {
  key: string;
  label: string;
  count: number | null;
  pct: number | null;
  drop: number | null;
  note?: string;
  sub?: boolean;
  expandable?: boolean;
  detail?: boolean;
};

const nf = (n: number) => n.toLocaleString("en-IN");

function barColor(i: number): string {
  const c = [
    "var(--primary)",
    "var(--primary-2)",
    "var(--blue)",
    "var(--cyan-bright)",
    "var(--green)",
    "var(--yellow)",
    "#136c46",
  ];
  return c[i % c.length];
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`fchevron-ic ${open ? "open" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export default function FunnelView({ rows, maxCount }: { rows: Row[]; maxCount: number }) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});

  // each detail row belongs to the nearest preceding expandable row
  const parentOf: Record<string, string> = {};
  let cur: string | null = null;
  for (const r of rows) {
    if (r.expandable) cur = r.key;
    else if (!r.detail) cur = null;
    if (r.detail && cur) parentOf[r.key] = cur;
  }

  return (
    <div className="funnel">
      {rows.map((row, i) => {
        if (row.detail && !openKeys[parentOf[row.key]]) return null;
        const rowOpen = !!openKeys[row.key];

        if (row.count === null) {
          return (
            <div className="frow pending" key={row.key}>
              <span className="name">{row.label}</span>
              <div className="pbar">{row.note}</div>
              <span className="meta">-</span>
            </div>
          );
        }

        const count = row.count;
        const width = Math.max(6, Math.round((count / maxCount) * 100));
        return (
          <div className={`frow ${row.sub ? "sub" : ""} ${row.detail ? "detail" : ""}`} key={row.key}>
            <span className="name">
              {row.label}
              {row.expandable ? (
                <button
                  className="fchevron"
                  onClick={() => setOpenKeys((o) => ({ ...o, [row.key]: !o[row.key] }))}
                  aria-expanded={rowOpen}
                  aria-label={rowOpen ? "Collapse detail" : "Expand detail"}
                >
                  <Chevron open={rowOpen} />
                </button>
              ) : null}
            </span>
            <div className="fbar" style={{ width: `${width}%`, background: barColor(i) }}>
              {nf(count)}
            </div>
            <span className="meta">
              {row.pct !== null ? <b className="tnum">{row.pct.toFixed(1)}%</b> : null}
              {row.drop !== null && row.drop < 0 ? (
                <>
                  {" "}
                  · <span className="drop tnum">{row.drop.toFixed(1)}%</span>
                </>
              ) : null}
              {row.note ? (
                <>
                  <br />
                  <span style={{ fontSize: 11 }}>{row.note}</span>
                </>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
