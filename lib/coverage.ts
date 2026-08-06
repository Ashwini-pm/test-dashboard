import db from "./db";

// ---------------------------------------------------------------------------
// Data coverage audit.
//
// The recurring failure this exists to kill: the pipeline adds a table or a
// column, it lands with RLS on and no read policy, the dashboard silently reads
// zero, and nobody notices until a human spots a blank row on a page. That has
// happened with nsat4_counselling, nsat4_lead_map.test_result, lead_map.test_given
// and csat_counselling.
//
// Rendered at /coverage. Two checks the app runs against itself:
//   1. every table the anon key can see in the project vs the ones we pull
//   2. every table we pull vs whether it actually landed with rows
//
// It answers "what data exists that we are not showing" without anyone having to
// look at a dashboard page and notice something missing.
// ---------------------------------------------------------------------------

/** Tables fetched from the NSAT CSAT project, and what the dashboard uses each for. */
export const PULLED: Record<string, string> = {
  nsat4: "NSAT-4 raw signups",
  bba: "CSAT BBA signups",
  bca: "CSAT BCA signups",
  combined: "CSAT Combined signups",
  nsat3_lead_map: "NSAT-3 lead map",
  lead_map: "CSAT-1 lead map",
  nsat4_lead_map: "NSAT-4 lead map",
  nsat5_lead_map: "NSAT-5 lead map",
  nsat4_counselling: "NSAT-4 counselling slots",
  csat_counselling: "CSAT-1 counselling slots",
  csat_counselling_outcomes: "CSAT-1 panelist outcomes (counselling attendance)",
  nsat_counselling_outcomes: "NSAT-4 panelist outcomes (counselling attendance, gates OL and seats)",
  ai_calls: "AI calling (narrowed to cohort leads)",
};

/** Tables we deliberately ignore, with the reason, so they are not flagged forever. */
export const IGNORED: Record<string, string> = {
  app_secrets: "credentials, never read by the dashboard",
  sync_state: "pipeline bookkeeping",
  sync_watermarks: "pipeline bookkeeping",
  influencer_views: "reel view counts, not part of the funnel",
  "nsat 1_4": "historical NSAT 1-4 export, superseded by the round lead maps",
  lovable_leads_bba: "raw mirror of bba",
  lovable_leads_bca: "raw mirror of bca",
  lovable_leads_combined: "raw mirror of combined",
  lovable_leads_nsat4: "raw mirror of nsat4",
  lovable_leads_nsat5: "raw mirror, NSAT-5 signups",
  crm_leads_6756: "CRM dump, already reconciled into lead_map",
  crm_leads_6757: "CRM dump, already reconciled into nsat3_lead_map",
  crm_leads_6778: "CRM dump, already reconciled into nsat4/5_lead_map",
  nsat4_manual_leads: "pipeline input to nsat4_lead_map",
  nsat4_parked_leads: "pipeline input to nsat4_lead_map",
  nsat4_test_results: "test scores; outcome already on nsat4_lead_map.test_result",
  nsat4_seat_bookings: "seat bookings; already written onto nsat4_lead_map",
  panelist_ol_sb: "panelist OL/SB feed; the map's offer_letter and seat_booked are the authority",
};

export interface TableStatus {
  table: string;
  /** readable by the anon key */
  readable: boolean;
  /** rows the anon key can actually see */
  rows: number | null;
  state: "ok" | "unreadable" | "empty" | "not-pulled" | "ignored";
  note: string;
}

/**
 * Ask PostgREST what the anon key can see, then compare with what we pull.
 * The OpenAPI root lists every table exposed to the key, so a new table appears
 * here the moment it gets a read policy.
 */
