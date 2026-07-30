import Link from "next/link";
import type { SourceStage } from "@/lib/v2";
import { NO_SRC } from "@/lib/v2";

// Stacked bars: one row per funnel stage, split by the CRM's source category
// (never the student's own utm_source). Colors are assigned in a FIXED order so
// a source keeps its hue across stages and rounds — never cycled by rank.
// Palette = validated categorical set (light surface); NO_SRC is a neutral gray
// because it marks a data gap, not a real source.
const SRC_COLOR: Record<string, string> = {
  "Influencers": "#2a78d6",
  "Organic": "#eb6834",
  "Direct": "#1baf7a",
  "Inbound": "#eda100",
  "Youtube Channels": "#e87ba4",
  "Paid Performance Google": "#008300",
  "Instagram Organic": "#4a3aa7",
  "Others": "#e34948",
  [NO_SRC]: "#898781",
};
const colorOf = (src: string) => SRC_COLOR[src] ?? "#898781";
const nf = (n: number) => n.toLocaleString("en-IN");

export default function SourceBars({ stages, legend, qs }: { stages: SourceStage[]; legend: string[]; qs: string }) {
  if (!stages.length) {
    return <p className="sb-empty">No CRM-source mapping for this round yet.</p>;
  }
  // Only lead/registration live in the map, so only those drill down.
  const stageParam = (key: string) => (key === "lead" ? "lead" : key === "registration" ? "reg" : null);
  const href = (stageKey: string, src?: string) => {
    const st = stageParam(stageKey);
    if (!st) return null;
    return `/drill?${qs}&stage=${st}${src ? `&src=${encodeURIComponent(src)}` : ""}`;
  };
  // One shared scale across stages, so bar lengths are comparable down the funnel.
  const max = Math.max(1, ...stages.map((s) => s.total));

  return (
    <div className="sb">
      <div className="sb-legend">
        {legend.map((src) => (
          <span key={src} className="sb-key">
            <i style={{ background: colorOf(src) }} />
            {src}
          </span>
        ))}
        {stages.some((s) => s.totalCalled > 0) && (
          <span className="sb-key sb-note">leads <span className="sb-called">| called</span></span>
        )}
      </div>

      <div className="sb-rows">
        {stages.map((st) => (
          <div key={st.key} className="sb-row">
            <div className="sb-name">{st.label}</div>
            <div className="sb-track">
              <div className="sb-bar" style={{ width: `${(st.total / max) * 100}%` }}>
                {st.parts.map((p) => {
                  const h = href(st.key, p.src);
                  const sharedStyle = { flexGrow: p.n, background: colorOf(p.src) };
                  const tipTitle = `${p.src} · ${nf(p.n)} leads | ${nf(p.called)} called (${Math.round((p.n / st.total) * 100)}%)`;
                  const tip = (
                    <span className="sb-tip">
                      {p.src}: <b>{nf(p.n)}</b> · {Math.round((p.n / st.total) * 100)}%
                      <br />
                      called: <b>{nf(p.called)}</b>
                      {p.n > 0 ? ` (${Math.round((p.called / p.n) * 100)}%)` : ""}
                    </span>
                  );
                  return h ? (
                    <Link key={p.src} href={h} className="sb-seg sb-clickable" style={sharedStyle} title={tipTitle}>
                      {tip}
                    </Link>
                  ) : (
                    <div key={p.src} className="sb-seg" style={sharedStyle} title={tipTitle}>
                      {tip}
                    </div>
                  );
                })}
              </div>
              <div className="sb-total tnum">
                {href(st.key) ? (
                  <Link href={href(st.key)!} className="sb-link">
                    {nf(st.total)}
                    {st.totalCalled > 0 && <span className="sb-called"> | {nf(st.totalCalled)}</span>}
                  </Link>
                ) : (
                  <>
                    {nf(st.total)}
                    {st.totalCalled > 0 && <span className="sb-called"> | {nf(st.totalCalled)}</span>}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Relief for the sub-3:1 hues + the a11y table view: identity never by color alone. */}
      <details className="sb-table">
        <summary>Show numbers</summary>
        <div className="sb-scroll">
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                {legend.map((s) => <th key={s} className="tnum">{s}</th>)}
                <th className="tnum">Total</th>
              </tr>
            </thead>
            <tbody>
              {stages.map((st) => (
                <tr key={st.key}>
                  <td>{st.label}</td>
                  {legend.map((s) => {
                    const hit = st.parts.find((p) => p.src === s);
                    if (!hit) return <td key={s} className="tnum">—</td>;
                    const h = href(st.key, s);
                    const inner = (
                      <>
                        {nf(hit.n)}
                        {hit.called > 0 && <span className="sb-called"> | {nf(hit.called)}</span>}
                      </>
                    );
                    return (
                      <td key={s} className="tnum">
                        {h ? <Link href={h} className="sb-link">{inner}</Link> : inner}
                      </td>
                    );
                  })}
                  <td className="tnum">
                    <b>{nf(st.total)}</b>
                    {st.totalCalled > 0 && <span className="sb-called"> | {nf(st.totalCalled)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
