import db from "./db";
import { progWhere } from "./queries";

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
  /** leads in this row whose source was inferred, not captured by the form */
  derived?: number;
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
              COUNT(DISTINCT CASE WHEN m.registered='paid' AND nullif(m.test_given,'') IS NULL THEN t.lead_id END) unk,
              0 derived
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

// ---------------------------------------------------------------------------
// CSAT-1 calling: did we dial this student, and if we dialled, did anyone speak
// to them. Human (CRM) and AI (Alchemyst) side by side, NEVER summed — the same
// student can be dialled by both.
//
// Every figure counts LEADS, not calls.
//
//   Leads
//    |- Dialled
//    |   |- Connected        we spoke to them
//    |   \- Not connected    we dialled, nobody picked up
//    |- Never dialled
//    \- No calling data      human channel only
//
// "No calling data" is total_calls IS NULL: the lead's CRM record predates the
// Redash dump behind lead_map, so the dump has no row for it. That means we do not
// know, which is NOT the same claim as "we never called". It stays its own bucket
// and is never folded into Never dialled. (Note the older act=never drill filter
// does merge the two — deliberately not reused here.)
//
// Connected is shown as a share of DIALLED, never of leads: the two channels dial
// very different numbers of people, so only that ratio compares them fairly.
// ---------------------------------------------------------------------------

export interface CallSide {
  dialled: number;
  connected: number;
  notConnected: number;
  neverDialled: number;
  /** human channel only; AI has no equivalent */
  noData: number | null;
}

export interface CallSegment {
  key: string;
  label: string;
  leads: number;
  human: CallSide;
  ai: CallSide;
}

export interface CsatCalling {
  all: CallSegment;
  segments: CallSegment[];
  /** max(ai_calls.called_at) — AI data loads on demand, not on a schedule */
  aiLastCall: string | null;
}

const AI_DIALLED = "m.lead_id IN (SELECT lead_id FROM ai_reach WHERE cohort='CSAT-1')";
const AI_CONN = "m.lead_id IN (SELECT lead_id FROM ai_reach WHERE cohort='CSAT-1' AND reached=1)";

function callSegment(key: string, label: string, where: string): CallSegment {
  const r = db
    .prepare(
      `SELECT COUNT(*) leads,
              SUM(CASE WHEN coalesce(m.total_calls,0) > 0 THEN 1 ELSE 0 END) h_d,
              SUM(CASE WHEN coalesce(m.connected_calls,0) > 0 THEN 1 ELSE 0 END) h_c,
              SUM(CASE WHEN coalesce(m.total_calls,0) > 0 AND coalesce(m.connected_calls,0) = 0 THEN 1 ELSE 0 END) h_n,
              SUM(CASE WHEN m.total_calls IS NULL THEN 1 ELSE 0 END) h_u,
              SUM(CASE WHEN m.total_calls IS NOT NULL AND m.total_calls = 0 THEN 1 ELSE 0 END) h_never,
              SUM(CASE WHEN ${AI_DIALLED} THEN 1 ELSE 0 END) a_d,
              SUM(CASE WHEN ${AI_CONN} THEN 1 ELSE 0 END) a_c
         FROM csat_map m WHERE 1=1${where}`
    )
    .get() as Record<string, number>;
  const n = (k: string) => Number(r?.[k] ?? 0);
  const leads = n("leads");
  const aD = n("a_d");
  return {
    key,
    label,
    leads,
    human: {
      dialled: n("h_d"),
      connected: n("h_c"),
      notConnected: n("h_n"),
      neverDialled: n("h_never"),
      noData: n("h_u"),
    },
    ai: {
      dialled: aD,
      connected: n("a_c"),
      notConnected: aD - n("a_c"),
      neverDialled: leads - aD,
      noData: null,
    },
  };
}

export function csatCalling(where = ""): CsatCalling | null {
  if (!tableReady("csat_map") || !tableReady("ai_reach")) return null;
  const all = callSegment("all", "All", where);
  if (all.leads === 0) return null;
  const last = db
    .prepare("SELECT max(last_call) d FROM ai_reach WHERE cohort='CSAT-1' AND last_call IS NOT NULL")
    .get() as { d: string | null } | undefined;
  return {
    all,
    segments: [
      callSegment("reg", "Registered", `${where} AND m.registered='paid'`),
      callSegment("unreg", "Not registered", `${where} AND coalesce(m.registered,'') <> 'paid'`),
      all,
    ],
    aiLastCall: last?.d ?? null,
  };
}

