import Link from "next/link";
import { ensureFresh } from "@/lib/db";
import { parseCtx, oneMinute, stageCounts, leaks, movers, intentSummary, roundOptions, defaultRound, SLA } from "@/lib/v2";
import RoundSelect from "@/components/RoundSelect";

export const dynamic = "force-dynamic";

const nf = (n: number) => n.toLocaleString("en-IN");

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await ensureFresh();
  const ctx = parseCtx(sp.ctx);
  const round = sp.round || defaultRound(ctx);
  const qs = `${ctx === "CSAT" ? "&ctx=CSAT" : ""}${round ? `&round=${round}` : ""}`;
  const lines = oneMinute(ctx, round);
  const s = stageCounts(ctx, round);
  const L = leaks(ctx, round);
  const m = movers(ctx, round);
  const I = intentSummary(ctx, round);

  const kpis: [string, number, string][] = ctx === "NSAT"
    ? [["Passed", s.pass, "result"], ["Counselled", s.held, "counselling"], ["Offers", s.offers, "offer_letter"], ["Seats", s.seats, "seat_payment"]]
    : [["Leads", s.leads, "lead"], ["Paid", s.paid, "registration"], ["Counselled", s.held, "counselling"], ["Seats", s.seats, "seat_payment"]];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{ctx} Command</h1>
          <div className="sub">the one-minute read: where we stand, what moved, where we are losing students</div>
        </div>
        <div className="spacer" />
        <RoundSelect options={roundOptions(ctx)} />
        <span className="pill"><span className="dot" /> {nf(s.leads)} leads in play</span>
      </div>

      {/* The one minute */}
      <section className="grid mb">
        <div className="card">
          <header><h3>In one minute</h3><span className="cap">computed live from every feed</span></header>
          <ul className="minute">
            {lines.map((l, i) => (<li key={i}>{l}</li>))}
          </ul>
        </div>
      </section>

      {/* Stage KPIs + intent pulse */}
      <section className="grid stage-kpis">
        {kpis.map(([label, val]) => (
          <div key={label} className="skpi band-none">
            <div className="skpi-top"><span className="skpi-label">{label}</span></div>
            <div className="skpi-val tnum">{nf(val)}</div>
          </div>
        ))}
        <div className="skpi band-none">
          <div className="skpi-top"><span className="skpi-label">Intent pulse</span></div>
          <div className="intent-pulse">
            <Link href={`/students?filter=hot${qs}`} className="ip hot tnum">{I.hot} hot</Link>
            <span className="ip warm tnum">{I.warm} warm</span>
            <span className="ip cool tnum">{I.cooling} cooling</span>
          </div>
        </div>
      </section>

      {/* Leak board */}
      <section className="grid mb">
        <div className="card">
          <header><h3>Where we are losing them</h3><span className="cap">SLA clocks: pass→slot {SLA.passToSlot}d · held→offer {SLA.heldToOffer}d · offer→seat {SLA.offerToSeat}d</span></header>
          <div className="leak-grid">
            {L.map((l) => (
              <Link key={l.key} href={`/students?filter=${l.key}${qs}`} className={`leak ${l.count > 0 ? l.tone : "ok"}`}>
                <div className="leak-n tnum">{l.count}</div>
                <div className="leak-t">{l.title}</div>
                <div className="leak-d">{l.desc}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Last 24h */}
      <section className="grid mb">
        <div className="card">
          <header><h3>Last 24 hours</h3><span className="cap">what moved since yesterday</span></header>
          <div className="movers">
            <span className="mv"><b className="tnum">+{m.held}</b> counselling done</span>
            <span className="mv"><b className="tnum">+{m.offers}</b> offers launched</span>
            <span className="mv"><b className="tnum">+{m.seats}</b> seats booked</span>
            <span className="mv"><b className="tnum">{nf(m.calls)}</b> human calls</span>
            <span className="mv"><b className="tnum">+{m.registrations}</b> registrations</span>
          </div>
        </div>
      </section>
    </>
  );
}
