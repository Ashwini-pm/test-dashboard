import db from "./db";

export type Round =
  | "NSAT-2" | "NSAT-3" | "NSAT-4" | "NSAT-5" | "Combined"
  | "CSAT" | "CSAT-BBA" | "CSAT-BCA" | "CSAT-COMB";
export const ROUNDS: Round[] = ["NSAT-2", "NSAT-3", "NSAT-4", "NSAT-5", "Combined"];
// CSAT section sub-programs (All = the three together).
export const CSAT_ROUNDS: { key: Round; label: string }[] = [
  { key: "CSAT", label: "All" },
  { key: "CSAT-BBA", label: "BBA" },
  { key: "CSAT-BCA", label: "BCA" },
  { key: "CSAT-COMB", label: "Combined" },
];

export function normalizeRound(v: string | undefined | null): Round {
  if (v === "NSAT-3") return "NSAT-3";
  if (v === "NSAT-4") return "NSAT-4";
  if (v === "NSAT-5") return "NSAT-5";
  if (v === "CSAT" || v === "CSAT-BBA" || v === "CSAT-BCA" || v === "CSAT-COMB") return v;
  if (v === "Combined") return "Combined";
  return "NSAT-2";
}

// Which nsat_round values a selected Round covers. Values are a fixed enum, so
// interpolating them into SQL is safe (never user free-text).
function roundList(round: Round): string[] {
  if (round === "NSAT-2") return ["NSAT-2"];
  if (round === "NSAT-3") return ["NSAT-3"];
  if (round === "NSAT-4") return ["NSAT-4"];
  if (round === "NSAT-5") return ["NSAT-5"];
  if (round === "CSAT") return ["CSAT-BBA", "CSAT-BCA", "CSAT-COMB"];
  if (round === "CSAT-BBA" || round === "CSAT-BCA" || round === "CSAT-COMB") return [round];
  return ["NSAT-2", "NSAT-3", "NSAT-4", "NSAT-5"];
}
function inClause(round: Round): string {
  return roundList(round)
    .map((r) => `'${r}'`)
    .join(",");
}

// CSAT source filter: utm_source lands in leads.source ("Influencers" / "organic" / null).
export type Src = "organic" | "influencer" | null;
export function parseSrc(v: string | undefined | null): Src {
  return v === "organic" || v === "influencer" ? v : null;
}
function srcClause(src?: Src): string {
  if (src === "influencer") return " AND lower(coalesce(l.source,'')) LIKE 'influencer%'";
  if (src === "organic") return " AND lower(coalesce(l.source,'')) NOT LIKE 'influencer%'";
  return "";
}

// Accepts a raw number OR a better-sqlite3 row object ({ n: 5814 } etc) and
// returns the numeric scalar. get() returns a row object, so unwrap it here.
const int = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    const first = Object.values(v as Record<string, unknown>)[0];
    return Number(first ?? 0);
  }
  return Number(v ?? 0);
};

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------
export interface Kpi {
  label: string;
  value: number;
  sub: string;
  tint: "info" | "warning" | "error" | "success";
  icon: "users" | "phone" | "check" | "alert" | "cap" | "test";
  tone?: "up" | "down" | "warn";
}