// ---------------------------------------------------------------------------
// CSAT-1 post-test: communication by channel, then did they turn up.
//
// Population: the 280 students who GAVE THE TEST. Post-test means after the exam,
// so the denominator is the people who actually sat it.
//
// Per channel, the tree the stakeholders asked for:
//
//   Touched                        a human dialled / AI dialled
//    |- Connected                  the call connected
//    |   |- turned up / did not turn up / rescheduled / not known
//    \- Not connected
//        \- turned up / ...
//   Not touched
//    \- turned up / ...
//
// Turn-up comes from the panelist form and nowhere else. FOUR states, not two:
// "to be rescheduled" is not a no-show, and "no response yet" (91 of 138 slot
// bookers) is not a no-show either. Merging either into "did not turn up" would
// invent no-shows that nobody recorded.
//
// Human touch counts are CUMULATIVE, not post-test-only: lead_map carries
// total_calls / connected_calls with no date breakdown, so a call made before the
// exam counts as a touch here. Stated on the page rather than silently implied.
// ---------------------------------------------------------------------------

/** The CSAT-1 test ran 30-31 Jul, so a call from 30 Jul onward is a post-test call.
 *  A single cutoff rather than each student's own test_date, as instructed. */
// ---------------------------------------------------------------------------
// Contact before the test, crossed with every funnel stage.
//
// The question this answers: of the students we reached before the test, how
// many carried through to each stage — and does reaching them change anything.
//
// CONTACT WINDOW is calls up to and including the test day. Contact after the
// test cannot explain whether someone sat the test, so it is excluded.
//
// Touched reads first_call_at, Connected reads first_conn_at, straight from the
// lead map. The invariant that a connected call is also a call is enforced in
// the data, not patched here, so Connected is always a subset of Touched.
//
// OFFER LETTER and SEAT BOOKED are gated on the lead having a panelist
// response. A CRM offer letter on a lead that never went through CSAT
// counselling is a lead-level outcome, not a CSAT funnel outcome.
//
// Human and AI are two separate tables and are never added: the same student
// is dialled by both.
// ---------------------------------------------------------------------------

/** end of the test day, exclusive — contact at or after this is post-test */
export const PRE_TEST_CUT = "2026-07-31";

export interface StageCell { n: number; pct: number | null; drill: string }
export interface ContactRow {
  key: string;
  label: string;
  indent?: boolean;
  strong?: boolean;
  cells: StageCell[];
}
export interface ContactFunnel {
  key: "human" | "ai";
  label: string;
  note: string;
  rows: ContactRow[];
}

const STAGES: { key: string; label: string; cond: string; drill: string }[] = [
  { key: "lead",  label: "Lead",        cond: "1=1", drill: "fstage=lead" },
  { key: "reg",   label: "Registered",  cond: "m.registered='paid'", drill: "fstage=reg" },
  { key: "test",  label: "Test given",  cond: "m.test_given='Test_Given'", drill: "fstage=test" },
  { key: "slot",  label: "Slot booked",
    cond: "m.lead_id IN (SELECT lead_id FROM csat_slots)",
    drill: "fstage=slot" },
  { key: "couns", label: "Counselled",
    cond: "m.lead_id IN (SELECT lead_id FROM csat_outcome WHERE status LIKE 'Happening%')",
    drill: "fstage=couns" },
  { key: "ol",    label: "OL released",
    cond: "m.lead_id IN (SELECT lead_id FROM csat_outcome) AND nullif(m.offer_letter,'') IS NOT NULL",
    drill: "fstage=ol" },
  { key: "sb",    label: "Seat booked",
    cond: "m.lead_id IN (SELECT lead_id FROM csat_outcome) AND m.seat_booked='Yes'",
    drill: "fstage=sb" },
];

