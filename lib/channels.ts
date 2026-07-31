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
  /** total leads, not just registrations — only set on the source/UTM tables */
  leads?: number;
  /** "src:organic" / "utm:vedantu_yt_bca", for the &tag= drill */
  tag?: string;
}

export interface Attendance {
  all: AttendRow;
  byProgramme: AttendRow[];
  /** campaign_source, comma-split — DOUBLE COUNTS, does not sum to registrations */
  bySource: AttendRow[];
  /** utm_campaign, comma-split, only names above minUtmReg — also double counts */
  byUtm: AttendRow[];
  minUtmReg: number;
  /** called-vs-appeared, registered students only */
  calling: CalledAppeared | null;
  /** max(test_given_at) — this feed moves in batches, not continuously */
  lastSync: string | null;
}

function attendRow(key: string, label: string, where: string): AttendRow {
  // leads counts every lead in the slice; the rest only the registered ones, since
  // a lead who never registered was never due to give the test
  const r = db
    .prepare(
      `SELECT COUNT(*) leads,
              SUM(CASE WHEN registered='paid' THEN 1 ELSE 0 END) reg,
              SUM(CASE WHEN registered='paid' AND test_given='Test_Given' THEN 1 ELSE 0 END) g,
              SUM(CASE WHEN registered='paid' AND test_given='Test_Not_Appear' THEN 1 ELSE 0 END) ns,
              SUM(CASE WHEN registered='paid' AND nullif(test_given,'') IS NULL THEN 1 ELSE 0 END) unk
         FROM csat_map WHERE 1=1${where}`
    )
    .get() as Record<string, number>;
  return {
    key,
    label,
    leads: Number(r?.leads ?? 0),
    registered: Number(r?.reg ?? 0),
    given: Number(r?.g ?? 0),
    noShow: Number(r?.ns ?? 0),
    noStatus: Number(r?.unk ?? 0),
  };
}

/**
 * Attendance grouped by a comma-split tag (campaign_source or utm_campaign).
 *
 * Every value on a multi-value cell is credited, so a student who arrived via
 * "Influencers, Organic" counts under both. These tables therefore DOUBLE COUNT
 * and their columns do not add up to the registration total — that is intended,
 * and the UI says so under each table.
 *
 * Leads are counted DISTINCT per key, so a cell repeating a value in a different
 * case ('organic, Organic') still counts the lead once.
 */
function attendanceByTag(kind: "src" | "utm", where: string): AttendRow[] {
  const rows = db
    .prepare(
      `SELECT t.key,
              min(t.label) label,
              COUNT(DISTINCT t.lead_id) leads,
              COUNT(DISTINCT CASE WHEN m.registered='paid' THEN t.lead_id END) reg,
              COUNT(DISTINCT CASE WHEN m.registered='paid' AND m.test_given='Test_Given' THEN t.lead_id END) g,
              COUNT(DISTINCT CASE WHEN m.registered='paid' AND m.test_given='Test_Not_Appear' THEN t.lead_id END) ns,
              COUNT(DISTINCT CASE WHEN m.registered='paid' AND nullif(m.test_given,'') IS NULL THEN t.lead_id END) unk
         FROM csat_tag t JOIN csat_map m ON m.lead_id = t.lead_id
        WHERE t.kind = ?${where}
        GROUP BY t.key`
    )
    .all(kind) as Record<string, string | number>[];
  // Sources arrive with inconsistent casing ('organic' / 'Organic'), which is why
  // the key is lower-cased; capitalise the first character for display. UTM names
  // are tags and keep their exact casing.
  const disp = (v: string) => (kind === "src" && v && /^[a-z]/.test(v) ? v[0].toUpperCase() + v.slice(1) : v);
  return rows.map((r) => ({
    key: `${kind}_${String(r.key)}`,
    label: disp(String(r.label)),
    leads: Number(r.leads ?? 0),
    registered: Number(r.reg ?? 0),
    given: Number(r.g ?? 0),
    noShow: Number(r.ns ?? 0),
    noStatus: Number(r.unk ?? 0),
    tag: `${kind}:${String(r.key)}`,
  }));
}

// utm_campaign placeholders that are not campaign names, so not influencer rows
const UTM_PLACEHOLDER = new Set(["(not set)", "none", "null", "na", "n/a", "-"]);

export function csatAttendance(where = "", minUtmReg = 20): Attendance | null {
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

  // signup_programs holds 'BBA', 'BCA' or 'BBA,BCA' — the student's own choice.
  // Grouped over ALL leads, not just the paid ones, so a CRM-attributed lead that
  // never filled the form still appears (as "no signup") and the Leads column adds
  // up to the cohort instead of quietly dropping them.
  const progs = db
    .prepare(
      `SELECT coalesce(nullif(signup_programs,''),'(no signup)') p,
              COUNT(*) n,
              SUM(CASE WHEN registered='paid' THEN 1 ELSE 0 END) paid
         FROM csat_map WHERE 1=1${where} GROUP BY 1 ORDER BY paid DESC, n DESC`
    )
    .all() as { p: string; n: number; paid: number }[];

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

  const tagWhere = where.replace(/\bsignup_programs\b/g, "m.signup_programs")
                        .replace(/\bround_tag\b/g, "m.round_tag");
  // Sources: by volume. Keeps rows with leads but zero registrations — "this
  // source produced leads and nothing else" is a finding, not a gap.
  const bySource = attendanceByTag("src", tagWhere)
    .sort((a, b) => b.registered - a.registered || (b.leads ?? 0) - (a.leads ?? 0));
  // UTM names: by Appeared %, since a raw count just re-ranks by volume. Small
  // names are excluded or a 2-registration name lands on top at 50%.
  const byUtm = attendanceByTag("utm", tagWhere)
    .filter((r) => r.registered >= minUtmReg && !UTM_PLACEHOLDER.has(r.label.toLowerCase()))
    .sort((a, b) => b.given / b.registered - a.given / a.registered || b.registered - a.registered);

  return {
    all, byProgramme, bySource, byUtm, minUtmReg,
    calling: csatCalledVsAppeared(where),
    lastSync: ls?.d ?? null,
  };
}

