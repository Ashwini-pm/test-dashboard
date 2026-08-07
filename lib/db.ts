import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { supabase, supabaseConfigured } from "./supabase";
import { fetchCallsBooked, type BookedRow } from "./sheets";

// LIVE DATA — no local snapshot file, no cron.
//
// The dashboard's query layer (lib/queries.ts) is ~1000 lines of synchronous
// SQL. Rather than rewrite it, we keep an IN-MEMORY SQLite database and hydrate
// it live from the Supabase `nsat_*` tables, cached with a short TTL (the same
// live-with-TTL pattern the acquisition dashboard uses for its Redash feed).
//
// Every server page calls `await ensureFresh()` before running queries; the
// first call (or the first after the TTL lapses) pulls the current rows from
// Supabase and repopulates the in-memory tables. queries.ts imports the same
// stable `db` instance and needs no changes.

declare global {
  // eslint-disable-next-line no-var
  var __nsatDb: Database.Database | undefined;
  // eslint-disable-next-line no-var
  var __nsatLoadedAt: number | undefined;
  // eslint-disable-next-line no-var
  var __nsatInflight: Promise<void> | undefined;
  // eslint-disable-next-line no-var
  var __nsatLoadError: string | undefined;
}

const TTL_MS = Number(process.env.NSAT_LIVE_TTL_MS || 60_000); // 1 min default

// Every table queries.ts reads. sqlite table name === supabase table minus the
// `nsat_` prefix (schemas are 1:1). Order is irrelevant — FKs are off in memory.
const TABLES = [
  "reps",
  "leads",
  "registrations",
  "test_results",
  "slot_forms",
  "counselling_sessions",
  "offer_letters",
  "payments",
  "call_logs",
  "call_outcomes",
  "stage_targets",
  "lead_call_summary",
  "stage_channels",
] as const;

function open(): Database.Database {
  const dbm = new Database(":memory:");
  const schema = fs.readFileSync(
    path.join(process.cwd(), "db", "schema.sql"),
    "utf8"
  );
  dbm.exec(schema);
  // schema.sql sets `PRAGMA foreign_keys = ON`; turn it back OFF here. This is a
  // read-only mirror and some FKs don't hold (e.g. counselling rep_id is a
  // panelist email, not a reps row), so we don't enforce them.
  dbm.pragma("foreign_keys = OFF");
  return dbm;
}

const db: Database.Database = global.__nsatDb ?? open();
if (process.env.NODE_ENV !== "production") global.__nsatDb = db;

// PostgREST caps a response at 1000 rows, so a 19k-row table needs 19 requests.
// Doing them sequentially was the whole first-sync cost (~10s). Ask for the count
// once, then fetch every page concurrently.
async function pullTable(supaTable: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const { count, error: cErr } = await supabase
    .from(supaTable)
    .select("*", { count: "exact", head: true });
  if (cErr) throw new Error(`${supaTable} count: ${cErr.message}`);
  const total = count ?? 0;
  if (total === 0) return [];
  const pages = Math.ceil(total / PAGE);
  const chunks = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      supabase
        .from(supaTable)
        .select("*")
        .range(i * PAGE, i * PAGE + PAGE - 1)
        .then(({ data, error }) => {
          if (error) throw new Error(`${supaTable}: ${error.message}`);
          return (data ?? []) as Record<string, unknown>[];
        })
    )
  );
  return chunks.flat();
}

// Internal test leads, never shown anywhere.
//
// The list is DATA, not code: public.excluded_leads in Supabase. Adding a future
// test lead is one INSERT with no deploy. The three known ones are also deleted
// from lead_map itself, but this stays as the backstop — rebuild_lead_map()
// truncates and re-inserts the whole table, so a deliberate manual rebuild would
// bring them back and only this would catch it.
//
// Never a name match: "test" occurs inside real names, and silently dropping a
// real student is worse than carrying a few fake ones.
let EXCLUDED_LEAD_IDS = new Set<string>();
function isTestLead(r: Record<string, any>): boolean {
  return EXCLUDED_LEAD_IDS.has(String(r.lead_id ?? "").trim())
    || String(r.origin ?? "").trim() === "test";
}

// Effective CSAT source. The CRM's own category is the authority. Where the CRM
// has none, fall back to the utm our signup form captured, but ONLY when it maps
// cleanly onto a category the CRM already uses. Anything else stays empty and
// shows as "No CRM source" rather than inventing a category.
//
// Lower confidence than the CRM value, deliberately narrow: when the CRM HAD a
// source, our captured utm disagreed with it 3 times out of 3 against the
// Influencer sheet. This only fires where the CRM has nothing at all, so the
// choice is our utm or no attribution, and it recovers 6 of 39 leads.
const UTM_TO_CATEGORY: Record<string, string> = {
  influencers: "Influencers",
  influencer: "Influencers",
  organic: "Organic",
  direct: "Direct",
  collegedunia: "Collegedunia",
  inbound: "Inbound",
};
function effectiveSource(r: Record<string, any>): string | null {
  const crm = String(r.crm_source_category ?? "").trim();
  if (crm) return crm;
  const utm = String(r.raw_utm_source ?? "").trim().toLowerCase();
  return UTM_TO_CATEGORY[utm] ?? null;
}

// Reporting buckets for CSAT, agreed with the business. One place, so By source,
// Source x action, the Sankey bars and the drill can never disagree.
//
// SOURCE: five named sources, Inbound folded into Organic, everything else Others
// including no-source-at-all. The CRM's own taxonomy has 20 values; these six are
// what anyone actually reports on.
const SRC_MAIN = new Set(["Influencers", "Organic", "Direct", "Paid Performance Google", "Youtube Channels"]);
function sourceBucket(r: Record<string, any>): string {
  const raw = effectiveSource(r);
  if (!raw) return "Others";
  const c = raw.trim().toLowerCase() === "inbound" ? "Organic" : raw.trim();
  return SRC_MAIN.has(c) ? c : "Others";
}