export async function auditTables(): Promise<TableStatus[]> {
  const url = process.env.CSAT_SUPABASE_URL;
  const key = process.env.CSAT_SUPABASE_ANON_KEY;
  if (!url || !key) return [];
  const H = { apikey: key, Authorization: `Bearer ${key}` };

  let exposed: string[] = [];
  try {
    const res = await fetch(`${url}/rest/v1/`, { headers: H, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const spec = (await res.json()) as { paths?: Record<string, unknown> };
      exposed = Object.keys(spec.paths ?? {})
        .filter((p) => p.startsWith("/") && p.length > 1 && !p.startsWith("/rpc/"))
        .map((p) => p.slice(1));
    }
  } catch {
    /* leave exposed empty; the pulled-table check below still runs */
  }

  const counts = await Promise.all(
    [...new Set([...Object.keys(PULLED), ...exposed])].map(async (t) => {
      try {
        const res = await fetch(`${url}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`, {
          headers: { ...H, Prefer: "count=exact", Range: "0-0" },
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return [t, null] as const;
        return [t, Number((res.headers.get("content-range") || "").split("/")[1] || 0)] as const;
      } catch {
        return [t, null] as const;
      }
    })
  );

  return counts
    .map(([table, rows]): TableStatus => {
      const pulled = table in PULLED;
      const ignored = table in IGNORED;
      if (rows === null)
        return {
          table, readable: false, rows: null,
          state: "unreadable",
          note: pulled
            ? "WE PULL THIS AND CANNOT READ IT — check for a missing anon read policy"
            : "not readable by the anon key",
        };
      if (pulled && rows === 0)
        return { table, readable: true, rows, state: "empty", note: "we pull this but it is empty" };
      if (pulled) return { table, readable: true, rows, state: "ok", note: PULLED[table] };
      if (ignored) return { table, readable: true, rows, state: "ignored", note: IGNORED[table] };
      return {
        table, readable: true, rows,
        state: "not-pulled",
        note: `${rows.toLocaleString("en-IN")} rows readable and NOT used by the dashboard — decide whether to map it`,
      };
    })
    .sort((a, b) => {
      const rank = { unreadable: 0, "not-pulled": 1, empty: 2, ok: 3, ignored: 4 } as const;
      return rank[a.state] - rank[b.state] || a.table.localeCompare(b.table);
    });
}

/**
 * Rows in a feed whose lead_id is not in the lead map, so every map-scoped view
 * silently drops them. This is why Slot booked read 138 against 139 in the sheet.
 */
export function auditOrphans(): { feed: string; orphans: number; note: string }[] {
  const checks: [string, string, string][] = [
    ["csat_slots", "csat_map", "CSAT-1 counselling slots"],
    ["csat_outcome", "csat_map", "CSAT-1 panelist outcomes"],
    ["nsat_outcome", "nsat4_map", "NSAT-4 panelist outcomes"],
    ["nsat4_slots", "nsat4_map", "NSAT-4 counselling slots"],
  ];
  const out: { feed: string; orphans: number; note: string }[] = [];
  for (const [feed, map, label] of checks) {
    try {
      const r = db.prepare(
        `SELECT COUNT(DISTINCT lead_id) n FROM ${feed} WHERE lead_id NOT IN (SELECT lead_id FROM ${map})`
      ).get() as { n: number };
      if (r?.n > 0)
        out.push({
          feed,
          orphans: r.n,
          note: `${r.n} lead${r.n === 1 ? "" : "s"} in ${label} are not in ${map}, so every view scoped to the map drops them`,
        });
    } catch { /* table missing: the memory audit already reports that */ }
  }
  return out;
}

/** In-memory tables the hydrate is meant to build, and whether they have rows. */
export function auditMemory(): { table: string; rows: number; ok: boolean }[] {
  const want = [
    "leads", "registrations", "csat_map", "nsat3_map", "nsat4_map", "csat_tag",
    "ai_reach", "nsat4_slots", "csat_slots", "csat_outcome", "cohort_csat1", "cohort_nsat3",
    "cohort_nsat4", "cohort_nsat5", "stage_flags",
  ];
  return want.map((t) => {
    let rows = 0;
    try {
      const exists = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='${t}'`).get() as { n: number };
      if (exists?.n) rows = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    } catch { rows = 0; }
    return { table: t, rows, ok: rows > 0 };
  });
}

// ---------------------------------------------------------------------------
// Block coverage: data exists but a page renders it blank.
//
// The table checks above would not have caught the CSAT post-test block reading
// "no post-test data yet" while the funnel two blocks above it showed 138 slots,
// 15 offer letters and 8 seats. The table was fine; the block had no branch for
// that round. So compare, per round, what the funnel knows against what the
// blocks render.
// ---------------------------------------------------------------------------

import { funnel, type Round } from "./queries";
import { postTestTable, preTestTable, sourceStages, sankeyTree, parseCtx, type Ctx, type SNode } from "./v2";

const ROUNDS: { ctx: Ctx; round: string; funnelRound: Round }[] = [
  { ctx: "NSAT", round: "NSAT-2", funnelRound: "NSAT-2" as Round },
  { ctx: "NSAT", round: "NSAT-3", funnelRound: "NSAT-3" as Round },
  { ctx: "NSAT", round: "NSAT-4", funnelRound: "NSAT-4" as Round },
  { ctx: "NSAT", round: "NSAT-5", funnelRound: "NSAT-5" as Round },
  { ctx: "CSAT", round: "All", funnelRound: "CSAT" as Round },
  { ctx: "CSAT", round: "BBA", funnelRound: "CSAT-BBA" as Round },
  { ctx: "CSAT", round: "BCA", funnelRound: "CSAT-BCA" as Round },
  { ctx: "CSAT", round: "Combined", funnelRound: "CSAT-COMB" as Round },
];

/** Post-test funnel stages: if any of these has a count, the block must not be empty. */
const POST_KEYS = new Set(["slot_form", "counselling", "offer_letter", "seat_payment"]);

export interface BlockIssue { round: string; issue: string; expected?: string }

/**
 * Gaps we know about and accept, with the reason. Kept separate so the actionable
 * list stays short — a check that always shows the same three warnings gets ignored,
 * which defeats the point of having it.
 */
const EXPECTED: Record<string, string> = {
  "NSAT / NSAT-2": "legacy round with no lead map, so it has no coverage or source blocks — ask if you want it wired",
};

export function auditBlocks(): BlockIssue[] {
  const raw: BlockIssue[] = [];
  for (const r of ROUNDS) {
    let rows: { key: string; count: number | null }[] = [];
    try {
      rows = funnel(r.funnelRound).rows as { key: string; count: number | null }[];
    } catch {
      raw.push({ round: `${r.ctx} / ${r.round}`, issue: "funnel() threw" });
      continue;
    }
    const has = (k: string) => Number(rows.find((x) => x.key === k)?.count ?? 0);
    const leads = has("lead");
    if (leads === 0) continue; // an empty round is not a coverage problem

    const postInFunnel = [...POST_KEYS].filter((k) => has(k) > 0);
    let post: unknown[] = [];
    let pre: unknown[] = [];
    let donuts: { total: number }[] = [];
    try { post = postTestTable(r.ctx, r.round); } catch { /* counted below */ }
    try { pre = preTestTable(r.ctx, r.round); } catch { /* counted below */ }
    try { donuts = sourceStages(r.ctx, r.round) as { total: number }[]; } catch { /* counted below */ }

    if (postInFunnel.length > 0 && post.length === 0) {
      raw.push({
        round: `${r.ctx} / ${r.round}`,
        issue: `funnel has post-test data (${postInFunnel.join(", ")}) but the Post test block is empty — that block needs a branch for this round`,
      });
    }
    if (pre.length === 0) {
      raw.push({ round: `${r.ctx} / ${r.round}`, issue: "Pre test block is empty" });
    }
    if (donuts.length === 0 || donuts.every((d) => d.total === 0)) {
      raw.push({ round: `${r.ctx} / ${r.round}`, issue: "Stages-by-source donuts are empty" });
    }

    // The Flow diagram reads its own id sets, so it can disagree with the funnel
    // sitting directly above it — that is how CSAT showed "Test given 0" next to a
    // funnel reading 280. Compare the stages both of them claim to know.
    let tree: SNode | null = null;
    try { tree = sankeyTree(r.ctx, r.round); } catch {
      raw.push({ round: `${r.ctx} / ${r.round}`, issue: "sankeyTree() threw" });
    }
    if (tree) {
      const flat: SNode[] = [];
      const walk = (n: SNode) => { flat.push(n); (n.children ?? []).forEach(walk); };
      walk(tree);
      const find = (label: string) => flat.find((n) => n.label.toLowerCase() === label)?.n ?? null;
      const pairs: [string, string][] = [
        ["lead", "leads"], ["registration", "registered"], ["test", "test given"],
      ];
      for (const [fk, sl] of pairs) {
        const f = has(fk);
        const sv = find(sl);
        if (f > 0 && sv !== null && sv === 0) {
          raw.push({
            round: `${r.ctx} / ${r.round}`,
            issue: `funnel says ${fk} = ${f.toLocaleString("en-IN")} but the Flow diagram shows "${sl}" = 0 — the sankey needs a branch for this round`,
          });
        }
      }
      // every box must contain its children exactly, or the diagram contradicts itself
      for (const n of flat) {
        const kids = n.children ?? [];
        if (!kids.length) continue;
        // cross-cut boxes (offer letter / seat booked) are not steps in the flow:
        // the students in them are already inside their siblings. Excluded from the
        // sum so the check stays a real contradiction test.
        const flow = kids.filter((c) => !c.cross);
        if (!flow.length) continue;
        const sum = flow.reduce((t, c) => t + c.n, 0);
        if (sum !== n.n) {
          raw.push({
            round: `${r.ctx} / ${r.round}`,
            issue: `Flow box "${n.label}" = ${n.n.toLocaleString("en-IN")} but its children sum to ${sum.toLocaleString("en-IN")}`,
          });
        }
      }
    }
  }
  // tag the accepted ones instead of dropping them, so nothing is hidden
  return raw.map((i) => (EXPECTED[i.round] ? { ...i, expected: EXPECTED[i.round] } : i));
}

export { parseCtx };
