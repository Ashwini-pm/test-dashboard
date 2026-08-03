"use client";

import Link from "next/link";
import { useState } from "react";
import type { SourceAction } from "@/lib/v2";
import { NO_SRC } from "@/lib/v2";

// Source x calling coverage. The CRM's taxonomy has a long tail: for CSAT-1,
// twelve categories hold 38 leads between them, mostly pre-campaign leads
// carrying whatever source first brought them into the CRM months or years ago.
// Listing them all buried the six that matter, so anything under the threshold
// collapses into one Small quantum row that expands on click.
//
// Nothing is hidden or re-bucketed in the data: the rows are the same rows, and
// Small quantum's own numbers are the exact sum of its children.

const nf = (n: number) => n.toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** A source with fewer leads than this folds into Small quantum. */
const SMALL_MAX = 10;
/** Always folded in regardless of size, by request. */
const isSmall = (r: SourceAction) => r.leads < SMALL_MAX || r.src === NO_SRC;

function Row({ r, qs, indent }: { r: SourceAction; qs: string; indent?: boolean }) {
  const cp = pct(r.called, r.leads);
  const src = `src=${encodeURIComponent(r.src)}`;
  return (
    <tr>
      <td className={indent ? "sa-child" : undefined}>{r.src}</td>
      <td className="tnum"><Link href={`/drill?${qs}&${src}`} className="sb-link">{nf(r.leads)}</Link></td>
      <td className="tnum">
        {r.called > 0
          ? <Link href={`/drill?${qs}&${src}&act=called`} className="sb-link">{nf(r.called)}</Link>
          : nf(r.called)}
      </td>
      <td className={`tnum ${cp === 0 ? "cv-zero" : ""}`}>{cp}%{cp === 0 ? " ⚠" : ""}</td>
      <td className="tnum">
        {r.connected > 0
          ? <Link href={`/drill?${qs}&${src}&act=conn`} className="sb-link">{nf(r.connected)}</Link>
          : nf(r.connected)}
      </td>
      <td className="tnum">{pct(r.connected, r.leads)}%</td>
    </tr>
  );
}

export default function SourceActionTable({ rows, qs }: { rows: SourceAction[]; qs: string }) {
  const [open, setOpen] = useState(false);

  const big = rows.filter((r) => !isSmall(r));
  const small = rows.filter(isSmall);
  const sum = (rs: SourceAction[]) =>
    rs.reduce((a, r) => ({ leads: a.leads + r.leads, called: a.called + r.called, connected: a.connected + r.connected }),
      { leads: 0, called: 0, connected: 0 });
  const t = sum(rows);
  const s = sum(small);
  // every source in the tail, so the row's own numbers open exactly its own leads
  const smallQs = small.map((r) => `src=${encodeURIComponent(r.src)}`).join("&");
  const scp = pct(s.called, s.leads);

  return (
    <div className="cv-scroll">
      <table className="cv-table">
        <thead>
          <tr>
            <th>Source</th>
            <th className="tnum">Leads</th>
            <th className="tnum">Called</th>
            <th className="tnum">%</th>
            <th className="tnum">Connected</th>
            <th className="tnum">%</th>
          </tr>
        </thead>
        <tbody>
          {big.map((r) => <Row key={r.src} r={r} qs={qs} />)}

          {small.length > 0 && (
            <tr className="sa-group">
              <td>
                <button type="button" className="sa-toggle" onClick={() => setOpen(!open)}
                        aria-expanded={open}>
                  <span className={`sa-caret${open ? " on" : ""}`}>▸</span>
                  Small quantum
                  <span className="sa-count">{small.length} sources</span>
                </button>
              </td>
              <td className="tnum"><Link href={`/drill?${qs}&${smallQs}`} className="sb-link">{nf(s.leads)}</Link></td>
              <td className="tnum">
                {s.called > 0
                  ? <Link href={`/drill?${qs}&${smallQs}&act=called`} className="sb-link">{nf(s.called)}</Link>
                  : nf(s.called)}
              </td>
              <td className={`tnum ${scp === 0 ? "cv-zero" : ""}`}>{scp}%{scp === 0 ? " ⚠" : ""}</td>
              <td className="tnum">
                {s.connected > 0
                  ? <Link href={`/drill?${qs}&${smallQs}&act=conn`} className="sb-link">{nf(s.connected)}</Link>
                  : nf(s.connected)}
              </td>
              <td className="tnum">{pct(s.connected, s.leads)}%</td>
            </tr>
          )}
          {open && small.map((r) => <Row key={r.src} r={r} qs={qs} indent />)}
        </tbody>
        <tfoot>
          <tr>
            <td><b>Total</b></td>
            <td className="tnum"><b>{nf(t.leads)}</b></td>
            <td className="tnum"><b>{nf(t.called)}</b></td>
            <td className="tnum"><b>{pct(t.called, t.leads)}%</b></td>
            <td className="tnum"><b>{nf(t.connected)}</b></td>
            <td className="tnum"><b>{pct(t.connected, t.leads)}%</b></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