export function kpis(round: Round): Kpi[] {
  if (round === "NSAT-3") {
    const called = int(
      db.prepare("SELECT COUNT(DISTINCT lead_id) n FROM call_logs WHERE nsat_round='NSAT-3'").get() as any
    );
    const connected = int(
      db
        .prepare(
          "SELECT COUNT(DISTINCT lead_id) n FROM call_logs WHERE nsat_round='NSAT-3' AND answered=1"
        )
        .get() as any
    );
    const attending = int(
      db
        .prepare(
          "SELECT COUNT(DISTINCT lead_id) n FROM call_outcomes WHERE nsat_round='NSAT-3' AND attending=1"
        )
        .get() as any
    );
    const attendingCreds = int(
      db
        .prepare(
          "SELECT COUNT(DISTINCT lead_id) n FROM call_outcomes WHERE nsat_round='NSAT-3' AND attending=1 AND creds_received=1"
        )
        .get() as any
    );
    const noCreds = int(
      db
        .prepare(
          "SELECT COUNT(*) n FROM leads WHERE nsat_round='NSAT-3' AND login_creds_received=0"
        )
        .get() as any
    );
    const neverReached = called - connected;
    return [
      {
        label: "Leads called by AI",
        value: called,
        sub: `distinct students, 3 waves, before test`,
        tint: "info",
        icon: "users",
      },
      {
        label: `Leads connected (${pct(connected, called)}%)`,
        value: connected,
        sub: `picked up at least once`,
        tint: "success",
        icon: "phone",
        tone: "up",
      },
      {
        label: `Attending confirmed (${pct(attending, called)}%)`,
        value: attending,
        sub: `${attendingCreds} also have login creds`,
        tint: "warning",
        icon: "check",
        tone: "warn",
      },
      {
        label: `Never reached (${pct(neverReached, called)}%)`,
        value: neverReached,
        sub: `+${noCreds} got no login creds`,
        tint: "error",
        icon: "alert",
        tone: "down",
      },
    ];
  }

  // NSAT-2 and Combined: full-funnel KPIs.
  const inc = inClause(round);
  const leads = int(db.prepare(`SELECT COUNT(*) n FROM leads WHERE nsat_round IN (${inc})`).get() as any);
  const reg = int(
    db.prepare(`SELECT COUNT(*) n FROM registrations WHERE nsat_round IN (${inc})`).get() as any
  );
  const appeared = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM test_results tr JOIN leads l ON l.lead_id=tr.lead_id WHERE l.nsat_round IN (${inc}) AND tr.appeared=1`
      )
      .get() as any
  );
  const passed = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM test_results tr JOIN leads l ON l.lead_id=tr.lead_id WHERE l.nsat_round IN (${inc}) AND tr.result='pass'`
      )
      .get() as any
  );
  const couns = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM counselling_sessions cs JOIN leads l ON l.lead_id=cs.lead_id WHERE l.nsat_round IN (${inc})`
      )
      .get() as any
  );
  return [
    {
      label: "Total Leads",
      value: leads,
      sub: round === "Combined" ? "NSAT-2 + NSAT-3 cohorts" : "NSAT-2 cohort",
      tint: "info",
      icon: "users",
    },
    {
      label: `Registrations (${pct(reg, leads)}%)`,
      value: reg,
      sub: "paid registrations",
      tint: "success",
      icon: "check",
      tone: "up",
    },
    {
      label: `Test Appeared (${pct(appeared, leads)}%)`,
      value: appeared,
      sub: `${passed.toLocaleString("en-IN")} passed`,
      tint: "warning",
      icon: "test",
      tone: "warn",
    },
    {
      label: `Counselling (${pct(couns, leads)}%)`,
      value: couns,
      sub: "sessions held",
      tint: "error",
      icon: "cap",
      tone: "down",
    },
  ];
}

function pct(part: number, whole: number): string {
  if (!whole) return "0";
  return ((part / whole) * 100).toFixed(1);
}

// ---------------------------------------------------------------------------
// 9-stage canonical funnel
// ---------------------------------------------------------------------------
export interface FunnelRow {
  key: string;
  label: string;
  count: number | null; // null => no data / awaiting feed
  pct: number | null; // vs base
  drop: number | null; // decline vs previous data-bearing stage, in pct points
  note?: string; // dashed-row caption when no data
  sub?: boolean; // indented sub-step of the stage above
  expandable?: boolean; // row has a chevron that reveals its detail rows
  detail?: boolean; // hidden until the parent expandable row is opened
}

const CANON: { key: string; label: string }[] = [
  { key: "lead", label: "Lead" },
  { key: "registration", label: "Registration" },
  { key: "before_test", label: "Before Test" },
  { key: "test", label: "Test" },
  { key: "result", label: "Result" },
  { key: "slot_form", label: "Slot Form" },
  { key: "counselling", label: "Counselling" },
  { key: "offer_letter", label: "Offer Letter" },
  { key: "seat_payment", label: "Seat Payment" },
];

export type Activation = {
  total: number;
  called: number;
  untouched: number;
  regTotal: number;
  regCalled: number;
  regUntouched: number;
};

// A lead is "called" if it has a human call summary with attempts, or its phone
// matches any number that appears in the call logs (AI campaign).
export function activation(round: Round): Activation {
  const inc = inClause(round);
  const calledPhones =
    "SELECT DISTINCT l2.phone10 FROM leads l2 JOIN call_logs c ON c.lead_id=l2.lead_id WHERE l2.phone10 IS NOT NULL";
  const calledExpr =
    `(l.lead_id IN (SELECT lead_id FROM lead_call_summary WHERE total_attempts>0) ` +
    `OR (l.phone10 IS NOT NULL AND l.phone10 IN (${calledPhones})))`;
  const one = (where: string) =>
    int(db.prepare(`SELECT COUNT(*) n FROM leads l WHERE l.nsat_round IN (${inc}) AND ${where}`).get() as any);
  const total = int(db.prepare(`SELECT COUNT(*) n FROM leads l WHERE l.nsat_round IN (${inc})`).get() as any);
  const called = one(calledExpr);
  const regTotal = one("l.lead_id IN (SELECT lead_id FROM registrations)");
  const regCalled = one(`l.lead_id IN (SELECT lead_id FROM registrations) AND ${calledExpr}`);
  return {
    total,
    called,
    untouched: total - called,
    regTotal,
    regCalled,
    regUntouched: regTotal - regCalled,
  };
}

export type CoverageRow = {
  leadId: string;
  name: string | null;
  phone: string | null;
  stage: string | null;
  called: number;
  attempts: number | null;
};

export function callCoverage(
  round: Round,
  limit = 500
): { rows: CoverageRow[]; total: number; called: number } {
  const inc = inClause(round);
  const calledPhones =
    "SELECT DISTINCT l2.phone10 FROM leads l2 JOIN call_logs c ON c.lead_id=l2.lead_id WHERE l2.phone10 IS NOT NULL";
  const calledExpr =
    `(l.lead_id IN (SELECT lead_id FROM lead_call_summary WHERE total_attempts>0) ` +
    `OR (l.phone10 IS NOT NULL AND l.phone10 IN (${calledPhones})))`;
  const rows = db
    .prepare(
      `SELECT l.lead_id leadId, l.full_name name, l.phone phone, l.current_stage stage,
              CASE WHEN ${calledExpr} THEN 1 ELSE 0 END called,
              (SELECT SUM(total_attempts) FROM lead_call_summary s WHERE s.lead_id=l.lead_id) attempts
       FROM leads l WHERE l.nsat_round IN (${inc})
       ORDER BY called ASC,
                (l.lead_id IN (SELECT lead_id FROM registrations)) DESC,
                l.full_name
       LIMIT ${limit}`
    )
    .all() as CoverageRow[];
  const total = int(db.prepare(`SELECT COUNT(*) n FROM leads l WHERE l.nsat_round IN (${inc})`).get() as any);
  const called = int(
    db.prepare(`SELECT COUNT(*) n FROM leads l WHERE l.nsat_round IN (${inc}) AND ${calledExpr}`).get() as any
  );
  return { rows, total, called };
}

export type StageKpi = {
  key: string;
  label: string;
  achieved: number;
  target: number | null;
  pct: number | null;
  band: "good" | "warn" | "low" | "bad" | "none";
  sub: string | null; // extra small numbers inside the tile (e.g. pass/fail)
};

// The 5 funnel-stage KPIs, achieved vs target (target from stage_targets, may be null).
// Test = who actually took the exam (has a result); pass/fail shown as sub-numbers.
// NSAT-3 / CSAT "better data" overrides: our reconciliation mappings live in
// in-memory nsat3_map (NSAT-3) and csat_map (CSAT = the lead_map reconciliation).
function nsat3MapReady(): boolean {
  try {
    if (!int(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='nsat3_map'").get() as any)) return false;
    return int(db.prepare("SELECT COUNT(*) n FROM nsat3_map").get() as any) > 0;
  } catch { return false; }
}
function n5MapReady(): boolean {
  try {
    if (!int(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='cohort_nsat5'").get() as any)) return false;
    return int(db.prepare("SELECT COUNT(*) n FROM cohort_nsat5").get() as any) > 0;
  } catch { return false; }
}
function n4MapReady(): boolean {
  try {
    if (!int(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='nsat4_map'").get() as any)) return false;
    return int(db.prepare("SELECT COUNT(*) n FROM nsat4_map").get() as any) > 0;
  } catch { return false; }
}
function csatMapReady(): boolean {
  try {
    if (!int(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='csat_map'").get() as any)) return false;
    return int(db.prepare("SELECT COUNT(*) n FROM csat_map").get() as any) > 0;
  } catch { return false; }
}
const CSAT_ROUND_SET = new Set<Round>(["CSAT", "CSAT-BBA", "CSAT-BCA", "CSAT-COMB"]);
// round is a fixed enum value (never user free-text) so interpolation is safe.
const csatMapWhere = (round: Round, paidOnly: boolean): string => {
  const parts: string[] = [];
  if (round !== "CSAT") parts.push(`round_tag='${round}'`);
  if (paidOnly) parts.push(`registered='paid'`);
  return parts.length ? " WHERE " + parts.join(" AND ") : "";
};

export function stageKpis(round: Round, src?: Src): StageKpi[] {
  const inc = inClause(round);
  const S = srcClause(src);
  const c = (sql: string) => int(db.prepare(sql).get() as any);
  const jl = (extra: string) =>
    `JOIN leads l ON l.lead_id=x.lead_id WHERE l.nsat_round IN (${inc})${S}${extra}`;
  const passed = c(`SELECT COUNT(*) n FROM test_results x ${jl(" AND x.result='pass'")}`);
  const failed = c(`SELECT COUNT(*) n FROM test_results x ${jl(" AND x.result='fail'")}`);
  const achieved: Record<string, number> = {
    registration: (round === "NSAT-5" && !src && n5MapReady())
      ? c(`SELECT COUNT(*) n FROM cohort_nsat5 WHERE registered='paid'`)
      : (round === "NSAT-4" && !src && n4MapReady())
      ? c(`SELECT COUNT(*) n FROM nsat4_map WHERE registered='paid'`)
      : (round === "NSAT-3" && !src && nsat3MapReady())
      ? c(`SELECT COUNT(*) n FROM nsat3_map WHERE reg_status='paid'`)
      : (CSAT_ROUND_SET.has(round) && !src && csatMapReady())
      ? c(`SELECT COUNT(*) n FROM csat_map${csatMapWhere(round, true)}`)
      : c(`SELECT COUNT(DISTINCT x.lead_id) n FROM registrations x ${jl("")}`),
    test: c(`SELECT COUNT(*) n FROM test_results x ${jl(" AND x.appeared=1")}`),
    // Same definitions as the funnel: counselling = sessions held; offers =
    // NSAT-flow only (passed + post-test); seats = NSAT-flow only (the 45
    // SB_Status students are pre-booked re-testers, shown on the Test card).
    counselling: c(`SELECT COUNT(DISTINCT x.lead_id) n FROM counselling_sessions x ${jl(" AND x.status='held'")}`),
    offer_letter: c(`SELECT COUNT(*) n FROM offer_letters x ${jl(" AND x.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))")}`),
    seat_payment: c(`SELECT COUNT(*) n FROM payments x ${jl(" AND x.paid_at >= '2026-07-16' AND x.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))")}`),
  };
  const subs: Record<string, string | null> = {
    test: passed + failed > 0 ? `${passed} pass · ${failed} fail` : null,
  };
  const labels: [string, string][] = [
    ["registration", "Registration"],
    ["test", "Test"],
    ["counselling", "Counselling"],
    ["offer_letter", "Offer Letter"],
    ["seat_payment", "Seat Booking"],
  ];
  const band = (p: number | null): StageKpi["band"] => {
    if (p === null) return "none";
    if (p >= 90) return "good";
    if (p >= 50) return "warn";
    if (p >= 20) return "low";
    return "bad";
  };
  return labels.map(([key, label]) => {
    const t = db
      .prepare(`SELECT SUM(target) t FROM stage_targets WHERE nsat_round IN (${inc}) AND stage_key=?`)
      .get(key) as any;
    const target = t && t.t != null ? Number(t.t) : null;
    const a = achieved[key] ?? 0;
    const pct = target && target > 0 ? Math.round((a / target) * 1000) / 10 : null;
    return { key, label, achieved: a, target, pct, band: band(pct), sub: subs[key] ?? null };
  });
}

// ---------------------------------------------------------------------------
// Alerts board ("Red flags"): DERIVED, not hand-labelled. Severity comes from a
// pipeline over the same per-stage metrics as the Stage Breakdown (block 3):
//
//   1. FACTS     - each stage's `bad`-tone tiles (SQL-counted, see STAGE_BREAKDOWN)
//   2. FRONTIER  - deepest funnel stage with real activity (data-detected)
//   3. DISTANCE  - stage position vs the frontier (0 = at it, +1 = next, <0 = behind)
//   4. RECOVERY  - can the miss still be fixed? (slot not booked: yes; failed test: no)
//   5. MATRIX    - distance x recovery -> critical / serious / warning / info
//
// Nothing is hardcoded per rule: as the funnel advances (offers start rolling),
// the frontier moves and every flag re-scores itself on the next data hydrate.
// ---------------------------------------------------------------------------
export type Severity = "critical" | "serious" | "warning" | "info";
export type AlertCard = {
  key: string;
  severity: Severity;
  title: string;
  action: string;
  count: number | null; // null => feed not available yet
  stage?: string; // optional stage for the drill-down link
  stageKey: string; // funnel stage the flag belongs to (heatmap Y axis)
};

// Funnel stages that carry alertable metrics, in canonical order.
const FUNNEL_ORDER = ["registration", "test", "counselling", "offer_letter", "seat_payment"] as const;

// ACTIVE BAND: every stage with real activity in the last window is LIVE at
// once (counselling slots being booked while offers roll and seats close).
// Detected from the data's own timestamps; stages whose feeds carry no dates
// (frozen registration/test) fall out of the band naturally.
const ACTIVE_WINDOW_DAYS = 7;

export function activeStages(round: Round): string[] {
  const inc = inClause(round);
  const latest: Record<string, string> = {
    registration: `SELECT MAX(registered_at) d FROM registrations WHERE nsat_round IN (${inc})`,
    test: `SELECT MAX(t.test_at) d FROM test_results t JOIN leads l ON l.lead_id=t.lead_id WHERE l.nsat_round IN (${inc})`,
    counselling: `SELECT MAX(c.scheduled_at) d FROM counselling_sessions c JOIN leads l ON l.lead_id=c.lead_id WHERE l.nsat_round IN (${inc})`,
    offer_letter: `SELECT MAX(o.issued_at) d FROM offer_letters o JOIN leads l ON l.lead_id=o.lead_id WHERE l.nsat_round IN (${inc}) AND o.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))`,
    seat_payment: `SELECT MAX(p.paid_at) d FROM payments p JOIN leads l ON l.lead_id=p.lead_id WHERE l.nsat_round IN (${inc}) AND p.paid_at >= '2026-07-16'`,
  };
  const band: string[] = [];
  for (const s of FUNNEL_ORDER) {
    const v = (db.prepare(latest[s]).get() as { d: string | null } | undefined)?.d;
    if (v && Math.abs(Date.now() - Date.parse(v)) < ACTIVE_WINDOW_DAYS * 86400_000) band.push(s);
  }
  if (band.length > 0) return band;
  // Fallback (no dated activity anywhere): deepest stage with rows.
  for (let i = FUNNEL_ORDER.length - 1; i >= 0; i--) {
    const s = FUNNEL_ORDER[i];
    const n = int(db.prepare(latest[s].replace(/MAX\([^)]+\) d/, "COUNT(*) n")).get() as any);
    if (n > 0) return [s];
  }
  return [FUNNEL_ORDER[0]];
}

// MATRIX: position vs the active band x recoverability -> severity.
function severityFor(stage: string, band: string[], recoverable: boolean): Severity {
  const idx = FUNNEL_ORDER.indexOf(stage as (typeof FUNNEL_ORDER)[number]);
  const last = FUNNEL_ORDER.indexOf(band[band.length - 1] as (typeof FUNNEL_ORDER)[number]);
  if (band.includes(stage)) return "critical"; // the miss is where work is happening right now
  if (idx > last) return idx - last === 1 ? "serious" : "warning"; // ahead: next up, or further out
  return recoverable ? "warning" : "info"; // behind the band: fixable -> warning, ship sailed -> info
}

const SEV_RANK: Record<Severity, number> = { critical: 0, serious: 1, warning: 2, info: 3 };

export function alerts(round: Round): AlertCard[] {
  const inc = inClause(round);
  const band = activeStages(round);
  const cards: AlertCard[] = [];
  for (const g of STAGE_BREAKDOWN) {
    for (const t of g.tiles) {
      if (t.tone !== "bad") continue;
      let count: number | null = null;
      if (t.where) {
        count = int(
          db.prepare(`SELECT COUNT(*) n FROM leads l WHERE l.nsat_round IN (${inc}) AND ${t.where}`).get() as any
        );
      }
      cards.push({
        key: `${g.stage}_${t.key}`,
        severity: severityFor(g.stage, band, t.recoverable !== false),
        title: t.alertTitle ?? `${g.label}: ${t.label}`,
        action: t.action ?? "Review with owner",
        count,
        stage: t.stageLink ?? g.stage,
        stageKey: g.stage,
      });
    }
  }
  return cards.sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (b.count ?? -1) - (a.count ?? -1)
  );
}

export function funnel(round: Round, src?: Src): { base: number; rows: FunnelRow[] } {
  // NSAT-4 and CSAT use the same real-stage funnel layout as NSAT-3; only
  // NSAT-2/Combined keep the legacy canonical-stages view.
  if (round === "NSAT-3" || round === "NSAT-4" || round === "NSAT-5" || round.startsWith("CSAT")) return funnelN3(round, src);
  return funnelN2(round);
}

function funnelN2(round: Round): { base: number; rows: FunnelRow[] } {
  const inc = inClause(round);
  const leads = int(db.prepare(`SELECT COUNT(*) n FROM leads WHERE nsat_round IN (${inc})`).get() as any);
  const reg = int(
    db.prepare(`SELECT COUNT(*) n FROM registrations WHERE nsat_round IN (${inc})`).get() as any
  );
  const appeared = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM test_results tr JOIN leads l ON l.lead_id=tr.lead_id WHERE l.nsat_round IN (${inc}) AND tr.appeared=1`
      )
      .get() as any
  );
  const passed = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM test_results tr JOIN leads l ON l.lead_id=tr.lead_id WHERE l.nsat_round IN (${inc}) AND tr.result='pass'`
      )
      .get() as any
  );
  const failed = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM test_results tr JOIN leads l ON l.lead_id=tr.lead_id WHERE l.nsat_round IN (${inc}) AND tr.result='fail'`
      )
      .get() as any
  );
  const couns = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM counselling_sessions cs JOIN leads l ON l.lead_id=cs.lead_id WHERE l.nsat_round IN (${inc})`
      )
      .get() as any
  );
  const offers = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM offer_letters o JOIN leads l ON l.lead_id=o.lead_id WHERE l.nsat_round IN (${inc})`
      )
      .get() as any
  );
  const seats = int(
    db
      .prepare(
        `SELECT COUNT(*) n FROM payments p JOIN leads l ON l.lead_id=p.lead_id WHERE l.nsat_round IN (${inc})`
      )
      .get() as any
  );

  const base = leads || 1;
  const data: Record<string, { count: number; note?: string }> = {
    lead: { count: leads },
    registration: { count: reg },
    test: { count: appeared },
    result: { count: passed, note: `${passed.toLocaleString("en-IN")} pass / ${failed} fail` },
    counselling: { count: couns },
    offer_letter: { count: offers },
    seat_payment: { count: seats },
  };

  const rows: FunnelRow[] = [];
  let prevPct: number | null = null;
  for (const c of CANON) {
    const d = data[c.key];
    if (d) {
      const p = (d.count / base) * 100;
      rows.push({
        key: c.key,
        label: c.key === "result" ? "Result: Pass" : c.label,
        count: d.count,
        pct: p,
        drop: prevPct === null ? null : p - prevPct,
        note: d.note,
      });
      prevPct = p;
    } else {
      rows.push({
        key: c.key,
        label: c.label,
        count: null,
        pct: null,
        drop: null,
        note: "no data / awaiting feed",
      });
    }
  }
  return { base, rows };
}