// ---------------------------------------------------------------------------
// CSAT-1: did calling a registered student get them to sit the test?
//
// Population is REGISTERED students only. An unregistered lead was never due to
// sit the test, so including them would make calling look worse than it is.
//
// Reached by calling = human (connected_calls > 0) OR AI (>=1 ai_calls row with
// status 'completed'). Appeared = test_given 'Test_Given'.
//
// NOTE ON NULLS: test_given is NULL for 11 registered leads. "Not appeared" must
// treat NULL as not-appeared, otherwise SQL's three-valued logic drops those rows
// and the four Venn regions no longer add up to the cohort (886/451 instead of
// 891/457). Hence the CASE ... ELSE 0 form rather than NOT (x = 'Test_Given').
//
// Both reach signals are cumulative to date, not "called before the test", so
// this is association, not proof of cause. The UI says so.
// ---------------------------------------------------------------------------

export interface CalledAppeared {
  /** whole "reached by calling" circle */
  reached: number;
  /** whole "appeared" circle */
  appeared: number;
  /** the four mutually exclusive regions; they add to `total` */
  both: number;
  reachedNoShow: number;
  appearedUnreached: number;
  neither: number;
  total: number;
  /** by which channel reached them: exclusive, adds to `total` */
  channels: { key: string; label: string; registered: number; appeared: number }[];
}

export function csatCalledVsAppeared(where = ""): CalledAppeared | null {
  if (!tableReady("csat_map") || !tableReady("ai_reach")) return null;
  // per-lead flags, computed once
  const base = `
    SELECT CASE WHEN coalesce(m.connected_calls,0) > 0 THEN 1 ELSE 0 END hu,
           CASE WHEN EXISTS (
             SELECT 1 FROM ai_reach r
              WHERE r.cohort='CSAT-1' AND r.lead_id=m.lead_id AND r.reached=1
           ) THEN 1 ELSE 0 END ai,
           CASE WHEN m.test_given='Test_Given' THEN 1 ELSE 0 END app
      FROM csat_map m
     WHERE m.registered='paid'${where}`;
  const r = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN hu=1 OR ai=1 THEN 1 ELSE 0 END) reached,
              SUM(app) appeared,
              SUM(CASE WHEN (hu=1 OR ai=1) AND app=1 THEN 1 ELSE 0 END) both_n,
              SUM(CASE WHEN (hu=1 OR ai=1) AND app=0 THEN 1 ELSE 0 END) rns,
              SUM(CASE WHEN hu=0 AND ai=0 AND app=1 THEN 1 ELSE 0 END) aun,
              SUM(CASE WHEN hu=0 AND ai=0 AND app=0 THEN 1 ELSE 0 END) none_n,
              SUM(CASE WHEN hu=1 AND ai=1 THEN 1 ELSE 0 END) c_both,
              SUM(CASE WHEN hu=1 AND ai=1 AND app=1 THEN 1 ELSE 0 END) c_both_a,
              SUM(CASE WHEN hu=1 AND ai=0 THEN 1 ELSE 0 END) c_hu,
              SUM(CASE WHEN hu=1 AND ai=0 AND app=1 THEN 1 ELSE 0 END) c_hu_a,
              SUM(CASE WHEN ai=1 AND hu=0 THEN 1 ELSE 0 END) c_ai,
              SUM(CASE WHEN ai=1 AND hu=0 AND app=1 THEN 1 ELSE 0 END) c_ai_a,
              SUM(CASE WHEN hu=0 AND ai=0 THEN 1 ELSE 0 END) c_no,
              SUM(CASE WHEN hu=0 AND ai=0 AND app=1 THEN 1 ELSE 0 END) c_no_a
         FROM (${base})`
    )
    .get() as Record<string, number>;
  if (!r || !Number(r.total)) return null;
  const n = (k: string) => Number(r[k] ?? 0);
  const channels = [
    { key: "both", label: "Both AI and human", registered: n("c_both"), appeared: n("c_both_a") },
    { key: "hu", label: "Human only", registered: n("c_hu"), appeared: n("c_hu_a") },
    { key: "ai", label: "AI only", registered: n("c_ai"), appeared: n("c_ai_a") },
    { key: "no", label: "Nobody", registered: n("c_no"), appeared: n("c_no_a") },
  ]
    // sort by yield, so the ordering itself carries the finding
    .sort((a, b) =>
      (b.registered ? b.appeared / b.registered : 0) - (a.registered ? a.appeared / a.registered : 0)
    );
  return {
    reached: n("reached"),
    appeared: n("appeared"),
    both: n("both_n"),
    reachedNoShow: n("rns"),
    appearedUnreached: n("aun"),
    neither: n("none_n"),
    total: n("total"),
    channels,
  };
}
