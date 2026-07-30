import Link from "next/link";
import type { ChannelRow, ChannelSplit } from "@/lib/channels";

// AI vs human calling. Four mutually exclusive buckets per row, never a sum of
// the two channels: a student can be reached by both, so adding them double counts.

const nf = (n: number) => n.toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

/**
 * Two circles with areas proportional to each channel's reach, overlapping by an
 * amount that reflects the "both" count. Circle radius from area (r = sqrt(A/pi))
 * so the eye compares areas, not radii.
 */
function Venn({ row }: { row: ChannelRow }) {
  const ai = row.both + row.aiOnly;
  const hu = row.both + row.humanOnly;
  if (ai === 0 && hu === 0) return null;

  const W = 320, H = 190;
  const big = Math.max(ai, hu, 1);
  const rMax = 66;
  const r = (n: number) => Math.max(8, rMax * Math.sqrt(n / big));
  const rA = r(ai), rH = r(hu);

  // Overlap: 0 shared -> circles just touch; all shared -> smaller sits inside
  // the larger. Linear in the shared fraction of the smaller set, which reads
  // honestly even though exact-area Venn solving is not closed-form.
  const share = Math.min(ai, hu) > 0 ? row.both / Math.min(ai, hu) : 0;
  const gap = (rA + rH) - share * (rA + rH - Math.abs(rA - rH));
  const cx = W / 2, cy = H / 2 - 4;
  const xA = cx - gap / 2, xH = cx + gap / 2;

  return (
    <div className="cs-venn">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
           aria-label={`AI reached ${ai}, human reached ${hu}, both ${row.both}`}>
        <circle cx={xA} cy={cy} r={rA} className="cs-c-ai" />
        <circle cx={xH} cy={cy} r={rH} className="cs-c-hu" />
        <text x={xA - rA * 0.35} y={cy + 4} className="cs-vlab">{nf(row.aiOnly)}</text>
        <text x={xH + rH * 0.35} y={cy + 4} className="cs-vlab">{nf(row.humanOnly)}</text>
        {row.both > 0 && <text x={cx} y={cy + 4} className="cs-vlab cs-vboth">{nf(row.both)}</text>}
      </svg>
      <div className="cs-vkey">
        <span><i className="cs-sw-ai" />AI reached {nf(ai)}</span>
        <span><i className="cs-sw-hu" />Human reached {nf(hu)}</span>
        <span><i className="cs-sw-both" />Both {nf(row.both)}</span>
      </div>
    </div>
  );
}

export default function ChannelSplitBlock({
  split, qs, note,
}: {
  split: ChannelSplit;
  /** base drill query string, e.g. "round=NSAT-4" */
  qs: string;
  note?: string;
}) {
  const { all, rows, cohort, scope, reachedAny, nobody } = split;
  const href = (r: ChannelRow) => (r.drill ? `/drill?${qs}&${r.drill}` : `/drill?${qs}`);

  return (
    <section className="grid mb">
      <div className="card">
        <header>
          <h3>AI calling vs human calling · {cohort}</h3>
          <span className="cap">two channels, not two steps · {scope}</span>
        </header>

        <div className="cs-top">
          <Venn row={all} />
          <div className="cs-figs">
            <div className="cs-fig">
              <div className="cs-n tnum">{nf(reachedAny)}</div>
              <div className="cs-l">Reached by anyone <span className="cs-dim">{pct(reachedAny, all.total)} of {nf(all.total)}</span></div>
            </div>
            <div className="cs-fig cs-fig-bad">
              <div className="cs-n tnum">{nf(nobody)}</div>
              <div className="cs-l">Reached by nobody <span className="cs-dim">{pct(nobody, all.total)} of {nf(all.total)}</span></div>
            </div>
          </div>
        </div>

        <div className="cv-scroll">
          <table className="cv-table cs-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="tnum">Total</th>
                <th className="tnum">Both</th>
                <th className="tnum">AI only</th>
                <th className="tnum">Human only</th>
                <th className="tnum">Nobody</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={r.key === "all" ? "co-strong" : undefined}>
                  <td><Link href={href(r)} className="sb-link">{r.label}</Link></td>
                  <td className="tnum">{nf(r.total)}</td>
                  <td className="tnum cs-both">{nf(r.both)}<span className="fc-pct"> {pct(r.both, r.total)}</span></td>
                  <td className="tnum cs-ai">{nf(r.aiOnly)}<span className="fc-pct"> {pct(r.aiOnly, r.total)}</span></td>
                  <td className="tnum cs-hu">{nf(r.humanOnly)}<span className="fc-pct"> {pct(r.humanOnly, r.total)}</span></td>
                  <td className="tnum fc-bad">{nf(r.nobody)}<span className="fc-pct"> {pct(r.nobody, r.total)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* The gap the view exists to expose. */}
        {(() => {
          const un = rows.find((r) => r.key === "unreg");
          if (!un || un.total === 0) return null;
          const aiTouched = un.both + un.aiOnly;
          return (
            <div className="cs-gap">
              <b>{nf(un.nobody)}</b> of {nf(un.total)} unregistered leads ({pct(un.nobody, un.total)}) have heard from
              nobody. AI has reached just <b>{nf(aiTouched)}</b> of them.
            </div>
          );
        })()}

        {note && <p className="cs-note">{note}</p>}
      </div>
    </section>
  );
}
