import db from "./db";

// ---------------------------------------------------------------------------
// NSAT Dashboard V2 — founder/CBO cockpit logic.
// Context = NSAT (active rounds) | CSAT. All numbers anchor on funnel-sheet
// lead IDs (the universe); comms/CRM feeds only decorate those leads.
// ---------------------------------------------------------------------------

export type Ctx = "NSAT" | "CSAT";
export function parseCtx(v: string | undefined | null): Ctx {
  return v === "CSAT" ? "CSAT" : "NSAT";
}
// Optional round narrows the context: NSAT -> NSAT-2/3/4, CSAT -> BBA/BCA/COMB.
export function ctxRounds(ctx: Ctx, round?: string | null): string[] {
  if (ctx === "CSAT") {
    if (round === "BBA") return ["CSAT-BBA"];
    if (round === "BCA") return ["CSAT-BCA"];
    if (round === "Combined") return ["CSAT-COMB"];
    return ["CSAT-BBA", "CSAT-BCA", "CSAT-COMB"];
  }
  if (round === "NSAT-2" || round === "NSAT-3" || round === "NSAT-4" || round === "NSAT-5") return [round];
  return ["NSAT-2", "NSAT-3", "NSAT-4", "NSAT-5"];
}
export function roundOptions(ctx: Ctx): string[] {
  return ctx === "CSAT" ? ["All", "BBA", "BCA", "Combined"] : ["NSAT-2", "NSAT-3", "NSAT-4", "NSAT-5"];
}
// No "All": rounds are separate cohorts. Default = the running round.
export function defaultRound(ctx: Ctx): string {
  return ctx === "CSAT" ? "All" : "NSAT-3";
}
export function inClause(ctx: Ctx, round?: string | null): string {
  return ctxRounds(ctx, round).map((r) => `'${r}'`).join(",");
}

// SLA rules (days a student may sit between stages before we call it a leak).
// TODO: replace with the business's fixed rules once provided.
export const SLA = {
  passToSlot: 2, // passed the test, no counselling slot booked
  slotToOutcome: 1, // slot day passed, panelist never responded
  heldToOffer: 2, // counselling done, no offer letter
  offerToSeat: 3, // offer letter valid for 3 days
};

const int = (row: any): number => Number((row && (row.n ?? row)) || 0);
const q = (sql: string) => int(db.prepare(sql).get() as any);
// csat_map = the lead_map reconciliation (deduped bba/bca/combined + crm_only),
// hydrated by db.ts. round_tag values are CSAT-BBA/BCA/COMB, matching the enum.
const tableHasRows = (t: string): boolean => {
  try {
    if (!int(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='${t}'`).get() as any)) return false;
    return int(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any) > 0;
  } catch { return false; }
};
// Rounds whose Lead/Registration come from a reconciliation map instead of the
// base tables. CSAT and NSAT-4 qualify: neither has base downstream stage rows,
// so swapping the universe cannot break later stages. NSAT-3 keeps the Sheet1
// universe for its base tables (its stage data is keyed to it).
function mapUniverse(ctx: Ctx, round?: string | null): { table: string; where: string } | null {
  if (ctx === "CSAT" && tableHasRows("csat_map")) {
    return { table: "csat_map", where: ` AND round_tag IN (${inClause(ctx, round)})` };
  }
  if (ctx === "NSAT" && round === "NSAT-4" && tableHasRows("nsat4_map")) {
    return { table: "nsat4_map", where: "" };
  }
  if (ctx === "NSAT" && round === "NSAT-5" && tableHasRows("cohort_nsat5")) {
    return { table: "cohort_nsat5", where: "" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core stage counts (same definitions the v1 dashboard settled on)
// ---------------------------------------------------------------------------
export interface StageCounts {
  leads: number; paid: number; appeared: number; pass: number; fail: number;
  slotBooked: number; held: number; offers: number; seats: number;
}
export function stageCounts(ctx: Ctx, round?: string | null): StageCounts {
  const inc = inClause(ctx, round);
  const jl = (t: string, extra = "") =>
    `SELECT COUNT(DISTINCT x.lead_id) n FROM ${t} x JOIN leads l ON l.lead_id=x.lead_id WHERE l.nsat_round IN (${inc})${extra}`;
  const COH = ` AND x.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))`;
  // CSAT Lead + Registration come from the lead_map reconciliation (csat_map),
  // not the raw base tables. Downstream stages stay 0 for CSAT (no such data).
  const mu = mapUniverse(ctx, round);
  // NSAT-4 keeps its test outcome, offer letter and seat on the map itself; the
  // base test_results / offer_letters / payments tables have no NSAT-4 rows, so
  // reading them here left every KPI after Leads at zero.
  const n4 = mu?.table === "nsat4_map";
  const fromN4 = (where: string) => q(`SELECT COUNT(*) n FROM nsat4_map WHERE ${where}`);
  const n4Appeared = n4 ? fromN4("nullif(test_result,'') IS NOT NULL") : 0;
  return {
    leads: mu
      ? q(`SELECT COUNT(*) n FROM ${mu.table} WHERE 1=1${mu.where}`)
      : q(`SELECT COUNT(*) n FROM leads WHERE nsat_round IN (${inc})`),
    paid: mu
      ? q(`SELECT COUNT(*) n FROM ${mu.table} WHERE registered='paid'${mu.where}`)
      : q(`SELECT COUNT(DISTINCT lead_id) n FROM registrations WHERE nsat_round IN (${inc})`),
    // Pass and Fail both land on the map now, so appeared = anyone with a result
    appeared: n4
      ? n4Appeared
      : ctx === "CSAT" && mu?.table === "csat_map"
        ? q(`SELECT COUNT(*) n FROM csat_map WHERE registered='paid' AND test_given='Test_Given'${mu.where}`)
        : q(jl("test_results", " AND x.appeared=1")),
    pass: n4 ? fromN4("test_result = 'Pass'") : q(jl("test_results", " AND x.result='pass'")),
    fail: n4 ? fromN4("test_result = 'Fail'") : q(jl("test_results", " AND x.result='fail'")),
    // NSAT-4 slots come from nsat4_counselling; it has no attendance column, so
    // held stays 0 instead of being inferred from the booking.
    slotBooked: n4
      ? q("SELECT COUNT(DISTINCT lead_id) n FROM nsat4_slots WHERE lead_id IN (SELECT lead_id FROM nsat4_map)")
      : q(jl("counselling_sessions", " AND x.scheduled_at IS NOT NULL")),
    held: n4 ? 0 : q(jl("counselling_sessions", " AND x.status='held'")),
    offers: n4 ? fromN4("nullif(offer_letter,'') IS NOT NULL") : q(jl("offer_letters", COH)),
    seats: n4 ? fromN4("seat_booked = 'Yes'") : q(jl("payments", " AND x.paid_at >= '2026-07-16'" + COH)),
  };
}

// ---------------------------------------------------------------------------
// Source-wise stage breakdown (stacked bars under the Sankey)
// ---------------------------------------------------------------------------
// Source ALWAYS comes from the reconciliation map's crm_source_category (what
// the CRM assigned the lead) — never the utm_source the student picked on the
// form. Map = lead_map (CSAT) / nsat3_lead_map (NSAT-3), hydrated by db.ts.
export const NO_SRC = "No CRM source";
// Does an in-memory map table exist AND carry rows? (hydration may skip it)
function hasRows(t: string): boolean {
  try {
    if (!int(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='${t}'`).get() as any)) return false;
    return int(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any) > 0;
  } catch { return false; }
}
export const csatMapHasRows = () => hasRows("csat_map");
// Fixed order so colors stay stable across rounds; anything unseen appends.
const SRC_ORDER = [
  "Influencers", "Organic", "Direct", "Inbound",
  "Youtube Channels", "Paid Performance Google", "Instagram Organic", "Others", NO_SRC,
];
export interface SourceStage {
  key: string;
  label: string;
  total: number;
  totalCalled: number;
  // called = human-calling reach from the map (total_calls > 0), shown as "n | called"
  parts: { src: string; n: number; called: number }[];
}
function mapTableFor(ctx: Ctx, round?: string | null): { table: string; where: string } | null {
  const has = hasRows;
  if (ctx === "CSAT" && has("csat_map")) {
    return { table: "csat_map", where: ` AND m.round_tag IN (${inClause(ctx, round)})` };
  }
  if (ctx === "NSAT" && (!round || round === "NSAT-3") && has("nsat3_map")) {
    return { table: "nsat3_map", where: "" };
  }
  // NSAT-4 has its own map, and it carries offer_letter / seat_booked inline.
  if (ctx === "NSAT" && round === "NSAT-4" && has("nsat4_map")) {
    return { table: "nsat4_map", where: "" };
  }
  if (ctx === "NSAT" && round === "NSAT-5" && has("cohort_nsat5")) {
    return { table: "cohort_nsat5", where: "" };
  }
  return null;
}
export function sourceStages(ctx: Ctx, round?: string | null): SourceStage[] {
  const m = mapTableFor(ctx, round);
  if (!m) return [];
  const inc = inClause(ctx, round);
  const paidCol = m.table === "nsat3_map" ? "reg_status" : "registered";
  const src = `coalesce(nullif(m.crm_source_category,''),'${NO_SRC}')`;
  // Stage counts split by source. Lead/Registration read the map directly (it IS
  // the deduped universe); later stages join the map onto the stage tables.
  const CALLED = "SUM(CASE WHEN coalesce(m.total_calls,0) > 0 THEN 1 ELSE 0 END)";
  const fromMap = (extra: string) =>
    `SELECT ${src} s, COUNT(*) n, ${CALLED} called FROM ${m.table} m WHERE 1=1${m.where}${extra} GROUP BY 1`;
  const viaStage = (t: string, extra = "") =>
    `SELECT ${src} s, COUNT(DISTINCT x.lead_id) n, ${CALLED} called FROM ${t} x
       JOIN leads l ON l.lead_id = x.lead_id
       JOIN ${m.table} m ON (m.lead_id = l.student_id OR m.lead_id = l.lead_id)
      WHERE l.nsat_round IN (${inc})${m.where}${extra} GROUP BY 1`;
  const COH = ` AND x.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))`;
  const defs: [string, string, string][] = [
    ["lead", "Lead", fromMap("")],
    ["registration", "Registration", fromMap(` AND m.${paidCol}='paid'`)],
    // NSAT-4/5 carry the test outcome on the map itself, so read it from there
    // instead of the (empty) base stage tables.
    ...(m.table === "csat_map"
      ? ([
          ["slotb", "Slot booked", fromMap(" AND m.lead_id IN (SELECT lead_id FROM csat_slots)")],
          ["ol", "Offer letter (all)", fromMap(" AND nullif(m.offer_letter,'') IS NOT NULL")],
          // lead level: every seat, counselled or not
          ["seat", "Seat booked (all)", fromMap(" AND m.seat_booked = 'Yes'")],
        ] as [string, string, string][])
      : []),
    ...(m.table === "nsat4_map"
      ? ([
          ["result", "Test given", fromMap(" AND nullif(m.test_result,'') IS NOT NULL")],
          ["slotb", "Slot booked", fromMap(" AND m.lead_id IN (SELECT lead_id FROM nsat4_slots)")],
        ] as [string, string, string][])
      : []),
    ["test", "Test", viaStage("test_results", " AND x.appeared=1")],
    ["result", "Result: Pass", viaStage("test_results", " AND x.result='pass'")],
    ["slot_form", "Slot Form", viaStage("counselling_sessions", " AND x.scheduled_at IS NOT NULL")],
    ["counselling", "Counselling", viaStage("counselling_sessions", " AND x.status='held'")],
    ["offer_letter", "Offer Letter", viaStage("offer_letters", COH)],
    ["seat_payment", "Seat Payment", viaStage("payments", " AND x.paid_at >= '2026-07-16'" + COH)],
  ];
  const out: SourceStage[] = [];
  for (const [key, label, sql] of defs) {
    let rows: { s: string; n: number; called: number }[] = [];
    try { rows = db.prepare(sql).all() as { s: string; n: number; called: number }[]; } catch { rows = []; }
    const parts = rows
      .filter((r) => Number(r.n) > 0)
      .sort((a, b) => {
        const ia = SRC_ORDER.indexOf(a.s), ib = SRC_ORDER.indexOf(b.s);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map((r) => ({ src: r.s, n: Number(r.n), called: Number(r.called ?? 0) }));
    const total = parts.reduce((a, b) => a + b.n, 0);
    const totalCalled = parts.reduce((a, b) => a + b.called, 0);
    if (total > 0) out.push({ key, label, total, totalCalled, parts });
  }
  return out;
}
export function sourceLegend(stages: SourceStage[]): string[] {
  const seen = new Set<string>();
  for (const st of stages) for (const p of st.parts) seen.add(p.src);
  return SRC_ORDER.filter((s) => seen.has(s)).concat([...seen].filter((s) => !SRC_ORDER.includes(s)));
}

// ---------------------------------------------------------------------------
// Coverage views — "did we do our job", as distinct from "did it convert".
// ---------------------------------------------------------------------------
// All read the reconciliation map (lead_map / nsat3_lead_map). Calling here is a
// REMEDIATION action aimed at people who did not register, so these are coverage
// metrics: never divide them into conversion rates and call it causation.
const paidColFor = (t: string) => (t === "nsat3_map" ? "reg_status" : "registered");

export function coverageAvailable(ctx: Ctx, round?: string | null): boolean {
  const m = mapTableFor(ctx, round);
  if (!m) return false;
  try {
    return int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE coalesce(m.total_calls,0) > 0${m.where}`).get() as any) > 0;
  } catch { return false; }
}

export interface ActionBucket { key: string; label: string; leads: number; registered: number; notRegistered: number; }
export function actionCoverage(ctx: Ctx, round?: string | null): ActionBucket[] {
  const m = mapTableFor(ctx, round);
  if (!m) return [];
  const p = paidColFor(m.table);
  const row = (key: string, label: string, cond: string): ActionBucket => {
    const r = db.prepare(
      `SELECT COUNT(*) leads,
              SUM(CASE WHEN m.${p}='paid' THEN 1 ELSE 0 END) reg
         FROM ${m.table} m WHERE ${cond}${m.where}`
    ).get() as any;
    const leads = Number(r?.leads ?? 0), registered = Number(r?.reg ?? 0);
    return { key, label, leads, registered, notRegistered: leads - registered };
  };
  return [
    row("never", "Never called", "coalesce(m.total_calls,0)=0"),
    row("noconn", "Called, no answer", "coalesce(m.total_calls,0)>0 AND coalesce(m.connected_calls,0)=0"),
    row("conn", "Connected", "coalesce(m.connected_calls,0)>0"),
  ];
}

export interface AgeBand { key: string; label: string; n: number; tone: "good" | "warn" | "bad"; }
export interface Untouched { total: number; bands: AgeBand[]; noCounsellor: number; }
export function untouchedAgeing(ctx: Ctx, round?: string | null): Untouched | null {
  const m = mapTableFor(ctx, round);
  if (!m) return null;
  const p = paidColFor(m.table);
  // untouched = not registered AND never called
  const base = `m.${p}<>'paid' AND coalesce(m.total_calls,0)=0${m.where}`;
  const band = (cond: string) =>
    int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE ${base} AND m.first_signup IS NOT NULL AND ${cond}`).get() as any);
  const age = "(julianday('now') - julianday(m.first_signup)) * 24";
  const bands: AgeBand[] = [
    { key: "b1", label: "0–8h", n: band(`${age} < 8`), tone: "good" },
    { key: "b2", label: "8–24h", n: band(`${age} >= 8 AND ${age} < 24`), tone: "warn" },
    { key: "b3", label: "24–72h", n: band(`${age} >= 24 AND ${age} < 72`), tone: "bad" },
    { key: "b4", label: "72h+", n: band(`${age} >= 72`), tone: "bad" },
  ];
  let noCounsellor = 0;
  try {
    noCounsellor = int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE nullif(m.counsellor,'') IS NULL${m.where}`).get() as any);
  } catch { noCounsellor = 0; }
  return { total: int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE ${base}`).get() as any), bands, noCounsellor };
}