function funnelN3(round: Round = "NSAT-3", src?: Src): { base: number; rows: FunnelRow[] } {
  const inc = inClause(round);
  const S = srcClause(src);
  const c = (sql: string) => int(db.prepare(sql).get() as any);
  const jl = (extra: string) =>
    `JOIN leads l ON l.lead_id=x.lead_id WHERE l.nsat_round IN (${inc})${S}${extra}`;
  // Real LOVABLE-sourced funnel. NSAT-3 Lead + Registration come from our
  // reconciliation mapping (nsat3_map) when present; all other stages unchanged.
  const useNsat3 = round === "NSAT-3" && !src && nsat3MapReady();
  const useCsat = CSAT_ROUND_SET.has(round) && !src && csatMapReady();
  const useN4 = round === "NSAT-4" && !src && n4MapReady();
  const useN5 = round === "NSAT-5" && !src && n5MapReady();
  const leads = useN5
    ? c(`SELECT COUNT(*) n FROM cohort_nsat5`)
    : useN4
    ? c(`SELECT COUNT(*) n FROM nsat4_map`)
    : useNsat3
    ? c(`SELECT COUNT(*) n FROM nsat3_map`)
    : useCsat
    ? c(`SELECT COUNT(*) n FROM csat_map${csatMapWhere(round, false)}`)
    : c(`SELECT COUNT(*) n FROM leads l WHERE l.nsat_round IN (${inc})${S}`);
  const reg = useN5
    ? c(`SELECT COUNT(*) n FROM cohort_nsat5 WHERE registered='paid'`)
    : useN4
    ? c(`SELECT COUNT(*) n FROM nsat4_map WHERE registered='paid'`)
    : useNsat3
    ? c(`SELECT COUNT(*) n FROM nsat3_map WHERE reg_status='paid'`)
    : useCsat
    ? c(`SELECT COUNT(*) n FROM csat_map${csatMapWhere(round, true)}`)
    : c(`SELECT COUNT(DISTINCT x.lead_id) n FROM registrations x ${jl("")}`);
  const appeared = c(`SELECT COUNT(*) n FROM test_results x ${jl(" AND x.appeared=1")}`);
  const passed = c(`SELECT COUNT(*) n FROM test_results x ${jl(" AND x.result='pass'")}`);
  const failed = c(`SELECT COUNT(*) n FROM test_results x ${jl(" AND x.result='fail'")}`);
  const couns = c(`SELECT COUNT(*) n FROM counselling_sessions x ${jl(" AND x.scheduled_at IS NOT NULL")}`); // slots booked (day tabs)
  const held = c(`SELECT COUNT(DISTINCT x.lead_id) n FROM counselling_sessions x ${jl(" AND x.status='held'")}`); // counselling actually done
  // NSAT-flow offers only: CRM also holds direct-admission offers (never tested)
  const offers = c(`SELECT COUNT(*) n FROM offer_letters x ${jl(" AND x.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))")}`);
  // Seat = counselled (held) students who booked; pre-booked re-testers live on the Test card
  const seats = c(`SELECT COUNT(*) n FROM payments x ${jl(" AND x.paid_at >= '2026-07-16' AND x.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule'))")}`);
  // AI before-test calling (context sub-block)
  const called = c(`SELECT COUNT(DISTINCT lead_id) n FROM call_logs WHERE nsat_round IN (${inc})`);
  const connected = c(`SELECT COUNT(DISTINCT lead_id) n FROM call_logs WHERE nsat_round IN (${inc}) AND answered=1`);
  const attending = c(`SELECT COUNT(DISTINCT lead_id) n FROM call_outcomes WHERE nsat_round IN (${inc}) AND attending=1`);

  const base = leads || 1;
  const pb = (n: number) => (n / base) * 100;
  const pc = (n: number) => (called ? (n / called) * 100 : 0);
  const rows: FunnelRow[] = [];
  let prev: number | null = null;
  const main = (key: string, label: string, count: number, note: string, resultNote?: string) => {
    if (count > 0) {
      const pct = pb(count);
      rows.push({ key, label, count, pct, drop: prev === null ? null : pct - prev, note: resultNote });
      prev = pct;
    } else {
      rows.push({ key, label, count: null, pct: null, drop: null, note });
    }
  };
  main("lead", "Lead", leads, "no lead-source feed");
  // Combined sells BBA and BCA together, so the round itself has no program.
  // The Combined page DOES capture the student's choice, so split on that
  // (signup_programs). Leads with no signup are crm_only attribution rows.
  // Program bifurcation on Lead and Registration, for EVERY CSAT tab. The round
  // pills select a landing page (signup_tables); program is a separate dimension,
  // so All and Combined are genuinely mixed while BBA/BCA resolve to one row.
  const progSplit = (parentKey: string, extraWhere: string): void => {
    if (!(CSAT_ROUND_SET.has(round) && csatMapReady())) return;
    let rows2: { p: string; n: number }[] = [];
    try {
      rows2 = db.prepare(
        `SELECT coalesce(nullif(signup_programs,''),'no signup (CRM-only lead)') p, COUNT(*) n
           FROM csat_map WHERE round_tag IN (${inc})${extraWhere}
          GROUP BY 1 ORDER BY n DESC`
      ).all() as { p: string; n: number }[];
    } catch { return; }
    if (!rows2.length) return;
    rows[rows.length - 1].expandable = true; // the row we just pushed
    for (const r of rows2) {
      if (!r.n) continue;
      rows.push({
        key: `${parentKey}_prog_${r.p}`,
        label: r.p,
        count: r.n,
        pct: pb(r.n),
        drop: null,
        detail: true,
      });
    }
  };
  progSplit("lead", "");
  main("registration", "Registration", reg, "no registration feed");
  progSplit("registration", " AND registered='paid'");
  main("test", "Test", appeared, "awaiting exam feed");
  // Detail nested under Test (revealed by the chevron): AI calling, attending, result.
  const waveCount = int(
    db.prepare(`SELECT COUNT(DISTINCT calling_wave) n FROM call_logs WHERE nsat_round IN (${inc})`).get() as any
  );
  if (appeared > 0) {
    rows[rows.length - 1].expandable = true; // mark the Test row
    if (called > 0) {
      rows.push({
        key: "before_test",
        label: `Before Test: AI calling (${waveCount} waves)`,
        count: called,
        pct: pb(called),
        drop: null,
        detail: true,
        note: `${called.toLocaleString("en-IN")} distinct students called`,
      });
      rows.push({
        key: "bt_connected",
        label: "Connected",
        count: connected,
        pct: pc(connected),
        drop: null,
        sub: true,
        detail: true,
        note: `${connected.toLocaleString("en-IN")} of ${called.toLocaleString("en-IN")} picked up`,
      });
      rows.push({
        key: "bt_attending",
        label: "Attending confirmed",
        count: attending,
        pct: pc(attending),
        drop: null,
        sub: true,
        detail: true,
      });
    }
    rows.push({
      key: "result",
      label: "Result: Pass",
      count: passed,
      pct: pb(passed),
      drop: null,
      detail: true,
      note: `${passed.toLocaleString("en-IN")} pass / ${failed} fail`,
    });
  }
  main("slot_form", "Slot Form", couns, "no slots booked yet", `${couns.toLocaleString("en-IN")} slots booked`);
  // Slot Form is day-wise: expand to Day 1 (16 Jul 2026), Day 2, … with per-day booked counts
  if (couns > 0) {
    rows[rows.length - 1].expandable = true;
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    // Day numbering derived from the actual booked dates (Day 1 = earliest), nothing hardcoded
    const days = db.prepare(
      `SELECT substr(x.scheduled_at,1,10) d, COUNT(*) n, SUM(CASE WHEN x.rep_id IS NOT NULL AND x.rep_id<>'' THEN 1 ELSE 0 END) wp FROM counselling_sessions x JOIN leads l ON l.lead_id=x.lead_id WHERE l.nsat_round IN (${inc}) AND x.scheduled_at IS NOT NULL GROUP BY d ORDER BY d`
    ).all() as any[];
    days.forEach((row, idx) => {
      const p = String(row.d).split("-");
      const wp = Number(row.wp || 0);
      rows.push({ key: "slot_day_" + row.d, label: `Day ${idx + 1} · ${+p[2]} ${MON[(+p[1]) - 1]} ${p[0]}`, count: row.n, pct: pb(row.n), drop: null, detail: true, note: `${wp} with panelist · ${row.n - wp} not booked` });
    });
  }
  main("counselling", "Counselling", held, "counselling not started yet");
  main("offer_letter", "Offer Letter", offers, "no offer feed yet");
  main("seat_payment", "Seat Payment", seats, "no seat-payment feed yet");
  return { base, rows };
}

