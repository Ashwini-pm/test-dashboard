import { ensureFresh } from "@/lib/db";
import { parseCtx, coverage, commsByDay, dispositions } from "@/lib/v2";

export const dynamic = "force-dynamic";
const nf = (n: number) => n.toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "–");

export default async function Comms({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await ensureFresh();
  const ctx = parseCtx(sp.ctx);
  const cov = coverage(ctx);
  const days = commsByDay(ctx);
  const disp = dispositions(ctx);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Communication</h1>
          <div className="sub">{ctx} · who we reached, on which channel, and who has heard nothing</div>
        </div>
      </div>

      <section className="grid mb">
        <div className="card">
          <header><h3>Coverage by stage</h3><span className="cap">students at each stage vs the channels that touched them</span></header>
          <div className="heat-wrap">
            <table className="heatmap cday">
              <thead>
                <tr>
                  <th>Stage</th><th className="r">Students</th><th className="r">AI called</th>
                  <th className="r">Human called</th><th className="r">Connected</th>
                  <th className="r">WhatsApp</th><th className="r">Read</th>
                  <th className="r cday-divider">Touched last 72h</th><th className="r">Silent 72h</th>
                </tr>
              </thead>
              <tbody>
                {cov.filter((r) => r.total > 0).map((r) => (
                  <tr key={r.stage}>
                    <td className="heat-stage">{r.stage}</td>
                    <td className="r tnum">{nf(r.total)}</td>
                    <td className="r tnum">{pct(r.ai, r.total)}</td>
                    <td className="r tnum">{pct(r.human, r.total)}</td>
                    <td className="r tnum cday-good">{pct(r.humanConn, r.total)}</td>
                    <td className="r tnum">{pct(r.wa, r.total)}</td>
                    <td className="r tnum cday-good">{pct(r.waRead, r.total)}</td>
                    <td className="r tnum cday-divider">{pct(r.touched72, r.total)}</td>
                    <td className={`r tnum${r.total - r.touched72 > 0 ? " cday-bad" : ""}`}>{nf(r.total - r.touched72)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid mb">
        <div className="card">
          <header><h3>Day-wise volume</h3><span className="cap">last 14 days</span></header>
          <div className="heat-wrap">
            <table className="heatmap cday">
              <thead><tr><th>Day</th><th className="r">Human calls</th><th className="r">Connected</th><th className="r">WhatsApp</th><th className="r">Read</th></tr></thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day}>
                    <td className="heat-stage">{d.day}</td>
                    <td className="r tnum">{nf(d.human)}</td>
                    <td className="r tnum cday-good">{nf(d.humanConn)}</td>
                    <td className="r tnum">{nf(d.wa)}</td>
                    <td className="r tnum cday-good">{nf(d.waRead)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid mb">
        <div className="card">
          <header><h3>What students told us</h3><span className="cap">AI-call dispositions · CRM call-notes feed lands here next</span></header>
          <div className="movers">
            {disp.map((d) => (<span key={d.label} className="mv"><b className="tnum">{nf(d.n)}</b> {d.label}</span>))}
          </div>
        </div>
      </section>
    </>
  );
}
