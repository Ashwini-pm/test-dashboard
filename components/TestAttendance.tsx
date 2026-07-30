import Link from "next/link";
import type { Attendance, AttendRow } from "@/lib/channels";
import CalledVsAppeared from "./CalledVsAppeared";

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

function Row({ r, qs, strong, showLeads }: { r: AttendRow; qs: string; strong?: boolean; showLeads?: boolean }) {
  // Each row carries its own filter so the list that opens is that row's students:
  // programme rows use signup_programs, source/UTM rows use the comma-split tag.
  const own = r.prog
    ? `&sprog=${encodeURIComponent(r.prog)}`
    : r.tag
      ? `&tag=${encodeURIComponent(r.tag)}`
      : "";
  const link = (n: number, tg: string, cls?: string) => (
    <td className={`tnum${cls ? ` ${cls}` : ""}`}>
      {n > 0 ? <Link href={`/drill?${qs}&tg=${tg}${own}`} className="sb-link">{nf(n)}</Link> : nf(n)}
    </td>
  );
  // no registrations means a test status was never possible — a dash, not 0%
  const noReg = r.registered === 0;
  return (
    <tr className={strong ? "co-strong" : undefined}>
      <td>{r.label}</td>
      {showLeads && <td className="tnum">{nf(r.leads ?? 0)}</td>}
      <td className="tnum">{nf(r.registered)}</td>
      {noReg ? <td className="tnum fc-zero">–</td> : link(r.given, "given", "cv-reg")}
      <td className="tnum">{noReg ? "–" : pct(r.given, r.registered)}</td>
      {noReg ? <td className="tnum fc-zero">–</td> : link(r.noShow, "noshow", "fc-bad")}
      {noReg ? <td className="tnum fc-zero">–</td> : link(r.noStatus, "nostatus")}
    </tr>
  );
}

function Head({ first, showLeads }: { first: string; showLeads?: boolean }) {
  return (
    <thead>
      <tr>
        <th>{first}</th>
        {showLeads && <th className="tnum">Leads</th>}
        <th className="tnum">Registered</th>
        <th className="tnum">Appeared</th>
        <th className="tnum">Appeared %</th>
        <th className="tnum">Did not appear</th>
        <th className="tnum">No status yet</th>
      </tr>
    </thead>
  );
}

export default function TestAttendanceBlock({ data, qs }: { data: Attendance; qs: string }) {
  const { all, byProgramme, bySource, byUtm, minUtmReg, calling, lastSync } = data;
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

        <h4 className="ta-h">By programme</h4>
        <div className="cv-scroll">
          <table className="cv-table ta-table">
            <Head first="Programme" />
            <tbody>
              {byProgramme.map((p) => <Row key={p.key} r={p} qs={qs} />)}
              <Row r={all} qs={qs} strong />
            </tbody>
          </table>
        </div>

        {/* Which source brought students who actually sat the test. */}
        {bySource.length > 0 && (
          <>
            <h4 className="ta-h">By source</h4>
            <div className="cv-scroll">
              <table className="cv-table ta-table">
                <Head first="Source" showLeads />
                <tbody>
                  {bySource.map((r) => <Row key={r.key} r={r} qs={qs} showLeads />)}
                </tbody>
              </table>
            </div>
            <p className="ta-foot">
              A lead can arrive through more than one route, and those cells hold several
              comma-separated values, so every source on the row is credited.{" "}
              <b>This table double counts on purpose and does not add up to {nf(all.registered)} registrations.</b>{" "}
              Compare sources on Appeared %, not on Appeared: Influencers tops any raw count because it is
              {" "}{pct(bySource[0]?.registered ?? 0, all.registered)} of the volume. A dash means the source
              produced leads but no registrations, so a test status was never possible.
            </p>
          </>
        )}

        {/* Which influencer actually worked. */}
        {byUtm.length > 0 && (
          <>
            <h4 className="ta-h">By UTM name</h4>
            <div className="cv-scroll">
              <table className="cv-table ta-table">
                <Head first="UTM name" />
                <tbody>
                  {byUtm.map((r) => <Row key={r.key} r={r} qs={qs} />)}
                </tbody>
              </table>
            </div>
            <p className="ta-foot">
              Sorted by Appeared %, not by volume, because the two disagree. Names with fewer than{" "}
              {minUtmReg} registrations are left out, or a name with 2 registrations and 1 appearance
              would lead on 50%. Placeholder values like &quot;(not set)&quot; and &quot;none&quot; are not
              campaign names and are excluded. <b>Multi-value cells are split, so this table double counts too.</b>
            </p>
          </>
        )}

        {calling && <CalledVsAppeared data={calling} qs={qs} />}

        {best && worst && best.key !== worst.key && (
          <div className="ta-gap">
            <b>{best.label}</b> students turn up at {pct(best.given, best.registered)} against{" "}
            <b>{worst.label}</b> at {pct(worst.given, worst.registered)}
            {" "}— that gap matters more than the overall {pct(all.given, all.registered)}.
          </div>
        )}

        {/* Volume and quality pull in opposite directions; a table sorted by
            registrations hides that entirely. */}
        {(() => {
          if (byUtm.length < 2) return null;
          const byVol = [...byUtm].sort((a, b) => b.registered - a.registered);
          const biggest = byVol[0];
          const rival = byVol.find((r) => r.key !== biggest.key && r.given / r.registered > biggest.given / biggest.registered * 1.5);
          const zero = byUtm.filter((r) => r.given === 0);
          if (!rival) return null;
          const ratio = (rival.given / rival.registered) / (biggest.given / biggest.registered);
          return (
            <div className="ta-gap">
              <b>{biggest.label}</b> brought the most registrations of anyone, {nf(biggest.registered)}, and only{" "}
              {pct(biggest.given, biggest.registered)} of them sat the test. <b>{rival.label}</b> brought{" "}
              {nf(rival.registered)} and {pct(rival.given, rival.registered)} sat it — the same effort,{" "}
              {ratio >= 2 ? `more than ${Math.floor(ratio)} times` : "well over"} the yield.
              {zero.length > 0 && (
                <> {zero.map((z) => `${z.label} brought ${nf(z.registered)} registrations and not one appeared`).join("; ")}.</>
              )}
            </div>
          );
        })()}
      </div>
    </section>
  );
}
