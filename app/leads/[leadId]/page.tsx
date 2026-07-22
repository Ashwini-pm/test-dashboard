import Link from "next/link";
import { notFound } from "next/navigation";
import { leadDetail } from "@/lib/queries";
import { ensureFresh } from "@/lib/db";
import { IconArrowLeft } from "@/components/icons";

export const dynamic = "force-dynamic";

const nf = (n: number) => n.toLocaleString("en-IN");

const STAGE_LABEL: Record<string, string> = {
  lead: "Lead",
  registration: "Registration",
  before_test: "Before Test",
  test: "Test",
  result: "Result",
  slot_form: "Slot Form",
  counselling: "Counselling",
  offer_letter: "Offer Letter",
  seat_payment: "Seat Payment",
};

function initials(name: string | null): string {
  if (!name) return "NA";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "NA";
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  await ensureFresh(); // pull live data from Supabase (TTL-cached)
  const d = leadDetail(decodeURIComponent(leadId));
  if (!d.lead) notFound();
  const lead = d.lead;

  return (
    <>
      <Link href="/leads" className="back">
        <IconArrowLeft className="ic" /> Back to leads
      </Link>

      <div className="topbar">
        <div className="detail-head">
          <div className="av">{initials(lead.full_name)}</div>
          <div>
            <h1>{lead.full_name || "(unnamed lead)"}</h1>
            <div className="sub">
              {lead.phone || "no phone"} · {lead.email || "no email"} · {lead.city || "city unknown"}
            </div>
          </div>
        </div>
        <div className="spacer" />
        <span className="stagechip">{lead.nsat_round || "-"}</span>
        <span className="pill">
          <span className="dot" /> {STAGE_LABEL[lead.current_stage ?? ""] ?? lead.current_stage ?? "-"}
        </span>
      </div>

      {/* Identity facts */}
      <section className="grid mb">
        <div className="card">
          <header>
            <h3>Lead facts</h3>
            <span className="cap">{lead.lead_id}</span>
          </header>
          <div className="facts">
            <Fact k="Round" v={lead.nsat_round || "-"} />
            <Fact k="Current stage" v={STAGE_LABEL[lead.current_stage ?? ""] ?? lead.current_stage ?? "-"} />
            <Fact k="Source" v={lead.source || "-"} />
            <Fact k="City" v={lead.city || "-"} />
            <Fact
              k="Login creds"
              v={lead.login_creds_received === 0 ? "NOT received" : "received"}
            />
          </div>
        </div>
      </section>

      {/* Funnel facts */}
      <section className="grid mb">
        <div className="card">
          <header>
            <h3>Funnel record</h3>
            <span className="cap">registration / test / counselling</span>
          </header>
          <div className="facts">
            <Fact
              k="Registration"
              v={d.registration ? `registered${d.registration.registered_at ? " · " + d.registration.registered_at : ""}` : "no record"}
            />
            <Fact
              k="Test"
              v={
                d.test
                  ? `${d.test.appeared ? "appeared" : "absent"}${d.test.result ? " · " + d.test.result : ""}${d.test.score != null ? " · score " + d.test.score : ""}`
                  : "no record"
              }
            />
            <Fact
              k="Counselling"
              v={d.counselling ? `${d.counselling.status || "held"}${d.counselling.held_at ? " · " + d.counselling.held_at : ""}` : "no record"}
            />
          </div>

          {d.outcomes.length > 0 && (
            <>
              <div className="note" style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 22, marginBottom: 6, fontWeight: 600 }}>
                Captured call outcomes
              </div>
              <table className="data">
                <thead>
                  <tr>
                    <th>Wave</th>
                    <th>Category</th>
                    <th>Attending</th>
                    <th>Creds</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {d.outcomes.map((o, i) => (
                    <tr key={i}>
                      <td>
                        <span className="wv">{o.calling_wave ?? "-"}</span>
                      </td>
                      <td>{o.category || "-"}</td>
                      <td>{o.attending === 1 ? "Yes" : o.attending === 0 ? "No" : "-"}</td>
                      <td>{o.creds_received === 1 ? "Yes" : o.creds_received === 0 ? "No" : "-"}</td>
                      <td style={{ color: "var(--text-muted)" }}>{o.notes || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </section>

      {/* Call history */}
      <section className="grid">
        <div className="card">
          <header>
            <h3>Call history</h3>
            <span className="cap">{nf(d.calls.length)} calls logged</span>
          </header>
          {d.calls.length === 0 ? (
            <div className="pbar" style={{ borderStyle: "dashed" }}>
              no call records for this lead
            </div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Wave</th>
                  <th>Status</th>
                  <th>Sentiment</th>
                  <th className="r">Duration</th>
                  <th className="r">Cost</th>
                  <th>Hangup</th>
                  <th>Attempted</th>
                </tr>
              </thead>
              <tbody>
                {d.calls.map((c) => (
                  <tr key={c.call_id}>
                    <td>
                      <span className="wv">{c.calling_wave ?? "-"}</span>
                    </td>
                    <td>{c.status || "-"}</td>
                    <td>{c.sentiment || "-"}</td>
                    <td className="r tnum">{c.duration_sec != null ? `${Math.round(c.duration_sec)}s` : "-"}</td>
                    <td className="r tnum">{c.cost != null ? `Rs ${c.cost.toFixed(2)}` : "-"}</td>
                    <td>{c.hangup_source || "-"}</td>
                    <td style={{ color: "var(--text-muted)" }}>{c.attempted_at || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="fact">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
