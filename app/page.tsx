import Link from "next/link";
import { ensureFresh } from "@/lib/db";
import { parseCtx, stageCounts, roundOptions, defaultRound, ctxRounds, sankeyTree } from "@/lib/v2";
import Sankey from "@/components/Sankey";
import { funnel, type Round } from "@/lib/queries";
import FunnelView from "@/components/FunnelView";
import RoundSelect from "@/components/RoundSelect";

export const dynamic = "force-dynamic";

const nf = (n: number) => n.toLocaleString("en-IN");

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await ensureFresh();
  const ctx = parseCtx(sp.ctx);
  const round = sp.round || defaultRound(ctx);
  const qs = `${ctx === "CSAT" ? "&ctx=CSAT" : ""}${round ? `&round=${round}` : ""}`;
  const s = stageCounts(ctx, round);
  const f = funnel(ctxRounds(ctx, round)[0] as Round);
  const tree = sankeyTree(ctx, round);
  const maxCount = Math.max(1, ...f.rows.filter((r) => r.count !== null).map((r) => r.count as number));
  // The four numbers the CBO tracks — same funnel everywhere, that's the point.
  const kpis: [string, number][] = [
    ["Leads", s.leads],
    ["Test given", s.appeared],
    ["Counselled", s.held],
    ["Seat booked", s.seats],
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{ctx} Command</h1>
          <div className="sub">the one-minute read: where we stand, what moved, where we are losing students</div>
        </div>
        <div className="spacer" />
        <RoundSelect options={roundOptions(ctx)} current={round} />
      </div>


      {/* Stage KPIs + intent pulse */}
      <section className="grid stage-kpis">
        {kpis.map(([label, val]) => (
          <div key={label} className="skpi band-none">
            <div className="skpi-top"><span className="skpi-label">{label}</span></div>
            <div className="skpi-val tnum">{nf(val)}</div>
          </div>
        ))}
      </section>

      {/* Conversion funnel */}
      <section className="grid mb">
        <div className="card">
          <header><h3>Conversion Funnel</h3><span className="cap">full funnel · {round}</span></header>
          <FunnelView rows={f.rows} maxCount={maxCount} />
        </div>
      </section>

      {/* Flow sankey */}
      <section className="grid mb">
        <div className="card">
          <header><h3>Flow</h3><span className="cap">click any box: progressed vs dropped, and whether the dropped were even called</span></header>
          <Sankey root={tree} />
        </div>
      </section>


    </>
  );
}
