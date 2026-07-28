import db from "./db";

// ---------------------------------------------------------------------------
// Cohort dashboard: NSAT-4 and CSAT-1, read from the prepared lead maps.
// ---------------------------------------------------------------------------
// THE RULE: the CRM lead id is the only key. Nothing here joins or dedupes on
// email or phone, and a signup with no lead id is not in the map at all.
//
// Each universe has two arms that add to the total:
//   signup     = filled that test's own form   (origin both | capture_only)
//   attributed = never filled it, but landed in the CRM inside the window on
//                the right program from an owned source (origin crm_only)
//
// "Not called" and "no call data" are DIFFERENT. total_calls = 0 means we have a
// CRM dump row and it shows zero attempts. total_calls IS NULL means there is no
// dump row at all, so calls are unknown. Never merge them.

export type CohortKey = "NSAT-4" | "NSAT-5" | "CSAT-1";

export interface CohortMeta {
  key: CohortKey;
  table: string;
  label: string;
  window: string;
  closed: boolean;
  refresh: string;
  programCol: string | null; // CSAT-1 splits by program; NSAT-4 is B.Tech only
  hasPaidAt: boolean;        // registrations-over-time needs paid_at (NSAT-4 only)
}

export const COHORTS: Record<CohortKey, CohortMeta> = {
  "NSAT-4": {
    key: "NSAT-4",
    table: "cohort_nsat4",
    label: "NSAT-4",
    window: "14 Jul 2026 15:30 IST → 27 Jul 2026 15:30 IST",
    closed: true,
    refresh: "every 5 minutes",
    programCol: null,
    hasPaidAt: true,
  },
  "NSAT-5": {
    key: "NSAT-5",
    table: "cohort_nsat5",
    label: "NSAT-5",
    window: "opens 27 Jul 2026 15:30 IST (NSAT-4 cutoff)",
    closed: false,
    refresh: "automatic",
    programCol: null,
    hasPaidAt: true,
  },
  "CSAT-1": {
    key: "CSAT-1",
    table: "cohort_csat1",
    label: "CSAT-1",
    window: "opens 20 Jul 2026",
    closed: false,
    refresh: "every 10 minutes",
    programCol: "signup_programs",
    hasPaidAt: false,
  },
};

export function parseCohort(v: string | undefined | null): CohortKey {
  if (v === "CSAT-1" || v === "NSAT-5") return v;
  return "NSAT-4";
}
export const COHORT_ORDER: CohortKey[] = ["NSAT-4", "NSAT-5", "CSAT-1"];