export interface SourceAction { src: string; leads: number; called: number; connected: number; }
export function sourceAction(ctx: Ctx, round?: string | null): SourceAction[] {
  const m = mapTableFor(ctx, round);
  if (!m) return [];
  const src = `coalesce(nullif(m.crm_source_category,''),'${NO_SRC}')`;
  const rows = db.prepare(
    `SELECT ${src} s, COUNT(*) leads,
            SUM(CASE WHEN coalesce(m.total_calls,0)>0 THEN 1 ELSE 0 END) called,
            SUM(CASE WHEN coalesce(m.connected_calls,0)>0 THEN 1 ELSE 0 END) connected
       FROM ${m.table} m WHERE 1=1${m.where} GROUP BY 1 ORDER BY 2 DESC`
  ).all() as any[];
  return rows.map((r) => ({ src: String(r.s), leads: Number(r.leads), called: Number(r.called), connected: Number(r.connected) }));
}

export interface SpeedBand { key: string; label: string; n: number; }
export function speedToLead(ctx: Ctx, round?: string | null): SpeedBand[] {
  const m = mapTableFor(ctx, round);
  if (!m) return [];
  const hrs = "(julianday(m.first_call_at) - julianday(m.first_signup)) * 24";
  const base = `m.first_call_at IS NOT NULL AND m.first_signup IS NOT NULL${m.where}`;
  const b = (cond: string) => int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE ${base} AND ${cond}`).get() as any);
  return [
    { key: "s0", label: "within 1 hr", n: b(`${hrs} >= 0 AND ${hrs} <= 1`) },
    { key: "s1", label: "1–24 hrs", n: b(`${hrs} > 1 AND ${hrs} <= 24`) },
    { key: "s2", label: "1–3 days", n: b(`${hrs} > 24 AND ${hrs} <= 72`) },
    { key: "s3", label: "3+ days", n: b(`${hrs} > 72`) },
    { key: "s4", label: "called before signup", n: b(`${hrs} < 0`) },
  ].filter((x) => x.n > 0);
}

// ---------------------------------------------------------------------------
// Pre/Post test call tree — Lead and Registered each split called / not called,
// then called splits picked / not picked (same shape as the Sankey).
// ---------------------------------------------------------------------------
// NOTE: the map holds ONE call aggregate per lead (total_calls / connected_calls)
// and no registration timestamp, so "registered AND called" cannot be resolved
// into "called before vs after registering". Counts are nested, not exclusive:
// registered-called is a SUBSET of lead-called.
export interface CallNode {
  key: string; label: string; n: number; tone?: "good" | "warn" | "bad" | "info";
  drill?: string; children?: CallNode[];
}
// Two sides, split down the middle: Lead -> Registered (left) and
// Lead -> Not registered (right). Calling is aimed at the NOT-registered side,
// so that is the one that carries the actionable funnel.
export function preTestTree(ctx: Ctx, round?: string | null): CallNode[] {
  const m = mapTableFor(ctx, round);
  if (!m) return [];
  const paid = paidColFor(m.table);
  const c = (extra: string) =>
    int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE 1=1${m.where}${extra}`).get() as any);

  const leadTotal = c("");
  const side = (key: string, label: string, scope: string, drillScope: string, tone: CallNode["tone"]): CallNode => {
    const total = c(scope);
    const called = c(`${scope} AND coalesce(m.total_calls,0)>0`);
    const notCalled = c(`${scope} AND coalesce(m.total_calls,0)=0`);
    const picked = c(`${scope} AND coalesce(m.connected_calls,0)>0`);
    return {
      key: "lead:" + key, label: "Lead", n: leadTotal, tone: "info", drill: "stage=lead",
      children: [{
        key, label, n: total, tone,
        drill: drillScope,
        children: [
          {
            key: `${key}:called`, label: "Called", n: called, tone: "good",
            drill: `${drillScope}&act=called`,
            children: [
              { key: `${key}:picked`, label: "Picked up", n: picked, tone: "good", drill: `${drillScope}&conn=1` },
              { key: `${key}:notpicked`, label: "Did not pick", n: called - picked, tone: "warn", drill: `${drillScope}&act=noconn` },
            ],
          },
          { key: `${key}:notcalled`, label: "Not called", n: notCalled, tone: "bad", drill: `${drillScope}&act=never` },
        ],
      }],
    };
  };

  return [
    side("reg", "Registered", ` AND m.${paid}='paid'`, "reg=paid", "good"),
    side("unreg", "Not registered", ` AND m.${paid}<>'paid'`, "reg=unpaid", "bad"),
  ];
}

