import Link from "next/link";
import type { ActionBucket, Untouched, SpeedBand } from "@/lib/v2";

// Coverage, not conversion. See lib/v2.ts: calling targets people who did NOT
// register, so these numbers answer "did we work the lead", never "did calling work".
const nf = (n: number) => n.toLocaleString("en-IN");
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export function ActionCoverage({ buckets, qs }: { buckets: ActionBucket[]; qs: string }) {
  const total = buckets.reduce((a, b) => a + b.leads, 0);
  if (!total) return null;
  const called = buckets.filter((b) => b.key !== "never").reduce((a, b) => a + b.leads, 0);
  const connected = buckets.find((b) => b.key === "conn")?.leads ?? 0;
  const gap = buckets.find((b) => b.key === "never")?.notRegistered ?? 0;
  const tone: Record<string, string> = { never: "cv-bad", noconn: "cv-warn", conn: "cv-good" };

  return (
    <div className="cv">
      <div className="cv-rows">
        {buckets.map((b) => (
          <div key={b.key} className="cv-row">
            <div className="cv-name">{b.label}</div>
            <div className="cv-track">
              <div className={`cv-bar ${tone[b.key]}`} style={{ width: `${(b.leads / total) * 100}%` }} />
            </div>
            <div className="cv-n tnum">
              <Link href={`/drill?${qs}&act=${b.key}`} className="sb-link">{nf(b.leads)}</Link>
              <span className="cv-pct"> {pct(b.leads, total)}%</span>
            </div>
            <div className="cv-split">
              <Link href={`/drill?${qs}&act=${b.key}&reg=paid`} className="cv-reg sb-link">{nf(b.registered)} registered</Link>
              <span className="cv-sep">·</span>
              <Link href={`/drill?${qs}&act=${b.key}&reg=unpaid`} className="cv-unreg sb-link">{nf(b.notRegistered)} not</Link>
            </div>
          </div>
        ))}
      </div>
      <div className="cv-foot">
        <span>Connect rate among called: <b>{nf(connected)} / {nf(called)} = {pct(connected, called)}%</b></span>
        {gap > 0 && (
          <Link href={`/drill?${qs}&act=never&reg=unpaid`} className="cv-alert sb-link">
            ⚠ Never touched and not registered: <b>{nf(gap)}</b>
          </Link>
        )}
      </div>
    </div>
  );
}

export function UntouchedAgeing({ data, qs }: { data: Untouched; qs: string }) {
  const max = Math.max(1, ...data.bands.map((b) => b.n));
  return (
    <div className="cv">
      <div className="cv-rows">
        {data.bands.map((b) => (
          <div key={b.key} className="cv-row">
            <div className="cv-name">{b.label}</div>
            <div className="cv-track">
              <div className={`cv-bar cv-${b.tone}`} style={{ width: `${(b.n / max) * 100}%` }} />
            </div>
            <div className="cv-n tnum"><Link href={`/drill?${qs}&age=${b.key}`} className="sb-link">{nf(b.n)}</Link></div>
            <div className="cv-split">
              {b.tone === "good" ? "within SLA" : b.tone === "warn" ? "breaching" : "breached"}
            </div>
          </div>
        ))}
      </div>
      <div className="cv-foot">
        <Link href={`/drill?${qs}&act=never&reg=unpaid`} className="sb-link">Total untouched and unregistered: <b>{nf(data.total)}</b></Link>
        {data.noCounsellor > 0 && (
          <Link href={`/drill?${qs}&nocouns=1`} className="cv-alert sb-link">
            ⚠ No counsellor assigned: <b>{nf(data.noCounsellor)}</b>
          </Link>
        )}
      </div>
    </div>
  );
}

export function SpeedToLead({ bands, qs }: { bands: SpeedBand[]; qs: string }) {
  const max = Math.max(1, ...bands.map((b) => b.n));
  return (
    <div className="cv">
      <div className="cv-rows">
        {bands.map((b) => (
          <div key={b.key} className="cv-row">
            <div className="cv-name">{b.label}</div>
            <div className="cv-track"><div className="cv-bar cv-info" style={{ width: `${(b.n / max) * 100}%` }} /></div>
            <div className="cv-n tnum"><Link href={`/drill?${qs}&speed=${b.key}`} className="sb-link">{nf(b.n)}</Link></div>
            <div className="cv-split" />
          </div>
        ))}
      </div>
    </div>
  );
}
