import Link from "next/link";
import { ensureFresh, dataLoaded } from "@/lib/db";
import {
  parseCtx, stageCounts, roundOptions, defaultRound, ctxRounds, sankeyTree, sourceStages, sourceLegend,
  coverageAvailable, actionCoverage, untouchedAgeing, sourceAction, speedToLead,
  preTestTable, postTestTable,
} from "@/lib/v2";
import Sankey from "@/components/Sankey";
import SourcePie from "@/components/SourcePie";
import FunnelCallTable from "@/components/FunnelCallTable";
import { ActionCoverage, UntouchedAgeing, SourceActionTable, SpeedToLead } from "@/components/CoverageViews";
import { funnel, type Round } from "@/lib/queries";
import { cohortForRound, callingFunnel, callingFunnelByProgram, activityByDay, cohortReady, overview as cohortOverview } from "@/lib/cohort";
import { CallingFunnelBlock } from "@/components/CallingFunnel";
import FunnelView from "@/components/FunnelView";
import RoundSelect from "@/components/RoundSelect";

export const dynamic = "force-dynamic";
// cold-start hydrate pulls ~20 tables; the default 10s limit was too tight
export const maxDuration = 60;

const nf = (n: number) => n.toLocaleString("en-IN");

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await ensureFresh();
  const loaded = dataLoaded();
  const ctx = parseCtx(sp.ctx);
  const round = sp.round || defaultRound(ctx);
  const qs = `${ctx === "CSAT" ? "&ctx=CSAT" : ""}${round ? `&round=${round}` : ""}`;
  const s = stageCounts(ctx, round);
  // CSAT "All" spans BBA/BCA/Combined -> use the combined "CSAT" funnel; else the single round.
  const funnelRound = ctx === "CSAT" && ctxRounds(ctx, round).length > 1 ? "CSAT" : ctxRounds(ctx, round)[0];
  const f = funnel(funnelRound as Round);
  const tree = sankeyTree(ctx, round);
  const srcStages = sourceStages(ctx, round);
  // base query for drill-down links (no leading &)
  const dq = `${ctx === "CSAT" ? "ctx=CSAT&" : ""}round=${round}`;
  // Calling funnel: lead counts from this test's lead map. Present for every
  // test that has one (NSAT-3/4/5, CSAT-1); absent rounds simply skip the block.
  const cSel = cohortForRound(ctx, round);
  const cOk = !!cSel && cohortReady(cSel.key);
  const cSegs = cOk && cSel ? callingFunnel(cSel.key, cSel.where) : [];
  const cOv = cOk && cSel ? cohortOverview(cSel.key, cSel.where) : null;
  const cProg = cOk && cSel && !cSel.where ? callingFunnelByProgram(cSel.key) : [];
  const cDays = cOk && cSel ? activityByDay(cSel.key, cSel.where) : [];
  // Coverage views only render where the map actually carries calling data.
  const hasCoverage = coverageAvailable(ctx, round);
  const buckets = hasCoverage ? actionCoverage(ctx, round) : [];
  const untouched = hasCoverage ? untouchedAgeing(ctx, round) : null;
  const srcAct = hasCoverage ? sourceAction(ctx, round) : [];
  const speed = hasCoverage ? speedToLead(ctx, round) : [];
  const preTest = hasCoverage ? preTestTable(ctx, round) : [];
  const postTest = hasCoverage ? postTestTable(ctx, round) : [];
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


      {!loaded && (
        <section className="grid mb">
          <div className="card co-caveat">
            <p className="sb-empty">
              <b>Data did not load.</b> The live pull failed or timed out on this request, so every number
              below would read zero. Hit <b>Sync now</b> — this is a load failure, not an empty cohort.
            </p>
          </div>
        </section>
      )}

      {/* Stage KPIs + intent pulse */}
      <section className="grid stage-kpis">
        {kpis.map(([label, val]) => (
          <div key={label} className="skpi band-none">
            <div className="skpi-top"><span className="skpi-label">{label}</span></div>
            <div className="skpi-val tnum">{nf(val)}</div>
          </div>
        ))}
      </section>

      {cOk && cOv && cSegs.length > 0 && (
        <CallingFunnelBlock
          segs={cSegs}
          leads={cOv.total}
          registrations={cOv.registrations}
          byProgram={cProg}
          days={cDays}
          label={round}
        />
      )}

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
          <header><h3>Flow</h3><span className="cap">click a box to expand · click a number to open that student list</span></header>
          <Sankey root={tree} qs={dq} />
        </div>
      </section>

      {/* Source-wise stage split — source is the CRM's category, not the student's utm */}
      <section className="grid mb">
        <div className="card">
          <header>
            <h3>Stages by source</h3>
            <span className="cap">CRM source category (not form utm) · {round}</span>
          </header>
          <SourcePie stages={srcStages} legend={sourceLegend(srcStages)} qs={dq} />
        </div>
      </section>

      {/* Pre test / Post test call funnels */}
      {hasCoverage && (
        <>
        <section className="grid mb">
          <div className="card">
            <header>
              <h3>Pre test</h3>
              <span className="cap">calling coverage before the exam · every cell opens its list</span>
            </header>
            <FunnelCallTable rows={preTest} qs={dq} />
          </div>
        </section>
        <section className="grid mb">
          <div className="card">
            <header>
              <h3>Post test</h3>
              <span className="cap">
                {postTest.length ? `after the exam · ${postTest.map((r) => r.label.toLowerCase()).join(" · ")}` : "after the exam"}
              </span>
            </header>
            <FunnelCallTable
              rows={postTest}
              qs={dq}
              emptyNote={`No post-test data for ${round}: this cohort has no test or counselling rows yet, so there is nothing to split. It fills in once the exam and counselling feeds land.`}
            />
          </div>
        </section>
        </>
      )}

      {hasCoverage && (
        <>
          {/* Did we work the lead at all */}
          <section className="grid mb">
            <div className="card">
              <header>
                <h3>Action coverage</h3>
                <span className="cap">every lead sits in exactly one bucket · {round}</span>
              </header>
              <ActionCoverage buckets={buckets} qs={dq} />
            </div>
          </section>

          {/* The worklist: unregistered and never called, by age */}
          {untouched && untouched.total > 0 && (
            <section className="grid mb">
              <div className="card">
                <header>
                  <h3>Untouched &amp; ageing</h3>
                  <span className="cap">not registered and never called, by time since signup</span>
                </header>
                <UntouchedAgeing data={untouched} qs={dq} />
              </div>
            </section>
          )}

          {/* Who we neglect */}
          <section className="grid mb">
            <div className="card">
              <header>
                <h3>Source × action</h3>
                <span className="cap">calling coverage per CRM source</span>
              </header>
              <SourceActionTable rows={srcAct} qs={dq} />
            </div>
          </section>

          {/* Time to first call */}
          {speed.length > 0 && (
            <section className="grid mb">
              <div className="card">
                <header>
                  <h3>Speed to lead</h3>
                  <span className="cap">time from signup to first call</span>
                </header>
                <SpeedToLead bands={speed} qs={dq} />
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
