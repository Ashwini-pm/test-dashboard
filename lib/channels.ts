import db from "./db";

// ---------------------------------------------------------------------------
// AI calling vs human calling.
//
// These are two SEPARATE CHANNELS, not two steps of a funnel. The same student
// can be reached by both, so "AI reached" + "human reached" double counts and is
// never shown. Everything here is expressed as four mutually exclusive buckets
// that always add back to the row's total:
//
//   both        reached by AI and by a human
//   aiOnly      reached by AI, never by a human
//   humanOnly   reached by a human, never by AI
//   nobody      reached by neither
//
// reached by AI    = >=1 ai_calls row with status 'completed' (a conversation).
//                    Other statuses are attempts that never connected.
// reached by human = connected_calls > 0 on the lead map (from the CRM).
//
// Joins are on the lead ids already resolved onto the ai_calls row
// (nsat4_lead_id / csat1_lead_id) — never on phone.
// ---------------------------------------------------------------------------

export type ChannelCohort = "NSAT-4" | "CSAT-1";

export interface ChannelRow {
  key: string;
  label: string;
  total: number;
  both: number;
  aiOnly: number;
  humanOnly: number;
  nobody: number;
  /** query string for the drill-down, appended to the caller's base */
  drill?: string;
}

export interface ChannelSplit {
  cohort: ChannelCohort;
  scope: string;
  rows: ChannelRow[];
  /** the "All leads" row, kept separate for the Venn */
  all: ChannelRow;
  reachedAny: number;
  nobody: number;
}

