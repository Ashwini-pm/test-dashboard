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