// ---------------------------------------------------------------------------
// Loss / disposition panel
// ---------------------------------------------------------------------------
export interface Disposition {
  kind: "calls" | "dropoff";
  total: number;
  connectedPct?: number;
  segments: { label: string; value: number; color: string }[];
  carrierPct?: number;
  avgDurationSec?: number;
}

export function disposition(round: Round): Disposition {
  const hasCalls = round === "NSAT-3" || round === "Combined";
  if (hasCalls) {
    const inc = inClause(round);
    const rows = db
      .prepare(`SELECT status, COUNT(*) n FROM call_logs WHERE nsat_round IN (${inc}) GROUP BY status`)
      .all() as { status: string; n: number }[];
    const total = rows.reduce((s, r) => s + int(r.n), 0);
    const by = (s: string) => int(rows.find((r) => r.status === s)?.n ?? 0);
    const connected = by("completed");
    const rejected = by("rejected");
    const noAnswer = by("no-answer");
    const voicemail = by("machine");
    const other = total - connected - rejected - noAnswer - voicemail;
    const carrier = int(
      db
        .prepare(`SELECT COUNT(*) n FROM call_logs WHERE nsat_round IN (${inc}) AND hangup_source='Carrier'`)
        .get() as any
    );
    const avg = db
      .prepare(
        `SELECT AVG(duration_sec) a FROM call_logs WHERE nsat_round IN (${inc}) AND answered=1 AND duration_sec IS NOT NULL`
      )
      .get() as any;
    return {
      kind: "calls",
      total,
      connectedPct: total ? Math.round((connected / total) * 100) : 0,
      carrierPct: total ? Math.round((carrier / total) * 100) : 0,
      avgDurationSec: avg?.a ? Math.round(avg.a) : 0,
      segments: [
        { label: "Rejected", value: rejected, color: "var(--dead)" },
        { label: "No answer", value: noAnswer, color: "var(--yellow)" },
        { label: "Voicemail", value: voicemail, color: "var(--blue)" },
        { label: "Connected", value: connected, color: "var(--green)" },
        ...(other > 0 ? [{ label: "Other", value: other, color: "var(--divider)" }] : []),
      ],
    };
  }

  // NSAT-2: funnel drop-off by stage.
  const f = funnelN2("NSAT-2");
  const active = f.rows.filter((r) => r.count !== null);
  const segments: { label: string; value: number; color: string }[] = [];
  const palette = ["var(--primary)", "var(--primary-2)", "var(--blue)", "var(--green)", "var(--yellow)"];
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1];
    const cur = active[i];
    segments.push({
      label: `${prev.label} → ${cur.label}`,
      value: (prev.count as number) - (cur.count as number),
      color: palette[(i - 1) % palette.length],
    });
  }
  return { kind: "dropoff", total: segments.reduce((s, x) => s + x.value, 0), segments };
}

