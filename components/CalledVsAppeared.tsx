import Link from "next/link";
import type { CalledAppeared } from "@/lib/channels";

// Called vs appeared, registered students only. The bounding box IS the cohort:
// without it the students who were never called and never appeared vanish from the
// picture, and they are a third of the group.

const nf = (n: number) => n.toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

/**
 * Circle radii come from area (r = sqrt(A/pi)), so Appeared is drawn a sixth the
 * area of Reached rather than the same size. The overlap distance is linear in the
 * shared fraction of the smaller set — exact-area two-circle Venn has no closed
 * form — so the areas are exact and the overlap is indicative. Counts, not
 * percentages, sit in the regions; percentages live in the table.
 */
export default function CalledVsAppeared({ data, qs }: { data: CalledAppeared; qs: string }) {
  const { reached, appeared, both, reachedNoShow, appearedUnreached, neither, total, channels } = data;

  const W = 400, H = 236, PAD = 10;
  const rR = 76;
  const rA = Math.max(14, rR * Math.sqrt(appeared / Math.max(1, reached)));
  const share = appeared > 0 ? both / Math.min(reached, appeared) : 0;
  const gap = rR + rA - share * (rR + rA - Math.abs(rR - rA));
  const cy = H / 2 + 2;
  const cxR = PAD + 34 + rR;
  const cxA = cxR + gap;

  const rows: { key: string; label: string; n: number; tone?: string; drill: string }[] = [
    { key: "both", label: "Connected and gave the test", n: both, tone: "cv-reg", drill: "reach=any&tg=given" },
    { key: "rns", label: "Connected, did not give the test", n: reachedNoShow, tone: "fc-bad", drill: "reach=any&tg=notgiven" },
    { key: "aun", label: "Gave the test, never connected", n: appearedUnreached, drill: "reach=none&tg=given" },
    { key: "none", label: "No call connected, no test", n: neither, tone: "fc-warn", drill: "reach=none&tg=notgiven" },
  ];

  const top = channels[0];
  const bottom = channels[channels.length - 1];
  const aiOnly = channels.find((c) => c.key === "ai");

  return (
    <>
      <h4 className="ta-h">Calling vs test given</h4>

      <div className="ca-wrap">
        <svg className="ca-svg" viewBox={`0 0 ${W} ${H}`} role="img"
             aria-label={`Of ${total} registered students, ${reached} connected on a call and ${appeared} gave the test; ${both} did both, ${neither} did neither`}>
          {/* the box is the whole registered cohort */}
          <rect x={1} y={1} width={W - 2} height={H - 2} rx={10} className="ca-box" />
          <text x={10} y={17} className="ca-boxlab">All {nf(total)} registered</text>

          <circle cx={cxR} cy={cy} r={rR} className="ca-c-reached" />
          <circle cx={cxA} cy={cy} r={rA} className="ca-c-appeared" />

          {/* reached-only */}
          <a href={`/drill?${qs}&reach=any&tg=notgiven`}>
            <text x={cxR - rR * 0.42} y={cy - 2} className="ca-n ca-link">{nf(reachedNoShow)}</text>
          </a>
          <text x={cxR - rR * 0.42} y={cy + 13} className="ca-t">connected,<tspan x={cxR - rR * 0.42} dy="11">no test</tspan></text>

          {/* overlap */}
          <a href={`/drill?${qs}&reach=any&tg=given`}>
            <text x={cxA - rA * 0.15} y={cy + 1} className="ca-n ca-n-sm ca-link">{nf(both)}</text>
          </a>
          <text x={cxA - rA * 0.15} y={cy + 13} className="ca-t">both</text>

          {/* appeared-only: a thin crescent, so label it outside with a leader */}
          <line x1={cxA + rA + 2} y1={cy - rA * 0.55} x2={cxA + rA + 26} y2={cy - rA - 16} className="ca-lead" />
          <a href={`/drill?${qs}&reach=none&tg=given`}>
            <text x={cxA + rA + 28} y={cy - rA - 18} className="ca-n ca-n-sm ca-link">{nf(appearedUnreached)}</text>
          </a>
          <text x={cxA + rA + 28} y={cy - rA - 6} className="ca-t">gave test,<tspan x={cxA + rA + 28} dy="11">never called</tspan></text>

          {/* neither: outside both circles, in the corner of the box */}
          <a href={`/drill?${qs}&reach=none&tg=notgiven`}>
            <text x={W - 12} y={H - 26} className="ca-n ca-n-sm ca-link" textAnchor="end">{nf(neither)}</text>
          </a>
          <text x={W - 12} y={H - 14} className="ca-t" textAnchor="end">no call, no test</text>
        </svg>

        <div className="ca-key">
          <span><i className="ca-sw-reached" />Connected on a call {nf(reached)}</span>
          <span><i className="ca-sw-appeared" />Gave the test {nf(appeared)}</span>
        </div>
      </div>

      <div className="cv-scroll">
        <table className="cv-table ta-table">
          <thead>
            <tr><th>Segment</th><th className="tnum">Students</th><th className="tnum">Share of registered</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td><Link href={`/drill?${qs}&${r.drill}`} className="sb-link">{r.label}</Link></td>
                <td className={`tnum${r.tone ? ` ${r.tone}` : ""}`}>
                  <Link href={`/drill?${qs}&${r.drill}`} className="sb-link">{nf(r.n)}</Link>
                </td>
                <td className="tnum">{pct(r.n, total)}</td>
              </tr>
            ))}
            <tr className="co-strong">
              <td><Link href={`/drill?${qs}&reg=paid`} className="sb-link">All registered</Link></td>
              <td className="tnum"><Link href={`/drill?${qs}&reg=paid`} className="sb-link">{nf(total)}</Link></td>
              <td className="tnum">100%</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h4 className="ta-h">Test given, by who called them</h4>
      <div className="cv-scroll">
        <table className="cv-table ta-table">
          <thead>
            <tr>
              <th>Connected by</th>
              <th className="tnum">Registered</th>
              <th className="tnum">Gave test</th>
              <th className="tnum">Gave test %</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.key}>
                <td><Link href={`/drill?${qs}&reg=paid&ch=${c.key}`} className="sb-link">{c.label}</Link></td>
                <td className="tnum">
                  <Link href={`/drill?${qs}&reg=paid&ch=${c.key}`} className="sb-link">{nf(c.registered)}</Link>
                </td>
                <td className="tnum cv-reg">
                  {c.appeared > 0
                    ? <Link href={`/drill?${qs}&ch=${c.key}&tg=given`} className="sb-link">{nf(c.appeared)}</Link>
                    : nf(c.appeared)}
                </td>
                <td className="tnum ca-pct">{pct(c.appeared, c.registered)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="ta-foot">
        <Link href={`/drill?${qs}&tg=noshow`} className="sb-link">Open the list of registered students who did not give the test</Link>
      </p>
    </>
  );
}
