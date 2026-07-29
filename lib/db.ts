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
  run("CREATE INDEX IF NOT EXISTS ix_n4sb_lead ON nsat4_sb(lead_id)");
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
  const pull = async (table: string) => {
    const PAGE = 1000;
    const head = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
      headers: { ...H, Prefer: "count=exact", Range: "0-0" },
      cache: "no-store", signal: AbortSignal.timeout(20000),
    });
    if (!head.ok) throw new Error(`${table}: HTTP ${head.status}`);
    const total = Number((head.headers.get("content-range") || "").split("/")[1] || 0);
    if (!total) return [];
    const pages = Math.ceil(total / PAGE);
    const chunks = await Promise.all(
      Array.from({ length: pages }, (_, i) =>
        fetch(`${url}/rest/v1/${table}?select=*&limit=${PAGE}&offset=${i * PAGE}`, {
          headers: H, cache: "no-store", signal: AbortSignal.timeout(30000),
        }).then(async (res) => {
          if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
          return (await res.json()) as Record<string, any>[];
        })
      )
    );
    return chunks.flat();
  };
  return Promise.all(
    // nsat4_counselling is pulled for its slot fields only. nsat4_lead_map stays
    // the NSAT-4 lead universe and the authority on offer letter / seat booked.
    ["nsat4", "bba", "bca", "combined", "nsat3_lead_map", "lead_map", "nsat4_lead_map", "nsat5_lead_map", "nsat4_counselling", "nsat4_seat_bookings"].map(async (t) => ({ table: t, rows: await pull(t) }))
  );
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
  db.exec("CREATE TABLE nsat4_map (lead_id TEXT, registered TEXT, campaign_source TEXT, origin TEXT, crm_source_category TEXT, total_calls INTEGER, connected_calls INTEGER, first_signup TEXT, first_call_at TEXT, last_call_at TEXT, counsellor TEXT, name TEXT, phone TEXT, utm_campaign TEXT, offer_letter TEXT, seat_booked TEXT, test_result TEXT, test_creds_shared TEXT)");
  const insN4 = db.prepare("INSERT INTO nsat4_map(lead_id,registered,campaign_source,origin,crm_source_category,total_calls,connected_calls,first_signup,first_call_at,last_call_at,counsellor,name,phone,utm_campaign,offer_letter,seat_booked,test_result,test_creds_shared) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  // Counselling slots for NSAT-4. Booking exists when booking_id is set; there is
  // no attendance/outcome column in the source, so "counselling done" cannot be
  // derived — call_date is the scheduled day, which for now is all in the future.
  // Seat bookings come from the NSAT working sheet, not from crm_leads_6778: that
  // Redash dump filters lead_created >= 14 Jul, so it misses every booking made by
  // a student whose CRM lead predates the round (20 of 25 of them).
  db.exec("DROP TABLE IF EXISTS nsat4_sb");
  db.exec("CREATE TABLE nsat4_sb (lead_id TEXT, sb_date TEXT)");
  const insSb = db.prepare("INSERT INTO nsat4_sb(lead_id,sb_date) VALUES (?,?)");
  db.exec("DROP TABLE IF EXISTS nsat4_slots");
  db.exec("CREATE TABLE nsat4_slots (lead_id TEXT, booking_id TEXT, call_date TEXT, call_time TEXT, panelist TEXT, meet_link TEXT, conf_sent INTEGER, booked_at TEXT)");
  const insSlot = db.prepare("INSERT INTO nsat4_slots(lead_id,booking_id,call_date,call_time,panelist,meet_link,conf_sent,booked_at) VALUES (?,?,?,?,?,?,?,?)");
  db.exec("DROP TABLE IF EXISTS csat_map");
  db.exec("CREATE TABLE csat_map (lead_id TEXT, round_tag TEXT, registered TEXT, campaign_source TEXT, origin TEXT, crm_source_category TEXT, total_calls INTEGER, connected_calls INTEGER, first_signup TEXT, first_call_at TEXT, last_call_at TEXT, counsellor TEXT, name TEXT, phone TEXT, utm_campaign TEXT, crm_program TEXT, signup_programs TEXT)");
  const insCsat = db.prepare("INSERT INTO csat_map(lead_id,round_tag,registered,campaign_source,origin,crm_source_category,total_calls,connected_calls,first_signup,first_call_at,last_call_at,counsellor,name,phone,utm_campaign,crm_program,signup_programs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM registrations WHERE nsat_round IN ('NSAT-4','CSAT','CSAT-BBA','CSAT-BCA','CSAT-COMB')").run();
    db.prepare("DELETE FROM leads WHERE nsat_round IN ('NSAT-4','CSAT','CSAT-BBA','CSAT-BCA','CSAT-COMB')").run();
    db.prepare("DELETE FROM nsat3_map").run();
    db.prepare("DELETE FROM csat_map").run();
    for (const { table, rows } of pulls) {
      if (table === "nsat3_lead_map") {
        mirrorRaw("cohort_nsat3", rows);
        for (const r of rows) insMap.run(String(r.lead_id ?? ""), r.reg_status ?? null, r.campaign_source ?? null, r.origin ?? null, r.crm_source_category ?? null, r.total_calls ?? null, r.connected_calls ?? null, r.first_signup ?? null, r.first_call_at ?? null, r.last_call_at ?? null, r.counsellor ?? null, r.name ?? null, r.phone ?? null, r.utm_campaign ?? null);
        continue;
      }
      if (table === "nsat4_seat_bookings") {
        for (const r of rows) insSb.run(String(r.lead_id ?? ""), r.sb_date ?? null);
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
          r.name ?? null, r.phone ?? null, r.utm_campaign ?? null, r.offer_letter ?? null, r.seat_booked ?? null, r.test_result ?? null, r.test_creds_shared ?? null);
        continue;
      }
      if (table === "lead_map") {
        mirrorRaw("cohort_csat1", rows);
        for (const r of rows) {
          const st = String(r.signup_tables ?? "");
          const tag = st === "bba" ? "CSAT-BBA" : st === "bca" ? "CSAT-BCA" : "CSAT-COMB";
          insCsat.run(String(r.lead_id ?? ""), tag, r.registered ?? null, r.campaign_source ?? null, r.origin ?? null, r.crm_source_category ?? null, r.total_calls ?? null, r.connected_calls ?? null, r.first_signup ?? null, r.first_call_at ?? null, r.last_call_at ?? null, r.counsellor ?? null, r.name ?? null, r.phone ?? null, r.utm_campaign ?? null, r.crm_program ?? null, r.signup_programs ?? null);
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
