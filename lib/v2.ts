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
  if (round === "NSAT-2" || round === "NSAT-3" || round === "NSAT-4") return [round];
  return ["NSAT-2", "NSAT-3", "NSAT-4"];
}
export function roundOptions(ctx: Ctx): string[] {
  return ctx === "CSAT" ? ["BBA", "BCA", "Combined"] : ["NSAT-2", "NSAT-3", "NSAT-4"];
}
// No "All": rounds are separate cohorts. Default = the running round.
export function defaultRound(ctx: Ctx): string {
  return ctx === "CSAT" ? "BBA" : "NSAT-3";
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
  return {
    leads: q(`SELECT COUNT(*) n FROM leads WHERE nsat_round IN (${inc})`),
    paid: q(`SELECT COUNT(DISTINCT lead_id) n FROM registrations WHERE nsat_round IN (${inc})`),
    appeared: q(jl("test_results", " AND x.appeared=1")),
    pass: q(jl("test_results", " AND x.result='pass'")),
    fail: q(jl("test_results", " AND x.result='fail'")),
    slotBooked: q(jl("counselling_sessions", " AND x.scheduled_at IS NOT NULL")),
    held: q(jl("counselling_sessions", " AND x.status='held'")),
    offers: q(jl("offer_letters", COH)),
    seats: q(jl("payments", " AND x.paid_at >= '2026-07-16'" + COH)),
  };
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
  if (ctx === "CSAT") {
    const defs: [string, string, string, Leak["tone"]][] = [
      ["csat_unpaid", "Lead, payment pending", "filled the form but has not paid yet", "warn"],
      ["csat_unpaid_24h", "Payment pending 24h+", "a day gone since signup, still unpaid", "bad"],
    ];
    return defs.map(([key, title, desc, tone]) => ({ key, title, desc, tone, count: c(key) }));
  }
  const defs: [string, string, string, Leak["tone"]][] = [
    ["pass_no_slot", "Passed, no counselling slot", "cleared the test but nobody booked them", "bad"],
    ["slot_no_outcome", "Slot passed, no outcome", "slot day is gone and the panelist never responded", "warn"],
    ["held_no_offer", `Counselled ${SLA.heldToOffer}+ days, no offer`, "said yes to us, offer still not launched", "bad"],
    ["offer_expiring", `Offer ${SLA.offerToSeat}+ days old, unbooked`, "offer window lapsing without a seat", "bad"],
    ["no_show_open", "No-show / reschedule, open", "missed counselling and nothing rebooked yet", "warn"],
    ["untouched_48h", "Passed + silent 48h", "no call, no session, nothing in two days", "bad"],
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
