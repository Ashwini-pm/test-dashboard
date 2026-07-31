import Link from "next/link";
import type { CsatCalling, CallSegment } from "@/lib/channels";

// Two channels side by side, never summed: the same student can be dialled by both.
// Every figure counts leads, not calls. Connected is a share of DIALLED, not of
// leads, because the two channels dial very different numbers of people.
//
// Not a funnel chart: Dialled and Connected are nested, and the two channels sit
// alongside each other rather than feeding one another.

const nf = (n: number) => n.toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

// "2026-07-30 07:17:00+00" -> "30 Jul, 12:47 PM IST"
function istStamp(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 5.5 * 3600 * 1000);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h24 = d.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${h}:${mm} ${h24 < 12 ? "AM" : "PM"} IST`;
}

export default function CallingBlock({
  data, qs,
}: {
  data: CsatCalling;
  /** base drill query string, e.g. "ctx=CSAT&round=All" */
  qs: string;
}) {
  const { all, segments, aiLastCall } = data;
  const stamp = istStamp(aiLastCall);
  const L = (n: number, f: string, cls?: string) =>
    n > 0
      ? <Link href={`/drill?${qs}&${f}`} className={`sb-link${cls ? ` ${cls}` : ""}`}>{nf(n)}</Link>
      : <span className={cls}>{nf(n)}</span>;

  // Rows of the hierarchy. Indented rows are inside Dialled.
  const rows: { label: string; h: number; a: number | null; hf: string; af: string; inner?: boolean; tone?: string }[] = [
    { label: "Dialled", h: all.human.dialled, a: all.ai.dialled, hf: "hc=dialled", af: "ac=dialled" },
    { label: "Connected", h: all.human.connected, a: all.ai.connected, hf: "hc=conn", af: "ac=conn", inner: true, tone: "cv-reg" },
    { label: "Not connected", h: all.human.notConnected, a: all.ai.notConnected, hf: "hc=noconn", af: "ac=noconn", inner: true, tone: "fc-warn" },
    { label: "Never dialled", h: all.human.neverDialled, a: all.ai.neverDialled, hf: "hc=never", af: "ac=never", tone: "fc-bad" },
  ];

  const seg = (s: CallSegment) => (
    <tr key={s.key} className={s.key === "all" ? "co-strong" : undefined}>
      <td>{s.label}</td>
      <td className="tnum">{L(s.leads, s.key === "reg" ? "reg=paid" : s.key === "unreg" ? "reg=unpaid" : "")}</td>
      <td className="tnum cb-h">{L(s.human.dialled, `${segFilter(s)}hc=dialled`)}</td>
      <td className="tnum cb-h">{L(s.human.connected, `${segFilter(s)}hc=conn`, "cv-reg")}</td>
      <td className="tnum cb-pct">{pct(s.human.connected, s.human.dialled)}</td>
      <td className="tnum cb-a">{L(s.ai.dialled, `${segFilter(s)}ac=dialled`)}</td>
      <td className="tnum cb-a">{L(s.ai.connected, `${segFilter(s)}ac=conn`, "cv-reg")}</td>
      <td className="tnum cb-pct">{pct(s.ai.connected, s.ai.dialled)}</td>
    </tr>
  );

  const unreg = segments.find((s) => s.key === "unreg");

  return (
    <section className="grid mb">
      <div className="card">
        <header>
          <h3>Calling · CSAT-1</h3>
          <span className="cap">
            leads, never calls · connected is a share of dialled
            {stamp ? ` · AI as of last sync, ${stamp}` : ""}
          </span>
        </header>

        <div className="cv-scroll">
          <table className="cv-table cb-table">
            <thead>
              <tr>
                <th />
                <th className="tnum cb-h">Human (CRM)</th>
                <th className="tnum">%</th>
                <th className="tnum cb-a">AI (Alchemyst)</th>
                <th className="tnum">%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className={r.inner ? "cb-inner" : undefined}>{r.label}</td>
                  <td className={`tnum${r.tone ? ` ${r.tone}` : ""}`}>{L(r.h, r.hf)}</td>
                  <td className="tnum cb-pct">{r.inner ? pct(r.h, all.human.dialled) : ""}</td>
                  <td className={`tnum${r.tone ? ` ${r.tone}` : ""}`}>{r.a === null ? "–" : L(r.a, r.af)}</td>
                  <td className="tnum cb-pct">{r.inner && r.a !== null ? pct(r.a, all.ai.dialled) : ""}</td>
                </tr>
              ))}
              <tr>
                <td>No calling data</td>
                <td className="tnum">{L(all.human.noData ?? 0, "hc=nodata")}</td>
                <td className="tnum" />
                <td className="tnum fc-zero">not applicable</td>
                <td className="tnum" />
              </tr>
              <tr className="co-strong">
                <td>Leads</td>
                <td className="tnum">{nf(all.leads)}</td>
                <td className="tnum" />
                <td className="tnum">{nf(all.leads)}</td>
                <td className="tnum" />
              </tr>
            </tbody>
          </table>
        </div>

        <h4 className="ta-h">By registration</h4>
        <div className="cv-scroll">
          <table className="cv-table cb-table">
            <thead>
              <tr>
                <th>Segment</th>
                <th className="tnum">Leads</th>
                <th className="tnum cb-h">Human dialled</th>
                <th className="tnum cb-h">Human connected</th>
                <th className="tnum">Human connect %</th>
                <th className="tnum cb-a">AI dialled</th>
                <th className="tnum cb-a">AI connected</th>
                <th className="tnum">AI connect %</th>
              </tr>
            </thead>
            <tbody>{segments.map(seg)}</tbody>
          </table>
        </div>

        <div className="ta-gap">
          AI connects with <b>{pct(all.ai.connected, all.ai.dialled)}</b> of the students it dials, people with{" "}
          <b>{pct(all.human.connected, all.human.dialled)}</b>. But AI is pointed almost entirely at students who have
          already registered: of {unreg ? nf(unreg.leads) : "—"} unregistered leads it has dialled{" "}
          <b>{unreg ? nf(unreg.ai.dialled) : "—"}</b>.
          <br />
          People dialled <b>{nf(all.human.notConnected)}</b> leads and never got through to any of them — the largest
          wasted-effort bucket on this page.
        </div>

        <p className="ta-foot">
          The two channels are never added together: the same student can be dialled by both, so a total would count
          them twice. <b>No calling data</b> ({nf(all.human.noData ?? 0)} leads) means the CRM dump has no row for that
          lead, so we cannot say whether anyone called — it is kept apart from <b>Never dialled</b>, which is a real
          zero. Human calling refreshes every 10 minutes; AI call data loads on demand, so its columns are as of the
          last sync rather than live.
        </p>
      </div>
    </section>
  );
}

// segment rows carry their own registration filter into every cell
function segFilter(s: CallSegment): string {
  if (s.key === "reg") return "reg=paid&";
  if (s.key === "unreg") return "reg=unpaid&";
  return "";
}
