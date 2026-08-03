import Link from "next/link";
import type { PostChannel, PostRow } from "@/lib/channels";

// Post-test communication by channel, then turn-up. Terminology is fixed for
// stakeholder reporting: Touched = a call was dialled; Connected / Not connected
// are splits of Touched. Turn-up is the panelist's record.
//
// Four turn-up states, not two: "to be rescheduled" is not a no-show, and
// "not known yet" is not a no-show. Merging either would invent no-shows.

const nf = (n: number) => n.toLocaleString("en-IN");
const pc = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function Cell({ n, of, href, tone }: { n: number; of?: number; href?: string; tone?: string }) {
  if (!n) return <td className="tnum fc-zero">—</td>;
  const body = (
    <>
      {nf(n)}
      {of !== undefined && <span className="fc-pct"> {pc(n, of)}</span>}
    </>
  );
  return (
    <td className={`tnum ${tone ?? ""}`}>
      {href ? <Link href={href} className="sb-link">{body}</Link> : body}
    </td>
  );
}

function ChannelTable({ ch, qs }: { ch: PostChannel; qs: string }) {
  const url = (base: string, extra?: string) => `/drill?${qs}&${base}${extra ? `&${extra}` : ""}`;
  // Touched is the denominator for its two children, the population for the rest.
  const touched = ch.rows.find((r) => r.key.endsWith("_touched"))?.students ?? 0;
  const den = (r: PostRow) => (r.indent ? touched : ch.total);

  return (
    <>
      <h4 className="ta-h">{ch.label}</h4>
      <div className="cv-scroll">
        <table className="cv-table pt-table">
          <thead>
            <tr>
              <th />
              <th className="tnum">Students</th>
              <th className="tnum">Turned up</th>
              <th className="tnum">Did not turn up</th>
              <th className="tnum">To be rescheduled</th>
              <th className="tnum">Not known yet</th>
            </tr>
          </thead>
          <tbody>
            {ch.rows.map((r) => (
              <tr key={r.key}>
                <td className={r.indent ? "cb-inner" : undefined}>{r.label}</td>
                <Cell n={r.students} of={den(r)} href={url(r.drill)} />
                <Cell n={r.turn.turnedUp} of={r.students} href={url(r.drill, "pstage=couns")} tone="cv-reg" />
                <Cell n={r.turn.noShow} of={r.students} tone="fc-bad" />
                <Cell n={r.turn.rescheduled} of={r.students} tone="fc-warn" />
                <Cell n={r.turn.unknown} of={r.students} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function PostTestChannels({
  channels, population, qs,
}: {
  channels: PostChannel[];
  population: number;
  qs: string;
}) {
  return (
    <section className="grid mb">
      <div className="card">
        <header>
          <h3>Post test · by channel</h3>
          <span className="cap">
            the {nf(population)} students who gave the test · calls from 30 Jul, the test day, onward
          </span>
        </header>

        {channels.map((ch) => <ChannelTable key={ch.key} ch={ch} qs={qs} />)}

        <p className="ta-foot">
          <b>Touched</b> means a call was dialled; <b>Connected</b> and <b>Not connected</b> are splits of Touched, so
          their percentages are of Touched and the two add back to it. Touched plus Not touched add back to the{" "}
          {nf(population)} who gave the test.
          {" "}Turn-up comes from the panelist form only. <b>To be rescheduled</b> and <b>Not known yet</b> are kept
          apart from <b>Did not turn up</b> on purpose: a rescheduled session is not a no-show, and a student the
          panelists have not filed yet is not a no-show either.
          {" "}<b>Touched counts calls from 30 Jul onward</b>, the test day. For humans that comes from the last-call
          timestamp, which is exact for &quot;was there a call in the window&quot;. <b>Connected is not exact for humans</b>:
          the CRM has no last-connected timestamp, so it reads &quot;called in the window and connected at some point&quot;.
          Adding Last_Connected_Call to the lead map, which your master sheet already has, makes it exact. AI keeps
          per-call timestamps, so both columns are exact there.
          {" "}WhatsApp is not shown: there is no WhatsApp feed for CSAT-1 yet.
        </p>
      </div>
    </section>
  );
}
