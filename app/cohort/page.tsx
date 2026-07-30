import { ensureFresh } from "@/lib/db";
import {
  COHORTS, cohortForRound, cohortReady, overview, callingSplit, bySource,
  byProgram, registrationsByDay, byCounsellor, lastRefreshed,
} from "@/lib/cohort";
import { parseCtx, roundOptions, defaultRound } from "@/lib/v2";
import RoundSelect from "@/components/RoundSelect";

export const dynamic = "force-dynamic";
// cold-start hydrate pulls ~20 tables; the default 10s limit was too tight
export const maxDuration = 60;

const nf = (n: number) => n.toLocaleString("en-IN");
const pc = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

export default async function Cohort({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await ensureFresh();
  const ctx = parseCtx(sp.ctx);
  const round = sp.round || defaultRound(ctx);
  const sel = cohortForRound(ctx, round);
  const key = sel?.key ?? null;
  const meta = key ? COHORTS[key] : null;
  const ready = key ? cohortReady(key) : false;
  const w = sel?.where ?? "";

  const ov = key && ready ? overview(key, w) : null;
  const calls = key && ready ? callingSplit(key, w) : [];
  const srcCampaign = key && ready ? bySource(key, "campaign_source", w) : [];
  const srcCrm = key && ready ? bySource(key, "crm_source_category", w) : [];
  const progs = key && ready && !w ? byProgram(key) : [];
  const regDays = key && ready ? registrationsByDay(key) : [];
  const couns = key && ready ? byCounsellor(key) : [];
  const refreshed = key && ready ? lastRefreshed(key) : null;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{round} · Cohort</h1>
          <div className="sub">
            {meta
              ? `${meta.window} · ${meta.closed ? "intake closed, numbers frozen" : "live"} · refresh ${meta.refresh}${sel?.scope ? ` · ${sel.scope}` : ""}`
              : "no lead map for this round"}
          </div>
        </div>
        <div className="spacer" />
        <RoundSelect options={roundOptions(ctx)} current={round} />
      </div>

      {!meta ? (
        <section className="grid mb"><div className="card">
          <p className="sb-empty">
            <b>No cohort map for {round}.</b> Cohort analysis needs a prepared lead map, which exists for
            NSAT-4, NSAT-5 and CSAT-1. Pick one of those in the round selector above.
          </p>
        </div></section>
      ) : !ready || !ov ? (
        <section className="grid mb"><div className="card">
          <p className="sb-empty">Lead map for {meta.label} not loaded yet. Hit Sync now.</p>
        </div></section>
      ) : (
        <>
          {/* Two arms, stated as two numbers that add to the total */}
          <section className="grid mb">
            <div className="card">
              <header>
                <h3>Universe</h3>
                <span className="cap">every row keyed on the CRM lead id</span>
              </header>
              <div className="co-arms">
                <div className="co-arm">
                  <div className="co-n tnum">{nf(ov.signup)}</div>
                  <div className="co-l">Signup leads</div>
                  <div className="co-d">filled the {meta.label} form</div>
                </div>
                <div className="co-plus">+</div>
                <div className="co-arm">
                  <div className="co-n tnum">{nf(ov.attributed)}</div>
                  <div className="co-l">Attributed leads</div>
                  <div className="co-d">never filled it · in CRM in-window, right program, owned source</div>
                </div>
                <div className="co-plus">=</div>
                <div className="co-arm co-total">
                  <div className="co-n tnum">{nf(ov.total)}</div>
                  <div className="co-l">Total leads</div>
                  <div className="co-d">{meta.closed ? "frozen at cutoff" : "still growing"}</div>
                </div>
              </div>
            </div>
          </section>

          {/* Headline tiles */}
          <section className="grid stage-kpis">
            {[
              ["Registrations", ov.registrations, `${pc(ov.registrations, ov.total)} of leads · paid the fee`],
              ["Signed up, unpaid", ov.pending, "filled the form, no payment"],
              ["Offer letters", ov.offerLetters, "under-reported, see note"],
              ["Seats booked", ov.seats, "under-reported, see note"],
            ].map(([l, v, d]) => (
              <div key={String(l)} className="skpi band-none">
                <div className="skpi-top"><span className="skpi-label">{String(l)}</span></div>
                <div className="skpi-val tnum">{nf(Number(v))}</div>
                <div className="co-d">{String(d)}</div>
              </div>
            ))}
          </section>

          {/* The calling view: three mutually exclusive segments */}
          <section className="grid mb">
            <div className="card">
              <header>
                <h3>Calling coverage</h3>
                <span className="cap">not registered + registered add back to all leads</span>
              </header>
              <div className="cv-scroll">
                <table className="cv-table">
                  <thead>
                    <tr>
                      <th>Segment</th>
                      <th className="tnum">Leads</th>
                      <th className="tnum">Called</th>
                      <th className="tnum">Connected</th>
                      <th className="tnum">Not called</th>
                      <th className="tnum">No call data</th>
                      <th className="tnum">Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((r) => (
                      <tr key={r.key} className={r.key === "all" ? "co-strong" : undefined}>
                        <td>{r.label}</td>
                        <td className="tnum">{nf(r.leads)}</td>
                        <td className="tnum">{nf(r.called)}<span className="fc-pct"> {pc(r.called, r.leads)}</span></td>
                        <td className="tnum cv-reg">{nf(r.connected)}<span className="fc-pct"> {pc(r.connected, r.called)}</span></td>
                        <td className="tnum fc-bad">{nf(r.notCalled)}</td>
                        <td className="tnum fc-warn">{nf(r.noData)}</td>
                        <td className="tnum">{nf(r.attempts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* CSAT-1 program split */}
          {progs.length > 0 && (
            <section className="grid mb">
              <div className="card">
                <header><h3>By program</h3><span className="cap">from the signup form</span></header>
                <div className="cv-scroll">
                  <table className="cv-table">
                    <thead>
                      <tr>
                        <th>Program</th><th className="tnum">Leads</th><th className="tnum">Signup</th>
                        <th className="tnum">Attributed</th><th className="tnum">Registrations</th>
                        <th className="tnum">Called</th><th className="tnum">Connected</th><th className="tnum">No call data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {progs.map((p) => (
                        <tr key={p.program}>
                          <td>{p.program}</td>
                          <td className="tnum">{nf(p.leads)}</td>
                          <td className="tnum">{nf(p.signup)}</td>
                          <td className="tnum">{nf(p.attributed)}</td>
                          <td className="tnum cv-reg">{nf(p.registrations)}<span className="fc-pct"> {pc(p.registrations, p.leads)}</span></td>
                          <td className="tnum">{nf(p.called)}</td>
                          <td className="tnum">{nf(p.connected)}</td>
                          <td className="tnum fc-warn">{nf(p.noData)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {/* Sources */}
          <section className="grid mb two-col">
            {[
              ["Signup source", srcCampaign, "campaign_source from the form, case-folded"],
              ["CRM source category", srcCrm, "the CRM's own bucket"],
            ].map(([title, list, capn]) => (
              <div className="card" key={String(title)}>
                <header><h3>{String(title)}</h3><span className="cap">{String(capn)}</span></header>
                <div className="cv-scroll">
                  <table className="cv-table">
                    <thead>
                      <tr>
                        <th>Source</th><th className="tnum">Leads</th><th className="tnum">Reg.</th>
                        <th className="tnum">Called</th><th className="tnum">Conn.</th><th className="tnum">Attr.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(list as ReturnType<typeof bySource>).map((r) => (
                        <tr key={r.src}>
                          <td>{r.src}</td>
                          <td className="tnum">{nf(r.leads)}</td>
                          <td className="tnum cv-reg">{nf(r.registrations)}<span className="fc-pct"> {pc(r.registrations, r.leads)}</span></td>
                          <td className="tnum">{nf(r.called)}</td>
                          <td className="tnum">{nf(r.connected)}</td>
                          <td className="tnum fc-warn">{nf(r.attributed)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>

          {/* Registrations over time (paid_at) */}
          {regDays.length > 0 && (
            <section className="grid mb">
              <div className="card">
                <header><h3>Registrations over time</h3><span className="cap">by payment time (paid_at), not signup</span></header>
                <div className="co-days">
                  {(() => {
                    const max = Math.max(...regDays.map((d) => d.n), 1);
                    return regDays.map((d) => (
                      <div key={d.day} className="co-day">
                        <div className="co-bar-wrap"><div className="co-bar" style={{ height: `${(d.n / max) * 100}%` }} /></div>
                        <div className="co-day-n tnum">{nf(d.n)}</div>
                        <div className="co-day-l">{d.day.slice(8)}/{d.day.slice(5, 7)}</div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </section>
          )}

          {/* Counsellor coverage */}
          {couns.length > 0 && (
            <section className="grid mb">
              <div className="card">
                <header><h3>Counsellor coverage</h3><span className="cap">top {couns.length} by leads assigned</span></header>
                <div className="cv-scroll">
                  <table className="cv-table">
                    <thead>
                      <tr><th>Counsellor</th><th className="tnum">Leads</th><th className="tnum">Called</th>
                        <th className="tnum">Connected</th><th className="tnum">Registrations</th></tr>
                    </thead>
                    <tbody>
                      {couns.map((c) => (
                        <tr key={c.name}>
                          <td>{c.name}</td>
                          <td className="tnum">{nf(c.leads)}</td>
                          <td className="tnum">{nf(c.called)}<span className="fc-pct"> {pc(c.called, c.leads)}</span></td>
                          <td className="tnum">{nf(c.connected)}</td>
                          <td className="tnum cv-reg">{nf(c.registrations)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

        </>
      )}
    </>
  );
}
