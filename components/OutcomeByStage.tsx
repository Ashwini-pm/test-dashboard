import Link from "next/link";
import type { OutcomeStageRow } from "@/lib/v2";

// Offers and seats at every funnel stage.
//
// Rows are nested cohorts, not a flow: each is "students who reached this stage
// and already hold an offer letter". So the numbers do not fall monotonically and
// are not drop-off. Percentages are of that row's own students, which is the
// comparison that matters — 1% of leads hold an offer against 38% of counselled.
//
// Seats are always a subset of offers (every seat has an offer letter), so
// "Offer open" = OL - SB is exact rather than a residual.

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

export default function OutcomeByStage({ rows, qs }: { rows: OutcomeStageRow[]; qs: string }) {
  if (!rows.length) return null;
  return (
    <section className="grid mb">
      <div className="card">
        <header>
          <h3>Offers and seats by stage</h3>
          <span className="cap">how many at each stage already hold an offer, and how many booked</span>
        </header>

        <div className="cv-scroll">
          <table className="cv-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="tnum">Students</th>
                <th className="tnum">Offer letter</th>
                <th className="tnum">Seat booked</th>
                <th className="tnum">Offer open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="tnum">
                    <Link href={`/drill?${qs}&${r.drill}`} className="sb-link">{nf(r.students)}</Link>
                  </td>
                  <Cell n={r.ol} of={r.students} href={`/drill?${qs}&${r.drill}&has=ol`} />
                  <Cell n={r.sb} of={r.students} href={`/drill?${qs}&${r.drill}&has=sb`} tone="cv-reg" />
                  <Cell n={r.open} of={r.students} href={`/drill?${qs}&${r.drill}&has=olopen`} tone="fc-warn" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