const int = (row: unknown): number => Number((row as { n?: number } | undefined)?.n ?? 0);
const tableReady = (t: string): boolean => {
  try {
    if (!int(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='${t}'`).get()))
      return false;
    return int(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()) > 0;
  } catch {
    return false;
  }
};

/** Is the AI-call feed loaded for this cohort? */
export function channelsReady(cohort: ChannelCohort): boolean {
  const map = cohort === "NSAT-4" ? "nsat4_map" : "csat_map";
  return tableReady("ai_reach") && tableReady(map);
}

// Per cohort: the lead universe, and how a registration is spelled on it.
const SRC: Record<ChannelCohort, { map: string; regCol: string }> = {
  "NSAT-4": { map: "nsat4_map", regCol: "registered" },
  "CSAT-1": { map: "csat_map", regCol: "registered" },
};

/**
 * One row of the four buckets for an arbitrary slice of the cohort.
 * `extra` is additional SQL on the map alias `m` (e.g. " AND m.registered='paid'").
 */
function bucketRow(
  cohort: ChannelCohort,
  key: string,
  label: string,
  extra: string,
  drill?: string
): ChannelRow {
  const { map } = SRC[cohort];
  // ai = did AI ever have a conversation with this lead; human = CRM connected
  const sql = `
    SELECT COUNT(*) total,
           SUM(CASE WHEN ai=1 AND hu=1 THEN 1 ELSE 0 END) both_n,
           SUM(CASE WHEN ai=1 AND hu=0 THEN 1 ELSE 0 END) ai_n,
           SUM(CASE WHEN ai=0 AND hu=1 THEN 1 ELSE 0 END) hu_n,
           SUM(CASE WHEN ai=0 AND hu=0 THEN 1 ELSE 0 END) none_n
      FROM (
        SELECT CASE WHEN EXISTS (
                 SELECT 1 FROM ai_reach r
                  WHERE r.cohort='${cohort}' AND r.lead_id=m.lead_id AND r.reached=1
               ) THEN 1 ELSE 0 END ai,
               CASE WHEN coalesce(m.connected_calls,0) > 0 THEN 1 ELSE 0 END hu
          FROM ${map} m
         WHERE 1=1${extra}
      )`;
  const r = db.prepare(sql).get() as Record<string, number>;
  return {
    key,
    label,
    total: Number(r?.total ?? 0),
    both: Number(r?.both_n ?? 0),
    aiOnly: Number(r?.ai_n ?? 0),
    humanOnly: Number(r?.hu_n ?? 0),
    nobody: Number(r?.none_n ?? 0),
    drill,
  };
}

/**
 * The whole view for one cohort. `where` narrows CSAT-1 to a signup page when the
 * round pills select BBA / BCA / Combined; it is "" for the full cohort.
 */
export function channelSplit(
  cohort: ChannelCohort,
  where = "",
  scope = ""
): ChannelSplit | null {
  if (!channelsReady(cohort)) return null;
  const { regCol } = SRC[cohort];
  // csat_map carries signup_tables-style scoping through `where`; it arrives
  // already prefixed with " AND ..." and aliased to m by the caller's convention.
  const paid = ` AND m.${regCol}='paid'`;
  const notPaid = ` AND coalesce(m.${regCol},'') <> 'paid'`;

  const rows: ChannelRow[] = [
    bucketRow(cohort, "all", "All leads", where, ""),
    bucketRow(cohort, "reg", "Registered", where + paid, "reg=paid"),
    bucketRow(cohort, "unreg", "Not registered", where + notPaid, "reg=unpaid"),
  ];

  if (cohort === "NSAT-4") {
    rows.push(
      bucketRow(cohort, "pass", "Passed the test", `${where} AND lower(coalesce(m.test_result,''))='pass'`, "pstage=pass"),
      // a lead counts as booked when it has a counselling row with a booking_id
      bucketRow(cohort, "slot", "Counselling booked", `${where} AND m.lead_id IN (SELECT lead_id FROM nsat4_slots)`, "pstage=slot")
    );
  }

  const all = rows[0];
  return {
    cohort,
    scope,
    rows,
    all,
    reachedAny: all.both + all.aiOnly + all.humanOnly,
    nobody: all.nobody,
  };
}

/** Which cohort does the top-bar round map onto? Null where there is no AI feed. */
export function channelCohortForRound(
  ctx: "NSAT" | "CSAT",
  round?: string | null
): { cohort: ChannelCohort; where: string; scope: string } | null {
  if (ctx === "CSAT") {
    // csat_map splits the pages by round_tag, matching the round pills
    if (round === "BBA") return { cohort: "CSAT-1", where: " AND m.round_tag='CSAT-BBA'", scope: "BBA page" };
    if (round === "BCA") return { cohort: "CSAT-1", where: " AND m.round_tag='CSAT-BCA'", scope: "BCA page" };
    if (round === "Combined") return { cohort: "CSAT-1", where: " AND m.round_tag='CSAT-COMB'", scope: "Combined page" };
    return { cohort: "CSAT-1", where: "", scope: "all CSAT-1" };
  }
  if (round === "NSAT-4") return { cohort: "NSAT-4", where: "", scope: "all NSAT-4" };
  return null; // no AI-call mapping for NSAT-2 / 3 / 5
}

// ---------------------------------------------------------------------------
// CSAT-1 test attendance (lead_map.test_given)
//
// Test_Given      sat the test
// Test_Not_Appear registered for it and did not sit it   <- the actionable number
// NULL            no status on record yet                <- NOT a no-show
//
// The last two are never merged: one says the student skipped, the other says we
// do not know. Attendance is a share of REGISTRATIONS, since an unregistered lead
// was never due to sit the test.
// ---------------------------------------------------------------------------

export interface AttendRow {
  key: string;
  label: string;
  registered: number;
  given: number;
  noShow: number;
  noStatus: number;
  /** raw signup_programs value, for the &sprog= drill; absent on the total row */
  prog?: string;
}

export interface Attendance {
  all: AttendRow;
  byProgramme: AttendRow[];
  /** max(test_given_at) — this feed moves in batches, not continuously */
  lastSync: string | null;
}

function attendRow(key: string, label: string, where: string): AttendRow {
  const r = db
    .prepare(
      `SELECT COUNT(*) reg,
              SUM(CASE WHEN test_given='Test_Given' THEN 1 ELSE 0 END) g,
              SUM(CASE WHEN test_given='Test_Not_Appear' THEN 1 ELSE 0 END) ns,
              SUM(CASE WHEN nullif(test_given,'') IS NULL THEN 1 ELSE 0 END) unk
         FROM csat_map WHERE registered='paid'${where}`
    )
    .get() as Record<string, number>;
  return {
    key,
    label,
    registered: Number(r?.reg ?? 0),
    given: Number(r?.g ?? 0),
    noShow: Number(r?.ns ?? 0),
    noStatus: Number(r?.unk ?? 0),
  };
}

export function csatAttendance(where = ""): Attendance | null {
  if (!tableReady("csat_map")) return null;
  let cols: { name: string }[] = [];
  try {
    cols = db.prepare("PRAGMA table_info(csat_map)").all() as { name: string }[];
  } catch {
    return null;
  }
  if (!cols.some((c) => c.name === "test_given")) return null;

  const all = attendRow("all", "All CSAT-1", where);
  if (all.registered === 0) return null;

  // signup_programs holds 'BBA', 'BCA' or 'BBA,BCA' — the student's own choice
  const progs = db
    .prepare(
      `SELECT coalesce(nullif(signup_programs,''),'(no signup)') p, COUNT(*) n
         FROM csat_map WHERE registered='paid'${where} GROUP BY 1 ORDER BY n DESC`
    )
    .all() as { p: string; n: number }[];

  const label = (p: string) => (p === "BBA,BCA" ? "BBA + BCA" : p);
  const byProgramme = progs.map((r) => ({
    ...attendRow(
      `prog_${r.p}`,
      label(r.p),
      `${where} AND coalesce(nullif(signup_programs,''),'(no signup)') = '${r.p.replace(/'/g, "''")}'`
    ),
    prog: r.p === "(no signup)" ? "__none__" : r.p,
  }));

  const ls = db
    .prepare(`SELECT max(test_given_at) d FROM csat_map WHERE nullif(test_given_at,'') IS NOT NULL`)
    .get() as { d: string | null } | undefined;

  return { all, byProgramme, lastSync: ls?.d ?? null };
}
