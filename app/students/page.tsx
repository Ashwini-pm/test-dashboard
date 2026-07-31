import Link from "next/link";
import { ensureFresh } from "@/lib/db";
import { parseCtx, students, leaks, intentSummary, roundOptions, defaultRound } from "@/lib/v2";
import RoundSelect from "@/components/RoundSelect";
import { csatAttendance, csatCalling } from "@/lib/channels";
import TestAttendanceBlock from "@/components/TestAttendance";
import CallingBlock from "@/components/CallingBlock";

export const dynamic = "force-dynamic";
// cold-start hydrate pulls ~20 tables; the default 10s limit was too tight
export const maxDuration = 60;

const nf = (n: number) => n.toLocaleString("en-IN");
const INTENT_CLS: Record<string, string> = { hot: "i-hot", warm: "i-warm", cooling: "i-cool", cold: "i-cold", converted: "i-conv", closed: "i-closed" };

export default async function Students({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await ensureFresh();
  const ctx = parseCtx(sp.ctx);
  const round = sp.round || defaultRound(ctx);
  const qs = `${ctx === "CSAT" ? "&ctx=CSAT" : ""}${round ? `&round=${round}` : ""}`;
  const filter = sp.filter || null;
  const { rows } = students(ctx, filter, round);
  const L = leaks(ctx, round);
  const I = intentSummary(ctx, round);
  // CSAT-1 test attendance (lead_map.test_given). Deliberately NOT scoped to the
  // round pill: the programme split (from signup_programs, what the student
  // picked) is the breakdown that matters here, and scoping to a signup page as
  // well would give two different splits of the same cohort.
  const attend = ctx === "CSAT" ? csatAttendance() : null;
  // Calling sits under the test-given block, cohort-wide like it.
  const calling = ctx === "CSAT" ? csatCalling() : null;
  const dq = `${ctx === "CSAT" ? "ctx=CSAT&" : ""}round=All`;

  const chips: { key: string | null; label: string; n: number }[] = [
    { key: null, label: "All", n: -1 },
    { key: "hot", label: "Hot", n: I.hot },
    { key: "hot_untouched", label: "Hot + untouched", n: -1 },
    ...L.map((l) => ({ key: l.key, label: l.title, n: l.count })),
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Students</h1>
          <div className="sub">{ctx} · one list, every student, ranked by intent · click a name for the full journey</div>
        </div>
        <div className="spacer" />
        <RoundSelect options={roundOptions(ctx)} current={round} />
        <span className="pill"><span className="dot" /> {nf(rows.length)} students</span>
      </div>

      {attend && <TestAttendanceBlock data={attend} qs={dq} />}
      {calling && <CallingBlock data={calling} qs={dq} />}
      <div className="chips">
        {chips.map((c) => (
          <Link key={c.label} href={`/students?${c.key ? `filter=${c.key}` : ""}${qs}`.replace("?&", "?")}
            className={`chip${(filter ?? null) === c.key ? " on" : ""}`}>
            {c.label}{c.n >= 0 ? <b className="tnum"> {c.n}</b> : null}
          </Link>
        ))}
      </div>
      <div className="card">
        <div className="heat-wrap">
          <table className="heatmap cday v2tab">
            <thead>
              <tr>
                <th>Student</th><th>Phone</th><th>Round</th><th>Stage</th>
                <th className="r">Days in stage</th><th>Intent</th><th className="r">Score</th>
                <th>Last touch</th><th>Counsellor</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((r) => (
                <tr key={r.lead_id}>
                  <td><Link className="cday-link" href={`/leads/${encodeURIComponent(r.lead_id)}`}>{r.name || r.lead_id}</Link></td>
                  <td className="tnum">{r.phone}</td>
                  <td>{r.round}</td>
                  <td>{r.stage}{r.stage_since ? <span className="cap"> · {r.stage_since}</span> : null}</td>
                  <td className="r tnum">{r.days_in_stage ?? "–"}</td>
                  <td><span className={`ibadge ${INTENT_CLS[r.intent]}`}>{r.intent}</span></td>
                  <td className="r tnum">{r.score}</td>
                  <td>{r.last_touch ? `${r.last_touch}${r.last_touch_ch ? ` (${r.last_touch_ch.replace("_call", "")})` : ""}` : "—"}</td>
                  <td>{r.counsellor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 500 ? <div className="cap" style={{ padding: 12 }}>showing first 500 — use a filter chip to narrow</div> : null}
      </div>
    </>
  );
}
