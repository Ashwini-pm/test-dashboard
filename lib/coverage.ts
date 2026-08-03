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
