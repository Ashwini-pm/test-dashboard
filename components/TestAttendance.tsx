import Link from "next/link";
import type { Attendance, AttendRow } from "@/lib/channels";
import CalledVsAppeared from "./CalledVsAppeared";

// CSAT-1 test given. Always a share of REGISTERED students, never of leads: a lead
// who never registered was never due to give the test. "Not known yet" stays its own column
// and is never folded into "did not give test" — one means they skipped it, the
// other means the sheet has no status for them.

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
  const leadHref = r.prog
    ? `/drill?${qs}&sprog=${encodeURIComponent(r.prog)}`
    : r.tag
      ? `/drill?${qs}&tag=${encodeURIComponent(r.tag)}`
      : `/drill?${qs}`;
  return (
    <tr className={strong ? "co-strong" : undefined}>
      <td>{r.label}</td>
      {showLeads && (
        <td className="tnum">
          {(r.leads ?? 0) > 0
            ? <Link href={leadHref} className="sb-link">{nf(r.leads ?? 0)}</Link>
            : nf(r.leads ?? 0)}
        </td>
      )}
      <td className="tnum">
        {r.registered > 0
          ? <Link href={`/drill?${qs}&reg=paid${own}`} className="sb-link">{nf(r.registered)}</Link>
          : nf(r.registered)}
      </td>
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
        <th className="tnum">Gave test</th>
        <th className="tnum">Gave test %</th>
        <th className="tnum">Did not give test</th>
        <th className="tnum">Not known yet</th>
      </tr>
    </thead>
  );
}

export default function TestAttendanceBlock({ data, qs }: { data: Attendance; qs: string }) {
  const { all, byProgramme, bySource, byUtm, minUtmReg, derivedSource, calling, lastSync } = data;
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
          <h3>Test given · CSAT-1</h3>
          <span className="cap">
            all CSAT-1 · out of registered students, not all leads{stamp ? ` · as of last sync, ${stamp}` : ""}
          </span>
        </header>

        <div className="ta-tiles">
          <div className="ta-tile">
            <div className="ta-n tnum">{nf(all.given)}</div>
            <div className="ta-l">Gave the test <span className="ta-dim">{pct(all.given, all.registered)} of {nf(all.registered)} registered</span></div>
          </div>
          <div className="ta-tile ta-bad">
            <div className="ta-n tnum">
              <Link href={`/drill?${qs}&tg=noshow`} className="sb-link">{nf(all.noShow)}</Link>
            </div>
            <div className="ta-l">Registered but did not give the test <span className="ta-dim">{pct(all.noShow, all.registered)} of registered</span></div>
          </div>
          <div className="ta-tile">
            <div className="ta-n tnum">{nf(all.noStatus)}</div>
            <div className="ta-l">Not known yet <span className="ta-dim">no status on the sheet, so we cannot say</span></div>
          </div>
        </div>

        <h4 className="ta-h">By programme</h4>
        <div className="cv-scroll">
          <table className="cv-table ta-table">
            <Head first="Programme" showLeads />
            <tbody>
              {byProgramme.map((p) => <Row key={p.key} r={p} qs={qs} showLeads />)}
              <Row r={all} qs={qs} strong showLeads />
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
              <b>The same student can be counted twice here, so this table will not add up to {nf(all.registered)}.</b>{" "}
              Compare sources on Gave test %, not on the count: Influencers tops any count because it is
              {" "}{pct(bySource[0]?.registered ?? 0, all.registered)} of the volume. A dash means that source
              brought leads but no registrations, so there was never a test to give.
              {derivedSource > 0 && (
                <>
                  {" "}For <b>{nf(derivedSource)}</b> leads the signup form captured no source at all, so it was
                  taken from the CRM&apos;s own category, or from the utm_source on their raw signup row. What is
                  left under <b>No source captured</b> has no source anywhere.
                </>
              )}
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
              Sorted by Gave test %, not by volume, because the two disagree. Names with fewer than{" "}
              {minUtmReg} registrations are left out, or a name with 2 registrations and 1 test given would sit
              on top at 50%. Values like &quot;(not set)&quot; and &quot;none&quot; are not campaign names, so they
              are left out. <b>A student can be counted under two names here as well.</b>
            </p>
          </>
        )}

        {calling && <CalledVsAppeared data={calling} qs={qs} />}

        {best && worst && best.key !== worst.key && (
          <div className="ta-gap">
            <b>{best.label}</b> students give the test at {pct(best.given, best.registered)} against{" "}
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
              {pct(biggest.given, biggest.registered)} of them gave the test. <b>{rival.label}</b> brought{" "}
              {nf(rival.registered)} and {pct(rival.given, rival.registered)} gave it — the same effort,{" "}
              {ratio >= 2 ? `more than ${Math.floor(ratio)} times` : "well over"} the yield.
              {zero.length > 0 && (
                <> {zero.map((z) => `${z.label} brought ${nf(z.registered)} registrations and not one gave the test`).join("; ")}.</>
              )}
            </div>
          );
        })()}
      </div>
    </section>
  );
}