// Pre/post test as TABLES: one row per stage, columns = calling coverage.
export interface FunnelCallRow {
  key: string; label: string; total: number; called: number;
  picked: number; notPicked: number; notCalled: number;
  /** total_calls IS NULL: no calling record for this lead, so we cannot say. NOT
   *  the same as not touched, and never merged into it. */
  noData: number;
  drill?: string; // base filter for this row; columns append their own
}
function callCols(m: { table: string; where: string }, scope: string) {
  const c = (extra: string) =>
    int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE 1=1${m.where}${scope}${extra}`).get() as any);
  const total = c("");
  const called = c(" AND coalesce(m.total_calls,0)>0");
  const picked = c(" AND coalesce(m.connected_calls,0)>0");
  // notCalled must exclude NULLs: a lead with no calling record was not "not
  // touched", we simply do not know. Split so the two never merge.
  const hasCol = (() => {
    try { return (db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[]).some((x) => x.name === "total_calls"); }
    catch { return false; }
  })();
  const noData = hasCol ? c(" AND m.total_calls IS NULL") : 0;
  return {
    total, called, picked,
    notPicked: called - picked,
    notCalled: c(" AND m.total_calls IS NOT NULL AND m.total_calls = 0"),
    noData,
  };
}
export function preTestTable(ctx: Ctx, round?: string | null): FunnelCallRow[] {
  const m = mapTableFor(ctx, round);
  if (!m) return [];
  const paid = paidColFor(m.table);
  const rows: FunnelCallRow[] = [];
  rows.push({ key: "lead", label: "Lead (all)", ...callCols(m, ""), drill: "stage=lead" });
  rows.push({ key: "reg", label: "Registered", ...callCols(m, ` AND m.${paid}='paid'`), drill: "reg=paid" });
  rows.push({ key: "unreg", label: "Not registered", ...callCols(m, ` AND m.${paid}<>'paid'`), drill: "reg=unpaid" });
  // Calling coverage of the students who actually sat the test. CSAT-1 records this
  // on the map as test_given; NSAT-4 as test_result.
  if (m.table === "csat_map") {
    const t = callCols(m, " AND m.test_given='Test_Given'");
    if (t.total > 0) rows.push({ key: "test", label: "Test given", ...t, drill: "tg=given" });
  } else if (m.table === "nsat4_map") {
    const t = callCols(m, " AND nullif(m.test_result,'') IS NOT NULL");
    if (t.total > 0) rows.push({ key: "test", label: "Test given", ...t, drill: "pstage=test" });
  }

  // The Combined page offers BBA and BCA together, so the signup carries no
  // program. Bifurcate it by the program the CRM assigned instead.
  // Combined ONLY. That page sells BBA and BCA together, so the split is the
  // whole point there. On the BBA/BCA tabs every row is already that program,
  // and on All the split just repeats the by-program card.
  if (m.table === "csat_map" && round === "Combined") {
    let progs: string[] = [];
    try {
      progs = (db.prepare(
        `SELECT coalesce(nullif(m.signup_programs,''),'__none__') p, COUNT(*) n
           FROM csat_map m WHERE 1=1${m.where} GROUP BY 1 ORDER BY n DESC`
      ).all() as any[]).map((r) => String(r.p));
    } catch { progs = []; }
    // BBA/BCA first (the two the page sells), then anything else the CRM assigned.
    const ordered = ["BBA", "BCA", ...progs.filter((x) => x !== "BBA" && x !== "BCA")];
    for (const pg of ordered) {
      if (!progs.includes(pg)) continue;
      const scope = pg === "__none__"
        ? " AND nullif(m.signup_programs,'') IS NULL"
        : ` AND m.signup_programs = '${esc(pg)}'`;
      const cols = callCols(m, scope);
      if (!cols.total) continue;
      rows.push({
        key: `cprog_${pg}`,
        label: `· ${pg === "__none__" ? "no signup (CRM-only lead)" : pg}`,
        ...cols,
        drill: `sprog=${encodeURIComponent(pg)}`,
      });
    }
  }
  return rows;
}
export function postTestTable(ctx: Ctx, round?: string | null): FunnelCallRow[] {
  const m = mapTableFor(ctx, round);
  if (!m) return [];
  // CSAT-1's post-test stages live on its own tables, not in the base stage tables:
  // slots in csat_slots, attendance in csat_outcome (panelist form), offer letter and
  // seat on the map itself. Without this the block read "no post-test data yet" while
  // the funnel two blocks above showed 138 slots, 15 offers and 8 seats.
  if (m.table === "csat_map") {
    const out: FunnelCallRow[] = [];
    const defs: [string, string, string][] = [
      ["slot", "Slot booked", " AND m.lead_id IN (SELECT lead_id FROM csat_slots)"],
      ["couns", "Counselling done", " AND m.lead_id IN (SELECT lead_id FROM csat_outcome WHERE status LIKE 'Happening%')"],
      ["ol", "Offer letter · counselled", " AND nullif(m.offer_letter,'') IS NOT NULL AND m.lead_id IN (SELECT lead_id FROM csat_outcome)"],
      ["ol_nc", "Offer letter · no panelist response", " AND nullif(m.offer_letter,'') IS NOT NULL AND m.lead_id NOT IN (SELECT lead_id FROM csat_outcome)"],
      // Verified = a panelist recorded this student. The rest are real seats but
      // direct admissions that never went through counselling, so they are counted
      // separately at lead level rather than credited to the counselling funnel.
      ["seat", "Seat booked · counselled", " AND m.seat_booked = 'Yes' AND m.lead_id IN (SELECT lead_id FROM csat_outcome)"],
      ["seat_nc", "Seat booked · no panelist response", " AND m.seat_booked = 'Yes' AND m.lead_id NOT IN (SELECT lead_id FROM csat_outcome)"],
    ];
    for (const [key, label, scope] of defs) {
      let cols;
      try { cols = callCols(m, scope); } catch { continue; }
      if (cols.total > 0) out.push({ key, label, ...cols, drill: `pstage=${key}` });
    }
    return out;
  }
  // NSAT-4: offer_letter / seat_booked are columns on the map itself.
  if (m.table === "nsat4_map") {
    const out: FunnelCallRow[] = [];
    // test_result only ever carries 'Pass' — we know who cleared, not who sat and
    // failed — so this row is a pass count, labelled as such.
    const defs: [string, string, string][] = [
      ["test", "Test given", " AND nullif(m.test_result,'') IS NOT NULL"],
      ["pass", "Test passed", " AND m.test_result = 'Pass'"],
      ["fail", "Test failed", " AND m.test_result = 'Fail'"],
      // slot booked = has a booking_id in nsat4_counselling (mirrored to nsat4_slots)
      ["slot", "Slot booked", " AND m.lead_id IN (SELECT lead_id FROM nsat4_slots)"],
      ["ol", "Offer letter", " AND nullif(m.offer_letter,'') IS NOT NULL"],
      ["seat", "Seat booked", " AND m.seat_booked = 'Yes'"],
    ];
    for (const [key, label, scope] of defs) {
      const cols = callCols(m, scope);
      if (cols.total > 0) out.push({ key, label, ...cols, drill: `pstage=${key}` });
    }
    return out;
  }
  const inc = inClause(ctx, round);
  // stage_flags is precomputed per hydrate (see db.ts buildMapIndexes), keyed the
  // same way the maps are keyed. One indexed lookup instead of a correlated scan.
  const defs: [string, string, string][] = [
    ["test",  "Test given",   "tested=1"],
    ["pass",  "Passed",       "passed=1"],
    ["slot",  "Slot booked",  "slot=1"],
    ["couns", "Counselled",   "couns=1"],
    ["ol",    "Offer letter", "ol=1 AND cohort=1"],
    ["seat",  "Seat booked",  "seat=1 AND cohort=1"],
  ];
  const out: FunnelCallRow[] = [];
  for (const [key, label, cond] of defs) {
    const scope = ` AND m.lead_id IN (SELECT k FROM stage_flags WHERE rnd IN (${inc}) AND ${cond})`;
    let cols;
    try { cols = callCols(m, scope); } catch { continue; }
    if (cols.total > 0) out.push({ key, label, ...cols, drill: `pstage=${key}` });
  }
  return out;
}

// Post-test needs test/counselling rows joined to calling data. Report what is
// actually available rather than rendering zeros as if they were measurements.
export function postTestAvailable(ctx: Ctx, round?: string | null): boolean {
  const m = mapTableFor(ctx, round);
  if (!m) return false;
  const inc = inClause(ctx, round);
  try {
    const tested = int(db.prepare(
      `SELECT COUNT(*) n FROM test_results x JOIN leads l ON l.lead_id=x.lead_id
        WHERE l.nsat_round IN (${inc}) AND x.appeared=1`
    ).get() as any);
    if (!tested) return false;
    // and does the map for this round carry calling data at all?
    return int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE coalesce(m.total_calls,0)>0${m.where}`).get() as any) > 0;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Drill-down: every stat above is a link into this, filtered by the same slice.