// MEDIUM: seven named mediums plus NURTURING, everything else OTHERS. Case is
// normalised (YT_Dedicated / YT_DEDICATED / yt_Dedicated are one medium) and only
// the FIRST value of a comma cell counts, so a lead with two mediums is counted
// once and the columns add back to the lead total.
//
// GA placeholders are treated as no medium, not as a medium called "(not set)".
const MED_ALIAS: Record<string, string> = {
  ig_reel: "IG_REEL", yt_dedicated: "YT_DEDICATED", yt_integrated: "YT_INTEGRATED",
  website: "WEBSITE", web: "WEBSITE", webpage: "WEBSITE", organic: "ORGANIC",
  whatsapp: "WHATSAPP", google_ads: "GOOGLE_ADS", nurturing: "NURTURING",
};
const MED_JUNK = new Set(["(not set)", "(not%20set)", "224"]);
function mediumBucket(r: Record<string, any>): string {
  const raw = String(r.utm_medium ?? "").trim();
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v || MED_JUNK.has(v)) continue;
    return MED_ALIAS[v.toLowerCase()] ?? "OTHERS";
  }
  return "OTHERS";
}

function repopulate(table: string, rows: Record<string, unknown>[]): void {
  const wipe = db.prepare(`DELETE FROM ${table}`);
  if (rows.length === 0) {
    wipe.run();
    return;
  }
  const cols = Object.keys(rows[0]);
  // OR REPLACE: the feed can carry duplicate PKs (e.g. overlapping loader runs
  // double-inserting call_ids) — last row wins instead of killing the hydrate.
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols
      .map((c) => "@" + c)
      .join(",")})`
  );
  const tx = db.transaction((data: Record<string, unknown>[]) => {
    wipe.run();
    for (const r of data) {
      const bound: Record<string, unknown> = {};
      for (const c of cols) {
        const v = r[c];
        // better-sqlite3 only binds primitives; coerce objects/bools.
        bound[c] =
          v === undefined
            ? null
            : typeof v === "boolean"
            ? v
              ? 1
              : 0
            : v !== null && typeof v === "object"
            ? JSON.stringify(v)
            : v;
      }
      insert.run(bound);
    }
  });
  tx(rows);
}

async function refresh(): Promise<void> {
  const T0 = Date.now();
  db.pragma("foreign_keys = OFF"); // robust even if a cached (dev global) db had it on
  if (!supabaseConfigured) {
    // Do NOT stamp __nsatLoadedAt here. Doing so marked an EMPTY database as
    // fresh for the whole TTL, so every later request (and every Sync) short-
    // circuited and returned zeros without attempting a pull.
    global.__nsatLoadError = "Supabase is not configured: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are missing in this environment.";
    console.error("[db] " + global.__nsatLoadError);
    return;
  }
  const pulled = await Promise.all([
    Promise.all(TABLES.map((t) => pullTable(`nsat_${t}`).then((rows) => [t, rows] as const))),
    // Live counselling: read the Calls Booked day tabs straight from Google
    // Sheets (link-shared). Null on failure -> the Supabase copy stays.
    fetchCallsBooked().catch((e) => {
      console.warn("[db] Calls Booked sheet fetch failed:", e?.message);
      return null;
    }),
    // Live OL/SB: Redash 6729 is the truth for offer letters + seat bookings,
    // so "Sync now" picks up fresh OLs without waiting for the local loader.
    fetchOLSB().catch((e) => {
      console.warn("[db] OLSB feed fetch failed:", e?.message);
      return null;
    }),
    // NSAT-4 + CSAT live from the second Supabase project ("NSAT CSAT").
    fetchCsatProject().catch((e) => {
      console.warn("[db] NSAT CSAT project fetch failed:", e?.message);
      return null;
    }),
    // Slot forms: was a sequential pull AFTER this batch, adding a full
    // round-trip to every cold hydrate. It belongs in the batch.
    pullTable("nsat_student_slots").catch((e) => {
      console.warn("[db] student_slots pull failed:", e?.message);
      return null;
    }),
  ]);
  const [results, booked, olsb, csat, slots] = pulled;
  // Never cache an empty pull: rendering all-zeros is worse than retrying.
  const gotLeads = results.find(([t]) => t === "leads")?.[1]?.length ?? 0;
  if (gotLeads === 0) throw new Error("leads pull returned 0 rows; keeping previous data");
  for (const [t, rows] of results) repopulate(t, rows);
  if (booked && booked.length > 0) overlayCounselling(booked);
  if (olsb && olsb.length > 0) overlayOLSB(olsb);
  if (csat) overlayNsat4Csat(csat);
  // Slot-form submissions (live via Apps Script) -> slot_forms, matched by phone.
  if (slots) { try { overlaySlotForms(slots); } catch (e: any) { console.warn("[db] slot overlay failed:", e?.message); } }
  deriveStages();
  enrichNsat3MapCalls();
  buildMapIndexes();
  console.log(`[db] hydrate ${Date.now() - T0}ms`);
  global.__nsatLoadError = undefined;
  global.__nsatLoadedAt = Date.now();
}

// The map tables are built fresh each hydrate, so index them here. Without this
// the post-test queries do a correlated scan per map row (24 counts x thousands
// of rows) and every page render paid for it.
export function mirrorRaw(name: string, rows: Record<string, any>[]): void {
  try {
    db.exec(`DROP TABLE IF EXISTS ${name}`);
    if (!rows.length) { db.exec(`CREATE TABLE ${name} (lead_id TEXT)`); return; }
    const cols = Object.keys(rows[0]);
    db.exec(`CREATE TABLE ${name} (${cols.map((c) => `"${c}"`).join(", ")})`);
    const ins = db.prepare(
      `INSERT INTO ${name} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`
    );
    const tx = db.transaction((data: Record<string, any>[]) => {
      for (const r of data) {
        ins.run(cols.map((c) => {
          const v = r[c];
          if (v === undefined || v === null) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          if (typeof v === "object") return JSON.stringify(v);
          return v;
        }));
      }
    });
    tx(rows);
    db.exec(`CREATE INDEX IF NOT EXISTS ix_${name}_lead ON ${name}(lead_id)`);
  } catch (e: any) {
    console.warn(`[db] mirrorRaw ${name} failed:`, e?.message);
  }
}

function buildMapIndexes(): void {
  const run = (sql: string) => { try { db.exec(sql); } catch { /* table may not exist */ } };
  run("CREATE INDEX IF NOT EXISTS ix_n3map_lead ON nsat3_map(lead_id)");
  run("CREATE INDEX IF NOT EXISTS ix_csatmap_lead ON csat_map(lead_id)");
  run("CREATE INDEX IF NOT EXISTS ix_csatmap_tag ON csat_map(round_tag)");
  run("CREATE INDEX IF NOT EXISTS ix_n4map_lead ON nsat4_map(lead_id)");
  run("CREATE INDEX IF NOT EXISTS ix_n4slot_lead ON nsat4_slots(lead_id)");
  run("CREATE INDEX IF NOT EXISTS ix_cslot_lead ON csat_slots(lead_id)");
  run("CREATE INDEX IF NOT EXISTS ix_aireach ON ai_reach(cohort, lead_id)");
  run("CREATE INDEX IF NOT EXISTS ix_csattag ON csat_tag(kind, key)");
  run("CREATE INDEX IF NOT EXISTS ix_csattag_lead ON csat_tag(lead_id)");
  run("CREATE INDEX IF NOT EXISTS ix_leads_student ON leads(student_id)");
  // Stage tables carry no lead_id index in schema.sql, yet /students runs a
  // correlated subquery per lead against every one of them.
  for (const t of ["registrations", "test_results", "slot_forms", "counselling_sessions", "offer_letters", "payments"]) {
    run(`CREATE INDEX IF NOT EXISTS ix_${t}_lead ON ${t}(lead_id)`);
  }
  run("CREATE INDEX IF NOT EXISTS ix_leads_round ON leads(nsat_round)");
  // Post-test stage membership, precomputed ONCE per hydrate and keyed the way the
  // maps are keyed. Replaces the per-row EXISTS subqueries in postTestTable/drill.
  run(`
    DROP TABLE IF EXISTS stage_flags;
    CREATE TABLE stage_flags AS
    SELECT COALESCE(NULLIF(TRIM(l.student_id),''), l.lead_id) AS k,
           l.nsat_round AS rnd,
           MAX(CASE WHEN t.appeared=1 THEN 1 ELSE 0 END)                     AS tested,
           MAX(CASE WHEN t.result='pass' THEN 1 ELSE 0 END)                  AS passed,
           MAX(CASE WHEN cs.scheduled_at IS NOT NULL THEN 1 ELSE 0 END)      AS slot,
           MAX(CASE WHEN cs.status='held' THEN 1 ELSE 0 END)                 AS couns,
           MAX(CASE WHEN cs.status IN ('held','no_show','reschedule') THEN 1 ELSE 0 END) AS cohort,
           MAX(CASE WHEN o.lead_id IS NOT NULL THEN 1 ELSE 0 END)            AS ol,
           MAX(CASE WHEN p.paid_at >= '2026-07-16' THEN 1 ELSE 0 END)        AS seat
      FROM leads l
      LEFT JOIN test_results t         ON t.lead_id  = l.lead_id
      LEFT JOIN counselling_sessions cs ON cs.lead_id = l.lead_id
      LEFT JOIN offer_letters o        ON o.lead_id  = l.lead_id
      LEFT JOIN payments p             ON p.lead_id  = l.lead_id
     GROUP BY 1, 2;
    CREATE INDEX IF NOT EXISTS ix_sflags ON stage_flags(k, rnd);
  `);
}

// NSAT-3's calling data lives in call_logs (human_call), not in nsat3_lead_map,
// so fill the map's call aggregates from it. This gives NSAT-3 the same coverage
// views CSAT gets, keyed the way the map is keyed (CRM lead id == leads.student_id).
// Map rows with no matching NSAT-3 lead keep NULL (unknown), never a false zero.
function enrichNsat3MapCalls(): void {
  try {
    if (!db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='nsat3_map'").get()) return;
    db.exec(`
      DROP TABLE IF EXISTS n3_agg;
      CREATE TABLE n3_agg AS
      SELECT COALESCE(NULLIF(TRIM(l.student_id),''), l.lead_id) AS k,
             SUM(CASE WHEN c.channel='human_call' THEN 1 ELSE 0 END) AS calls,
             SUM(CASE WHEN c.channel='human_call' AND c.answered=1 THEN 1 ELSE 0 END) AS conns,
             MIN(CASE WHEN c.channel='human_call' THEN c.attempted_at END) AS first_at,
             MAX(CASE WHEN c.channel='human_call' THEN c.attempted_at END) AS last_at
        FROM leads l JOIN call_logs c ON c.lead_id = l.lead_id
       WHERE l.nsat_round = 'NSAT-3'
       GROUP BY 1;
      CREATE INDEX IF NOT EXISTS ix_n3agg ON n3_agg(k);

      DROP TABLE IF EXISTS n3_rep;
      CREATE TABLE n3_rep AS
      SELECT COALESCE(NULLIF(TRIM(l.student_id),''), l.lead_id) AS k,
             MAX(NULLIF(TRIM(l.assigned_rep_id),'')) AS rep
        FROM leads l WHERE l.nsat_round = 'NSAT-3' GROUP BY 1;
      CREATE INDEX IF NOT EXISTS ix_n3rep ON n3_rep(k);

      UPDATE nsat3_map SET
        total_calls     = (SELECT a.calls    FROM n3_agg a WHERE a.k = nsat3_map.lead_id),
        connected_calls = (SELECT a.conns    FROM n3_agg a WHERE a.k = nsat3_map.lead_id),
        first_call_at   = (SELECT a.first_at FROM n3_agg a WHERE a.k = nsat3_map.lead_id),
        last_call_at    = (SELECT a.last_at  FROM n3_agg a WHERE a.k = nsat3_map.lead_id)
      WHERE EXISTS (SELECT 1 FROM n3_agg a WHERE a.k = nsat3_map.lead_id);

      UPDATE nsat3_map SET
        counsellor = (SELECT r.rep FROM n3_rep r WHERE r.k = nsat3_map.lead_id)
      WHERE EXISTS (SELECT 1 FROM n3_rep r WHERE r.k = nsat3_map.lead_id);
    `);
  } catch (e: any) {
    console.warn("[db] nsat3_map call enrichment failed:", e?.message);
  }
}

// Map raw slot-form submissions onto leads so "form filled but not booked yet"
// is answerable per student.
function overlaySlotForms(rows: Record<string, any>[]): void {
  const p10 = (v: string) => {
    const d = (v || "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : "";
  };
  const byPhone = new Map<string, string>();
  for (const r of db
    .prepare("SELECT lead_id, phone10 FROM leads WHERE phone10 IS NOT NULL AND phone10<>'' ORDER BY CASE WHEN nsat_round='NSAT-3' THEN 0 ELSE 1 END")
    .all() as { lead_id: string; phone10: string }[]) {
    if (!byPhone.has(r.phone10)) byPhone.set(r.phone10, r.lead_id);
  }
  const ins = db.prepare("INSERT INTO slot_forms(lead_id,submitted_at,preferred_slot) VALUES (?,?,?)");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM slot_forms").run();
    const seen = new Set<string>();
    for (const r of rows) {
      const lid = byPhone.get(p10(String(r.phone ?? "")));
      if (!lid || seen.has(lid)) continue;
      seen.add(lid);
      ins.run(lid, r.received_at ?? null, [r.slot_1_date, r.slot_1].filter(Boolean).join(" ") || null);
    }
  });
  tx();
}

// Rebuild counselling_sessions from the live sheet rows (matched by phone10;
// unmatched booked students get a synthetic lead, same as the loader script).
function overlayCounselling(rows: BookedRow[]): void {
  const phone10 = (v: string) => {
    const d = (v || "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : "";
  };
  const byPhone = new Map<string, string>();
  for (const r of db
    .prepare("SELECT lead_id, phone10 FROM leads WHERE phone10 IS NOT NULL AND phone10<>'' ORDER BY CASE WHEN nsat_round='NSAT-3' THEN 0 ELSE 1 END")
    .all() as { lead_id: string; phone10: string }[]) {
    if (!byPhone.has(r.phone10)) byPhone.set(r.phone10, r.lead_id);
  }
  const insLead = db.prepare(
    "INSERT OR IGNORE INTO leads(lead_id,phone,phone10,nsat_round,source) VALUES (?,?,?,?,?)"
  );
  const insSession = db.prepare(
    "INSERT INTO counselling_sessions(lead_id,rep_id,scheduled_at,status) VALUES (?,?,?,'scheduled')"
  );
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM counselling_sessions").run();
    for (const r of rows) {
      const p10 = phone10(r.phone);
      let lid = byPhone.get(p10);
      if (!lid) {
        lid = "cb_" + (p10 || Math.abs(hash(r.phone + r.iso + r.time)));
        insLead.run(lid, r.phone, p10, "NSAT-3", "calls_booked");
        if (p10) byPhone.set(p10, lid);
      }
      insSession.run(lid, r.panelist, r.time ? `${r.iso}T${r.time}` : r.iso);
    }
  });
  tx();
}

// Redash 6729: per-lead Offer_Letter_Released_TS / Seat_Booked_TS for the
// NSAT-3 cohort. Returns null when the env key is absent (e.g. missing on
// Vercel) so the Supabase copy stays authoritative.
async function fetchOLSB(): Promise<Record<string, any>[] | null> {
  const url = process.env.OLSB_FEED_URL;
  if (!url) return null;
  const res = await fetch(url.replace("http://", "https://"), {
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`OLSB feed HTTP ${res.status}`);
  const body: any = await res.json();
  return body?.query_result?.data?.rows ?? null;
}

// Replace NSAT-3 offer_letters + payments with the live feed (other rounds'
// rows are untouched). Matched by CRM id -> leads.student_id.
function overlayOLSB(rows: Record<string, any>[]): void {
  const byCrm = new Map<string, string>();
  for (const r of db
    .prepare("SELECT lead_id, student_id FROM leads WHERE nsat_round='NSAT-3' AND student_id IS NOT NULL AND student_id<>''")
    .all() as { lead_id: string; student_id: string }[]) {
    if (!byCrm.has(String(r.student_id))) byCrm.set(String(r.student_id), r.lead_id);
  }
  const insO = db.prepare("INSERT INTO offer_letters(lead_id,issued_at) VALUES (?,?)");
  const insP = db.prepare("INSERT INTO payments(lead_id,paid_at,status) VALUES (?,?,'seat_booked')");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM offer_letters WHERE lead_id IN (SELECT lead_id FROM leads WHERE nsat_round='NSAT-3')").run();
    db.prepare("DELETE FROM payments WHERE lead_id IN (SELECT lead_id FROM leads WHERE nsat_round='NSAT-3')").run();
    const oseen = new Set<string>();
    const pseen = new Set<string>();
    for (const r of rows) {
      const lid = byCrm.get(String(r.lead_id ?? ""));
      if (!lid) continue;
      const ots = String(r.Offer_Letter_Released_TS ?? "").slice(0, 10);
      const sts = String(r.Seat_Booked_TS ?? "").slice(0, 10);
      if (ots && !oseen.has(lid)) {
        oseen.add(lid);
        insO.run(lid, ots);
      }
      if (sts && !pseen.has(lid)) {
        pseen.add(lid);
        insP.run(lid, sts);
      }
    }
  });
  tx();
}

// ---- NSAT-4 + CSAT (second Supabase project "NSAT CSAT") ----
// Read-only via anon key (RLS read policies). Returns null when env is absent
// so environments without the vars just skip these rounds.
type CsatPull = { table: string; rows: Record<string, any>[] }[];
async function fetchCsatProject(): Promise<CsatPull | null> {
  const url = process.env.CSAT_SUPABASE_URL;
  const key = process.env.CSAT_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  // One HEAD for the row count, then all pages concurrently (was sequential).
  // sel/filter let a caller narrow the request: ai_calls has ~85k rows but only
  // ~13k belong to a cohort, and we need three columns of them, not all 12.
  const pull = async (table: string, sel = "*", filter = "") => {
    const PAGE = 1000;
    const q = `select=${sel}${filter}`;
    const head = await fetch(`${url}/rest/v1/${table}?${q}&limit=1`, {
      headers: { ...H, Prefer: "count=exact", Range: "0-0" },
      cache: "no-store", signal: AbortSignal.timeout(20000),
    });
    if (!head.ok) throw new Error(`${table}: HTTP ${head.status}`);
    const total = Number((head.headers.get("content-range") || "").split("/")[1] || 0);
    if (!total) return [];
    const pages = Math.ceil(total / PAGE);
    // Firing every page of every table at once meant ~56 simultaneous requests, and
    // roughly one in ten was dropped by the connection pool. A dropped page used to
    // fail the whole table, which reads on the dashboard as "no data" rather than as
    // an error. Bounded concurrency plus a retry per page fixes the flakiness at the
    // cost of a second or two on a cold hydrate.
    const LIMIT = 5;
    const getPage = async (i: number): Promise<Record<string, any>[]> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${url}/rest/v1/${table}?${q}&limit=${PAGE}&offset=${i * PAGE}`, {
            headers: H, cache: "no-store", signal: AbortSignal.timeout(30000),
          });
          if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
          return (await res.json()) as Record<string, any>[];
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`${table}: page ${i} failed`);
    };
    const chunks: Record<string, any>[][] = new Array(pages);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(LIMIT, pages) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= pages) return;
          chunks[i] = await getPage(i);
        }
      })
    );
    return chunks.flat();
  };
  // allSettled, NOT all: one flaky fetch used to reject the whole batch and leave
  // every CSAT table empty, which reads on the dashboard as "no data" rather than
  // as a failure. A table that fails now loses only itself, and /coverage reports
  // it as empty.
  const settle = async <T,>(label: string, p: Promise<T>): Promise<{ table: string; rows: Record<string, any>[] }> => {
    try { return { table: label, rows: (await p) as Record<string, any>[] }; }
    catch (e) { console.error(`[db] ${label} pull failed:`, e instanceof Error ? e.message : e); return { table: label, rows: [] }; }
  };
  return Promise.all([
    // nsat4_counselling is pulled for its slot fields only. nsat4_lead_map stays
    // the NSAT-4 lead universe and the authority on offer letter / seat booked.
    ...["nsat4", "bba", "bca", "combined", "nsat3_lead_map", "lead_map", "nsat4_lead_map", "nsat5_lead_map", "nsat4_counselling", "csat_counselling", "csat_counselling_outcomes", "nsat_counselling_outcomes"].map((t) => settle(t, pull(t))),
    // AI calls, narrowed to rows already resolved to a cohort lead. The lead ids
    // are stored on the row, so we never join on phone.
    settle("lead_vintage", pull("lead_vintage", "lead_id,lead_created")),
    settle("excluded_leads", pull("excluded_leads", "lead_id")),
    settle("ai_calls", pull(
      "ai_calls",
      "nsat4_lead_id,csat1_lead_id,status,called_at",
      "&or=(nsat4_lead_id.not.is.null,csat1_lead_id.not.is.null)"
    )),
  ]);
}

