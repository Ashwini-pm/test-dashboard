import Link from "next/link";
import type { ContactFunnel as CF, StageCell } from "@/lib/channels";

// Contact before the test, read across every funnel stage.
//
// Percentages are progressive: each stage against the stage before it, along the
// row. So a row reads left to right as one cohort's journey.
//
// The two channels are separate tables and are never added. The same student is
// dialled by a person and by AI, so a total would count them twice.

const nf = (n: number) => n.toLocaleString("en-IN");

function Cell({ c, qs, first }: { c: StageCell; qs: string; first?: boolean }) {
  const body = (
    <>
      {nf(c.n)}
      {!first && c.pct !== null && <span className="fc-pct"> {c.pct}%</span>}
    </>
  );
  return (
    <td className="tnum">
      {c.n > 0 ? <Link href={`/drill?${qs}&${c.drill}`} className="sb-link">{body}</Link> : <span className="fc-zero">—</span>}
    </td>
  );
}

function Table({ f, qs, labels }: { f: CF; qs: string; labels: string[] }) {
  return (
    <>
      <h4 className="ta-h">{f.label}</h4>
      <span className="cap cf-cap">{f.note}</span>
      <div className="cv-scroll">
        <table className="cv-table cf-table">
          <thead>
            <tr>
              <th />
              {labels.map((l: string) => <th key={l} className="tnum">{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {f.rows.map((r) => (
              <tr key={r.key} className={r.key === "total" ? "co-strong" : undefined}>
                <td className={r.indent ? "cb-inner" : r.strong ? "cf-strong" : undefined}>{r.label}</td>
                {r.cells.map((c, i) => <Cell key={i} c={c} qs={qs} first={i === 0} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function ContactFunnel({
  funnels, qs, labels, title, cut, humanConnExact,
}: {
  funnels: CF[]; qs: string; labels: string[]; title: string; cut: string; humanConnExact: boolean;
}) {
  return (
    <section className="grid mb">
      <div className="card">
        <header>
          <h3>Reached before the test · by stage</h3>
          <span className="cap">{title}</span>
        </header>

        {funnels.map((f) => <Table key={f.key} f={f} qs={qs} labels={labels} />)}

        <p className="ta-foot">
          Percentages are of the stage to the left, so each row reads as one cohort&apos;s journey.
          Connected and Not connected add back to Touched. The two channels are never added: the same
          student is dialled by a person and by AI.
          {" "}<b>Offer letter and seat booked count only leads with a panelist response.</b> A CRM
          outcome on a lead that never went through counselling is a lead-level result, not
          something the counselling funnel earned. Contact after the test day is excluded here, since it cannot explain
          whether someone sat the test. Every number opens the lead list.
          {!humanConnExact && (
            <>
              {" "}<b>One caveat on human Connected in this round:</b> the CRM feed carries no
              first-connected timestamp here, so Connected reads &quot;dialled before the test and
              connected at some point&quot; rather than &quot;connected before the test&quot;. It stays a
              subset of Touched, so the table still adds up, but it can credit a call that landed
              after the test. Adding a first-connected column to the CRM query makes it exact, as it
              already is for AI, which keeps per-call timestamps.
            </>
          )}
        </p>
      </div>
    </section>
  );
}
