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
    { key: "both", label: "Connected and gave the test", n: both, tone: "cv-reg" },
    { key: "rns", label: "Connected, did not give the test", n: reachedNoShow, tone: "fc-bad" },
    { key: "aun", label: "Gave the test, never connected", n: appearedUnreached },
    { key: "none", label: "No call connected, no test", n: neither, tone: "fc-warn" },
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
          <text x={cxR - rR * 0.42} y={cy - 2} className="ca-n">{nf(reachedNoShow)}</text>
          <text x={cxR - rR * 0.42} y={cy + 13} className="ca-t">connected,<tspan x={cxR - rR * 0.42} dy="11">no test</tspan></text>

          {/* overlap */}
          <text x={cxA - rA * 0.15} y={cy + 1} className="ca-n ca-n-sm">{nf(both)}</text>
          <text x={cxA - rA * 0.15} y={cy + 13} className="ca-t">both</text>

          {/* appeared-only: a thin crescent, so label it outside with a leader */}
          <line x1={cxA + rA + 2} y1={cy - rA * 0.55} x2={cxA + rA + 26} y2={cy - rA - 16} className="ca-lead" />
          <text x={cxA + rA + 28} y={cy - rA - 18} className="ca-n ca-n-sm">{nf(appearedUnreached)}</text>
          <text x={cxA + rA + 28} y={cy - rA - 6} className="ca-t">gave test,<tspan x={cxA + rA + 28} dy="11">never called</tspan></text>

          {/* neither: outside both circles, in the corner of the box */}
          <text x={W - 12} y={H - 26} className="ca-n ca-n-sm" textAnchor="end">{nf(neither)}</text>
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
          Calling works, but only when both AI and a person get through to the same student:{" "}
          <b>{pct(top.appeared, top.registered)}</b> of the students {top.label.toLowerCase()} connected with gave the test,
          against <b>{pct(bottom.appeared, bottom.registered)}</b> of the ones nobody got through to.
          {aiOnly && ` AI on its own gets ${pct(aiOnly.appeared, aiOnly.registered)}, barely better than no call at all.`}
          <br />
          <b>{nf(reachedNoShow)}</b> students registered, we got through to them on a call, and they still did not give
          the test — the biggest group of the four. So the problem is not that we cannot reach them.
        </div>
      )}

      <p className="ta-foot">
        Registered students only, since nobody else was due to give the test. Calls counted here are every call to date,
        not only calls made before the test day, so this shows what goes together, not what caused what. The four
        groups do not overlap and add up to {nf(total)}, and so do the four rows below. Circle sizes follow the
        numbers; the overlap is indicative.
      </p>
      <p className="ta-foot">
        <Link href={`/drill?${qs}&tg=noshow`} className="sb-link">Open the list of registered students who did not give the test</Link>
      </p>
    </>
  );
}
