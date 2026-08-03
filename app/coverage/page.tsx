import { ensureFresh } from "@/lib/db";
import { auditTables, auditMemory, auditBlocks } from "@/lib/coverage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const nf = (n: number) => n.toLocaleString("en-IN");

const TONE: Record<string, string> = {
  unreadable: "dc-bad", "not-pulled": "dc-warn", empty: "dc-warn", ok: "dc-ok", ignored: "dc-mute",
};
const WORD: Record<string, string> = {
  unreadable: "cannot read", "not-pulled": "not used", empty: "empty", ok: "in use", ignored: "ignored",
};

export default async function DataCoverage() {
  await ensureFresh();
  const tables = await auditTables();
  const mem = auditMemory();
  const allBlocks = auditBlocks();
  const blocks = allBlocks.filter((b) => !b.expected);
  const known = allBlocks.filter((b) => b.expected);
  const problems = tables.filter((t) => t.state === "unreadable" || t.state === "not-pulled");
  const memBad = mem.filter((m) => !m.ok);
  const anything = problems.length + memBad.length + blocks.length;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Data coverage</h1>
          <div className="sub">what exists in Supabase vs what the dashboard actually shows</div>
        </div>
      </div>

      <section className="grid mb">
        <div className={`card${anything ? " co-caveat" : ""}`}>
          <header>
            <h3>{anything ? `Needs attention (${anything})` : "Everything readable is mapped and every block renders"}</h3>
            <span className="cap">run this after any pipeline change</span>
          </header>
          {anything === 0 ? (
            <p className="sb-empty">Every table the key can read is either in use or deliberately ignored, every in-memory table has rows, and no page is rendering a block empty while the data exists.</p>
          ) : (
            <ul className="dc-list">
              {problems.map((t) => (
                <li key={t.table}><b>{t.table}</b> — {t.note}</li>
              ))}
              {memBad.map((m) => (
                <li key={m.table}><b>{m.table}</b> — in-memory table is empty after hydrate</li>
              ))}
              {blocks.map((b, i) => (
                <li key={`b${i}`}><b>{b.round}</b> — {b.issue}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {known.length > 0 && (
        <section className="grid mb">
          <div className="card">
            <header><h3>Known gaps</h3><span className="cap">accepted, with the reason — not regressions</span></header>
            <ul className="dc-list dc-mute">
              {known.map((b, i) => (
                <li key={`k${i}`}><b>{b.round}</b> — {b.issue}<br /><i>{b.expected}</i></li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="grid mb">
        <div className="card">
          <header><h3>Supabase tables</h3><span className="cap">NSAT CSAT project, as the dashboard&apos;s key sees them</span></header>
          <div className="cv-scroll">
            <table className="cv-table">
              <thead><tr><th>Table</th><th className="tnum">Rows</th><th>State</th><th>Note</th></tr></thead>
              <tbody>
                {tables.map((t) => (
                  <tr key={t.table}>
                    <td>{t.table}</td>
                    <td className="tnum">{t.rows === null ? "–" : nf(t.rows)}</td>
                    <td className={TONE[t.state]}>{WORD[t.state]}</td>
                    <td className="dc-note">{t.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid mb">
        <div className="card">
          <header><h3>In-memory tables after hydrate</h3><span className="cap">empty here means a mapping broke</span></header>
          <div className="cv-scroll">
            <table className="cv-table">
              <thead><tr><th>Table</th><th className="tnum">Rows</th><th>State</th></tr></thead>
              <tbody>
                {mem.map((m) => (
                  <tr key={m.table}>
                    <td>{m.table}</td>
                    <td className="tnum">{nf(m.rows)}</td>
                    <td className={m.ok ? "dc-ok" : "dc-bad"}>{m.ok ? "ok" : "EMPTY"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
