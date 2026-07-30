import type { ReactNode } from "react";
import Link from "next/link";
import { ensureFresh } from "@/lib/db";
import { parseCtx, defaultRound, drill, drillFacets, type DrillParams } from "@/lib/v2";

export const dynamic = "force-dynamic";

const nf = (n: number) => n.toLocaleString("en-IN");
const day = (iso: string | null) => (iso ? String(iso).slice(0, 10) : "—");

// Repeated query params (?src=A&src=B) arrive as string[]; single as string.
const many = (v: string | string[] | undefined): string[] | null => {
  if (v == null) return null;
  const a = (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
  return a.length ? a : null;
};
const one = (v: string | string[] | undefined): string | null =>
  (Array.isArray(v) ? v[0] : v) ?? null;

const PAGE_SIZE = 250;

const CALLS: [string, string][] = [["", "any"], ["never", "never called"], ["called", "called"], ["noconn", "no answer"]];
const CONNS: [string, string][] = [["", "any"], ["1", "connected"], ["0", "not connected"]];
const REGS: [string, string][] = [["", "any"], ["paid", "registered"], ["unpaid", "not registered"]];
const AGES: [string, string][] = [["", "any"], ["b1", "untouched 0–8h"], ["b2", "8–24h"], ["b3", "24–72h"], ["b4", "72h+"]];
const SPEEDS: [string, string][] = [
  ["", "any"], ["s0", "≤1 hr"], ["s1", "1–24 hrs"], ["s2", "1–3 days"], ["s3", "3+ days"], ["s4", "before signup"],
];

export default async function Drill({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  await ensureFresh();
  const ctx = parseCtx(one(sp.ctx));
  const round = one(sp.round) || defaultRound(ctx);
  const p: DrillParams = {
    src: many(sp.src), camp: many(sp.camp), origin: many(sp.origin), couns: many(sp.couns),
    stage: one(sp.stage), act: one(sp.act), reg: one(sp.reg), age: one(sp.age), speed: one(sp.speed),
    conn: one(sp.conn), nocouns: one(sp.nocouns), q: one(sp.q), pstage: one(sp.pstage), cprog: one(sp.cprog), sprog: one(sp.sprog),
    id: one(sp.id), name: one(sp.name), phone: one(sp.phone), tg: one(sp.tg),
  };
  const pageNum = Math.max(1, Number(one(sp.page) ?? 1) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;
  const { rows, total, label } = drill(ctx, round, p, PAGE_SIZE, offset);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + rows.length;
  // CSV link carries the exact filters in view, so the export always matches
  // what is on screen — and it is NOT capped at 1,000.
  const pageHref = (n: number) => `/drill?${csvQs}${csvQs ? "&" : ""}page=${n}`;
  const csvQs = (() => {
    const q = new URLSearchParams();
    if (ctx === "CSAT") q.set("ctx", "CSAT");
    q.set("round", round);
    const single: [string, string | null | undefined][] = [
      ["stage", p.stage], ["act", p.act], ["reg", p.reg], ["age", p.age], ["speed", p.speed],
      ["conn", p.conn], ["nocouns", p.nocouns], ["q", p.q], ["pstage", p.pstage],
      ["cprog", p.cprog], ["sprog", p.sprog], ["id", p.id], ["name", p.name], ["phone", p.phone], ["tg", p.tg],
    ];
    for (const [k, v] of single) if (v) q.set(k, v);
    const multi: [string, string[] | null | undefined][] = [
      ["src", p.src], ["camp", p.camp], ["origin", p.origin], ["couns", p.couns],
    ];
    for (const [k, arr] of multi) for (const v of arr ?? []) q.append(k, v);
    return q.toString();
  })();
  const f = drillFacets(ctx, round);
  const back = `/?${ctx === "CSAT" ? "ctx=CSAT&" : ""}round=${round}`;
  const clear = `/drill?${ctx === "CSAT" ? "ctx=CSAT&" : ""}round=${round}`;

  // multi-select: ctrl/cmd-click to pick several; OR within a column, AND across columns
  const multi = (name: string, opts: string[], selected: string[] | null | undefined, extra?: [string, string]) => (
    <select name={name} multiple size={3} defaultValue={selected ?? []} className="dh-multi">
      {extra && <option value={extra[0]}>{extra[1]}</option>}
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  const single = (name: string, opts: [string, string][], v: string | null | undefined) => (
    <select name={name} defaultValue={v ?? ""} className="dh-one">
      {opts.map(([val, l]) => <option key={val} value={val}>{l}</option>)}
    </select>
  );
  const text = (name: string, v: string | null | undefined, ph: string) => (
    <input type="text" name={name} defaultValue={v ?? ""} placeholder={ph} className="dh-txt" />
  );

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{nf(total)} students</h1>
          <div className="sub">{ctx} · {round} · {label}</div>
        </div>
        <div className="spacer" />
        <Link href={back} className="chip">← back to overview</Link>
      </div>

      <section className="grid mb">
        <div className="card">
          <header>
            <h3>Matching students</h3>
            <span className="cap">
              {`showing ${nf(from)}–${nf(to)} of ${nf(total)}`}
              {pages > 1 ? ` · page ${nf(pageNum)} of ${nf(pages)}` : ""}
              {" · filter in the header row · ⌘/ctrl-click for multiple"}
            </span>
          </header>

          {/* One GET form wrapping the table: filters live in the header cells. */}
          <form method="GET" action="/drill">
            {ctx === "CSAT" && <input type="hidden" name="ctx" value="CSAT" />}
            <input type="hidden" name="round" value={round} />
            {p.stage && <input type="hidden" name="stage" value={p.stage} />}
            {p.pstage && <input type="hidden" name="pstage" value={p.pstage} />}
            {p.tg && <input type="hidden" name="tg" value={p.tg} />}
            {p.cprog && <input type="hidden" name="cprog" value={p.cprog} />}
            {p.sprog && <input type="hidden" name="sprog" value={p.sprog} />}

            <div className="dh-bar">
              <button type="submit" className="df-btn">Apply filters</button>
              <Link href={clear} className="chip">Clear all</Link>
              <a href={`/drill/csv?${csvQs}`} className="chip dh-csv" download>
                ↓ Download CSV{total > rows.length ? ` (all ${nf(total)})` : ""}
              </a>
              {p.nocouns === "1" && <input type="hidden" name="nocouns" value="1" />}
            </div>

            <div className="cv-scroll">
              <table className="cv-table dh-table">
                <thead>
                  <tr>
                    <th className="dh-idx">#</th>
                    <th>Lead ID</th>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Source</th>
                    <th>Campaign</th>
                    <th>Registered</th>
                    <th className="tnum">Calls</th>
                    <th className="tnum">Conn.</th>
                    <th>Signed up</th>
                    <th>1st call</th>
                    <th>Counsellor</th>
                  </tr>
                  <tr className="dh-row">
                    <th className="dh-idx" />
                    <th>{text("id", p.id, "id")}</th>
                    <th>{text("name", p.name, "name")}</th>
                    <th>{text("phone", p.phone, "phone")}</th>
                    <th>{multi("src", f.sources, p.src, ["No CRM source", "No CRM source"])}</th>
                    <th>{multi("camp", f.campaigns, p.camp)}</th>
                    <th>{single("reg", REGS, p.reg)}</th>
                    <th>{single("act", CALLS, p.act)}</th>
                    <th>{single("conn", CONNS, p.conn)}</th>
                    <th>{single("age", AGES, p.age)}</th>
                    <th>{single("speed", SPEEDS, p.speed)}</th>
                    <th>{multi("couns", f.counsellors, p.couns, ["__none__", "(unassigned)"])}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.lead_id}>
                      <td className="dh-idx">{offset + i + 1}</td>
                      <td>{r.lead_id}</td>
                      <td>{r.name || "—"}</td>
                      <td className={r.phone && !/^\d/.test(r.phone) ? "df-enc" : ""}>{r.phone || "—"}</td>
                      <td>{r.source}</td>
                      <td>{r.campaign || "—"}</td>
                      <td className={r.registered === "paid" ? "cv-reg" : "cv-unreg"}>{r.registered || "—"}</td>
                      <td className="tnum">{r.calls}</td>
                      <td className="tnum">{r.connected}</td>
                      <td>{day(r.first_signup)}</td>
                      <td>{day(r.first_call_at)}</td>
                      <td>{r.counsellor || "—"}</td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr><td colSpan={12} className="cap">no students match this slice</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <nav className="dh-pager">
                <a className={`chip${pageNum <= 1 ? " off" : ""}`} href={pageNum > 1 ? pageHref(pageNum - 1) : undefined}>← prev</a>
                {(() => {
                  // first, last, and a window around the current page
                  const want = new Set<number>([1, pages, pageNum, pageNum - 1, pageNum + 1, pageNum - 2, pageNum + 2]);
                  const list = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
                  const out: ReactNode[] = [];
                  let prev = 0;
                  for (const n of list) {
                    if (prev && n - prev > 1) out.push(<span key={`gap${n}`} className="dh-gap">…</span>);
                    out.push(
                      <a key={n} href={pageHref(n)} className={`chip${n === pageNum ? " on" : ""}`}>{nf(n)}</a>
                    );
                    prev = n;
                  }
                  return out;
                })()}
                <a className={`chip${pageNum >= pages ? " off" : ""}`} href={pageNum < pages ? pageHref(pageNum + 1) : undefined}>next →</a>
              </nav>
            )}
          </form>
        </div>
      </section>
    </>
  );
}
