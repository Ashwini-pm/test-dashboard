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
    conn: one(sp.conn), nocouns: one(sp.nocouns), q: one(sp.q), pstage: one(sp.pstage),
    id: one(sp.id), name: one(sp.name), phone: one(sp.phone),
  };
  const { rows, total, label } = drill(ctx, round, p);
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
              {total > rows.length ? `showing first ${nf(rows.length)} of ${nf(total)}` : `${nf(rows.length)} rows`}
              {" · filter in the header row · ⌘/ctrl-click for multiple"}
            </span>
          </header>

          {/* One GET form wrapping the table: filters live in the header cells. */}
          <form method="GET" action="/drill">
            {ctx === "CSAT" && <input type="hidden" name="ctx" value="CSAT" />}
            <input type="hidden" name="round" value={round} />
            {p.stage && <input type="hidden" name="stage" value={p.stage} />}
            {p.pstage && <input type="hidden" name="pstage" value={p.pstage} />}

            <div className="dh-bar">
              <button type="submit" className="df-btn">Apply filters</button>
              <Link href={clear} className="chip">Clear all</Link>
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
                      <td className="dh-idx">{i + 1}</td>
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
          </form>
        </div>
      </section>
    </>
  );
}
