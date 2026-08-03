import Link from "next/link";
import type { ContactFunnel as CF, StageCell } from "@/lib/channels";
import { CONTACT_STAGE_LABELS } from "@/lib/channels";

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

function Table({ f, qs }: { f: CF; qs: string }) {
  return (
    <>
      <h4 className="ta-h">{f.label}</h4>
      <span className="cap cf-cap">{f.note}</span>
      <div className="cv-scroll">
        <table className="cv-table cf-table">
          <thead>
            <tr>
              <th />
              {CONTACT_STAGE_LABELS.map((l) => <th key={l} className="tnum">{l}</th>)}
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

export default function ContactFunnel({ funnels, qs }: { funnels: CF[]; qs: string }) {
  return (
    <section className="grid mb">
      <div className="card">
        <header>
          <h3>Reached before the test · by stage</h3>
          <span className="cap">calls up to and including 30 Jul, the test day</span>
        </header>

        {funnels.map((f) => <Table key={f.key} f={f} qs={qs} />)}

        <p className="ta-foot">
          Percentages are of the stage to the left, so each row reads as one cohort&apos;s journey.
          Connected and Not connected add back to Touched. The two channels are never added: the same
          student is dialled by a person and by AI.
          {" "}<b>Offer letter and seat booked count only leads with a panelist response.</b> A CRM
          outcome on a lead that never went through CSAT counselling is a lead-level result, not a
          CSAT funnel result. Contact after the test day is excluded here, since it cannot explain
          whether someone sat the test. Every number opens the lead list.
        </p>
      </div>
    </section>
  );
}
