import type { FunnelSeg, ActivityDay } from "@/lib/cohort";

// LEADS, never calls. Nobody asks how many dials were made, they ask how many
// people we reached — so no call-attempt counts appear here.
// The four buckets are mutually exclusive and add back to the lead count.
const nf = (n: number) => n.toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function Bar({ segs, total }: { segs: { n: number; cls: string; title: string }[]; total: number }) {
  return (
    <div className="kf-bar">
      {segs.filter((s) => s.n > 0).map((s, i) => (
        <div key={i} className={`kf-seg ${s.cls}`} style={{ flexGrow: s.n }} title={`${s.title}: ${nf(s.n)} (${pct(s.n, total)})`} />
      ))}
    </div>
  );
}

export function CallingFunnelBlock({
  segs, leads, registrations, byProgram, days, label,
}: {
  segs: FunnelSeg[];
  leads: number;
  registrations: number;
  byProgram?: (FunnelSeg & { program: string })[];
  days?: ActivityDay[];
  label: string;
}) {
  const all = segs.find((s) => s.key === "all");
  if (!all) return null;

  return (
    <>
      {/* Headline: leads and registrations */}
      <section className="grid mb">
        <div className="card">
          <header>
            <h3>Calling funnel · {label}</h3>
            <span className="cap">every figure counts leads, never call attempts</span>
          </header>

          <div className="kf-top">
            <div className="kf-fig">
              <div className="kf-n tnum">{nf(leads)}</div>
              <div className="kf-l">Leads</div>
            </div>
            <div className="kf-fig">
              <div className="kf-n tnum">{nf(registrations)}</div>
              <div className="kf-l">Registrations <span className="kf-dim">{pct(registrations, leads)} of leads</span></div>
            </div>
          </div>

          {/* the funnel itself */}
          <div className="kf-steps">
            <div className="kf-step">
              <div className="kf-sl">Called</div>
              <div className="kf-sv tnum">{nf(all.called)}</div>
              <div className="kf-sp">{pct(all.called, all.leads)} of leads</div>
            </div>
            <div className="kf-arrow">→</div>
            <div className="kf-step">
              <div className="kf-sl">Touched</div>
              <div className="kf-sv tnum cv-reg">{nf(all.touched)}</div>
              <div className="kf-sp">{pct(all.touched, all.called)} of called</div>
            </div>
            <div className="kf-arrow">·</div>
            <div className="kf-step">
              <div className="kf-sl">Not called</div>
              <div className="kf-sv tnum fc-bad">{nf(all.notCalled)}</div>
              <div className="kf-sp">{pct(all.notCalled, all.leads)} of leads</div>
            </div>
          </div>

          <Bar
            total={all.leads}
            segs={[
              { n: all.touched, cls: "kf-touched", title: "Touched" },
              { n: all.notTouched, cls: "kf-nottouched", title: "Not touched" },
              { n: all.notCalled, cls: "kf-notcalled", title: "Not called" },
              { n: all.noData, cls: "kf-nodata", title: "No calling data" },
            ]}
          />
          <div className="kf-legend">
            <span><i className="kf-touched" />Touched {nf(all.touched)}</span>
            <span><i className="kf-nottouched" />Not touched {nf(all.notTouched)}</span>
            <span><i className="kf-notcalled" />Not called {nf(all.notCalled)}</span>
            <span><i className="kf-nodata" />No calling data {nf(all.noData)}</span>
          </div>

          {/* three-way split */}
          <div className="cv-scroll" style={{ marginTop: 14 }}>
            <table className="cv-table">
              <thead>
                <tr>
                  <th>Segment</th>
                  <th className="tnum">Leads</th>
                  <th className="tnum">Called</th>
                  <th className="tnum">Touched</th>
                  <th className="tnum">Not touched</th>
                  <th className="tnum">Not called</th>
                  <th className="tnum">No calling data</th>
                </tr>
              </thead>
              <tbody>
                {segs.map((s) => (
                  <tr key={s.key} className={s.key === "all" ? "co-strong" : undefined}>
                    <td>{s.label}</td>
                    <td className="tnum">{nf(s.leads)}</td>
                    <td className="tnum">{nf(s.called)}<span className="fc-pct"> {pct(s.called, s.leads)}</span></td>
                    <td className="tnum cv-reg">{nf(s.touched)}<span className="fc-pct"> {pct(s.touched, s.called)}</span></td>
                    <td className="tnum fc-warn">{nf(s.notTouched)}</td>
                    <td className="tnum fc-bad">{nf(s.notCalled)}</td>
                    <td className="tnum">{nf(s.noData)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="cv-caveat">
            <b>Not registered + Registered add back to All leads.</b> Called % is of that segment&apos;s leads;
            Touched % is of those called. <b>No calling data</b> ({nf(all.noData)} leads) is not the same as
            &quot;not called&quot;: these leads exist in the CRM with phone numbers, but their record pre-dates the
            window of the Redash dump that feeds calling info, so the dump returns no row for them. We cannot
            say whether they were called.
          </p>
        </div>
      </section>

      {/* CSAT-1: same funnel per program */}
      {byProgram && byProgram.length > 0 && (
        <section className="grid mb">
          <div className="card">
            <header><h3>Calling funnel by program</h3><span className="cap">from the signup form</span></header>
            <div className="cv-scroll">
              <table className="cv-table">
                <thead>
                  <tr>
                    <th>Program</th><th className="tnum">Leads</th><th className="tnum">Called</th>
                    <th className="tnum">Touched</th><th className="tnum">Not touched</th>
                    <th className="tnum">Not called</th><th className="tnum">No calling data</th>
                  </tr>
                </thead>
                <tbody>
                  {byProgram.map((p) => (
                    <tr key={p.program}>
                      <td>{p.program}</td>
                      <td className="tnum">{nf(p.leads)}</td>
                      <td className="tnum">{nf(p.called)}<span className="fc-pct"> {pct(p.called, p.leads)}</span></td>
                      <td className="tnum cv-reg">{nf(p.touched)}<span className="fc-pct"> {pct(p.touched, p.called)}</span></td>
                      <td className="tnum fc-warn">{nf(p.notTouched)}</td>
                      <td className="tnum fc-bad">{nf(p.notCalled)}</td>
                      <td className="tnum">{nf(p.noData)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* leads created per day — works for every cohort */}
      {days && days.length > 0 && (
        <section className="grid mb">
          <div className="card">
            <header>
              <h3>Leads created per day</h3>
              <span className="cap">by signup time · registrations shown inside each bar</span>
            </header>
            <div className="co-days">
              {(() => {
                const max = Math.max(...days.map((d) => d.leads), 1);
                return days.map((d) => (
                  <div key={d.day} className="co-day" title={`${d.day}: ${nf(d.leads)} leads, ${nf(d.registrations)} registered`}>
                    <div className="co-bar-wrap">
                      <div className="kf-daybar" style={{ height: `${(d.leads / max) * 100}%` }}>
                        <div className="kf-dayreg" style={{ height: `${d.leads ? (d.registrations / d.leads) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <div className="co-day-n tnum">{nf(d.leads)}</div>
                    <div className="co-day-l">{d.day.slice(8)}/{d.day.slice(5, 7)}</div>
                  </div>
                ));
              })()}
            </div>
            <p className="cv-caveat">
              Bar height = leads created that day; the solid portion = those who went on to register.
            </p>
          </div>
        </section>
      )}
    </>
  );
}