// ---------------------------------------------------------------------------
// Channel plan matrix
// ---------------------------------------------------------------------------
export interface ChannelMatrix {
  channels: { key: string; label: string }[];
  rows: { label: string; cells: { channel: string; status: string; live: boolean }[] }[];
}

export function channelMatrix(round: Round): ChannelMatrix {
  const channels = [
    { key: "ai_call", label: "AI Call" },
    { key: "human_call", label: "Human" },
    { key: "sms", label: "SMS" },
    { key: "email", label: "Email" },
    { key: "whatsapp", label: "WhatsApp" },
    { key: "other", label: "Other" },
  ];
  const raw = db
    .prepare(
      "SELECT stage_label, stage_key, stage_order, channel, status FROM stage_channels ORDER BY stage_order"
    )
    .all() as { stage_label: string; stage_key: string; stage_order: number; channel: string; status: string }[];

  // Live data flows for NSAT-3 at before_test / ai_call.
  const showLive = round === "NSAT-3" || round === "Combined";

  const order: string[] = [];
  const byStage = new Map<string, { key: string; status: Record<string, string> }>();
  for (const r of raw) {
    if (!byStage.has(r.stage_label)) {
      byStage.set(r.stage_label, { key: r.stage_key, status: {} });
      order.push(r.stage_label);
    }
    byStage.get(r.stage_label)!.status[r.channel] = r.status;
  }
  const rows = order.map((label) => {
    const s = byStage.get(label)!;
    return {
      label,
      cells: channels.map((c) => ({
        channel: c.key,
        status: s.status[c.key] ?? "none",
        live: showLive && s.key === "before_test" && c.key === "ai_call",
      })),
    };
  });
  return { channels, rows };
}

// ---------------------------------------------------------------------------
// NSAT-3 calling waves
// ---------------------------------------------------------------------------
export interface Wave {
  wave: number;
  calls: number;
  connectRate: number;
  attending: number;
  cost: number;
}

export function callingWaves(round: Round): Wave[] {
  if (round === "NSAT-2") return [];
  const rows = db
    .prepare(
      `SELECT calling_wave w, COUNT(*) calls, SUM(answered) conn, SUM(cost) cost
       FROM call_logs WHERE nsat_round='NSAT-3' AND calling_wave IS NOT NULL
       GROUP BY calling_wave ORDER BY calling_wave`
    )
    .all() as { w: number; calls: number; conn: number; cost: number }[];
  const att = db
    .prepare(
      `SELECT calling_wave w, COUNT(*) n FROM call_outcomes
       WHERE nsat_round='NSAT-3' AND attending=1 GROUP BY calling_wave`
    )
    .all() as { w: number; n: number }[];
  const attMap = new Map(att.map((a) => [int(a.w), int(a.n)]));
  return rows.map((r) => ({
    wave: int(r.w),
    calls: int(r.calls),
    connectRate: r.calls ? (int(r.conn) / int(r.calls)) * 100 : 0,
    attending: attMap.get(int(r.w)) ?? 0,
    cost: Math.round(int(r.cost)),
  }));
}

// ---------------------------------------------------------------------------
// NSAT-3 captured-intent buckets
// ---------------------------------------------------------------------------
export interface Bucket {
  label: string;
  value: number;
  color: string;
}