// ---------------------------------------------------------------------------
// Params are a closed set of enums/keys, never free SQL. Values that reach SQL
// are either fixed literals or escaped below.
export interface DrillParams {
  src?: string[] | null;  // CRM source categories (or NO_SRC) — multi-select
  stage?: string | null;  // "lead" | "reg"
  act?: string | null;    // "never" | "noconn" | "conn"
  reg?: string | null;    // "paid" | "unpaid"
  age?: string | null;    // "b1".."b4"  (untouched ageing bands)
  speed?: string | null;  // "s0".."s4"
  nocouns?: string | null; // "1"
  origin?: string[] | null; // both | capture_only | crm_only — multi-select
  camp?: string[] | null;   // utm_campaign — multi-select
  q?: string | null;       // free text: name / lead id / phone
  id?: string | null;      // lead id contains
  name?: string | null;    // name contains
  phone?: string | null;   // phone contains
  conn?: string | null;    // "1" connected, "0" not connected
  pstage?: string | null;  // post-test stage: test|pass|slot|couns|ol|seat
  cprog?: string | null;   // CRM-assigned program (BBA/BCA/...); "__none__" = CRM has none
  sprog?: string | null;   // program the student picked on the page; "__none__" = never signed up
  couns?: string[] | null; // counsellor names, or "__none__" for unassigned — multi-select
  tg?: string | null;      // CSAT-1 test attendance: given | noshow | nostatus
  tag?: string | null;     // "src:organic" | "utm:vedantu_yt_bca" (comma-split tag)
  reach?: string | null;   // CSAT-1 call reach: "any" (AI or person connected) | "none"
  ch?: string | null;      // CSAT-1 channel that connected: both | hu | ai | no
  hc?: string | null;      // human calling: dialled | conn | noconn | never | nodata
  ac?: string | null;      // AI calling:    dialled | conn | noconn | never
  pt?: string | null;      // contact by test day, person: touched | conn | noconn | never | nodata
  pta?: string | null;     // contact by test day, AI:     touched | conn | noconn | never
  fstage?: string | null;  // funnel stage, panelist-gated: lead|reg|test|couns|ol|sb
}

