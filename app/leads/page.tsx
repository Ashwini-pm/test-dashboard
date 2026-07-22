import Link from "next/link";
import { leads, leadFilterOptions, tileFilter } from "@/lib/queries";
import { ensureFresh } from "@/lib/db";
import LeadsFilters from "@/components/LeadsFilters";

export const dynamic = "force-dynamic";

// Human-readable status per derived stage (what actually happened to the kid).
function stageDisplay(stage: string | null, testResult: string | null): { label: string; badge: string } {
  switch (stage) {
    case "seat_payment": return { label: "Seat booked", badge: "b-green" };
    case "offer_letter": return { label: "Offer released", badge: "b-green" };
    case "counselling": return { label: "Counselled", badge: "b-green" };
    case "slot_form": return { label: "Slot booked", badge: "b-green" };
    case "result":
      return testResult === "fail"
        ? { label: "Test failed", badge: "b-red" }
        : { label: "Test passed", badge: "b-green" };
    case "test": return { label: "Appeared, result pending", badge: "b-blue" };
    case "registration": return { label: "Registered, no test", badge: "b-blue" };
    case "lead": return { label: "Not registered", badge: "b-gray" };
    default: return { label: stage ?? "-", badge: "b-gray" };
  }
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ round?: string; stage?: string; tile?: string; q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  await ensureFresh(); // pull live data from Supabase (TTL-cached)
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const result = leads({ round: sp.round, stage: sp.stage, tile: sp.tile, q: sp.q, page });
  const opts = leadFilterOptions();
  const tf = sp.tile ? tileFilter(sp.tile) : null;

  const from = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const to = Math.min(result.total, result.page * result.pageSize);

  function pageHref(p: number) {
    const params = new URLSearchParams();
    if (sp.round) params.set("round", sp.round);
    if (sp.stage) params.set("stage", sp.stage);
    if (sp.tile) params.set("tile", sp.tile);
    if (sp.q) params.set("q", sp.q);
    params.set("page", String(p));
    return `/leads?${params.toString()}`;
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Leads</h1>
          <div className="sub">Filter, search and open any lead in the funnel</div>
        </div>
        <div className="spacer" />
        <span className="pill">
          <span className="dot" /> {result.total.toLocaleString("en-IN")} matching leads
        </span>
      </div>

      <div className="card">
        <LeadsFilters
          rounds={opts.rounds}
          stages={opts.stages}
          current={{ round: sp.round ?? "all", stage: sp.stage ?? "all", q: sp.q ?? "" }}
        />
        {tf ? (
          <div className="tile-chip">
            Filtered: <b>{tf.label}</b>
            <Link href={`/leads${sp.round ? `?round=${sp.round}` : ""}`} className="tile-chip-x" aria-label="Clear filter">
              ✕
            </Link>
          </div>
        ) : null}

        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>City</th>
              <th>Round</th>
              <th>Current stage</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ color: "var(--text-faint)" }}>
                  No leads match these filters.
                </td>
              </tr>
            ) : (
              result.rows.map((r) => (
                <tr key={r.lead_id} style={{ cursor: "pointer" }}>
                  <td>
                    <Link href={`/leads/${encodeURIComponent(r.lead_id)}`} style={{ fontWeight: 600, textDecoration: "none" }}>
                      {r.full_name || "(unnamed)"}
                    </Link>
                  </td>
                  <td className="tnum">
                    <Link href={`/leads/${encodeURIComponent(r.lead_id)}`} style={{ textDecoration: "none" }}>
                      {r.phone || "-"}
                    </Link>
                  </td>
                  <td>{r.city || "-"}</td>
                  <td>{r.nsat_round || "-"}</td>
                  <td>
                    {(() => {
                      const d = stageDisplay(r.current_stage, r.test_result);
                      return <span className={`badge ${d.badge}`}>{d.label}</span>;
                    })()}
                  </td>
                  <td>{r.source || "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="pager">
          <Link href={pageHref(result.page - 1)} className={`${result.page <= 1 ? "disabled" : ""}`}>
            Previous
          </Link>
          <span className="tnum">
            {from.toLocaleString("en-IN")} to {to.toLocaleString("en-IN")} of {result.total.toLocaleString("en-IN")}
            {"  "}(page {result.page} of {result.pages})
          </span>
          <Link href={pageHref(result.page + 1)} className={`${result.page >= result.pages ? "disabled" : ""}`}>
            Next
          </Link>
        </div>
      </div>
    </>
  );
}