export function intentBuckets(round: Round): Bucket[] {
  if (round === "NSAT-2") return [];
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) n FROM call_outcomes
       WHERE nsat_round='NSAT-3' AND category IS NOT NULL GROUP BY category ORDER BY n DESC`
    )
    .all() as { category: string; n: number }[];
  const colorFor = (c: string): string => {
    if (c.includes("Not Received")) return "var(--yellow)";
    if (c.startsWith("Attending")) return "var(--green)";
    if (c.startsWith("Not Attending")) return "var(--red)";
    if (c.startsWith("Tentative")) return "var(--cyan-bright)";
    if (c.startsWith("Callback")) return "var(--blue)";
    return "var(--primary-2)";
  };
  return rows.map((r) => ({ label: r.category, value: int(r.n), color: colorFor(r.category) }));
}

// ---------------------------------------------------------------------------
// NSAT-3 self-inflicted losses
// ---------------------------------------------------------------------------
export interface LossTile {
  value: number;
  text: string;
  tone: "warn" | "alarm" | "plain";
}

export function selfInflictedLosses(round: Round): LossTile[] {
  if (round === "NSAT-2") return [];
  const attNoCreds = int(
    db
      .prepare(
        "SELECT COUNT(DISTINCT lead_id) n FROM call_outcomes WHERE nsat_round='NSAT-3' AND attending=1 AND (creds_received=0 OR creds_received IS NULL)"
      )
      .get() as any
  );
  const flagged = int(
    db.prepare("SELECT COUNT(*) n FROM leads WHERE nsat_round='NSAT-3' AND login_creds_received=0").get() as any
  );
  const tentative = int(
    db
      .prepare(
        "SELECT COUNT(*) n FROM call_outcomes WHERE nsat_round='NSAT-3' AND category LIKE 'Tentative%'"
      )
      .get() as any
  );
  const called = int(
    db.prepare("SELECT COUNT(DISTINCT lead_id) n FROM call_logs WHERE nsat_round='NSAT-3'").get() as any
  );
  const connected = int(
    db
      .prepare("SELECT COUNT(DISTINCT lead_id) n FROM call_logs WHERE nsat_round='NSAT-3' AND answered=1")
      .get() as any
  );
  return [
    { value: attNoCreds, text: "Attending but login creds not received. Want in, blocked by us.", tone: "warn" },
    { value: flagged, text: 'On the "login not received" list. Pure operational leak.', tone: "alarm" },
    { value: tentative, text: "Tentative leads. A human follow-up could tip them.", tone: "plain" },
    { value: called - connected, text: "Never reached in 3 waves. Switch channel (WhatsApp).", tone: "plain" },
  ];
}

// ---------------------------------------------------------------------------
// Overview meta (topbar chip)
// ---------------------------------------------------------------------------
export function overviewMeta(round: Round): { title: string; subtitle: string; chip: string; pill: string } {
  if (round === "NSAT-3") {
    const called = int(
      db.prepare("SELECT COUNT(DISTINCT lead_id) n FROM call_logs WHERE nsat_round='NSAT-3'").get() as any
    );
    return {
      title: "NSAT-3 Overview",
      subtitle: "Lead-to-conversion funnel, AI test-reminder campaign",
      chip: "LIVE STAGE: BEFORE TEST",
      pill: `NSAT-3, ${called.toLocaleString("en-IN")} called (AI)`,
    };
  }
  if (round === "Combined") {
    const leads = int(db.prepare("SELECT COUNT(*) n FROM leads").get() as any);
    return {
      title: "Combined Overview",
      subtitle: "NSAT-2 full funnel + NSAT-3 AI-calling stage",
      chip: "NSAT-2 + NSAT-3",
      pill: `${leads.toLocaleString("en-IN")} leads total`,
    };
  }
  if (round === "NSAT-4") {
    const leads = int(db.prepare("SELECT COUNT(*) n FROM leads WHERE nsat_round='NSAT-4'").get() as any);
    return {
      title: "NSAT-4 Overview",
      subtitle: "Registrations live from the NSAT CSAT project",
      chip: "LIVE STAGE: REGISTRATION",
      pill: `NSAT-4, ${leads.toLocaleString("en-IN")} leads`,
    };
  }
  if (round.startsWith("CSAT")) {
    const prog = round === "CSAT-BBA" ? "BBA" : round === "CSAT-BCA" ? "BCA" : round === "CSAT-COMB" ? "Combined" : "All programs";
    const inc = inClause(round);
    const leads = int(db.prepare(`SELECT COUNT(*) n FROM leads WHERE nsat_round IN (${inc})`).get() as any);
    return {
      title: `CSAT Overview · ${prog}`,
      subtitle: "C-SAT landing-page leads, live from the NSAT CSAT project",
      chip: `CSAT: ${prog.toUpperCase()}`,
      pill: `${leads.toLocaleString("en-IN")} leads`,
    };
  }
  const leads = int(db.prepare("SELECT COUNT(*) n FROM leads WHERE nsat_round='NSAT-2'").get() as any);
  return {
    title: "NSAT-2 Overview",
    subtitle: "Lead-to-conversion across the full admissions funnel",
    chip: "FULL FUNNEL",
    pill: `NSAT-2, ${leads.toLocaleString("en-IN")} leads`,
  };
}

// ---------------------------------------------------------------------------
// Leads list (filter + paginate)
// ---------------------------------------------------------------------------
export interface LeadRow {
  lead_id: string;
  full_name: string | null;
  phone: string | null;
  city: string | null;
  nsat_round: string | null;
  current_stage: string | null;
  test_result: string | null; // pass | fail | null (splits the 'result' stage badge)
  source: string | null;
}
export interface LeadsResult {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  stages: string[];
}

export const LEADS_PAGE_SIZE = 50;

export function leadFilterOptions(): { rounds: string[]; stages: string[] } {
  const rounds = (db.prepare("SELECT DISTINCT nsat_round r FROM leads WHERE nsat_round IS NOT NULL ORDER BY r").all() as any[]).map(
    (x) => x.r as string
  );
  const stages = (
    db.prepare("SELECT DISTINCT current_stage s FROM leads WHERE current_stage IS NOT NULL ORDER BY s").all() as any[]
  ).map((x) => x.s as string);
  return { rounds, stages };
}

// ---------------------------------------------------------------------------
// Stage list views (sidebar tabs): one table per funnel stage. Fixed columns
// Name/Email/Phone/City/Round plus the stage's BIFURCATION column(s) — what
// happened next (appeared or not, pass or fail, booked or not...).
// ---------------------------------------------------------------------------
export interface StageListCol {
  key: string;
  label: string;
  kind: "text" | "select";
}
export interface StageList {
  stage: string;
  title: string;
  columns: StageListCol[];
  rows: Record<string, string | null>[];
}

const STAGE_LIST_DEFS: Record<
  string,
  { title: string; where: string; extras: { key: string; label: string; sql: string }[] }
> = {
  lead: {
    title: "Leads",
    where: "1=1",
    extras: [
      {
        key: "registered", label: "Registration",
        sql: "CASE WHEN l.lead_id IN (SELECT lead_id FROM registrations) THEN 'Registered' ELSE 'Not registered' END",
      },
      {
        key: "test_result", label: "Test",
        sql: "COALESCE((SELECT CASE t.result WHEN 'pass' THEN 'Pass' WHEN 'fail' THEN 'Fail' END FROM test_results t WHERE t.lead_id=l.lead_id LIMIT 1), '')",
      },
    ],
  },
  registration: {
    title: "Registrations",
    where: "l.lead_id IN (SELECT lead_id FROM registrations)",
    extras: [
      {
        key: "test", label: "Test",
        sql: "CASE WHEN l.lead_id IN (SELECT lead_id FROM test_results WHERE appeared=1) THEN 'Appeared' ELSE 'Did not appear' END",
      },
    ],
  },
  test: {
    title: "Test takers",
    where: "l.lead_id IN (SELECT lead_id FROM test_results WHERE appeared=1)",
    extras: [
      {
        key: "result", label: "Result",
        sql: "(SELECT CASE t.result WHEN 'pass' THEN 'Pass' WHEN 'fail' THEN 'Fail' ELSE '-' END FROM test_results t WHERE t.lead_id=l.lead_id LIMIT 1)",
      },
    ],
  },
  slot_form: {
    title: "Slot booking (passed students)",
    where: "l.lead_id IN (SELECT lead_id FROM test_results WHERE result='pass')",
    extras: [
      {
        key: "slot", label: "Slot",
        sql: "CASE WHEN l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE scheduled_at IS NOT NULL) THEN 'Booked' ELSE 'Not booked' END",
      },
      {
        key: "counsellor", label: "Counsellor",
        sql: "COALESCE(NULLIF(TRIM(l.assigned_rep_id),''),'Unassigned')",
      },
      {
        key: "slot_date", label: "Slot Date",
        sql: "(SELECT substr(c.scheduled_at,1,10) FROM counselling_sessions c WHERE c.lead_id=l.lead_id AND c.scheduled_at IS NOT NULL LIMIT 1)",
      },
      {
        key: "panelist", label: "Panelist",
        sql: "(SELECT CASE WHEN c.rep_id IS NULL THEN 'Not assigned' ELSE c.rep_id END FROM counselling_sessions c WHERE c.lead_id=l.lead_id AND c.scheduled_at IS NOT NULL LIMIT 1)",
      },
    ],
  },
  counselling: {
    title: "Counselling (booked slots)",
    where: "l.lead_id IN (SELECT lead_id FROM counselling_sessions)",
    extras: [
      {
        key: "outcome", label: "Outcome",
        sql: "(SELECT CASE c.status WHEN 'held' THEN 'Held' WHEN 'no_show' THEN 'Did not join' WHEN 'reschedule' THEN 'Reschedule' ELSE 'Pending' END FROM counselling_sessions c WHERE c.lead_id=l.lead_id LIMIT 1)",
      },
      {
        key: "day", label: "Day",
        sql: "(SELECT substr(c.scheduled_at,1,10) FROM counselling_sessions c WHERE c.lead_id=l.lead_id AND c.scheduled_at IS NOT NULL LIMIT 1)",
      },
      {
        key: "time", label: "Time",
        sql: "(SELECT substr(c.scheduled_at,12) FROM counselling_sessions c WHERE c.lead_id=l.lead_id AND c.scheduled_at IS NOT NULL LIMIT 1)",
      },
      {
        key: "panelist", label: "Panelist",
        sql: "(SELECT COALESCE(c.rep_id,'Not assigned') FROM counselling_sessions c WHERE c.lead_id=l.lead_id AND c.scheduled_at IS NOT NULL LIMIT 1)",
      },
    ],
  },
  offer_letter: {
    title: "Offer letters",
    where: "l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule')) AND l.lead_id IN (SELECT lead_id FROM offer_letters)",
    extras: [
      {
        key: "released", label: "Released on",
        sql: "(SELECT o.issued_at FROM offer_letters o WHERE o.lead_id=l.lead_id LIMIT 1)",
      },
    ],
  },
  seat_booking: {
    title: "Seat bookings (NSAT flow)",
    where: "l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule')) AND l.lead_id IN (SELECT lead_id FROM payments WHERE paid_at >= '2026-07-16')",
    extras: [
      {
        key: "booked", label: "Booked on",
        sql: "(SELECT p.paid_at FROM payments p WHERE p.lead_id=l.lead_id LIMIT 1)",
      },
    ],
  },
};

// Comms touch columns: FUNNEL-WISE — a tick means the channel touched the lead
// AT THAT STAGE. AI call_logs = before-test calling (pre-test tabs). Human call
// rollup (Redash 6714, source of truth) = counsellor calls since 14 Jul = the
// slot-booking push, so its ticks live on the post-result tabs.
const AI_TOUCHED =
  "(l.lead_id IN (SELECT lead_id FROM call_logs WHERE stage='before_test' OR stage IS NULL) OR (l.phone10 IS NOT NULL AND l.phone10 IN " +
  "(SELECT l2.phone10 FROM leads l2 JOIN call_logs c2 ON c2.lead_id=l2.lead_id WHERE l2.phone10 IS NOT NULL)))";
const HUMAN_TOUCHED =
  "l.lead_id IN (SELECT lead_id FROM lead_call_summary WHERE channel='human_call' AND total_attempts>0)";
const HUMAN_CONNECTED =
  "l.lead_id IN (SELECT lead_id FROM lead_call_summary WHERE channel='human_call' AND connected>0)";
const PRE_TEST_STAGES = new Set(["lead", "registration", "test"]);

function commsCols(stage: string): { key: string; label: string; sql: string }[] {
  const preTest = PRE_TEST_STAGES.has(stage);
  return [
    { key: "ai_call", label: "AI Call", sql: preTest ? `CASE WHEN ${AI_TOUCHED} THEN '✓' ELSE '' END` : "''" },
    {
      // Human calls (counsellor outreach since 14 Jul — NOT the counselling
      // session itself). "Last Call" shows when, so future-day sessions don't
      // read as already-called.
      key: "human_call", label: "Human Call",
      sql: `CASE WHEN ${HUMAN_CONNECTED} THEN 'Connected' WHEN ${HUMAN_TOUCHED} THEN 'Called, no pickup' ELSE '' END`,
    },
    {
      key: "called_by", label: "Called by",
      sql: "(SELECT c.rep_id FROM call_logs c WHERE c.lead_id=l.lead_id AND c.channel='human_call' AND c.rep_id IS NOT NULL ORDER BY c.attempted_at DESC LIMIT 1)",
    },
    {
      key: "last_call", label: "Last Call",
      sql: "(SELECT substr(MAX(attempted_at),1,10) FROM call_logs c3 WHERE c3.channel='human_call' AND c3.lead_id=l.lead_id)",
    },
    {
      key: "last_call_time", label: "Call Time",
      sql: "(SELECT substr(MAX(attempted_at),12,5) FROM call_logs c4 WHERE c4.channel='human_call' AND c4.lead_id=l.lead_id)",
    },
    {
      // WhatsApp status FUNNEL-WISE: pre-test tabs show the test-push blast,
      // slot/counselling tabs show the counselling confirmation/reminder.
      // Best status wins: Read > Delivered > Sent.
      key: "whatsapp", label: "WhatsApp",
      sql: waStatus(preTest ? "before_test" : "slot_push"),
    },
    {
      key: "last_wa", label: "Last WhatsApp",
      sql: "(SELECT substr(MAX(attempted_at),1,10) FROM call_logs w2 WHERE w2.channel='whatsapp' AND w2.lead_id=l.lead_id)",
    },
    { key: "email_sent", label: "Email Sent", sql: "''" },
  ];
}

function waStatus(stage: string): string {
  return (
    "COALESCE((SELECT CASE " +
    "WHEN SUM(CASE WHEN w.status='Read' THEN 1 ELSE 0 END)>0 THEN 'Read' " +
    "WHEN SUM(CASE WHEN w.status='Delivered' THEN 1 ELSE 0 END)>0 THEN 'Delivered' " +
    "WHEN SUM(CASE WHEN w.status='Sent' THEN 1 ELSE 0 END)>0 THEN 'Sent' " +
    "ELSE '' END " +
    `FROM call_logs w WHERE w.channel='whatsapp' AND w.lead_id=l.lead_id AND w.stage='${stage}'), '')`
  );
}

export function stageList(stage: string, round: Round, src?: Src): StageList | null {
  const def = STAGE_LIST_DEFS[stage];
  if (!def) return null;
  const inc = inClause(round);
  const S = srcClause(src);
  // Comms (AI/human/WhatsApp) ran only for NSAT-3 — hide those columns elsewhere.
  const hasComms = roundList(round).includes("NSAT-3");
  const allExtras = [...def.extras, ...(hasComms ? commsCols(stage) : [])];
  const extraSel = allExtras.map((e) => `${e.sql} AS ${e.key}`).join(", ");
  const rows = db
    .prepare(
      `SELECT l.lead_id, l.full_name AS name, l.email, l.phone, l.city, l.nsat_round AS round${extraSel ? ", " + extraSel : ""}
       FROM leads l
       WHERE l.nsat_round IN (${inc})${S} AND ${def.where}
       ORDER BY l.full_name`
    )
    .all() as Record<string, string | null>[];
  const columns: StageListCol[] = [
    { key: "name", label: "Name", kind: "text" },
    { key: "email", label: "Email", kind: "text" },
    { key: "phone", label: "Phone", kind: "text" },
    { key: "city", label: "City", kind: "select" },
    { key: "round", label: "Round", kind: "select" },
    ...allExtras.map((e) => ({ key: e.key, label: e.label, kind: "select" as const })),
  ];
  return { stage, title: def.title, columns, rows };
}

// ---------------------------------------------------------------------------
// Counselling by day (block after Stage Breakdown): per-day booked/outcomes.
// ---------------------------------------------------------------------------
export interface CounsellingDay {
  day: string; // 2026-07-16, or "" for responded-without-slot
  booked: number;
  withPanelist: number;
  held: number;
  noShow: number;
  reschedule: number;
  pending: number;
}

export function counsellingByDay(round: Round): CounsellingDay[] {
  const inc = inClause(round);
  // Bookings/panelist/pending belong to the BOOKING day; outcomes belong to
  // the day the panelist responded (held_at) — a student booked on the 16th
  // but counselled on the 17th must count under the 17th.
  const byDay = new Map<string, CounsellingDay>();
  const row = (day: string): CounsellingDay => {
    let r = byDay.get(day);
    if (!r) {
      r = { day, booked: 0, withPanelist: 0, held: 0, noShow: 0, reschedule: 0, pending: 0 };
      byDay.set(day, r);
    }
    return r;
  };
  for (const b of db
    .prepare(
      `SELECT COALESCE(substr(c.scheduled_at,1,10),'') day,
              SUM(CASE WHEN c.scheduled_at IS NOT NULL THEN 1 ELSE 0 END) booked,
              SUM(CASE WHEN c.rep_id IS NOT NULL THEN 1 ELSE 0 END) withPanelist,
              SUM(CASE WHEN c.status='scheduled' THEN 1 ELSE 0 END) pending
       FROM counselling_sessions c JOIN leads l ON l.lead_id=c.lead_id
       WHERE l.nsat_round IN (${inc})
       GROUP BY day`
    )
    .all() as { day: string; booked: number; withPanelist: number; pending: number }[]) {
    const r = row(b.day);
    r.booked = b.booked;
    r.withPanelist = b.withPanelist;
    r.pending = b.pending;
  }
  // One outcome per student, on the response day (fall back to the booking day
  // for legacy rows without a response timestamp).
  for (const o of db
    .prepare(
      `SELECT COALESCE(substr(c.held_at,1,10), substr(c.scheduled_at,1,10), '') day, c.status,
              COUNT(DISTINCT c.lead_id) n
       FROM counselling_sessions c JOIN leads l ON l.lead_id=c.lead_id
       WHERE l.nsat_round IN (${inc}) AND c.status IN ('held','no_show','reschedule')
       GROUP BY day, c.status`
    )
    .all() as { day: string; status: string; n: number }[]) {
    const r = row(o.day);
    if (o.status === "held") r.held += o.n;
    else if (o.status === "no_show") r.noShow += o.n;
    else r.reschedule += o.n;
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// "Slot not booked" (passed, no counselling booking) broken down by the
// counsellor who owns the lead — the actionable view of that number.
export interface PendingByCounsellor {
  counsellor: string;
  pending: number;
}
export function pendingByCounsellor(round: Round): PendingByCounsellor[] {
  const inc = inClause(round);
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(l.assigned_rep_id),''),'Unassigned') counsellor, COUNT(*) pending
       FROM leads l
       WHERE l.nsat_round IN (${inc})
         AND l.lead_id IN (SELECT lead_id FROM test_results WHERE result='pass')
         AND l.lead_id NOT IN (SELECT lead_id FROM counselling_sessions)
       GROUP BY counsellor ORDER BY pending DESC`
    )
    .all() as PendingByCounsellor[];
}