// Distinct values for the filter dropdowns on the drill page.
export function drillFacets(ctx: Ctx, round?: string | null):
  { sources: string[]; campaigns: string[]; origins: string[]; counsellors: string[] } {
  const m = mapTableFor(ctx, round);
  if (!m) return { sources: [], campaigns: [], origins: [], counsellors: [] };
  const col = (c: string, alias: string) => {
    try {
      return (db.prepare(
        `SELECT DISTINCT coalesce(nullif(m.${c},''),'') ${alias} FROM ${m.table} m WHERE 1=1${m.where} ORDER BY 1`
      ).all() as any[]).map((r) => String(r[alias])).filter(Boolean);
    } catch { return []; }
  };
  return {
    sources: col("crm_source_category", "v"),
    campaigns: col("utm_campaign", "v"),
    origins: col("origin", "v"),
    counsellors: col("counsellor", "v"),
  };
}
export interface DrillRow {
  lead_id: string; name: string; phone: string; source: string; campaign: string;
  registered: string; calls: number; connected: number; first_signup: string | null;
  first_call_at: string | null; counsellor: string;
}
const esc = (s: string) => s.replace(/'/g, "''");

export function drill(ctx: Ctx, round: string | null | undefined, p: DrillParams, limit = 1000, offset = 0):
  { rows: DrillRow[]; total: number; label: string } {
  const m = mapTableFor(ctx, round);
  if (!m) return { rows: [], total: 0, label: "no mapping for this round" };
  const paid = paidColFor(m.table);
  const w: string[] = ["1=1"];
  const bits: string[] = [];
  const age = "(julianday('now') - julianday(m.first_signup)) * 24";
  const hrs = "(julianday(m.first_call_at) - julianday(m.first_signup)) * 24";

  // multi-select: OR within a column, AND across columns
  if (p.src?.length) {
    const parts = p.src.map((v) =>
      v === NO_SRC ? "nullif(m.crm_source_category,'') IS NULL" : `m.crm_source_category = '${esc(v)}'`);
    w.push(`(${parts.join(" OR ")})`);
    bits.push(p.src.join(" / "));
  }
  if (p.stage === "reg") { w.push(`m.${paid}='paid'`); bits.push("registered"); }
  else if (p.stage === "lead") bits.push("all leads");

  if (p.act === "never")  { w.push("coalesce(m.total_calls,0)=0"); bits.push("never called"); }
  if (p.act === "called") { w.push("coalesce(m.total_calls,0)>0"); bits.push("called"); }
  if (p.act === "noconn") { w.push("coalesce(m.total_calls,0)>0 AND coalesce(m.connected_calls,0)=0"); bits.push("called, no answer"); }
  if (p.act === "conn")   { w.push("coalesce(m.connected_calls,0)>0"); bits.push("connected"); }

  if (p.reg === "paid")   { w.push(`m.${paid}='paid'`); bits.push("registered"); }
  if (p.reg === "unpaid") { w.push(`m.${paid}<>'paid'`); bits.push("not registered"); }

  if (p.age) {
    const band: Record<string, string> = {
      b1: `${age} < 8`, b2: `${age} >= 8 AND ${age} < 24`,
      b3: `${age} >= 24 AND ${age} < 72`, b4: `${age} >= 72`,
    };
    const lbl: Record<string, string> = { b1: "0–8h", b2: "8–24h", b3: "24–72h", b4: "72h+" };
    if (band[p.age]) {
      w.push(`m.${paid}<>'paid'`, "coalesce(m.total_calls,0)=0", "m.first_signup IS NOT NULL", band[p.age]);
      bits.push(`untouched ${lbl[p.age]}`);
    }
  }
  if (p.speed) {
    const band: Record<string, string> = {
      s0: `${hrs} >= 0 AND ${hrs} <= 1`, s1: `${hrs} > 1 AND ${hrs} <= 24`,
      s2: `${hrs} > 24 AND ${hrs} <= 72`, s3: `${hrs} > 72`, s4: `${hrs} < 0`,
    };
    const lbl: Record<string, string> = {
      s0: "first call within 1 hr", s1: "first call 1–24 hrs", s2: "first call 1–3 days",
      s3: "first call 3+ days", s4: "called before signup",
    };
    if (band[p.speed]) {
      w.push("m.first_call_at IS NOT NULL", "m.first_signup IS NOT NULL", band[p.speed]);
      bits.push(lbl[p.speed]);
    }
  }
  if (p.nocouns === "1") { w.push("nullif(m.counsellor,'') IS NULL"); bits.push("no counsellor"); }
  // Program as the CRM assigned it, not what the student picked on the form.
  if (p.cprog) {
    if (p.cprog === "__none__") { w.push("nullif(m.crm_program,'') IS NULL"); bits.push("no CRM program"); }
    else { w.push(`m.crm_program = '${esc(p.cprog)}'`); bits.push(`CRM ${p.cprog}`); }
  }
  // program as chosen on the landing page (the Combined page asks for it)
  if (p.sprog) {
    if (p.sprog === "__none__") { w.push("nullif(m.signup_programs,'') IS NULL"); bits.push("no signup"); }
    else { w.push(`m.signup_programs = '${esc(p.sprog)}'`); bits.push(p.sprog); }
  }
  // post-test stages live in the stage tables, not the map: match via leads.
  // CSAT-1 test status. "nostatus" stays its own filter: no status on the sheet is
  // missing information, not a skipped test. "notgiven" is the union of the two,
  // which is what the calling-vs-test-given table counts as "no test".
  if (p.tg && m.table === "csat_map") {
    if (p.tg === "given")    { w.push("m.registered='paid' AND m.test_given='Test_Given'"); bits.push("gave the test"); }
    if (p.tg === "noshow")   { w.push("m.registered='paid' AND m.test_given='Test_Not_Appear'"); bits.push("registered, did not give the test"); }
    if (p.tg === "nostatus") { w.push("m.registered='paid' AND nullif(m.test_given,'') IS NULL"); bits.push("registered, test status not known"); }
    if (p.tg === "notgiven") { w.push("m.registered='paid' AND coalesce(m.test_given,'') <> 'Test_Given'"); bits.push("registered, no test given"); }
  }
  // Did a call ever connect — by a person or by the AI agent. Same definition the
  // calling-vs-test-given block uses, so the counts match what is on screen.
  const CSAT_CONNECTED =
    "(coalesce(m.connected_calls,0) > 0 OR m.lead_id IN (SELECT lead_id FROM ai_reach WHERE cohort='CSAT-1' AND reached=1))";
  if (p.reach && m.table === "csat_map") {
    if (p.reach === "any")  { w.push(CSAT_CONNECTED); bits.push("a call connected"); }
    if (p.reach === "none") { w.push(`NOT ${CSAT_CONNECTED}`); bits.push("no call ever connected"); }
  }
  if (p.ch && m.table === "csat_map") {
    const HU = "coalesce(m.connected_calls,0) > 0";
    const AI = "m.lead_id IN (SELECT lead_id FROM ai_reach WHERE cohort='CSAT-1' AND reached=1)";
    if (p.ch === "both") { w.push(`${HU} AND ${AI}`); bits.push("AI and a person both connected"); }
    if (p.ch === "hu")   { w.push(`${HU} AND NOT (${AI})`); bits.push("only a person connected"); }
    if (p.ch === "ai")   { w.push(`${AI} AND NOT (${HU})`); bits.push("only AI connected"); }
    if (p.ch === "no")   { w.push(`NOT (${HU}) AND NOT (${AI})`); bits.push("nobody connected"); }
  }
  // Comma-split source / UTM value, matched through csat_tag so the count always
  // equals what the attendance table shows (both read the same split).
  if (p.tag && m.table === "csat_map") {
    const i = p.tag.indexOf(":");
    const kind = i > 0 ? p.tag.slice(0, i) : "";
    const key = i > 0 ? p.tag.slice(i + 1) : "";
    if ((kind === "src" || kind === "utm") && key) {
      w.push(`m.lead_id IN (SELECT lead_id FROM csat_tag WHERE kind='${esc(kind)}' AND key='${esc(key.toLowerCase())}')`);
      bits.push(`${kind === "src" ? "source" : "utm"} ${key}`);
    }
  }
  // Calling block filters. Unlike act=never, these keep "never dialled"
  // (total_calls = 0) apart from "no calling data" (total_calls IS NULL): the
  // second means we do not know, not that nobody called.
  if (p.hc && m.table === "csat_map") {
    if (p.hc === "dialled") { w.push("coalesce(m.total_calls,0) > 0"); bits.push("dialled by a person"); }
    if (p.hc === "conn")    { w.push("coalesce(m.connected_calls,0) > 0"); bits.push("a person connected"); }
    if (p.hc === "noconn")  { w.push("coalesce(m.total_calls,0) > 0 AND coalesce(m.connected_calls,0) = 0"); bits.push("dialled by a person, no answer"); }
    if (p.hc === "never")   { w.push("m.total_calls IS NOT NULL AND m.total_calls = 0"); bits.push("never dialled by a person"); }
    if (p.hc === "nodata")  { w.push("m.total_calls IS NULL"); bits.push("no calling data"); }
  }
  if (p.ac && m.table === "csat_map") {
    const D = "m.lead_id IN (SELECT lead_id FROM ai_reach WHERE cohort='CSAT-1')";
    const C = "m.lead_id IN (SELECT lead_id FROM ai_reach WHERE cohort='CSAT-1' AND reached=1)";
    if (p.ac === "dialled") { w.push(D); bits.push("dialled by AI"); }
    if (p.ac === "conn")    { w.push(C); bits.push("AI connected"); }
    if (p.ac === "noconn")  { w.push(`${D} AND NOT (${C})`); bits.push("dialled by AI, no answer"); }
    if (p.ac === "never")   { w.push(`NOT (${D})`); bits.push("never dialled by AI"); }
  }
  // Contact up to and including the test day. Post-test contact cannot explain
  // whether someone sat the test, so it is excluded here on purpose.
  if ((p.pt || p.pta) && m.table === "csat_map") {
    const CUT = "2026-07-31";
    const hTouch = `m.first_call_at IS NOT NULL AND m.first_call_at < '${CUT}'`;
    const hConn  = `m.first_conn_at IS NOT NULL AND m.first_conn_at < '${CUT}'`;
    const aOne = (col: string) =>
      `EXISTS (SELECT 1 FROM ai_reach a WHERE a.cohort='CSAT-1' AND a.lead_id=m.lead_id` +
      ` AND a.${col} IS NOT NULL AND a.${col} < '${CUT}')`;
    const aTouch = aOne("first_call");
    const aConn = aOne("first_conn");
    if (p.pt === "touched") { w.push(hTouch); bits.push("a person touched them by test day"); }
    if (p.pt === "conn")    { w.push(`${hTouch} AND ${hConn}`); bits.push("a person spoke to them by test day"); }
    if (p.pt === "noconn")  { w.push(`${hTouch} AND NOT (${hConn})`); bits.push("dialled by a person, never got through"); }
    if (p.pt === "never")   { w.push(`m.total_calls IS NOT NULL AND NOT (${hTouch})`); bits.push("never dialled by a person before the test"); }
    if (p.pt === "nodata")  { w.push("m.total_calls IS NULL"); bits.push("no calling record"); }
    if (p.pta === "touched") { w.push(aTouch); bits.push("AI dialled them by test day"); }
    if (p.pta === "conn")    { w.push(`${aTouch} AND ${aConn}`); bits.push("AI spoke to them by test day"); }
    if (p.pta === "noconn")  { w.push(`${aTouch} AND NOT (${aConn})`); bits.push("dialled by AI, never got through"); }
    if (p.pta === "never")   { w.push(`NOT (${aTouch})`); bits.push("never dialled by AI before the test"); }
  }
  // Funnel stages for the contact block. Offer letter and seat booked are gated
  // on a panelist response: a CRM outcome on a lead that never went through CSAT
  // counselling is a lead-level result, not a CSAT funnel result.
  if (p.fstage && m.table === "csat_map") {
    const HAS_RESP = "m.lead_id IN (SELECT lead_id FROM csat_outcome)";
    if (p.fstage === "reg")   { w.push(`m.${paid}='paid'`); bits.push("registered"); }
    if (p.fstage === "test")  { w.push("m.test_given='Test_Given'"); bits.push("gave the test"); }
    if (p.fstage === "couns") { w.push("m.lead_id IN (SELECT lead_id FROM csat_outcome WHERE status LIKE 'Happening%')"); bits.push("counselling done"); }
    if (p.fstage === "ol")    { w.push(`${HAS_RESP} AND nullif(m.offer_letter,'') IS NOT NULL`); bits.push("offer letter, panelist verified"); }
    if (p.fstage === "sb")    { w.push(`${HAS_RESP} AND m.seat_booked='Yes'`); bits.push("seat booked, panelist verified"); }
    if (p.fstage === "lead")  bits.push("all leads");
  }
  if (p.pstage && m.table === "csat_map") {
    if (p.pstage === "slot")  { w.push("m.lead_id IN (SELECT lead_id FROM csat_slots)"); bits.push("counselling slot booked"); }
    if (p.pstage === "couns") { w.push("m.lead_id IN (SELECT lead_id FROM csat_outcome WHERE status LIKE 'Happening%')"); bits.push("counselling done"); }
    if (p.pstage === "ol")      { w.push("nullif(m.offer_letter,'') IS NOT NULL AND m.lead_id IN (SELECT lead_id FROM csat_outcome)"); bits.push("offer letter, counselled"); }
    if (p.pstage === "ol_nc")   { w.push("nullif(m.offer_letter,'') IS NOT NULL AND m.lead_id NOT IN (SELECT lead_id FROM csat_outcome)"); bits.push("offer letter, no panelist response"); }
    if (p.pstage === "ol_all")  { w.push("nullif(m.offer_letter,'') IS NOT NULL"); bits.push("offer letter, any"); }
    if (p.pstage === "seat")     { w.push("m.seat_booked = 'Yes' AND m.lead_id IN (SELECT lead_id FROM csat_outcome)"); bits.push("seat booked, counselled"); }
    if (p.pstage === "seat_nc")  { w.push("m.seat_booked = 'Yes' AND m.lead_id NOT IN (SELECT lead_id FROM csat_outcome)"); bits.push("seat booked, no panelist response"); }
    if (p.pstage === "seat_all") { w.push("m.seat_booked = 'Yes'"); bits.push("seat booked, any"); }
  }
  if (p.pstage && m.table === "nsat4_map") {
    if (p.pstage === "test") { w.push("nullif(m.test_result,'') IS NOT NULL"); bits.push("test given"); }
    if (p.pstage === "pass") { w.push("m.test_result = 'Pass'"); bits.push("test passed"); }
    if (p.pstage === "fail") { w.push("m.test_result = 'Fail'"); bits.push("test failed"); }
    if (p.pstage === "slot") { w.push("m.lead_id IN (SELECT lead_id FROM nsat4_slots)"); bits.push("counselling slot booked"); }
    if (p.pstage === "ol")   { w.push("nullif(m.offer_letter,'') IS NOT NULL"); bits.push("offer letter"); }
    if (p.pstage === "seat") { w.push("m.seat_booked = 'Yes'"); bits.push("seat booked"); }
  } else if (p.pstage && m.table !== "csat_map") {
    const inc2 = inClause(ctx, round);
    const S: Record<string, [string, string]> = {
      test:  ["tested=1", "test given"],
      pass:  ["passed=1", "passed"],
      slot:  ["slot=1", "slot booked"],
      couns: ["couns=1", "counselled"],
      ol:    ["ol=1 AND cohort=1", "offer letter"],
      seat:  ["seat=1 AND cohort=1", "seat booked"],
    };
    const hit = S[p.pstage];
    if (hit) {
      w.push(`m.lead_id IN (SELECT k FROM stage_flags WHERE rnd IN (${inc2}) AND ${hit[0]})`);
      bits.push(hit[1]);
    }
  }
  if (p.origin?.length) {
    w.push(`m.origin IN (${p.origin.map((v) => `'${esc(v)}'`).join(",")})`);
    bits.push(p.origin.join(" / "));
  }
  if (p.camp?.length) {
    w.push(`m.utm_campaign IN (${p.camp.map((v) => `'${esc(v)}'`).join(",")})`);
    bits.push(p.camp.join(" / "));
  }
  if (p.q) {
    const t = esc(p.q.trim());
    if (t) {
      w.push(`(m.lead_id LIKE '%${t}%' OR coalesce(m.name,'') LIKE '%${t}%' OR coalesce(m.phone,'') LIKE '%${t}%')`);
      bits.push(`"${p.q.trim()}"`);
    }
  }
  // per-column text filters
  const like = (col: string, v: string | null | undefined, lbl: string) => {
    const t = (v ?? "").trim();
    if (!t) return;
    w.push(`coalesce(m.${col},'') LIKE '%${esc(t)}%'`);
    bits.push(`${lbl} ~ "${t}"`);
  };
  like("lead_id", p.id, "id");
  like("name", p.name, "name");
  like("phone", p.phone, "phone");
  if (p.conn === "1") { w.push("coalesce(m.connected_calls,0)>0"); bits.push("connected"); }
  if (p.conn === "0") { w.push("coalesce(m.connected_calls,0)=0"); bits.push("not connected"); }
  if (p.couns?.length) {
    const parts = p.couns.map((v) =>
      v === "__none__" ? "nullif(m.counsellor,'') IS NULL" : `m.counsellor = '${esc(v)}'`);
    w.push(`(${parts.join(" OR ")})`);
    bits.push(p.couns.map((v) => (v === "__none__" ? "no counsellor" : v)).join(" / "));
  }

  const sql =
    `SELECT m.lead_id, coalesce(m.name,'') name, coalesce(m.phone,'') phone,
            coalesce(nullif(m.crm_source_category,''),'${NO_SRC}') source,
            coalesce(m.utm_campaign,'') campaign,
            coalesce(m.${paid},'') registered,
            coalesce(m.total_calls,0) calls, coalesce(m.connected_calls,0) connected,
            m.first_signup, m.first_call_at, coalesce(m.counsellor,'') counsellor
       FROM ${m.table} m
      WHERE ${w.join(" AND ")}${m.where}
      ORDER BY m.first_signup DESC NULLS LAST${limit > 0 ? ` LIMIT ${limit} OFFSET ${Math.max(0, offset)}` : ""}`;
  let rows: DrillRow[] = [];
  try { rows = db.prepare(sql).all() as DrillRow[]; } catch { rows = []; }
  let total = rows.length;
  try {
    total = int(db.prepare(`SELECT COUNT(*) n FROM ${m.table} m WHERE ${w.join(" AND ")}${m.where}`).get() as any);
  } catch { /* keep rows.length */ }
  return { rows, total, label: bits.length ? bits.join(" · ") : "all leads" };
}

// ---------------------------------------------------------------------------
// Leaks — where we are losing high-intent students right now
// ---------------------------------------------------------------------------
export interface Leak {
  key: string;
  title: string;
  count: number;
  desc: string;
  tone: "bad" | "warn";
}
// Each leak also exists as a students-page filter (lib: leakWhere).
export function leakWhere(key: string, inc: string): string | null {
  const W: Record<string, string> = {
    pass_no_slot: `l.nsat_round IN (${inc}) AND l.lead_id IN (SELECT lead_id FROM test_results WHERE result='pass')
      AND l.lead_id NOT IN (SELECT lead_id FROM counselling_sessions)
      AND l.lead_id NOT IN (SELECT lead_id FROM payments)`,
    slot_no_outcome: `l.nsat_round IN (${inc}) AND l.lead_id IN (SELECT lead_id FROM counselling_sessions
        WHERE scheduled_at IS NOT NULL AND status='scheduled' AND substr(scheduled_at,1,10) < date('now','-${SLA.slotToOutcome} day'))
      AND l.lead_id NOT IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))`,
    held_no_offer: `l.nsat_round IN (${inc}) AND l.lead_id IN (SELECT lead_id FROM counselling_sessions
        WHERE status='held' AND held_at IS NOT NULL AND substr(held_at,1,10) <= date('now','-${SLA.heldToOffer} day'))
      AND l.lead_id NOT IN (SELECT lead_id FROM offer_letters)`,
    offer_expiring: `l.nsat_round IN (${inc}) AND l.lead_id IN (SELECT lead_id FROM offer_letters WHERE issued_at <= date('now','-${SLA.offerToSeat} day'))
      AND l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))
      AND l.lead_id NOT IN (SELECT lead_id FROM payments)`,
    no_show_open: `l.nsat_round IN (${inc}) AND l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('no_show','reschedule'))
      AND l.lead_id NOT IN (SELECT lead_id FROM counselling_sessions WHERE status='held')
      AND l.lead_id NOT IN (SELECT lead_id FROM payments)`,
    csat_unpaid: `l.nsat_round IN (${inc}) AND l.lead_id NOT IN (SELECT lead_id FROM registrations)`,
    csat_unpaid_24h: `l.nsat_round IN (${inc}) AND l.lead_id NOT IN (SELECT lead_id FROM registrations)
      AND l.created_at IS NOT NULL AND l.created_at < datetime('now','-1 day')`,
    untouched_48h: `l.nsat_round IN (${inc}) AND l.lead_id IN (SELECT lead_id FROM test_results WHERE result='pass')
      AND l.lead_id NOT IN (SELECT lead_id FROM payments)
      AND l.lead_id NOT IN (SELECT lead_id FROM call_logs WHERE attempted_at >= datetime('now','-2 day'))
      AND l.lead_id NOT IN (SELECT lead_id FROM counselling_sessions WHERE status='held' AND held_at >= datetime('now','-2 day'))`,
  };
  return W[key] ?? null;
}

export function leaks(ctx: Ctx, round?: string | null): Leak[] {
  const inc = inClause(ctx, round);
  const c = (k: string) => q(`SELECT COUNT(*) n FROM leads l WHERE ${leakWhere(k, inc)}`);
  const defs: [string, string, string, Leak["tone"]][] = [
    ["pass_no_slot", "Passed, no counselling slot", "cleared the test but nobody booked them", "bad"],
    ["slot_no_outcome", "Slot day gone, no outcome", "the slot day passed and the panelist never responded", "warn"],
    ["held_no_offer", `Counselled ${SLA.heldToOffer}+ days, no offer`, "said yes to us, offer still not launched", "bad"],
    ["offer_expiring", `Offer ${SLA.offerToSeat}+ days old, no seat`, "offer window lapsing without a seat", "bad"],
    ["no_show_open", "Missed counselling, not rebooked", "did not attend and nothing booked again yet", "warn"],
    ["untouched_48h", "Passed, nothing done for 48h", "no call, no session, nothing in two days", "bad"],
  ];
  return defs.map(([key, title, desc, tone]) => ({ key, title, desc, tone, count: c(key) }));
}

// ---------------------------------------------------------------------------
// Movers — last 24h deltas (founder's "what happened since yesterday")
// ---------------------------------------------------------------------------
export interface Movers { registrations: number; held: number; offers: number; seats: number; calls: number; }
export function movers(ctx: Ctx, round?: string | null): Movers {
  const inc = inClause(ctx, round);
  return {
    registrations: q(`SELECT COUNT(*) n FROM registrations r JOIN leads l ON l.lead_id=r.lead_id
      WHERE l.nsat_round IN (${inc}) AND r.registered_at >= datetime('now','-1 day')`),
    held: q(`SELECT COUNT(DISTINCT cs.lead_id) n FROM counselling_sessions cs JOIN leads l ON l.lead_id=cs.lead_id
      WHERE l.nsat_round IN (${inc}) AND cs.status='held' AND cs.held_at >= datetime('now','-1 day')`),
    offers: q(`SELECT COUNT(DISTINCT o.lead_id) n FROM offer_letters o JOIN leads l ON l.lead_id=o.lead_id
      WHERE l.nsat_round IN (${inc}) AND o.issued_at >= date('now','-1 day')`),
    seats: q(`SELECT COUNT(DISTINCT p.lead_id) n FROM payments p JOIN leads l ON l.lead_id=p.lead_id
      WHERE l.nsat_round IN (${inc}) AND p.paid_at >= date('now','-1 day')`),
    calls: q(`SELECT COUNT(*) n FROM call_logs c JOIN leads l ON l.lead_id=c.lead_id
      WHERE l.nsat_round IN (${inc}) AND c.channel='human_call' AND c.attempted_at >= datetime('now','-1 day')`),
  };
}

// ---------------------------------------------------------------------------
// The One Minute — computed narrative for the landing page
// ---------------------------------------------------------------------------
export function oneMinute(ctx: Ctx, round?: string | null): string[] {
  const s = stageCounts(ctx, round);
  const m = movers(ctx, round);
  const L = leaks(ctx, round);
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const lines: string[] = [];
  if (ctx === "NSAT") {
    lines.push(
      `${s.pass.toLocaleString("en-IN")} students passed; ${s.held} counselled (${pct(s.held, s.pass)}%), ${s.offers} offers out, ${s.seats} seats closed (${pct(s.seats, s.offers)}% of offers).`
    );
  } else {
    lines.push(
      `${s.leads.toLocaleString("en-IN")} C-SAT leads; ${s.paid} paid registrations (${pct(s.paid, s.leads)}%).`
    );
  }
  lines.push(
    `Last 24h: +${m.held} counselling done, +${m.offers} offers, +${m.seats} seats, ${m.calls.toLocaleString("en-IN")} human calls.`
  );
  const worst = [...L].sort((a, b) => b.count - a.count)[0];
  if (worst && worst.count > 0) lines.push(`Biggest leak right now: ${worst.count} students — ${worst.title.toLowerCase()} (${worst.desc}).`);
  const expiring = L.find((x) => x.key === "offer_expiring");
  if (expiring && expiring.count > 0) lines.push(`${expiring.count} offers are past their ${SLA.offerToSeat}-day window and still unbooked — that is the money on the table today.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Intent score — engagement-weighted, recency-decayed
// ---------------------------------------------------------------------------
export type IntentBucket = "hot" | "warm" | "cooling" | "cold" | "converted" | "closed";
export interface StudentRow {
  lead_id: string; name: string; phone: string; round: string; counsellor: string;
  stage: string; stage_since: string | null; days_in_stage: number | null;
  intent: IntentBucket; score: number; last_touch: string | null; last_touch_ch: string | null;
}

const STAGE_LABEL: Record<string, string> = {
  lead: "Lead", registration: "Registered", test: "Appeared", result: "Result",
  slot_form: "Slot booked", counselling: "Counselled", offer_letter: "Offer letter", seat_payment: "Seat booked",
};

export function students(ctx: Ctx, filter?: string | null, round?: string | null): { rows: StudentRow[]; total: number } {
  const inc = inClause(ctx, round);
  let where = `l.nsat_round IN (${inc})`;
  if (filter) {
    const lw = leakWhere(filter, inc);
    if (lw) where = lw;
    else if (filter === "hot") where += ` AND 1=1`; // bucket filters applied post-score
  }
  const rows = db
    .prepare(
      `SELECT l.lead_id, COALESCE(l.full_name,'') name, COALESCE(l.phone,'') phone, l.nsat_round round,
              COALESCE(NULLIF(TRIM(l.assigned_rep_id),''),'—') counsellor, COALESCE(l.current_stage,'lead') stage,
              (SELECT MAX(attempted_at) FROM call_logs c WHERE c.lead_id=l.lead_id) last_touch,
              (SELECT channel FROM call_logs c WHERE c.lead_id=l.lead_id ORDER BY attempted_at DESC LIMIT 1) last_touch_ch,
              (SELECT 1 FROM test_results t WHERE t.lead_id=l.lead_id AND t.appeared=1) appeared,
              (SELECT 1 FROM test_results t WHERE t.lead_id=l.lead_id AND t.result='pass') pass,
              (SELECT 1 FROM test_results t WHERE t.lead_id=l.lead_id AND t.result='fail') fail,
              (SELECT MIN(substr(scheduled_at,1,10)) FROM counselling_sessions cs WHERE cs.lead_id=l.lead_id AND cs.scheduled_at IS NOT NULL) slot_day,
              (SELECT MAX(held_at) FROM counselling_sessions cs WHERE cs.lead_id=l.lead_id AND cs.status='held') held_at,
              (SELECT 1 FROM counselling_sessions cs WHERE cs.lead_id=l.lead_id AND cs.status IN ('no_show','reschedule')) bounced,
              (SELECT MAX(issued_at) FROM offer_letters o WHERE o.lead_id=l.lead_id) ol_at,
              (SELECT MAX(paid_at) FROM payments p WHERE p.lead_id=l.lead_id) sb_at,
              (SELECT 1 FROM call_logs c WHERE c.lead_id=l.lead_id AND c.channel='human_call' AND c.answered=1) connected,
              (SELECT 1 FROM call_logs c WHERE c.lead_id=l.lead_id AND c.channel='whatsapp' AND c.answered=1) wa_read
       FROM leads l WHERE ${where}`
    )
    .all() as any[];

  const today = new Date();
  const days = (iso: string | null): number | null => {
    if (!iso) return null;
    const d = new Date(String(iso).slice(0, 10));
    if (isNaN(+d)) return null;
    return Math.max(0, Math.floor((+today - +d) / 86400000));
  };

  const out: StudentRow[] = rows.map((r) => {
    let score = 0;
    if (r.appeared) score += 30;
    if (r.pass) score += 15;
    if (r.slot_day) score += 15;
    if (r.held_at) score += 15;
    if (r.connected) score += 10;
    if (r.wa_read) score += 5;
    if (r.ol_at) score += 10;
    if (r.bounced && !r.held_at) score -= 5;
    const lastAct = [r.last_touch, r.held_at, r.ol_at, r.sb_at].filter(Boolean).sort().pop() as string | undefined;
    const idle = days(lastAct ?? null);
    if (idle !== null && idle > 2) score -= Math.min(30, (idle - 2) * 4);
    let intent: IntentBucket;
    if (r.sb_at) intent = "converted";
    else if (r.fail) intent = "closed";
    else if (score >= 70) intent = "hot";
    else if (score >= 45) intent = "warm";
    else if (score >= 25) intent = "cooling";
    else intent = "cold";
    const since = r.sb_at ?? r.ol_at ?? r.held_at ?? r.slot_day ?? null;
    return {
      lead_id: r.lead_id, name: r.name, phone: r.phone, round: r.round, counsellor: r.counsellor,
      stage: STAGE_LABEL[r.stage] ?? r.stage, stage_since: since ? String(since).slice(0, 10) : null,
      days_in_stage: days(since), intent, score: Math.max(0, score),
      last_touch: r.last_touch ? String(r.last_touch).slice(0, 16).replace("T", " ") : null,
      last_touch_ch: r.last_touch_ch,
    };
  });
  let final = out;
  if (filter === "hot") final = out.filter((r) => r.intent === "hot");
  if (filter === "hot_untouched") final = out.filter((r) => r.intent === "hot" && (!r.last_touch || days(r.last_touch) === null || (days(r.last_touch) ?? 9) >= 2));
  const order: Record<string, number> = { hot: 0, warm: 1, cooling: 2, cold: 3, converted: 4, closed: 5 };
  final.sort((a, b) => (order[a.intent] - order[b.intent]) || b.score - a.score);
  return { rows: final, total: final.length };
}

export function intentSummary(ctx: Ctx, round?: string | null): Record<IntentBucket, number> {
  const { rows } = students(ctx, null, round);
  const out: Record<IntentBucket, number> = { hot: 0, warm: 0, cooling: 0, cold: 0, converted: 0, closed: 0 };
  for (const r of rows) out[r.intent]++;
  return out;
}

// ---------------------------------------------------------------------------
// Communication — coverage per stage x channel + day-wise volumes
// ---------------------------------------------------------------------------
export interface CoverageRow { stage: string; total: number; ai: number; human: number; humanConn: number; wa: number; waRead: number; touched72: number; }
export function coverage(ctx: Ctx, round?: string | null): CoverageRow[] {
  const inc = inClause(ctx, round);
  const stages: [string, string][] = [
    ["registration", "Registered"], ["test", "Appeared"], ["result", "Passed"],
    ["slot_form", "Slot booked"], ["counselling", "Counselled"], ["offer_letter", "Offer letter"], ["seat_payment", "Seat booked"],
  ];
  return stages.map(([key, label]) => {
    const base = `FROM leads l WHERE l.nsat_round IN (${inc}) AND l.current_stage='${key}'`;
    const c = (extra: string) => q(`SELECT COUNT(*) n ${base} AND ${extra}`);
    const total = q(`SELECT COUNT(*) n ${base}`);
    return {
      stage: label, total,
      ai: c(`l.lead_id IN (SELECT lead_id FROM call_logs WHERE channel='ai_call' OR channel IS NULL)`),
      human: c(`l.lead_id IN (SELECT lead_id FROM call_logs WHERE channel='human_call')`),
      humanConn: c(`l.lead_id IN (SELECT lead_id FROM call_logs WHERE channel='human_call' AND answered=1)`),
      wa: c(`l.lead_id IN (SELECT lead_id FROM call_logs WHERE channel='whatsapp')`),
      waRead: c(`l.lead_id IN (SELECT lead_id FROM call_logs WHERE channel='whatsapp' AND answered=1)`),
      touched72: c(`l.lead_id IN (SELECT lead_id FROM call_logs WHERE attempted_at >= datetime('now','-3 day'))`),
    };
  });
}

export interface DayVol { day: string; human: number; humanConn: number; wa: number; waRead: number; }
export function commsByDay(ctx: Ctx, round?: string | null): DayVol[] {
  const inc = inClause(ctx, round);
  const rows = db
    .prepare(
      `SELECT substr(c.attempted_at,1,10) day,
              SUM(CASE WHEN c.channel='human_call' THEN 1 ELSE 0 END) human,
              SUM(CASE WHEN c.channel='human_call' AND c.answered=1 THEN 1 ELSE 0 END) humanConn,
              SUM(CASE WHEN c.channel='whatsapp' THEN 1 ELSE 0 END) wa,
              SUM(CASE WHEN c.channel='whatsapp' AND c.answered=1 THEN 1 ELSE 0 END) waRead
       FROM call_logs c JOIN leads l ON l.lead_id=c.lead_id
       WHERE l.nsat_round IN (${inc}) AND c.attempted_at >= date('now','-14 day')
       GROUP BY day ORDER BY day DESC`
    )
    .all() as any[];
  return rows.filter((r) => r.day);
}

// Disposition mining: AI sentiment + before-test outcome buckets.
// TODO: swap in CRM call-notes dispositions when the Redash query lands.
export function dispositions(ctx: Ctx, round?: string | null): { label: string; n: number }[] {
  const inc = inClause(ctx, round);
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(c.sentiment),''),'(none)') label, COUNT(*) n
       FROM call_logs c JOIN leads l ON l.lead_id=c.lead_id
       WHERE l.nsat_round IN (${inc}) AND c.channel='ai_call' GROUP BY label ORDER BY n DESC LIMIT 8`
    )
    .all() as any[];
  return rows;
}

// ---------------------------------------------------------------------------
// Sankey tree — click-to-expand funnel flow. Every "did not progress" node
// splits into Communicated (human call attempted) vs Not communicated, and
// Communicated splits into Connected vs Not connected.
// ---------------------------------------------------------------------------
export interface SNode {
  id: string; label: string; n: number;
  tone: "good" | "bad" | "warn" | "info" | "neutral";
  // drill = query string for /drill. Only set where the box maps EXACTLY onto a
  // map filter; left undefined (not clickable) where it cannot be expressed,
  // rather than linking to a list that would not match the number.
  drill?: string;
  children?: SNode[];
}

export function sankeyTree(ctx: Ctx, round?: string | null): SNode {
  const inc = inClause(ctx, round);
  const ids = (sql: string): Set<string> =>
    new Set((db.prepare(sql).all() as any[]).map((r) => r.lead_id as string));
  const inRound = (t: string, cond = "1=1") =>
    ids(`SELECT DISTINCT x.lead_id lead_id FROM ${t} x JOIN leads l ON l.lead_id=x.lead_id WHERE l.nsat_round IN (${inc}) AND ${cond}`);

  // CSAT lead/registration must come from the same lead_map reconciliation the
  // KPIs and funnel use, or the Sankey disagrees with the cards above it.
  // Safe for CSAT: it has no downstream stage rows, so the id-space differs
  // only where every later set is empty anyway.
  const mu = mapUniverse(ctx, round);
  const useCsatMap = !!mu;
  const all = mu
    ? ids(`SELECT lead_id FROM ${mu.table} WHERE 1=1${mu.where}`)
    : ids(`SELECT lead_id FROM leads WHERE nsat_round IN (${inc})`);
  const reg = mu
    ? ids(`SELECT lead_id FROM ${mu.table} WHERE registered='paid'${mu.where}`)
    : inRound("registrations");
  // NSAT-4 keeps its test outcome, slots, offer and seat on its own tables, not
  // in the base stage tables (which hold no NSAT-4 rows). Without this the Sankey
  // showed Test given 0 while the funnel above it showed 387.
  const isN4 = mu?.table === "nsat4_map";
  const isCsat = mu?.table === "csat_map";
  const fromN4 = (where: string) => ids(`SELECT lead_id FROM nsat4_map WHERE ${where}`);
  const fromCsat = (where: string) => ids(`SELECT lead_id FROM csat_map m WHERE ${where}${mu?.where ?? ""}`);
  const appeared = isN4
    ? fromN4("nullif(test_result,'') IS NOT NULL")
    : isCsat
      ? fromCsat("m.test_given='Test_Given'")
      : inRound("test_results", "x.appeared=1");
  const pass = isN4 ? fromN4("lower(test_result)='pass'") : inRound("test_results", "x.result='pass'");
  const fail = isN4 ? fromN4("lower(test_result)='fail'") : inRound("test_results", "x.result='fail'");
  const slot = isCsat
    ? ids(`SELECT DISTINCT s.lead_id FROM csat_slots s JOIN csat_map m ON m.lead_id=s.lead_id WHERE 1=1${mu?.where ?? ""}`)
    : isN4
    ? ids("SELECT DISTINCT lead_id FROM nsat4_slots")
    : inRound("counselling_sessions", "x.scheduled_at IS NOT NULL");
  // NSAT-4's counselling sheet records the booking, never the attendance, so
  // "held" is genuinely unknown there and must not gate the offer/seat sets.
  const held = isCsat
    ? ids(`SELECT o.lead_id FROM csat_outcome o JOIN csat_map m ON m.lead_id=o.lead_id WHERE o.status LIKE 'Happening%'${mu?.where ?? ""}`)
    : isN4 ? new Set<string>() : inRound("counselling_sessions", "x.status='held'");
  const cohort = isN4 ? all : inRound("counselling_sessions", "x.status IN ('held','no_show','reschedule')");
  const olAll = isN4 ? fromN4("nullif(offer_letter,'') IS NOT NULL") : inRound("offer_letters");
  // OL age buckets (business rule): live = first 3 days, expiring = day 3-4, expired = 5+ days
  const olLive = inRound("offer_letters", "x.issued_at > date('now','-3 day')");
  const olExpiring = inRound("offer_letters", "x.issued_at <= date('now','-3 day') AND x.issued_at > date('now','-5 day')");
  const olExpired = inRound("offer_letters", "x.issued_at <= date('now','-5 day')");
  const seatAll = isN4 ? fromN4("seat_booked='Yes'") : inRound("payments", "x.paid_at >= '2026-07-16'");
  // CSAT calling lives as aggregates on the map (total_calls / connected_calls),
  // not as call_logs rows, so the comms split must read the map for CSAT too.
  const attempted = mu
    ? ids(`SELECT lead_id FROM ${mu.table} WHERE coalesce(total_calls,0) > 0${mu.where}`)
    : inRound("call_logs", "x.channel='human_call'");
  const connected = mu
    ? ids(`SELECT lead_id FROM ${mu.table} WHERE coalesce(connected_calls,0) > 0${mu.where}`)
    : inRound("call_logs", "x.channel='human_call' AND x.answered=1");

  const inter = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)));
  const diff = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => !b.has(x)));
  const union = (a: Set<string>, b: Set<string>) => new Set([...a, ...b]);

  // drillBase: when the comms split IS the map's calling data (CSAT), each child
  // maps onto a map filter, so the boxes can link to the matching student list.
  const comms = (set: Set<string>, id: string, drillBase?: string): SNode[] => {
    const comm = inter(set, attempted);
    const conn = inter(comm, connected);
    const d = (suffix: string) => (useCsatMap && drillBase ? `${drillBase}&${suffix}` : undefined);
    return [
      {
        id: `${id}:comm`, label: "Communicated (human)", n: comm.size, tone: "info", drill: d("act=called"),
        children: [
          { id: `${id}:conn`, label: "Connected", n: conn.size, tone: "good", drill: d("conn=1") },
          { id: `${id}:nopick`, label: "Not connected", n: comm.size - conn.size, tone: "warn", drill: d("act=noconn") },
        ],
      },
      { id: `${id}:nocomm`, label: "Not communicated", n: set.size - comm.size, tone: "bad", drill: d("act=never") },
    ];
  };

  // progressive intersections down the funnel
  const sReg = inter(all, reg);
  const sApp = inter(sReg, appeared);
  const sPass = inter(sApp, pass);
  const sFail = inter(sApp, fail);
  // Some counselling rows are held with no scheduled_at (slot-less form outcomes),
  // so a held student can be missing from the slot set. Being counselled implies a
  // slot in reality, so fold held in — otherwise Slot booked reads less than its
  // own children (242 vs 250 on NSAT-3).
  const slotAny = union(slot, held);
  const sSlot = inter(sPass, slotAny);
  const sHeld = inter(sSlot.size ? new Set([...sPass]) : sPass, held); // held may include slot-less form outcomes
  const sOl = isN4 ? inter(all, olAll) : inter(sHeld.size ? inter(sPass, cohort) : cohort, olAll);
  const sSeat = isN4 ? inter(all, seatAll) : inter(sOl.size ? sOl : cohort, seatAll);

  const node = (id: string, label: string, n: number, tone: SNode["tone"], children?: SNode[], drill?: string): SNode =>
    ({ id, label, n, tone, ...(drill ? { drill } : {}), ...(children && children.length ? { children } : {}) });

  const seatNode = node("seat", "Seat booked", sSeat.size, "good");
  // Counselled splits by the offer's life: booked, live (day 0-2), expiring
  // (day 3-4), expired (5+ days), or no offer at all.
  const olOpen = diff(sOl, seatAll);
  const bLive = inter(olOpen, olLive);
  const bExpiring = inter(olOpen, olExpiring);
  const bExpired = inter(olOpen, olExpired);
  const heldNode = node("held", "Counselled", sHeld.size, "good", [
    seatNode,
    node("ol_live", "Offer live", bLive.size, "good", comms(bLive, "ol_live")),
    node("ol_expiring", "Offer expiring", bExpiring.size, "warn", comms(bExpiring, "ol_expiring")),
    node("ol_expired", "Offer expired", bExpired.size, "bad", comms(bExpired, "ol_expired")),
    node("held_no_ol", "No offer yet", sHeld.size - sOl.size, "bad", comms(diff(sHeld, olAll), "held_no_ol")),
  ]);
  // A Sankey box must contain its children exactly. For NSAT-4 that rules out
  // hanging Counselled / Offer / Seat off the pass chain: attendance is never
  // recorded, and the offers and seats there did not pass the test or book a
  // slot. So NSAT-4's flow terminates at Slot booked, split by calling reach;
  // the funnel above the diagram carries its offer and seat counts.
  const slotNode = isN4
    ? node("slot", "Slot booked", sSlot.size, "good", comms(sSlot, "slot"))
    : node("slot", "Slot booked", sSlot.size, "good", [
        heldNode,
        // count the actual set (slot booked, not held), not sSlot - sHeld: sHeld is
        // derived from sPass and can include leads with no slot, which made the box
        // read 80 while its own children summed to 88.
        node("slot_no_held", "Counselling pending", diff(sSlot, held).size, "warn", comms(diff(sSlot, held), "slot_no_held")),
      ]);
  const passNode = node("pass", "Passed", sPass.size, "good", [
    slotNode,
    node("pass_no_slot", "No slot booked", diff(sPass, slotAny).size, "bad", comms(diff(sPass, slotAny), "pass_no_slot")),
  ]);
  const sPending = diff(diff(sApp, pass), fail);
  // CSAT-1 records only whether the student gave the test, no pass/fail, so its test
  // node splits on slot booked rather than on result. Offers and seats are NOT nested
  // under it: only 4 of 15 offer letters gave the test and only 3 booked a slot, so
  // hanging them here would draw a progression that did not happen. The funnel above
  // the diagram carries those counts.
  const csatSlot = inter(sApp, slotAny);
  const csatHeld = inter(csatSlot, held);
  const testNodeCsat = node("test", "Test given", sApp.size, "good", [
    node("slot", "Slot booked", csatSlot.size, "good", [
      node("held", "Counselling done", csatHeld.size, "good", comms(csatHeld, "csat_held")),
      node("slot_pending", "Counselling pending", diff(csatSlot, held).size, "warn", comms(diff(csatSlot, held), "csat_slot_pending")),
    ]),
    node("no_slot", "No slot booked", diff(sApp, slotAny).size, "bad", comms(diff(sApp, slotAny), "csat_no_slot")),
  ]);
  // Slot bookers who never gave the test: 1 today. Without this branch they vanish
  // from the diagram and Slot booked reads one less than the funnel.
  const noTest = diff(sReg, appeared);
  const noTestSlot = inter(noTest, slotAny);
  const noTestChildren = noTestSlot.size > 0
    ? [
        node("nt_slot", "Slot booked anyway", noTestSlot.size, "warn", comms(noTestSlot, "csat_nt_slot")),
        node("nt_no_slot", "No slot booked", diff(noTest, slotAny).size, "bad", comms(diff(noTest, slotAny), "csat_nt_no_slot")),
      ]
    : comms(noTest, "reg_no_test", "reg=paid");
  const testNode = node("test", "Test given", sApp.size, "good", [
    passNode,
    node("fail", "Failed", sFail.size, "warn", comms(sFail, "fail")),
    // sat the test but no result row yet, so the box still contains its children
    ...(sPending.size > 0
      ? [node("result_pending", "Result pending", sPending.size, "warn", comms(sPending, "result_pending"))]
      : []),
  ]);
  const regNode = node("reg", "Registered", sReg.size, "good", [
    isCsat ? testNodeCsat : testNode,
    node(
      "reg_no_test", "Did not give test", sReg.size - sApp.size, "bad",
      isCsat ? noTestChildren : comms(diff(sReg, appeared), "reg_no_test", "reg=paid"),
    ),
  ], useCsatMap ? "reg=paid" : undefined);
  return node("lead", "Leads", all.size, "neutral", [
    regNode,
    node("no_reg", "Not registered", all.size - sReg.size, "bad", comms(diff(all, reg), "no_reg", "reg=unpaid"), useCsatMap ? "reg=unpaid" : undefined),
  ], useCsatMap ? "stage=lead" : undefined);
}
