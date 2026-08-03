import Link from "next/link";
import type { FunnelCallRow } from "@/lib/v2";

// Calling coverage per funnel stage, as a table. Every cell drills to the
// matching student list. "Coverage, not conversion": calling targets students who
// have not converted, so never read these columns as a conversion rate.
const nf = (n: number) => n.toLocaleString("en-IN");
const pc = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function Cell({ n, of, href, tone }: { n: number; of?: number; href?: string; tone?: string }) {
  if (!n) return <td className="tnum fc-zero">—</td>;
  const body = (
    <>
      {nf(n)}
      {of !== undefined && <span className="fc-pct"> {pc(n, of)}</span>}
    </>
  );
  return (
    <td className={`tnum ${tone ?? ""}`}>
      {href ? <Link href={href} className="sb-link">{body}</Link> : body}
    </td>
  );
}

export default function FunnelCallTable({
  rows, qs, emptyNote,
}: { rows: FunnelCallRow[]; qs: string; emptyNote?: string }) {
  if (!rows.length) return <p className="sb-empty">{emptyNote ?? "No data for this round yet."}</p>;
  const url = (base: string | undefined, extra?: string) =>
    base ? `/drill?${qs}&${base}${extra ? `&${extra}` : ""}` : undefined;

  return (
    <div className="cv-scroll">
      <table className="cv-table fc-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th className="tnum">Students</th>
            <th className="tnum">Touched</th>
            <th className="tnum">Connected</th>
            <th className="tnum">Not connected</th>
            <th className="tnum">Not touched</th>
            <th className="tnum">No calling data</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <Cell n={r.total} href={url(r.drill)} />
              <Cell n={r.called} of={r.total} href={url(r.drill, "act=called")} />
              <Cell n={r.picked} of={r.called} href={url(r.drill, "conn=1")} tone="cv-reg" />
              <Cell n={r.notPicked} of={r.called} href={url(r.drill, "act=noconn")} tone="fc-warn" />
              {/* "Not touched" is a real zero; "no calling data" is unknown. The old
                  act=never filter merges them, so these use the hc= filters that do not. */}
              <Cell n={r.notCalled} of={r.total} href={url(r.drill, "hc=never")} tone="fc-bad" />
              <Cell n={r.noData} of={r.total} href={url(r.drill, "hc=nodata")} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