const int = (row: any): number => Number((row && (row.n ?? row)) || 0);
const has = (t: string): boolean => {
  try {
    if (!int(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='${t}'`).get() as any)) return false;
    return int(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any) > 0;
  } catch { return false; }
};
export const cohortReady = (k: CohortKey): boolean => has(COHORTS[k].table);
const q = (sql: string): number => { try { return int(db.prepare(sql).get() as any); } catch { return 0; } };
const rows = <T>(sql: string): T[] => { try { return db.prepare(sql).all() as T[]; } catch { return []; } };

// The two arms, and the headline counts.
export interface Overview {
  total: number; signup: number; attributed: number;
  registrations: number; pending: number;
  offerLetters: number; seats: number;
  noCallData: number;
}
export function overview(k: CohortKey, where = ""): Overview {
  const t = COHORTS[k].table;
  const c = (cond: string) => q(`SELECT COUNT(*) n FROM ${t} WHERE ${cond}${where}`);
  return {
    total: c("1=1"),
    signup: c("origin IN ('both','capture_only')"),
    attributed: c("origin = 'crm_only'"),
    registrations: c("registered = 'paid'"),
    pending: c("registered = 'pending'"),
    offerLetters: c("nullif(offer_letter,'') IS NOT NULL"),
    seats: c("seat_booked = 'Yes'"),
    noCallData: c("total_calls IS NULL"),
  };
}

// Every calling metric, split three mutually exclusive ways. The last two rows
// must add back to the first — that is the point of the view: where is the
// calling effort actually going.
export interface CallRow {
  key: string; label: string;
  leads: number; called: number; connected: number;
  notCalled: number; noData: number; attempts: number;
}
export function callingSplit(k: CohortKey, where = ""): CallRow[] {
  const t = COHORTS[k].table;
  const seg: [string, string, string][] = [
    ["all", "All leads", "1=1"],
    ["unreg", "Not registered", "registered <> 'paid'"],
    ["reg", "Registered", "registered = 'paid'"],
  ];
  return seg.map(([key, label, cond]) => {
    const c = (extra: string) => q(`SELECT COUNT(*) n FROM ${t} WHERE ${cond}${extra}${where}`);
    return {
      key, label,
      leads: c(""),
      called: c(" AND total_calls > 0"),
      connected: c(" AND connected_calls > 0"),
      notCalled: c(" AND total_calls = 0"),
      noData: c(" AND total_calls IS NULL"),
      attempts: q(`SELECT coalesce(sum(total_calls),0) n FROM ${t} WHERE ${cond}${where}`),
    };
  });
}

// campaign_source is mixed case in the source data (Influencers / influencers),
// so lowercase before grouping, then present a tidy label.
const TIDY: Record<string, string> = {
  influencers: "Influencers", organic: "Organic", orgainic: "Organic",
  direct: "Direct", inbound: "Inbound", others: "Others",
  sp_auto_dm: "Influencers (auto DM)", moengage: "MoEngage",
  google_lg_web_new_age: "Google (new age)", lead_nurturing_2026: "Lead nurturing",
};
const tidy = (s: string) => TIDY[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : "(none)");

export interface SourceRow {
  src: string; leads: number; registrations: number;
  called: number; connected: number; attributed: number;
}
export function bySource(k: CohortKey, col: "campaign_source" | "crm_source_category", where = ""): SourceRow[] {
  const t = COHORTS[k].table;
  const g = `lower(trim(coalesce(nullif(${col},''),'(none)')))`;
  const r = rows<{ s: string; leads: number; reg: number; called: number; conn: number; attr: number }>(
    `SELECT ${g} s, COUNT(*) leads,
            SUM(CASE WHEN registered='paid' THEN 1 ELSE 0 END) reg,
            SUM(CASE WHEN total_calls > 0 THEN 1 ELSE 0 END) called,
            SUM(CASE WHEN connected_calls > 0 THEN 1 ELSE 0 END) conn,
            SUM(CASE WHEN origin='crm_only' THEN 1 ELSE 0 END) attr
       FROM ${t} WHERE 1=1${where} GROUP BY 1 ORDER BY leads DESC`
  );
  // fold the tidied labels together (influencers + Influencers + sp_auto_dm)
  const merged = new Map<string, SourceRow>();
  for (const x of r) {
    const label = tidy(x.s);
    const cur = merged.get(label) ?? { src: label, leads: 0, registrations: 0, called: 0, connected: 0, attributed: 0 };
    cur.leads += Number(x.leads); cur.registrations += Number(x.reg);
    cur.called += Number(x.called); cur.connected += Number(x.conn);
    cur.attributed += Number(x.attr);
    merged.set(label, cur);
  }
  return [...merged.values()].sort((a, b) => b.leads - a.leads);
}

// CSAT-1 only: BBA / BCA / both.
export interface ProgramRow {
  program: string; leads: number; signup: number; attributed: number;
  registrations: number; called: number; connected: number; noData: number;
}
export function byProgram(k: CohortKey): ProgramRow[] {
  const meta = COHORTS[k];
  if (!meta.programCol) return [];
  const t = meta.table, pc = meta.programCol;
  return rows<ProgramRow>(
    `SELECT coalesce(nullif(${pc},''),'(no program)') program,
            COUNT(*) leads,
            SUM(CASE WHEN origin IN ('both','capture_only') THEN 1 ELSE 0 END) signup,
            SUM(CASE WHEN origin='crm_only' THEN 1 ELSE 0 END) attributed,
            SUM(CASE WHEN registered='paid' THEN 1 ELSE 0 END) registrations,
            SUM(CASE WHEN total_calls > 0 THEN 1 ELSE 0 END) called,
            SUM(CASE WHEN connected_calls > 0 THEN 1 ELSE 0 END) connected,
            SUM(CASE WHEN total_calls IS NULL THEN 1 ELSE 0 END) noData
       FROM ${t} GROUP BY 1 ORDER BY leads DESC`
  ).map((r) => ({ ...r, leads: Number(r.leads) }));
}

// Registrations over time uses paid_at (when they actually paid), not signup.
export interface DayRow { day: string; n: number }
export function registrationsByDay(k: CohortKey): DayRow[] {
  const meta = COHORTS[k];
  if (!meta.hasPaidAt) return [];
  return rows<DayRow>(
    `SELECT date(paid_at) day, COUNT(*) n FROM ${meta.table}
      WHERE registered='paid' AND paid_at IS NOT NULL GROUP BY 1 ORDER BY 1`
  ).map((r) => ({ day: String(r.day), n: Number(r.n) }));
}

// Counsellor coverage — who is actually working the cohort.
export interface CounsellorRow { name: string; leads: number; called: number; connected: number; registrations: number }
export function byCounsellor(k: CohortKey, limit = 12): CounsellorRow[] {
  const t = COHORTS[k].table;
  return rows<CounsellorRow>(
    `SELECT coalesce(nullif(trim(counsellor),''),'(unassigned)') name,
            COUNT(*) leads,
            SUM(CASE WHEN total_calls > 0 THEN 1 ELSE 0 END) called,
            SUM(CASE WHEN connected_calls > 0 THEN 1 ELSE 0 END) connected,
            SUM(CASE WHEN registered='paid' THEN 1 ELSE 0 END) registrations
       FROM ${t} GROUP BY 1 ORDER BY leads DESC LIMIT ${limit}`
  ).map((r) => ({ ...r, leads: Number(r.leads) }));
}

export function lastRefreshed(k: CohortKey): string | null {
  const t = COHORTS[k].table;
  try {
    const r = db.prepare(`SELECT MAX(refreshed_at) v FROM ${t}`).get() as any;
    return r?.v ? String(r.v) : null;
  } catch { return null; }
}