// Human calling day-wise (per-call rows from Redash 6730, channel='human_call').
export interface HumanCallDay {
  day: string;
  attempts: number;
  connected: number;
  students: number;
  studentsConnected: number;
}
export function humanCallsByDay(): HumanCallDay[] {
  return db
    .prepare(
      `SELECT substr(attempted_at,1,10) day,
              COUNT(*) attempts,
              SUM(answered) connected,
              COUNT(DISTINCT lead_id) students,
              COUNT(DISTINCT CASE WHEN answered=1 THEN lead_id END) studentsConnected
       FROM call_logs WHERE channel='human_call'
       GROUP BY day ORDER BY day`
    )
    .all() as HumanCallDay[];
}

// WhatsApp day-wise (per-message rows, channel='whatsapp').
export interface WhatsAppDay {
  day: string;
  sent: number;
  delivered: number;
  read: number;
  students: number;
}
export function whatsAppByDay(): WhatsAppDay[] {
  return db
    .prepare(
      `SELECT substr(attempted_at,1,10) day,
              COUNT(*) sent,
              SUM(CASE WHEN status IN ('Delivered','Read') THEN 1 ELSE 0 END) delivered,
              SUM(CASE WHEN status='Read' THEN 1 ELSE 0 END) read,
              COUNT(DISTINCT lead_id) students
       FROM call_logs WHERE channel='whatsapp'
       GROUP BY day ORDER BY day`
    )
    .all() as WhatsAppDay[];
}

// Resolve a Stage Breakdown tile key ("counselling_slot_not_booked") to its
// SQL predicate + label, so tiles can drill down to the exact student list.
export function tileFilter(key: string): { where: string; label: string } | null {
  for (const g of STAGE_BREAKDOWN) {
    for (const t of g.tiles) {
      if (`${g.stage}_${t.key}` === key && t.where) {
        return { where: t.where, label: `${g.label}: ${t.label}` };
      }
    }
  }
  return null;
}

export function leads(params: {
  round?: string;
  stage?: string;
  tile?: string;
  q?: string;
  page?: number;
}): LeadsResult {
  const where: string[] = [];
  const args: any[] = [];
  if (params.round && params.round !== "all") {
    where.push("nsat_round = ?");
    args.push(params.round);
  }
  if (params.stage && params.stage !== "all") {
    where.push("current_stage = ?");
    args.push(params.stage);
  }
  if (params.tile) {
    const tf = tileFilter(params.tile);
    if (tf) where.push(tf.where);
  }
  if (params.q && params.q.trim()) {
    where.push("(full_name LIKE ? OR phone LIKE ?)");
    const like = `%${params.q.trim()}%`;
    args.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = int(db.prepare(`SELECT COUNT(*) n FROM leads l ${clause}`).get(...args) as any);
  const pageSize = LEADS_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, params.page ?? 1), pages);
  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT lead_id, full_name, phone, city, nsat_round, current_stage, source,
              (SELECT t.result FROM test_results t WHERE t.lead_id = l.lead_id LIMIT 1) AS test_result
       FROM leads l ${clause}
       ORDER BY nsat_round, full_name
       LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset) as LeadRow[];
  const stages = leadFilterOptions().stages;
  return { rows, total, page, pageSize, pages, stages };
}

