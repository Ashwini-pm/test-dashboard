import Link from "next/link";
import type { Attendance, AttendRow } from "@/lib/channels";

// CSAT-1 test attendance. Appeared is always a share of REGISTRATIONS, never of
// leads: an unregistered lead was never due to sit the test. "No status yet" is
// kept as its own column and never folded into "did not appear" — one is a
// no-show, the other is missing information.

const nf = (n: number) => n.toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

// "2026-07-30 06:36:29+00" -> "30 Jul, 12:06 IST"
function istStamp(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 5.5 * 3600 * 1000);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} IST`;
}

function Row({ r, qs, strong }: { r: AttendRow; qs: string; strong?: boolean }) {
  // programme rows carry their own signup_programs filter, so the list that opens
  // is that programme's students, not the whole cohort's
  const sp = r.prog ? `&sprog=${encodeURIComponent(r.prog)}` : "";
  const link = (n: number, tg: string, cls?: string) => (
    <td className={`tnum${cls ? ` ${cls}` : ""}`}>
      {n > 0 ? <Link href={`/drill?${qs}&tg=${tg}${sp}`} className="sb-link">{nf(n)}</Link> : nf(n)}
    </td>
  );
  return (
    <tr className={strong ? "co-strong" : undefined}>
      <td>{r.label}</td>
      <td className="tnum">{nf(r.registered)}</td>
      {link(r.given, "given", "cv-reg")}
      <td className="tnum">{pct(r.given, r.registered)}</td>
      {link(r.noShow, "noshow", "fc-bad")}
      {link(r.noStatus, "nostatus")}
    </tr>
  );
}

export default function TestAttendanceBlock({ data, qs }: { data: Attendance; qs: string }) {
  const { all, byProgramme, lastSync } = data;
  const stamp = istStamp(lastSync);
  // The programme gap is the story, so surface the best and worst rather than
  // leaving the reader to scan for them.
  const ranked = byProgramme.filter((p) => p.registered >= 10).sort((a, b) => b.given / b.registered - a.given / a.registered);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  return (
    <section className="grid mb">
      <div className="card">
        <header>
          <h3>Test attendance · CSAT-1</h3>
          <span className="cap">
            all CSAT-1 · share of registrations, not of leads{stamp ? ` · as of last sync, ${stamp}` : ""}
          </span>
        </header>

        <div className="ta-tiles">
          <div className="ta-tile">
            <div className="ta-n tnum">{nf(all.given)}</div>
            <div className="ta-l">Appeared <span className="ta-dim">{pct(all.given, all.registered)} of {nf(all.registered)} registered</span></div>
          </div>
          <div className="ta-tile ta-bad">
            <div className="ta-n tnum">
              <Link href={`/drill?${qs}&tg=noshow`} className="sb-link">{nf(all.noShow)}</Link>
            </div>
            <div className="ta-l">Registered, did not appear <span className="ta-dim">{pct(all.noShow, all.registered)} of registrations</span></div>
          </div>
          <div className="ta-tile">
            <div className="ta-n tnum">{nf(all.noStatus)}</div>
            <div className="ta-l">No status yet <span className="ta-dim">not a no-show, just unknown</span></div>
          </div>
        </div>

        <div className="cv-scroll">
          <table className="cv-table ta-table">
            <thead>
              <tr>
                <th>Programme</th>
                <th className="tnum">Registered</th>
                <th className="tnum">Appeared</th>
                <th className="tnum">Appeared %</th>
                <th className="tnum">Did not appear</th>
                <th className="tnum">No status yet</th>
              </tr>
            </thead>
            <tbody>
              {byProgramme.map((p) => <Row key={p.key} r={p} qs={qs} />)}
              <Row r={all} qs={qs} strong />
            </tbody>
          </table>
        </div>

        {best && worst && best.key !== worst.key && (
          <div className="ta-gap">
            <b>{best.label}</b> students turn up at {pct(best.given, best.registered)} against{" "}
            <b>{worst.label}</b> at {pct(worst.given, worst.registered)}
            {" "}— that gap matters more than the overall {pct(all.given, all.registered)}.
          </div>
        )}
      </div>
    </section>
  );
}
