import Link from "next/link";
import type { SourceStage } from "@/lib/v2";
import { NO_SRC } from "@/lib/v2";

// Part-to-whole by source, one donut per map-backed stage (Lead, Registration).
// Colors are the same fixed-order validated palette used everywhere else, so a
// source keeps its hue across every chart. NO_SRC is neutral gray: a data gap,
// not a real source.
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
const colorOf = (s: string) => SRC_COLOR[s] ?? "#898781";
const nf = (n: number) => n.toLocaleString("en-IN");

const R = 62;      // outer radius
const RI = 38;     // inner radius (donut hole)
const C = 74;      // svg center
const TAU = Math.PI * 2;

function arc(startFrac: number, endFrac: number): string {
  // 2px visual gap between slices is achieved by trimming the sweep slightly.
  const a0 = startFrac * TAU - Math.PI / 2;
  const a1 = endFrac * TAU - Math.PI / 2;
  const big = endFrac - startFrac > 0.5 ? 1 : 0;
  const x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0);
  const x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
  const ix1 = C + RI * Math.cos(a1), iy1 = C + RI * Math.sin(a1);
  const ix0 = C + RI * Math.cos(a0), iy0 = C + RI * Math.sin(a0);
  return `M ${x0} ${y0} A ${R} ${R} 0 ${big} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${RI} ${RI} 0 ${big} 0 ${ix0} ${iy0} Z`;
}

// Every funnel stage maps onto a drill filter: pre-test via the map, post-test
// via pstage (which joins the stage tables). So all donuts are clickable.
const STAGE_FILTER: Record<string, string> = {
  lead: "stage=lead", registration: "reg=paid",
  test: "pstage=test", result: "pstage=pass", slot_form: "pstage=slot",
  counselling: "pstage=couns", offer_letter: "pstage=ol", seat_payment: "pstage=seat",
};

function Donut({ stage, qs }: { stage: SourceStage; qs: string }) {
  const filter = STAGE_FILTER[stage.key] ?? null;
  let acc = 0;
  const slices = stage.parts.map((p) => {
    const start = acc / stage.total;
    acc += p.n;
    const end = acc / stage.total;
    // trim the tail of each slice for a hairline gap between fills
    const gap = stage.parts.length > 1 ? Math.min(0.004, (end - start) / 4) : 0;
    return { ...p, d: arc(start, Math.max(start, end - gap)) };
  });

  return (
    <div className="pie-unit">
      <svg viewBox="0 0 148 148" className="pie-svg" role="img" aria-label={`${stage.label} by source`}>
        {slices.map((s) => {
          const title = `${s.src}: ${nf(s.n)} (${Math.round((s.n / stage.total) * 100)}%)`;
          const path = <path d={s.d} fill={colorOf(s.src)} stroke="#fff" strokeWidth={1.5} />;
          return filter ? (
            <Link key={s.src} href={`/drill?${qs}&${filter}&src=${encodeURIComponent(s.src)}`}>
              <title>{title}</title>
              {path}
            </Link>
          ) : (
            <g key={s.src}><title>{title}</title>{path}</g>
          );
        })}
        <text x={C} y={C - 3} textAnchor="middle" className="pie-c1">{nf(stage.total)}</text>
        <text x={C} y={C + 13} textAnchor="middle" className="pie-c2">{stage.label}</text>
      </svg>
      {stage.totalCalled > 0 && (
        <div className="pie-sub">
          called <b className="sb-called">{nf(stage.totalCalled)}</b>
          <span className="pie-dim"> ({Math.round((stage.totalCalled / stage.total) * 100)}%)</span>
        </div>
      )}
    </div>
  );
}

export default function SourcePie({ stages, legend, qs }: { stages: SourceStage[]; legend: string[]; qs: string }) {
  // Every stage with data gets a donut (NSAT-3 has the full funnel; CSAT has two).
  const pies = stages.filter((s) => s.total > 0);
  if (!pies.length) return <p className="sb-empty">No CRM-source mapping for this round yet.</p>;

  return (
    <div className="pie-wrap">
      <div className="sb-legend">
        {legend.map((src) => (
          <span key={src} className="sb-key"><i style={{ background: colorOf(src) }} />{src}</span>
        ))}
      </div>

      <div className="pie-row">
        {pies.map((s) => <Donut key={s.key} stage={s} qs={qs} />)}
      </div>

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
              {pies.map((st) => (
                <tr key={st.key}>
                  <td>{st.label}</td>
                  {legend.map((s) => {
                    const hit = st.parts.find((x) => x.src === s);
                    if (!hit) return <td key={s} className="tnum">—</td>;
                    const fl = STAGE_FILTER[st.key];
                    return (
                      <td key={s} className="tnum">
                        <Link href={`/drill?${qs}&${fl ?? "stage=lead"}&src=${encodeURIComponent(s)}`} className="sb-link">
                          {nf(hit.n)}
                          {hit.called > 0 && <span className="sb-called"> | {nf(hit.called)}</span>}
                        </Link>
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
