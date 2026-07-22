-- NSAT Dashboard canonical schema (SQLite).
-- Kept source-agnostic: ingestion maps any CSV/extract into these tables.
-- Migratable to Postgres/MySQL with minimal type changes.
--
-- CANONICAL FUNNEL (9 stages, in order). `stage`/`current_stage` use these keys:
--   1 lead          - lead exists, not yet registered
--   2 registration  - registered for NSAT
--   3 before_test   - post-registration, pre-exam (test-reminder outreach lives here)
--   4 test          - appeared for the exam
--   5 result        - pass / fail
--   6 slot_form      - passed student picks a counselling slot
--   7 counselling   - counsellor session held
--   8 offer_letter  - offer rolled out
--   9 seat_payment  - final conversion

PRAGMA foreign_keys = ON;

-- Sales/outreach agents. The AI voice bot is modelled as a rep so call_logs
-- can attribute calls uniformly (human calls will land here too later).
CREATE TABLE IF NOT EXISTS reps (
  rep_id        TEXT PRIMARY KEY,
  name          TEXT,
  team          TEXT,
  region        TEXT,
  kind          TEXT            -- 'ai' | 'human'
);

-- Master lead. One row per (student, round). Join key strategy: phone10
-- (last 10 digits) is the canonical match key across fragmented sources.
CREATE TABLE IF NOT EXISTS leads (
  lead_id               TEXT PRIMARY KEY,
  student_id            TEXT,
  phone                 TEXT,
  phone10               TEXT,   -- normalized join key
  email                 TEXT,
  full_name             TEXT,
  city                  TEXT,
  region                TEXT,
  nsat_round            TEXT,   -- NSAT-1 | NSAT-2 | NSAT-3
  source                TEXT,
  assigned_rep_id       TEXT REFERENCES reps(rep_id),
  login_creds_received  INTEGER DEFAULT 1,  -- 0 = flagged in "not received" list
  created_at            TEXT,
  current_stage         TEXT    -- derived cache, e.g. 'before_test'
);
CREATE INDEX IF NOT EXISTS idx_leads_phone10 ON leads(phone10);
CREATE INDEX IF NOT EXISTS idx_leads_round   ON leads(nsat_round);

-- Funnel stage tables. Only registrations + before-test calling are populated
-- from the current AI-calling feed; the rest exist for later stages/sources.
CREATE TABLE IF NOT EXISTS registrations (
  lead_id       TEXT REFERENCES leads(lead_id),
  nsat_round    TEXT,
  registered_at TEXT
);
CREATE TABLE IF NOT EXISTS test_results (
  lead_id    TEXT REFERENCES leads(lead_id),
  test_at    TEXT,
  appeared   INTEGER,
  result     TEXT,           -- pass | fail
  score      REAL
);
CREATE TABLE IF NOT EXISTS slot_forms (
  lead_id        TEXT REFERENCES leads(lead_id),
  submitted_at   TEXT,
  preferred_slot TEXT
);
CREATE TABLE IF NOT EXISTS counselling_sessions (
  lead_id      TEXT REFERENCES leads(lead_id),
  rep_id       TEXT REFERENCES reps(rep_id),
  scheduled_at TEXT,
  held_at      TEXT,
  status       TEXT,
  outcome      TEXT
);
CREATE TABLE IF NOT EXISTS offer_letters (
  lead_id            TEXT REFERENCES leads(lead_id),
  issued_at          TEXT,
  scholarship_band   TEXT,
  scholarship_amount REAL,
  accepted           INTEGER
);
CREATE TABLE IF NOT EXISTS payments (
  lead_id  TEXT REFERENCES leads(lead_id),
  paid_at  TEXT,
  amount   REAL,
  status   TEXT
);

-- Contact log. Extended beyond the base schema to keep the AI-call feed's
-- rich fields (status/sentiment/cost/hangup). channel distinguishes AI vs human.
CREATE TABLE IF NOT EXISTS call_logs (
  call_id          TEXT PRIMARY KEY,
  provider_sid     TEXT,
  lead_id          TEXT REFERENCES leads(lead_id),
  rep_id           TEXT REFERENCES reps(rep_id),
  channel          TEXT,      -- 'ai_call' | 'human_call' | 'whatsapp' | 'email' | 'sms'
  direction        TEXT,      -- outbound | inbound
  stage            TEXT,      -- funnel stage at time of contact
  answered         INTEGER,   -- 1 if connected (status completed), else 0
  calling_wave     INTEGER,   -- 1|2|3 = 1st/2nd/3rd calling pass within the round
  status           TEXT,      -- completed | rejected | no-answer | machine | ...
  sentiment        TEXT,      -- notinterested | Processing | N/A | ...
  hangup_source    TEXT,      -- Carrier | Caller | AI | Unknown
  duration_sec     REAL,
  cost             REAL,
  attempted_at     TEXT,
  nsat_round       TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_lead  ON call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_round ON call_logs(nsat_round);
CREATE INDEX IF NOT EXISTS idx_calls_stage ON call_logs(stage);

-- Outcome captured by the before-test reminder call (the "Booking" tabs):
-- intent bucket + captured appointment/attendance details.
CREATE TABLE IF NOT EXISTS call_outcomes (
  outcome_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id          TEXT REFERENCES leads(lead_id),
  nsat_round       TEXT,
  stage            TEXT,       -- 'before_test'
  calling_wave     INTEGER,    -- 1|2|3
  category         TEXT,       -- one of the 6 buckets
  attending        INTEGER,    -- 1 attending, 0 not attending, NULL unknown
  creds_received   INTEGER,    -- 1/0/NULL
  preferred_date   TEXT,
  preferred_time   TEXT,
  notes            TEXT,
  campaign_id      TEXT,
  created_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_outcomes_lead ON call_outcomes(lead_id);

-- Stage-level targets (achieved-vs-target KPIs). Loaded from a targets sheet/CSV
-- when provided; empty until then so tiles show "target not set" (no fake numbers).
CREATE TABLE IF NOT EXISTS stage_targets (
  nsat_round TEXT,
  stage_key  TEXT,     -- registration | test | result | counselling | offer_letter | seat_payment
  target     REAL,
  PRIMARY KEY (nsat_round, stage_key)
);

-- Aggregated call activity per lead (when a source gives summary, not per-call
-- rows, e.g. the CRM lead_call_logs rollup). channel distinguishes human vs ai.
CREATE TABLE IF NOT EXISTS lead_call_summary (
  lead_id        TEXT REFERENCES leads(lead_id),
  channel        TEXT,      -- 'human_call' | 'ai_call'
  total_attempts INTEGER,
  connected      INTEGER,
  first_attempt  TEXT,
  last_connected TEXT,
  total_seconds  INTEGER,
  as_of          TEXT       -- window the summary covers
);
CREATE INDEX IF NOT EXISTS idx_callsum_lead ON lead_call_summary(lead_id);

-- Channel plan: which outreach channel is used at each funnel stage (from the
-- team's stage x channel matrix). Reference/config data, not per-lead.
-- status: 'active' (used), 'primary' (heaviest touch), 'dropped' (deliberately
-- off), 'inactive' (available but not used), 'none' (blank in the plan).
CREATE TABLE IF NOT EXISTS stage_channels (
  stage_label  TEXT,     -- plan label: LEAD, REG, Before Test, ...
  stage_key    TEXT,     -- canonical funnel key it maps to
  stage_order  INTEGER,
  channel      TEXT,     -- ai_call | human_call | sms | email | whatsapp | other
  status       TEXT
);
CREATE INDEX IF NOT EXISTS idx_stagechan ON stage_channels(stage_key, channel);
