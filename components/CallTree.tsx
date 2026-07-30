import Link from "next/link";
import type { CallNode } from "@/lib/v2";

// Click-to-expand tree, no client JS: <details> per branch, same shape as the
// Sankey (Lead -> called / not called -> picked / not picked).
// Counts are NESTED: "Registered · Called" is a subset of "Lead · Called".
const nf = (n: number) => n.toLocaleString("en-IN");

function Node({ node, qs, depth = 0 }: { node: CallNode; qs: string; depth?: number }) {
  const kids = node.children ?? [];
  const label = (
    <span className="ct-label">
      <span className={`ct-dot ct-${node.tone ?? "info"}`} />
      {node.label}
      {node.drill ? (
        <Link href={`/drill?${qs}&${node.drill}`} className="ct-n sb-link">{nf(node.n)}</Link>
      ) : (
        <span className="ct-n">{nf(node.n)}</span>
      )}
    </span>
  );

  if (!kids.length) return <div className={`ct-leaf ct-d${depth}`}>{label}</div>;

  return (
    <details className={`ct-branch ct-d${depth}`} open={depth === 0}>
      <summary>{label}</summary>
      <div className="ct-kids">
        {kids.map((k) => <Node key={k.key} node={k} qs={qs} depth={depth + 1} />)}
      </div>
    </details>
  );
}

export default function CallTree({ nodes, qs }: { nodes: CallNode[]; qs: string }) {
  if (!nodes.length) return <p className="sb-empty">No calling data mapped for this round.</p>;
  return (
    <div className="ct">
      {/* Split down the middle: registered on the left, not registered on the right.
          Calling targets the not-registered side, so that funnel is the actionable one. */}
      <div className="ct-split">
        {nodes.map((n) => (
          <div key={n.key} className="ct-side">
            <Node node={n} qs={qs} />
          </div>
        ))}
      </div>
      <p className="cv-caveat">
        The two sides are <b>mutually exclusive</b> and sum to the Lead total. Within a side, counts
        are nested. The map stores one call aggregate per lead and no registration timestamp, so
        calls cannot be split into before/after registering.
      </p>
    </div>
  );
}