const H = {
  conn:    `m.first_conn_at IS NOT NULL AND m.first_conn_at < '${PRE_TEST_CUT}'`,
  touched: `m.first_call_at IS NOT NULL AND m.first_call_at < '${PRE_TEST_CUT}'`,
  hasRow:  "m.total_calls IS NOT NULL",
};
const A = {
  conn:    `EXISTS (SELECT 1 FROM ai_reach a WHERE a.cohort='CSAT-1' AND a.lead_id=m.lead_id AND a.first_conn IS NOT NULL AND a.first_conn < '${PRE_TEST_CUT}')`,
  touched: `EXISTS (SELECT 1 FROM ai_reach a WHERE a.cohort='CSAT-1' AND a.lead_id=m.lead_id AND a.first_call IS NOT NULL AND a.first_call < '${PRE_TEST_CUT}')`,
};

/** SQL predicates for the contact buckets of one channel */
function buckets(channel: "human" | "ai"): { key: string; label: string; cond: string; indent?: boolean; strong?: boolean; drill: string }[] {
  const p = channel === "human" ? "pt" : "pta";
  if (channel === "ai") {
    return [
      { key: "touched",    label: "Touched",        cond: A.touched, strong: true, drill: `${p}=touched` },
      { key: "conn",       label: "Connected",      cond: `${A.touched} AND ${A.conn}`, indent: true, drill: `${p}=conn` },
      { key: "notconn",    label: "Not connected",  cond: `${A.touched} AND NOT (${A.conn})`, indent: true, drill: `${p}=noconn` },
      { key: "nottouched", label: "Not touched",    cond: `NOT (${A.touched})`, strong: true, drill: `${p}=never` },
    ];
  }
  return [
    { key: "touched",    label: "Touched",           cond: H.touched, strong: true, drill: `${p}=touched` },
    { key: "conn",       label: "Connected",         cond: `${H.touched} AND ${H.conn}`, indent: true, drill: `${p}=conn` },
    { key: "notconn",    label: "Not connected",     cond: `${H.touched} AND NOT (${H.conn})`, indent: true, drill: `${p}=noconn` },
    { key: "nottouched", label: "Not touched",       cond: `${H.hasRow} AND NOT (${H.touched})`, strong: true, drill: `${p}=never` },
    { key: "norec",      label: "No calling record", cond: `NOT (${H.hasRow})`, drill: `${p}=nodata` },
  ];
}

export function contactFunnel(where = "", prog?: string | null): ContactFunnel[] | null {
  if (!tableReady("csat_map")) return null;
  const pw = progWhere(prog, "m");
  const count = (cond: string) => int(db.prepare(
    `SELECT COUNT(*) n FROM csat_map m WHERE ${cond}${where}${pw}`
  ).get());

  const build = (channel: "human" | "ai", label: string, note: string): ContactFunnel => {
    const bs = buckets(channel);
    // Total is every lead, so the column sums are visible against it.
    const all: ContactRow = {
      key: "total", label: "Total", strong: true,
      cells: STAGES.map((s) => ({ n: count(s.cond), pct: null, drill: s.drill })),
    };
    const rows = bs.map((b) => {
      const cells = STAGES.map((s) => ({
        n: count(`(${b.cond}) AND (${s.cond})`),
        pct: null as number | null,
        drill: `${b.drill}&${s.drill}`,
      }));
      return { key: b.key, label: b.label, indent: b.indent, strong: b.strong, cells };
    });
    // Progressive: each stage against the stage before it, within the same row.
    for (const r of [all, ...rows]) {
      for (let i = 1; i < r.cells.length; i++) {
        const prev = r.cells[i - 1].n;
        r.cells[i].pct = prev > 0 ? Math.round((r.cells[i].n / prev) * 100) : null;
      }
    }
    return { key: channel, label, note, rows: [all, ...rows] };
  };

  const out = [
    build("human", "Human calling (CRM)",
      "contact up to the test day, from the CRM call log"),
    build("ai", "AI calling (Alchemyst)",
      "contact up to the test day, from per-call Alchemyst records"),
  ];
  return out[0].rows[0].cells[0].n > 0 ? out : null;
}

export const CONTACT_STAGE_LABELS = STAGES.map((s) => s.label);
