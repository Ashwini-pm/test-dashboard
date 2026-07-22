import "server-only";

// Direct Google Sheets reader for the Calls Booked day tabs (DD-MM-YYYY).
// Uses the gviz CSV export, which works server-side when the sheet is shared
// "Anyone with the link -> Viewer". No API key, no Apps Script, no cron: the
// dashboard pulls the sheet on every data refresh (TTL-cached like the rest).

const CALLS_SHEET_ID =
  process.env.CALLS_SHEET_ID || "1PU6bXx3rE8WuWdnEPvS7wqUJBefLsQrF_oiqZrglowU";

// How far around today to probe for day tabs (names are dates, tabs get added
// as counselling days are scheduled).
const PROBE_BACK_DAYS = 7;
const PROBE_FWD_DAYS = 21;

export interface BookedRow {
  iso: string; // 2026-07-16
  time: string; // "10:00 am"
  phone: string;
  panelist: string | null;
}

// Minimal CSV parser (handles quoted fields with commas).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

function tabName(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function tabIso(tab: string): string {
  const [dd, mm, yyyy] = tab.split("-");
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchTab(tab: string): Promise<string[][] | null> {
  const url =
    `https://docs.google.com/spreadsheets/d/${CALLS_SHEET_ID}/gviz/tq?tqx=out:csv` +
    `&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null; // tab doesn't exist (or sheet not link-shared)
  const text = await res.text();
  if (text.trimStart().startsWith("<")) return null; // HTML error page
  return parseCsv(text);
}

function col(hdr: string[], ...names: string[]): number {
  const low = hdr.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = low.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
}

// Pull every existing day tab and return the booked rows.
// Throws only on total failure; a missing tab is just skipped.
export async function fetchCallsBooked(): Promise<BookedRow[] | null> {
  const days: string[] = [];
  const now = Date.now();
  for (let off = -PROBE_BACK_DAYS; off <= PROBE_FWD_DAYS; off++) {
    days.push(tabName(new Date(now + off * 86400_000)));
  }
  const tabs = await Promise.all(
    days.map(async (t) => ({ tab: t, vals: await fetchTab(t) }))
  );
  const found = tabs.filter((t) => t.vals && t.vals.length > 1);
  if (found.length === 0) return null; // sheet unreachable / not shared

  const out: BookedRow[] = [];
  for (const { tab, vals } of found) {
    const hdr = vals![0];
    const cPhone = col(hdr, "phone");
    const cTime = col(hdr, "preferred time", "time");
    const cStatus = col(hdr, "status");
    const cPan = col(hdr, "panelist");
    if (cPhone === -1 || cStatus === -1) continue;
    const iso = tabIso(tab);
    for (const r of vals!.slice(1)) {
      const status = (r[cStatus] ?? "").trim();
      if (!status.startsWith("Booked")) continue;
      out.push({
        iso,
        time: (cTime > -1 ? r[cTime] ?? "" : "").trim(),
        phone: (r[cPhone] ?? "").trim(),
        panelist: cPan > -1 && (r[cPan] ?? "").trim() ? (r[cPan] as string).trim() : null,
      });
    }
  }
  return out;
}
