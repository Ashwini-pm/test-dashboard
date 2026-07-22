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

async function pullTable(supaTable: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(supaTable)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${supaTable}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
  }
  return rows;
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
  db.pragma("foreign_keys = OFF"); // robust even if a cached (dev global) db had it on
  if (!supabaseConfigured) {
    console.warn("[db] Supabase not configured - serving empty in-memory DB");
    global.__nsatLoadedAt = Date.now();
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
  ]);
  const [results, booked, olsb, csat] = pulled;
  // Never cache an empty pull: rendering all-zeros is worse than retrying.
  const gotLeads = results.find(([t]) => t === "leads")?.[1]?.length ?? 0;
  if (gotLeads === 0) throw new Error("leads pull returned 0 rows; keeping previous data");
  for (const [t, rows] of results) repopulate(t, rows);
  if (booked && booked.length > 0) overlayCounselling(booked);
  if (olsb && olsb.length > 0) overlayOLSB(olsb);
  if (csat) overlayNsat4Csat(csat);
  // Slot-form submissions (live via Apps Script) -> slot_forms, matched by phone.
  try {
    overlaySlotForms(await pullTable("nsat_student_slots"));
  } catch (e: any) {
    console.warn("[db] student_slots pull failed:", e?.message);
  }
  deriveStages();
  global.__nsatLoadedAt = Date.now();
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
  const pull = async (table: string) => {
    const PAGE = 1000;
    const rows: Record<string, any>[] = [];
    for (let from = 0; ; from += PAGE) {
      const res = await fetch(
        `${url}/rest/v1/${table}?select=*&limit=${PAGE}&offset=${from}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(20000) }
      );
      if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
      const page = (await res.json()) as Record<string, any>[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return rows;
  };
  return Promise.all(
    ["nsat4", "bba", "bca", "combined"].map(async (t) => ({ table: t, rows: await pull(t) }))
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
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM registrations WHERE nsat_round IN ('NSAT-4','CSAT','CSAT-BBA','CSAT-BCA','CSAT-COMB')").run();
    db.prepare("DELETE FROM leads WHERE nsat_round IN ('NSAT-4','CSAT','CSAT-BBA','CSAT-BCA','CSAT-COMB')").run();
    for (const { table, rows } of pulls) {
      const round =
        table === "nsat4" ? "NSAT-4" :
        table === "bba" ? "CSAT-BBA" :
        table === "bca" ? "CSAT-BCA" : "CSAT-COMB";
      for (const r of rows) {
        const lid = table === "nsat4" ? `NSAT-4-${r.id}` : `CSAT-${table}-${r.id}`;
        insLead.run(
          lid, String(r.id ?? ""), r.full_name ?? null, r.phone ?? null, p10(String(r.phone ?? "")),
          r.email ?? null, r.user_city ?? null, r.program ?? null, round, r.lead_source ?? null
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
  const loadedAt = global.__nsatLoadedAt ?? 0;
  const fresh = loadedAt > 0 && Date.now() - loadedAt < TTL_MS;
  if (fresh && !force) return;
  if (!global.__nsatInflight) {
    global.__nsatInflight = refresh().finally(() => {
      global.__nsatInflight = undefined;
    });
  }
  // Stale-while-revalidate: when we already have data, serve it instantly and
  // let the refresh finish in the background. Only a cold start (no data yet)
  // or an explicit Sync (force) blocks on the pull.
  if (loadedAt > 0 && !force) return;
  await global.__nsatInflight;
}

export default db;
