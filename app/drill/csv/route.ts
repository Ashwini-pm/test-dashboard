import { ensureFresh } from "@/lib/db";
import { parseCtx, defaultRound, drill, type DrillParams } from "@/lib/v2";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const many = (v: string | string[] | undefined): string[] | null => {
  if (v == null) return null;
  const a = (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
  return a.length ? a : null;
};
const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) ?? null;

// Excel/Sheets-safe CSV: quote everything, double inner quotes, and prefix a
// lone apostrophe on values Excel would mangle into a number or date.
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '""';
  const s = String(v);
  return `"${s.replace(/"/g, '""')}"`;
};

export async function GET(req: Request) {
  await ensureFresh();
  const u = new URL(req.url);
  const g = (k: string) => u.searchParams.getAll(k);
  const ctx = parseCtx(g("ctx")[0]);
  const round = g("round")[0] || defaultRound(ctx);
  const p: DrillParams = {
    src: many(g("src")), camp: many(g("camp")), med: many(g("med")), origin: many(g("origin")), couns: many(g("couns")),
    stage: one(g("stage")), act: one(g("act")), reg: one(g("reg")), age: one(g("age")),
    speed: one(g("speed")), conn: one(g("conn")), nocouns: one(g("nocouns")), q: one(g("q")),
    pstage: one(g("pstage")), has: one(g("has")), cprog: one(g("cprog")), sprog: one(g("sprog")),
    id: one(g("id")), name: one(g("name")), phone: one(g("phone")),
  };

  // limit 0 = every matching row, not just the page's first 1,000
  const { rows, label } = drill(ctx, round, p, 0);

  const head = [
    "lead_id", "name", "phone", "source", "medium", "campaign", "registered",
    "calls", "connected", "first_signup", "first_call_at", "counsellor",
  ];
  const body = rows.map((r) =>
    [r.lead_id, r.name, r.phone, r.source, r.medium, r.campaign, r.registered,
     r.calls, r.connected, r.first_signup ?? "", r.first_call_at ?? "", r.counsellor]
      .map(cell).join(",")
  );
  const csv = "﻿" + [head.map(cell).join(","), ...body].join("\r\n");

  const slug = `${ctx}-${round}-${label}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug || "students"}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