// ---------------------------------------------------------------------------
// Lead detail
// ---------------------------------------------------------------------------
export interface LeadDetail {
  lead: {
    lead_id: string;
    full_name: string | null;
    phone: string | null;
    email: string | null;
    city: string | null;
    nsat_round: string | null;
    source: string | null;
    current_stage: string | null;
    login_creds_received: number | null;
  } | null;
  registration: { registered_at: string | null } | null;
  test: { appeared: number | null; result: string | null; score: number | null; test_at: string | null } | null;
  counselling: { held_at: string | null; status: string | null; outcome: string | null } | null;
  outcomes: {
    calling_wave: number | null;
    category: string | null;
    attending: number | null;
    creds_received: number | null;
    notes: string | null;
  }[];
  calls: {
    call_id: string;
    calling_wave: number | null;
    status: string | null;
    sentiment: string | null;
    duration_sec: number | null;
    cost: number | null;
    hangup_source: string | null;
    attempted_at: string | null;
  }[];
}

export function leadDetail(leadId: string): LeadDetail {
  const lead = db
    .prepare(
      `SELECT lead_id, full_name, phone, email, city, nsat_round, source, current_stage, login_creds_received
       FROM leads WHERE lead_id = ?`
    )
    .get(leadId) as LeadDetail["lead"];
  if (!lead) {
    return { lead: null, registration: null, test: null, counselling: null, outcomes: [], calls: [] };
  }
  const registration = db
    .prepare("SELECT registered_at FROM registrations WHERE lead_id = ? LIMIT 1")
    .get(leadId) as LeadDetail["registration"];
  const test = db
    .prepare("SELECT appeared, result, score, test_at FROM test_results WHERE lead_id = ? LIMIT 1")
    .get(leadId) as LeadDetail["test"];
  const counselling = db
    .prepare("SELECT held_at, status, outcome FROM counselling_sessions WHERE lead_id = ? LIMIT 1")
    .get(leadId) as LeadDetail["counselling"];
  const outcomes = db
    .prepare(
      "SELECT calling_wave, category, attending, creds_received, notes FROM call_outcomes WHERE lead_id = ? ORDER BY calling_wave"
    )
    .all(leadId) as LeadDetail["outcomes"];
  const calls = db
    .prepare(
      `SELECT call_id, calling_wave, status, sentiment, duration_sec, cost, hangup_source, attempted_at
       FROM call_logs WHERE lead_id = ? ORDER BY calling_wave, attempted_at`
    )
    .all(leadId) as LeadDetail["calls"];
  return { lead, registration, test, counselling, outcomes, calls };
}

// ---------------------------------------------------------------------------
// Stage breakdown: per funnel-stage KPI tiles (the key pointers for each stage).
// Config-driven like ALERT_RULES. `where` = SQL predicate over leads l; omit it
// for a pointer whose feed doesn't exist yet -> rendered as "awaiting feed".
// UI-first: wire more `where` predicates here as the data lands.
// ---------------------------------------------------------------------------
export type Tone = "good" | "bad" | "neutral";
export type StageTile = { key: string; label: string; count: number | null; tone: Tone };
export type StageBreakdown = { stage: string; label: string; tiles: StageTile[] };

// `bad` tiles double as Red Flags (block 4): the severity pipeline reads them.
// recoverable=false marks misses that can't be fixed this round (info once the
// funnel has moved past them). action/alertTitle/stageLink shape the alert card.
type TileRule = {
  key: string;
  label: string;
  tone: Tone;
  where?: string;
  recoverable?: boolean;
  action?: string;
  alertTitle?: string;
  stageLink?: string;
};
const STAGE_BREAKDOWN: { stage: string; label: string; tiles: TileRule[] }[] = [
  {
    stage: "registration", label: "Registration", tiles: [
      { key: "total_reg", label: "Total registrations", tone: "neutral", where: "l.lead_id IN (SELECT lead_id FROM registrations)" },
      // Scoped to registrations so the card adds up: appeared + did-not = total.
      { key: "test_appeared", label: "Test appeared", tone: "good", where: "l.lead_id IN (SELECT lead_id FROM test_results WHERE appeared=1)" },
      { key: "did_not_appear", label: "Did not appear", tone: "bad", where: "l.lead_id IN (SELECT lead_id FROM registrations) AND l.lead_id NOT IN (SELECT lead_id FROM test_results WHERE appeared=1)", recoverable: false, alertTitle: "Registered, did not take the test", action: "Nurture for the next NSAT round" },
      // Pre-booked students in the cohort (old seat books, OL before 16 Jul).
      { key: "already_seatbook", label: "Already seat booked", tone: "neutral", where: "l.lead_id IN (SELECT lead_id FROM payments) AND NOT (l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule')) AND l.lead_id IN (SELECT lead_id FROM payments WHERE paid_at >= '2026-07-16'))" },
    ],
  },
  {
    stage: "test", label: "Test", tiles: [
      { key: "applied", label: "Test appeared", tone: "neutral", where: "l.lead_id IN (SELECT lead_id FROM test_results WHERE appeared=1)" },
      { key: "pass", label: "Pass", tone: "good", where: "l.lead_id IN (SELECT lead_id FROM test_results WHERE result='pass')" },
      { key: "fail", label: "Fail", tone: "bad", where: "l.lead_id IN (SELECT lead_id FROM test_results WHERE result='fail')", recoverable: false, alertTitle: "Appeared, failed the test", action: "Retake nurture for the next round", stageLink: "result" },
      // Pre-booked students who actually re-took NSAT-3 (appeared on the 14th).
      { key: "already_seatbook", label: "Already seat booked", tone: "neutral", where: "l.lead_id IN (SELECT lead_id FROM payments) AND NOT (l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule')) AND l.lead_id IN (SELECT lead_id FROM payments WHERE paid_at >= '2026-07-16')) AND l.lead_id IN (SELECT lead_id FROM test_results WHERE appeared=1)" },
    ],
  },
  {
    stage: "counselling", label: "Counselling", tiles: [
      // Scoped to passed students so the card adds up: booked + not booked = pass.
      // Any session row counts (a few students got counselled without a slot
      // booking, via the panelist form) so booked + not-booked = pass exactly.
      { key: "slot_booked", label: "Slot booked", tone: "good", where: "l.lead_id IN (SELECT lead_id FROM test_results WHERE result='pass') AND l.lead_id IN (SELECT lead_id FROM counselling_sessions)" },
      { key: "slot_not_booked", label: "Slot not booked", tone: "bad", where: "l.lead_id IN (SELECT lead_id FROM test_results WHERE result='pass') AND l.lead_id NOT IN (SELECT lead_id FROM counselling_sessions)", alertTitle: "Passed, counselling slot not booked", action: "Owner books the counselling slot", stageLink: "result" },
    ],
  },
  {
    stage: "offer_letter", label: "Offer Letter", tiles: [
      // OL is valid for 3 days from release. Seat booked -> converted; else
      // active (< 3 days old) or expiring (3+ days old, still unbooked).
      { key: "released", label: "Released", tone: "neutral", where: "l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule')) AND l.lead_id IN (SELECT lead_id FROM offer_letters)" },
      { key: "active", label: "Active", tone: "good", where: "l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule')) AND l.lead_id IN (SELECT lead_id FROM offer_letters) AND (l.lead_id IN (SELECT lead_id FROM payments) OR l.lead_id IN (SELECT lead_id FROM offer_letters WHERE issued_at > date('now','-3 day')))" },
      { key: "expiring", label: "Expiring", tone: "bad", where: "l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule')) AND l.lead_id IN (SELECT lead_id FROM offer_letters WHERE issued_at <= date('now','-3 day')) AND l.lead_id NOT IN (SELECT lead_id FROM payments)", alertTitle: "Offer 3+ days old, seat not booked", action: "Close call before the offer lapses" },
    ],
  },
  {
    stage: "seat_payment", label: "Seat Book", tiles: [
      { key: "total_seatbooked", label: "Total seat booked", tone: "good", where: "l.lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status IN ('held','no_show','reschedule')) AND l.lead_id IN (SELECT lead_id FROM payments WHERE paid_at >= '2026-07-16')" },
    ],
  },
];

export function stageBreakdown(round: Round, src?: Src): StageBreakdown[] {
  const inc = inClause(round);
  const S = srcClause(src);
  return STAGE_BREAKDOWN.map((g) => ({
    stage: g.stage,
    label: g.label,
    tiles: g.tiles.map((t) => {
      let count: number | null = null;
      if (t.where) {
        count = int(db.prepare(`SELECT COUNT(*) n FROM leads l WHERE l.nsat_round IN (${inc})${S} AND ${t.where}`).get() as any);
      }
      return { key: t.key, label: t.label, count, tone: t.tone };
    }),
  }));
}
