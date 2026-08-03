import Link from "next/link";
import { ensureFresh, loadState } from "@/lib/db";
import {
  parseCtx, stageCounts, roundOptions, defaultRound, ctxRounds, sankeyTree, sourceStages, sourceLegend,
  coverageAvailable, actionCoverage, untouchedAgeing, sourceAction, speedToLead,
  preTestTable, postTestTable, progOptions,
} from "@/lib/v2";
import Sankey from "@/components/Sankey";
import SourcePie from "@/components/SourcePie";
import FunnelCallTable from "@/components/FunnelCallTable";
import ContactFunnel from "@/components/ContactFunnel";
import { contactFunnel, contactMeta } from "@/lib/channels";
import { ActionCoverage, UntouchedAgeing, SourceActionTable, SpeedToLead } from "@/components/CoverageViews";
import { funnel, type Round } from "@/lib/queries";
import FunnelView from "@/components/FunnelView";
import RoundSelect from "@/components/RoundSelect";
import ProgSelect from "@/components/ProgSelect";

export const dynamic = "force-dynamic";
// cold-start hydrate pulls ~20 tables; the default 10s limit was too tight
export const maxDuration = 60;

const nf = (n: number) => n.toLocaleString("en-IN");

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  await ensureFresh();
  const load = loadState();
  const ctx = parseCtx(sp.ctx);
  const round = sp.round || defaultRound(ctx);
  const qs = `${ctx === "CSAT" ? "&ctx=CSAT" : ""}${round ? `&round=${round}` : ""}`;
  const s = stageCounts(ctx, round);
  // CSAT "All" spans BBA/BCA/Combined -> use the combined "CSAT" funnel; else the single round.
  const funnelRound = ctx === "CSAT" && ctxRounds(ctx, round).length > 1 ? "CSAT" : ctxRounds(ctx, round)[0];
  // Programme bifurcation, CSAT All tab only. The BBA and BCA tabs are already a
  // programme split, so the dropdown would duplicate them there.
  const progAll = ctx === "CSAT" && ctxRounds(ctx, round).length > 1;
  const progOpts = progAll ? progOptions(ctx, round) : [];
  const prog = progAll && progOpts.some((o) => o.value === sp.prog) ? (sp.prog as string) : "";
  const f = funnel(funnelRound as Round, undefined, prog || null);
  const tree = sankeyTree(ctx, round);
  const srcStages = sourceStages(ctx, round);
  // base query for drill-down links (no leading &)
  // prog rides along so a filtered cell opens the same filtered lead list
  const dq = `${ctx === "CSAT" ? "ctx=CSAT&" : ""}round=${round}`;
  const dqp = prog ? `${dq}&prog=${prog}` : dq;
  // Coverage views only render where the map actually carries calling data.
  const hasCoverage = coverageAvailable(ctx, round);
  const buckets = hasCoverage ? actionCoverage(ctx, round) : [];
  const untouched = hasCoverage ? untouchedAgeing(ctx, round) : null;
  const srcAct = hasCoverage ? sourceAction(ctx, round) : [];
  const speed = hasCoverage ? speedToLead(ctx, round) : [];
  const preTest = hasCoverage ? preTestTable(ctx, round) : [];
  const postTest = hasCoverage ? postTestTable(ctx, round) : [];
  // CSAT-1 only: post-test communication by channel, then turn-up from the panelist
  // form. Requires a turn-up source, which no other round has.
  // Reached-before-the-test, for whichever cohort has the pieces: CSAT-1 and
  // NSAT-4 both do. Everything cohort-specific lives in lib/channels.
  const cKey = ctx === "CSAT" ? "CSAT" : round === "NSAT-4" ? "NSAT-4" : null;
  const cMeta = cKey ? contactMeta(cKey) : null;
  const cWhere = ctx === "CSAT" ? ` AND m.round_tag IN (${ctxRounds(ctx, round).map((r) => `'${r}'`).join(",")})` : "";
  const cFunnel = cKey ? contactFunnel(cKey, cWhere, prog || undefined) : null;
  const maxCount = Math.max(1, ...f.rows.filter((r) => r.count !== null).map((r) => r.count as number));
  // The four numbers the CBO tracks — same funnel everywhere, that's the point.
  // NSAT-4's counselling sheet records the booking, not the attendance, so a
  // "Counselled" card there could only ever read 0. Show the number that exists.
  // NSAT-4 used to show Slot booked here because no attendance existed. The
  // panelist form now feeds nsat_outcome, so show Counselled like every other
  // round, and only fall back to Slot booked if that feed is genuinely empty.
  const slotsOnly = ctx === "NSAT" && round === "NSAT-4" && s.held === 0;
  const kpis: [string, number][] = [
    ["Leads", s.leads],
    ["Test given", s.appeared],
    slotsOnly ? ["Slot booked", s.slotBooked] : ["Counselled", s.held],
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
        {progOpts.length > 1 && <ProgSelect options={progOpts} current={prog} />}
      </div>


      {!load.ok && (
        <section className="grid mb">
          <div className="card co-caveat">
            <p className="sb-empty">
              <b>Data did not load.</b> {load.reason} Every number below would read zero, so this is a
              load failure, not an empty cohort. If it mentions missing configuration, Sync will not help:
              the environment variables have to be set where the app is deployed.
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
          <Sankey root={tree} qs={dqp} />
        </div>
      </section>

      {/* Source-wise stage split — source is the CRM's category, not the student's utm */}
      <section className="grid mb">
        <div className="card">
          <header>
            <h3>Stages by source</h3>
            <span className="cap">CRM source category (not form utm) · {round}</span>
          </header>
          <SourcePie stages={srcStages} legend={sourceLegend(srcStages)} qs={dqp} />
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
            <FunnelCallTable rows={preTest} qs={dqp} />
          </div>
        </section>
        <section className="grid mb">
          <div className="card">
            <header>
              <h3>Post test</h3>
              <span className="cap">
                after the exam · calling coverage at each stage · every cell opens its list
              </span>
            </header>
            <FunnelCallTable rows={postTest} qs={dqp} emptyNote="No post-test data yet." />
          </div>
        </section>
        {cFunnel && cMeta && (
          <ContactFunnel
            funnels={cFunnel}
            qs={dqp}
            labels={cMeta.labels}
            humanConnExact={cMeta.humanConnExact}
            cut={cMeta.cut}
            title={ctx === "CSAT" ? "calls up to and including 30 Jul, the test day" : "calls up to and including 29 Jul, the second test day"}
          />
        )}
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
              <ActionCoverage buckets={buckets} qs={dqp} />
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
                <UntouchedAgeing data={untouched} qs={dqp} />
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
              <SourceActionTable rows={srcAct} qs={dqp} />
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
                <SpeedToLead bands={speed} qs={dqp} />
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
