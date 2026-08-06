import Link from "next/link";
import type { XyzResult } from "@/lib/v2";

// Offers and seats as X + Y + Z.
//
//   X counselling  a panelist recorded the student
//   Y old lead     not counselled, lead existed before the round opened
//   Z direct       not counselled, lead created inside the window (sales ops)
//
// The three always sum to the total. Nothing is subtracted: an earlier version of
// this idea deducted old leads and made a funnel look like it fell from 26 to 11,
// which read as a loss that never happened.
//
// Never a bare percentage: every cell shows the count with its share beside it, so
// the group size is always visible.

const nf = (n: number) => n.toLocaleString("en-IN");
const pc = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function Cell({ n, of, href, tone }: { n: number; of: number; href?: string; tone?: string }) {
  if (!n) return <td className="tnum fc-zero">—</td>;
  const body = <>{nf(n)}<span className="fc-pct">{pc(n, of)}</span></>;
  return (
    <td className={`tnum${tone ? ` ${tone}` : ""}`}>
      {href ? <Link href={href} className="sb-link">{body}</Link> : body}
    </td>
  );
}

export default function OutcomeXyz({ data, qs }: { data: XyzResult; qs: string }) {
  const { rows, hasCounselling, windowOpen } = data;
  const d = new Date(windowOpen + "T00:00:00Z");
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const winLabel = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;

  return (
    <section className="grid mb">
      <div className="card">
        <header>
          <h3>Where the offers and seats came from</h3>
          <span className="cap">
            counselling · old lead · direct · registration opened {winLabel}
          </span>
        </header>

        <div className="cv-scroll">
          <table className="cv-table">
            <thead>
              <tr>
                <th />
                <th className="tnum">Total</th>
                <th className="tnum">Through counselling</th>
                <th className="tnum">Old lead</th>
                <th className="tnum">Direct</th>
                {rows.some((r) => r.unknown > 0) && <th className="tnum">Vintage unknown</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="tnum"><b>{nf(r.total)}</b></td>
                  {hasCounselling
                    ? <Cell n={r.counselling} of={r.total} href={`/drill?${qs}&has=${r.key}&xyz=couns`} tone="cv-reg" />
                    : <td className="fc-zero">no counselling yet</td>}
                  <Cell n={r.oldLead} of={r.total} href={`/drill?${qs}&has=${r.key}&xyz=old`} tone="fc-warn" />
                  <Cell n={r.direct} of={r.total} href={`/drill?${qs}&has=${r.key}&xyz=direct`} />
                  {rows.some((x) => x.unknown > 0) && <Cell n={r.unknown} of={r.total} />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
