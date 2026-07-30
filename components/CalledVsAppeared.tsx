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

  const rows: { key: string; label: string; n: number; tone?: string }[] = [
    { key: "both", label: "Reached and appeared", n: both, tone: "cv-reg" },
    { key: "rns", label: "Reached, did not appear", n: reachedNoShow, tone: "fc-bad" },
    { key: "aun", label: "Appeared without being reached", n: appearedUnreached },
    { key: "none", label: "Neither", n: neither, tone: "fc-warn" },
  ];

  const top = channels[0];
  const bottom = channels[channels.length - 1];
  const aiOnly = channels.find((c) => c.key === "ai");

  return (
    <>
      <h4 className="ta-h">Called vs appeared</h4>

      <div className="ca-wrap">
        <svg className="ca-svg" viewBox={`0 0 ${W} ${H}`} role="img"
             aria-label={`Of ${total} registered students, ${reached} were reached by calling and ${appeared} appeared; ${both} both, ${neither} neither`}>
          {/* the box is the whole registered cohort */}
          <rect x={1} y={1} width={W - 2} height={H - 2} rx={10} className="ca-box" />
          <text x={10} y={17} className="ca-boxlab">All {nf(total)} registered</text>

          <circle cx={cxR} cy={cy} r={rR} className="ca-c-reached" />
          <circle cx={cxA} cy={cy} r={rA} className="ca-c-appeared" />

          {/* reached-only */}
          <text x={cxR - rR * 0.42} y={cy - 2} className="ca-n">{nf(reachedNoShow)}</text>
          <text x={cxR - rR * 0.42} y={cy + 13} className="ca-t">reached,<tspan x={cxR - rR * 0.42} dy="11">no show</tspan></text>

          {/* overlap */}
          <text x={cxA - rA * 0.15} y={cy + 1} className="ca-n ca-n-sm">{nf(both)}</text>
          <text x={cxA - rA * 0.15} y={cy + 13} className="ca-t">both</text>

          {/* appeared-only: a thin crescent, so label it outside with a leader */}
          <line x1={cxA + rA + 2} y1={cy - rA * 0.55} x2={cxA + rA + 26} y2={cy - rA - 16} className="ca-lead" />
          <text x={cxA + rA + 28} y={cy - rA - 18} className="ca-n ca-n-sm">{nf(appearedUnreached)}</text>
          <text x={cxA + rA + 28} y={cy - rA - 6} className="ca-t">appeared,<tspan x={cxA + rA + 28} dy="11">never reached</tspan></text>

          {/* neither: outside both circles, in the corner of the box */}
          <text x={W - 12} y={H - 26} className="ca-n ca-n-sm" textAnchor="end">{nf(neither)}</text>
          <text x={W - 12} y={H - 14} className="ca-t" textAnchor="end">neither</text>
        </svg>

        <div className="ca-key">
          <span><i className="ca-sw-reached" />Reached by calling {nf(reached)}</span>
          <span><i className="ca-sw-appeared" />Appeared {nf(appeared)}</span>
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
                <td>{r.label}</td>
                <td className={`tnum${r.tone ? ` ${r.tone}` : ""}`}>{nf(r.n)}</td>
                <td className="tnum">{pct(r.n, total)}</td>
              </tr>
            ))}
            <tr className="co-strong">
              <td>All registered</td>
              <td className="tnum">{nf(total)}</td>
              <td className="tnum">100%</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h4 className="ta-h">Appeared, by which channel reached them</h4>
      <div className="cv-scroll">
        <table className="cv-table ta-table">
          <thead>
            <tr>
              <th>Reached by</th>
              <th className="tnum">Registered</th>
              <th className="tnum">Appeared</th>
              <th className="tnum">Appeared %</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.key}>
                <td>{c.label}</td>
                <td className="tnum">{nf(c.registered)}</td>
                <td className="tnum cv-reg">{nf(c.appeared)}</td>
                <td className="tnum ca-pct">{pct(c.appeared, c.registered)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {top && bottom && top.key !== bottom.key && (
        <div className="ta-gap">
          Calling moves the needle, but only when both channels reach the same student:{" "}
          <b>{pct(top.appeared, top.registered)}</b> of those reached by {top.label.toLowerCase()} appeared,
          against <b>{pct(bottom.appeared, bottom.registered)}</b> of those {bottom.label.toLowerCase()} reached.
          {aiOnly && ` AI alone lands at ${pct(aiOnly.appeared, aiOnly.registered)}, barely above doing nothing.`}
          <br />
          <b>{nf(reachedNoShow)}</b> registered students were reached by calling and still did not sit the test —
          the largest single segment, which says the problem is not reach.
        </div>
      )}

      <p className="ta-foot">
        Registered students only: an unregistered lead was never due to sit the test.
        Both reach signals are cumulative to date rather than &quot;called before the test&quot;, so read this as
        association, not proof that calling caused attendance. The four Venn regions are mutually exclusive and
        add to {nf(total)}; so do the four channel segments. Circle areas are proportional to the set sizes and
        the overlap is indicative.
      </p>
      <p className="ta-foot">
        <Link href={`/drill?${qs}&tg=noshow`} className="sb-link">Open the students who registered and did not appear</Link>
      </p>
    </>
  );
}