// Map the second project's registration rows into the same in-memory tables:
// nsat4 -> round NSAT-4, bba/bca/combined -> round CSAT. Only lead +
// registration stages exist for these rounds today; later stages stay empty.
function overlayNsat4Csat(pulls: CsatPull): void {
  const p10 = (v: string) => {
    const d = (v || "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : "";
  };
  const insLead = db.prepare(
    "INSERT OR IGNORE INTO leads(lead_id,student_id,full_name,phone,phone10,email,city,region,nsat_round,source) VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  const insReg = db.prepare("INSERT INTO registrations(lead_id,nsat_round,registered_at) VALUES (?,?,?)");
  // NSAT-3 "better data" mapping (our reconciliation) lives in its own table so it
  // can override only the NSAT-3 Lead + Registration counts, leaving every other
  // stage (test/pass/counselling/OL/seat) on the existing funnel-sheet pipeline.
  // DROP+CREATE (not IF NOT EXISTS): a long-lived dev process keeps the old
  // in-memory schema otherwise, and inserts fail once columns are added.
  db.exec("DROP TABLE IF EXISTS nsat3_map");
  db.exec("CREATE TABLE nsat3_map (lead_id TEXT, reg_status TEXT, campaign_source TEXT, origin TEXT, crm_source_category TEXT, total_calls INTEGER, connected_calls INTEGER, first_signup TEXT, first_call_at TEXT, last_call_at TEXT, counsellor TEXT, name TEXT, phone TEXT, utm_campaign TEXT)");
  const insMap = db.prepare("INSERT INTO nsat3_map(lead_id,reg_status,campaign_source,origin,crm_source_category,total_calls,connected_calls,first_signup,first_call_at,last_call_at,counsellor,name,phone,utm_campaign) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  // CSAT "better data" = the lead_map reconciliation (deduped bba/bca/combined +
  // crm_only attribution). Drives only CSAT Lead + Registration counts.
  db.exec("DROP TABLE IF EXISTS nsat4_map");
  db.exec("CREATE TABLE nsat4_map (lead_id TEXT, registered TEXT, campaign_source TEXT, origin TEXT, crm_source_category TEXT, total_calls INTEGER, connected_calls INTEGER, first_signup TEXT, first_call_at TEXT, last_call_at TEXT, counsellor TEXT, name TEXT, phone TEXT, utm_campaign TEXT, offer_letter TEXT, seat_booked TEXT, seat_booked_date TEXT, test_result TEXT, test_creds_shared TEXT)");
  const insN4 = db.prepare("INSERT INTO nsat4_map(lead_id,registered,campaign_source,origin,crm_source_category,total_calls,connected_calls,first_signup,first_call_at,last_call_at,counsellor,name,phone,utm_campaign,offer_letter,seat_booked,seat_booked_date,test_result,test_creds_shared) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  // Counselling slots for NSAT-4. Booking exists when booking_id is set; there is
  // no attendance/outcome column in the source, so "counselling done" cannot be
  // derived — call_date is the scheduled day, which for now is all in the future.
  // AI reach per lead, per cohort. reached = at least one 'completed' call (a real
  // conversation); called = any call at all, whatever the status.
  db.exec("DROP TABLE IF EXISTS ai_reach");
  db.exec("CREATE TABLE ai_reach (lead_id TEXT, cohort TEXT, reached INTEGER, called INTEGER, last_call TEXT, last_conn TEXT, first_call TEXT, first_conn TEXT)");
  const insAi = db.prepare("INSERT INTO ai_reach(lead_id,cohort,reached,called,last_call,last_conn,first_call,first_conn) VALUES (?,?,?,?,?,?,?,?)");
  // CSAT-1 counselling slots, same shape as NSAT-4: a booking_id means a slot is
  // booked, and there is no attendance column, so "counselling done" is unknowable.
  // Panelist outcomes, synced from the responses sheet every 15 min. The ONLY
  // source of counselling attendance: csat_counselling has the booking, this has
  // what happened. One row per submission, so a student can appear twice
  // (rescheduled, then held) — collapse to the latest per lead.
  // NSAT panelist responses. Same shape as csat_outcome so the seat-booking and
  // offer-letter gates read identically for both cohorts.
  // A lead's TRUE CRM creation date, unclipped by any query window. Every lead map
  // stores crm_created clipped to its own round, so "did this lead exist before the
  // campaign" is unanswerable there and reads as always false.
  db.exec("DROP TABLE IF EXISTS lead_vintage");
  db.exec("CREATE TABLE lead_vintage (lead_id TEXT PRIMARY KEY, lead_created TEXT)");
  const insVin = db.prepare("INSERT INTO lead_vintage(lead_id,lead_created) VALUES (?,?) ON CONFLICT(lead_id) DO NOTHING");
  db.exec("DROP TABLE IF EXISTS nsat_outcome");
  db.exec("CREATE TABLE nsat_outcome (lead_id TEXT PRIMARY KEY, status TEXT, submitted_at TEXT, panelist TEXT, likelihood INTEGER, motivation INTEGER, comms INTEGER, scholarship INTEGER, remarks TEXT, reschedule_reason TEXT)");
  const insNOut = db.prepare("INSERT INTO nsat_outcome(lead_id,status,submitted_at,panelist,likelihood,motivation,comms,scholarship,remarks,reschedule_reason) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET status=excluded.status, submitted_at=excluded.submitted_at, panelist=excluded.panelist, likelihood=excluded.likelihood, motivation=excluded.motivation, comms=excluded.comms, scholarship=excluded.scholarship, remarks=excluded.remarks, reschedule_reason=excluded.reschedule_reason WHERE excluded.submitted_at > nsat_outcome.submitted_at");
  db.exec("DROP TABLE IF EXISTS csat_outcome");
  db.exec("CREATE TABLE csat_outcome (lead_id TEXT PRIMARY KEY, status TEXT, submitted_at TEXT, panelist TEXT, likelihood INTEGER, motivation INTEGER, comms INTEGER, scholarship INTEGER, remarks TEXT, reschedule_reason TEXT)");
  const insOut = db.prepare("INSERT INTO csat_outcome(lead_id,status,submitted_at,panelist,likelihood,motivation,comms,scholarship,remarks,reschedule_reason) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET status=excluded.status, submitted_at=excluded.submitted_at, panelist=excluded.panelist, likelihood=excluded.likelihood, motivation=excluded.motivation, comms=excluded.comms, scholarship=excluded.scholarship, remarks=excluded.remarks, reschedule_reason=excluded.reschedule_reason WHERE excluded.submitted_at > csat_outcome.submitted_at");
  db.exec("DROP TABLE IF EXISTS csat_slots");
  db.exec("CREATE TABLE csat_slots (lead_id TEXT, booking_id TEXT, call_date TEXT, call_time TEXT, panelist TEXT, program TEXT)");
  const insCSlot = db.prepare("INSERT INTO csat_slots(lead_id,booking_id,call_date,call_time,panelist,program) VALUES (?,?,?,?,?,?)");
  db.exec("DROP TABLE IF EXISTS nsat4_slots");
  db.exec("CREATE TABLE nsat4_slots (lead_id TEXT, booking_id TEXT, call_date TEXT, call_time TEXT, panelist TEXT, meet_link TEXT, conf_sent INTEGER, booked_at TEXT)");
  const insSlot = db.prepare("INSERT INTO nsat4_slots(lead_id,booking_id,call_date,call_time,panelist,meet_link,conf_sent,booked_at) VALUES (?,?,?,?,?,?,?,?)");
  // campaign_source and utm_campaign can each hold SEVERAL comma-separated values
  // in one cell ("Influencers, Organic") — a student who arrived by more than one
  // route. Split once here and credit every value, so the tables and the drill-down
  // agree by construction instead of both trying to parse the cell in SQL.
  // Keys are lower-cased ('organic' and 'Organic' are the same source); label keeps
  // a readable raw form. These tables DOUBLE COUNT by design.
  db.exec("DROP TABLE IF EXISTS csat_tag");
  db.exec("CREATE TABLE csat_tag (lead_id TEXT, kind TEXT, key TEXT, label TEXT)");
  const insTag = db.prepare("INSERT INTO csat_tag(lead_id,kind,key,label) VALUES (?,?,?,?)");

  db.exec("DROP TABLE IF EXISTS csat_map");
  db.exec("CREATE TABLE csat_map (lead_id TEXT, round_tag TEXT, registered TEXT, campaign_source TEXT, origin TEXT, crm_source_category TEXT, total_calls INTEGER, connected_calls INTEGER, first_signup TEXT, first_call_at TEXT, last_call_at TEXT, counsellor TEXT, name TEXT, phone TEXT, utm_campaign TEXT, crm_program TEXT, signup_programs TEXT, test_given TEXT, test_given_at TEXT, test_result TEXT, last_call_at2 TEXT, first_conn_at TEXT, last_conn_at TEXT, utm_medium TEXT, offer_letter TEXT, seat_booked TEXT, seat_booked_date TEXT)");
  const insCsat = db.prepare("INSERT INTO csat_map(lead_id,round_tag,registered,campaign_source,origin,crm_source_category,total_calls,connected_calls,first_signup,first_call_at,last_call_at,counsellor,name,phone,utm_campaign,crm_program,signup_programs,test_given,test_given_at,test_result,last_call_at2,first_conn_at,last_conn_at,utm_medium,offer_letter,seat_booked,seat_booked_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM registrations WHERE nsat_round IN ('NSAT-4','CSAT','CSAT-BBA','CSAT-BCA','CSAT-COMB')").run();
    db.prepare("DELETE FROM leads WHERE nsat_round IN ('NSAT-4','CSAT','CSAT-BBA','CSAT-BCA','CSAT-COMB')").run();
    db.prepare("DELETE FROM nsat3_map").run();
    db.prepare("DELETE FROM csat_map").run();
    db.prepare("DELETE FROM nsat_outcome").run();
    db.prepare("DELETE FROM lead_vintage").run();
    // Load the exclusion list BEFORE the loop: pulls are processed in array order
    // and lead_map comes first, so populating it inside the loop would leave the
    // set empty exactly when the filter needs it.
    EXCLUDED_LEAD_IDS = new Set(
      (pulls.find((p) => p.table === "excluded_leads")?.rows ?? [])
        .map((r) => String(r.lead_id ?? "").trim())
        .filter(Boolean),
    );
    for (const { table, rows } of pulls) {
      if (table === "nsat3_lead_map") {
        mirrorRaw("cohort_nsat3", rows);
        for (const r of rows) insMap.run(String(r.lead_id ?? ""), r.reg_status ?? null, r.campaign_source ?? null, r.origin ?? null, r.crm_source_category ?? null, r.total_calls ?? null, r.connected_calls ?? null, r.first_signup ?? null, r.first_call_at ?? null, r.last_call_at ?? null, r.counsellor ?? null, r.name ?? null, r.phone ?? null, r.utm_campaign ?? null);
        continue;
      }
      if (table === "ai_calls") {
        // collapse call rows to one flag pair per lead before inserting
        const acc = new Map<string, { reached: boolean; last: string; lastConn: string; first: string; firstConn: string }>();
        for (const r of rows) {
          const done = String(r.status ?? "") === "completed";
          const at = r.called_at == null ? "" : String(r.called_at);
          for (const [col, coh] of [["nsat4_lead_id", "NSAT-4"], ["csat1_lead_id", "CSAT-1"]] as const) {
            const lid = r[col] == null ? "" : String(r[col]);
            if (!lid) continue;
            const k = `${coh}\u0000${lid}`;
            const cur = acc.get(k);
            if (cur) {
              if (done) {
                cur.reached = true;
                if (at > cur.lastConn) cur.lastConn = at;
                if (!cur.firstConn || at < cur.firstConn) cur.firstConn = at;
              }
              if (at > cur.last) cur.last = at;
              if (!cur.first || at < cur.first) cur.first = at;
            } else acc.set(k, { reached: done, last: at, lastConn: done ? at : "", first: at, firstConn: done ? at : "" });
          }
        }
        for (const [k, v] of acc) {
          const [coh, lid] = k.split("\u0000");
          insAi.run(lid, coh, v.reached ? 1 : 0, 1, v.last || null, v.lastConn || null, v.first || null, v.firstConn || null);
        }
        continue;
      }
      if (table === "excluded_leads") continue;   // already loaded above
      if (table === "lead_vintage") {
        for (const r of rows) {
          const lid = String(r.lead_id ?? "").trim();
          const lc = String(r.lead_created ?? "").slice(0, 10);
          if (lid && lc) insVin.run(lid, lc);
        }
        continue;
      }
      if (table === "nsat_counselling_outcomes") {
        for (const r of rows) {
          const lid = String(r.lead_id ?? "").trim();
          if (!lid) continue;
          insNOut.run(lid, r.status ?? null, String(r.submitted_at ?? ""), r.panelist_email ?? null,
                      r.likelihood_seat ?? null, r.motivation ?? null, r.communication_skills ?? null,
                      r.scholarship_reco ?? null, r.remarks ?? null, r.reschedule_reason ?? null);
        }
        continue;
      }
      if (table === "csat_counselling_outcomes") {
        for (const r of rows) {
          const lid = String(r.lead_id ?? "").trim();
          if (!lid) continue;
          insOut.run(lid, r.status ?? null, String(r.submitted_at ?? ""), r.panelist_email ?? null,
                     r.likelihood_seat ?? null, r.motivation ?? null, r.communication_skills ?? null,
                     r.scholarship_reco ?? null, r.remarks ?? null, r.reschedule_reason ?? null);
        }
        continue;
      }
      if (table === "csat_counselling") {
        for (const r of rows) {
          if (!r.booking_id) continue;
          insCSlot.run(String(r.lead_id ?? ""), String(r.booking_id ?? ""), r.call_date ?? null,
                       r.call_time ?? null, r.panelist ?? null, r.program ?? null);
        }
        continue;
      }
      if (table === "nsat4_counselling") {
        // slot rows only — everything else in this table duplicates nsat4_lead_map
        for (const r of rows) {
          if (!r.booking_id) continue;
          insSlot.run(
            String(r.lead_id ?? ""), String(r.booking_id ?? ""), r.call_date ?? null, r.call_time ?? null,
            r.panelist ?? null, r.meet_link ?? null, r.slot_confirmation_sent ? 1 : 0, r.booked_at ?? null);
        }
        continue;
      }
      if (table === "nsat5_lead_map") {
        // NSAT-5 has the same shape as NSAT-4; it only feeds the cohort page.
        mirrorRaw("cohort_nsat5", rows);
        continue;
      }
      if (table === "nsat4_lead_map") {
        mirrorRaw("cohort_nsat4", rows);
        // map_key is the dedup key; lead_id is the CRM id and may be null (capture_only)
        for (const r of rows) insN4.run(
          String(r.lead_id ?? r.map_key ?? ""), r.registered ?? null, r.campaign_source ?? null,
          r.origin ?? null, r.crm_source_category ?? null, r.total_calls ?? null, r.connected_calls ?? null,
          r.first_signup ?? null, r.first_call_at ?? null, r.last_call_at ?? null, r.counsellor ?? null,
          r.name ?? null, r.phone ?? null, r.utm_campaign ?? null, r.offer_letter ?? null, r.seat_booked ?? null, r.seat_booked_date ?? null, r.test_result ?? null, r.test_creds_shared ?? null);
        continue;
      }
      if (table === "lead_map") {
        // filter before the raw mirror too, or the test rows survive in cohort_csat1
        const real = rows.filter((r) => !isTestLead(r));
        mirrorRaw("cohort_csat1", real);
        for (const r of real) {
          const st = String(r.signup_tables ?? "");
          const tag = st === "bba" ? "CSAT-BBA" : st === "bca" ? "CSAT-BCA" : "CSAT-COMB";
          insCsat.run(String(r.lead_id ?? ""), tag, r.registered ?? null, r.campaign_source ?? null, r.origin ?? null, sourceBucket(r), r.total_calls ?? null, r.connected_calls ?? null, r.first_signup ?? null, r.first_call_at ?? null, r.last_call_at ?? null, r.counsellor ?? null, r.name ?? null, r.phone ?? null, r.utm_campaign ?? null, r.crm_program ?? null, r.signup_programs ?? null, r.test_given ?? null, r.test_given_at ?? null, r.test_result ?? null, r.last_call_at ?? null, r.first_connected_at ?? null, r.last_connected_at ?? null, mediumBucket(r), r.offer_letter ?? null, r.seat_booked ?? null, r.seat_booked_date ?? null);
          // one tag row per (lead, value); dedupe so a cell listing the same value
          // twice in different case does not count the lead twice
          const lid = String(r.lead_id ?? "");
          // Source = crm_source_category, the CRM's own conclusion, NOT campaign_source
          // (the utm the form captured). Checked against the C-SAT master sheet's LSC:
          // crm_source_category agreed 17/17, campaign_source disagreed 49/60, calling
          // Collegedunia / Consultants / Youtube Channels / Marketing Events / Referral
          // all "Influencers" or "organic". UTM campaign name still comes from the form,
          // which is correct — that IS a form field.
          insTag.run(lid, "med", mediumBucket(r).toLowerCase(), mediumBucket(r));
          for (const [kind, raw] of [["src", sourceBucket(r)], ["utm", r.utm_campaign]] as const) {
            const cell = String(raw ?? "").trim();
            const vals = cell ? cell.split(",").map((v) => v.trim()).filter(Boolean) : [];
            const seenK = new Set<string>();
            // A lead with no source in any feed gets its own bucket, NOT Others.
            // Folding it into Others hid it: the Source x action table showed it as
            // "No CRM source" while this tag showed Others, so the same leads gave
            // two different answers on one page. Both now say No CRM source.
            for (const v of vals.length ? vals : [kind === "src" ? "No CRM source" : "No source captured"]) {
              const k = v.toLowerCase();
              if (seenK.has(k)) continue;
              seenK.add(k);
              insTag.run(lid, kind, k, v);
            }
          }
        }
        continue;
      }
      const round =
        table === "nsat4" ? "NSAT-4" :
        table === "bba" ? "CSAT-BBA" :
        table === "bca" ? "CSAT-BCA" : "CSAT-COMB";
      for (const r of rows) {
        // CSAT: key the lead by person (sunstone_user_id → phone10 → id) so the
        // duplicate 422-rows (same student, form re-submitted) collapse to one
        // lead via INSERT OR IGNORE, giving the proper deduped lead count.
        const personKey =
          String(r.sunstone_user_id ?? "").trim() || p10(String(r.phone ?? "")) || String(r.id ?? "");
        const lid = table === "nsat4" ? `NSAT-4-${r.id}` : `CSAT-${table}-${personKey}`;
        insLead.run(
          lid, String(r.id ?? ""), r.full_name ?? null, r.phone ?? null, p10(String(r.phone ?? "")),
          r.email ?? null, r.user_city ?? null, r.program ?? null, round, r.utm_source ?? r.lead_source ?? null
        );
        if (String(r.payment_status ?? "").toLowerCase() === "paid") {
          insReg.run(lid, round, r.paid_at ?? r.created_at ?? null);
        }
      }
    }
  });
  tx();
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// current_stage is a DERIVED cache: the deepest funnel stage each lead actually
// reached per the stage tables (single source of truth), recomputed on every
// hydrate. Never trust the raw value that arrives on the leads feed.
function deriveStages(): void {
  db.exec(`
    UPDATE leads SET current_stage = CASE
      WHEN lead_id IN (SELECT lead_id FROM payments) THEN 'seat_payment'
      WHEN lead_id IN (SELECT lead_id FROM offer_letters) THEN 'offer_letter'
      WHEN lead_id IN (SELECT lead_id FROM counselling_sessions WHERE status='held') THEN 'counselling'
      WHEN lead_id IN (SELECT lead_id FROM counselling_sessions WHERE scheduled_at IS NOT NULL) THEN 'slot_form'
      WHEN lead_id IN (SELECT lead_id FROM test_results WHERE result IN ('pass','fail')) THEN 'result'
      WHEN lead_id IN (SELECT lead_id FROM test_results WHERE appeared=1) THEN 'test'
      WHEN lead_id IN (SELECT lead_id FROM registrations) THEN 'registration'
      ELSE 'lead'
    END
  `);
}

// Call before any query. Pulls fresh data from Supabase when the TTL has
// lapsed; concurrent callers share one in-flight refresh.
export async function ensureFresh(force = false): Promise<void> {
  // record why a hydrate failed so the UI can say something useful

  const loadedAt = global.__nsatLoadedAt ?? 0;
  const fresh = loadedAt > 0 && Date.now() - loadedAt < TTL_MS;
  if (fresh && !force) return;
  if (!global.__nsatInflight) {
    global.__nsatInflight = refresh()
      .catch((e: any) => {
        global.__nsatLoadError = `Live pull failed: ${e?.message ?? e}`;
        console.error("[db] " + global.__nsatLoadError);
      })
      .finally(() => {
        global.__nsatInflight = undefined;
      });
  }
  // Stale-while-revalidate: when we already have data, serve it instantly and
  // let the refresh finish in the background. Only a cold start (no data yet)
  // or an explicit Sync (force) blocks on the pull.
  if (loadedAt > 0 && !force) return;
  await global.__nsatInflight;
}

// True only when a hydrate actually landed rows. Pages use this to show an
// honest "not loaded" state instead of rendering a screen full of zeros when a
// cold-start hydrate times out.
export function loadState(): { ok: boolean; reason: string | null } {
  const ok = dataLoaded();
  if (ok) return { ok: true, reason: null };
  return { ok: false, reason: global.__nsatLoadError ?? "The live pull failed or timed out on this request." };
}

export function dataLoaded(): boolean {
  try {
    const r = db.prepare("SELECT COUNT(*) n FROM leads").get() as any;
    return Number(r?.n ?? 0) > 0;
  } catch { return false; }
}

export default db;
