"use client";

import { useMemo, useState } from "react";
import type { SNode } from "@/lib/v2";

// Click-to-expand funnel sankey. Clicking the BOX toggles its split; clicking the
// NUMBER opens the matching student list (only where the box maps exactly onto a
// map filter — see SNode.drill). Ribbon width ∝ students.

const TONE: Record<string, string> = {
  good: "#1f8a5b", bad: "#c0392b", warn: "#a07c00", info: "#2c5f8a", neutral: "#101828",
};
const NODE_W = 168;
const COL_GAP = 84;
const H = 430;
const PAD = 10;

interface Placed { node: SNode; depth: number; y: number; h: number; parent?: Placed; }

export default function Sankey({ root, qs }: { root: SNode; qs?: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set([root.id]));

  const placed = useMemo(() => {
    const cols: Placed[][] = [];
    const walk = (n: SNode, depth: number, parent?: Placed) => {
      const p: Placed = { node: n, depth, y: 0, h: 0, parent };
      (cols[depth] ||= []).push(p);
      if (n.children && open.has(n.id)) for (const c of n.children) walk(c, depth + 1, p);
    };
    walk(root, 0);
    // ONE scale for the whole diagram, anchored on the root, so a box's height
    // means the same thing in every column. Scaling per column (the old way) made
    // a 387-student box as tall as a 5,284-student box, which is not a sankey.
    const GAP = 12;
    const MIN_H = 22; // still legible when the count is tiny
    const scale = (H - PAD * 2) / Math.max(1, root.n);
    for (const col of cols) {
      const raw = col.map((p) => Math.max(MIN_H, p.node.n * scale));
      // a column can only overflow once min-heights kick in; shrink the ones that
      // have room to give, never the ones already at the floor
      const need = raw.reduce((s, h) => s + h, 0) + (col.length - 1) * GAP;
      const avail = H - PAD * 2;
      if (need > avail) {
        const slackTotal = raw.reduce((s, h) => s + Math.max(0, h - MIN_H), 0);
        const cut = need - avail;
        if (slackTotal > 0) {
          for (let i = 0; i < raw.length; i++) {
            const slack = Math.max(0, raw[i] - MIN_H);
            raw[i] -= (slack / slackTotal) * Math.min(cut, slackTotal);
          }
        }
      }
      // centre the stack vertically so short columns do not hug the top
      const used = raw.reduce((s, h) => s + h, 0) + (col.length - 1) * GAP;
      let y = PAD + Math.max(0, (avail - used) / 2);
      col.forEach((p, i) => { p.h = raw[i]; p.y = y; y += raw[i] + GAP; });
    }
    return cols;
  }, [root, open]);

  const width = placed.length * NODE_W + (placed.length - 1) * COL_GAP;
  const flat = placed.flat();

  const toggle = (n: SNode) => {
    if (!n.children) return;
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
      return next;
    });
  };

  return (
    <div className="sankey-wrap" style={{ overflowX: "auto" }}>
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} style={{ maxWidth: "100%", display: "block" }}>
        {/* ribbons */}
        {flat.filter((p) => p.parent).map((p) => {
          const a = p.parent!;
          const x1 = a.depth * (NODE_W + COL_GAP) + NODE_W;
          const y1 = a.y + a.h / 2;
          const x2 = p.depth * (NODE_W + COL_GAP);
          const y2 = p.y + p.h / 2;
          const w = Math.max(2, Math.min(p.h, a.h) * (p.node.n / Math.max(1, a.node.n)));
          const mx = (x1 + x2) / 2;
          return (
            <path key={`l-${p.node.id}`} className="sk-link" d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              stroke={TONE[p.node.tone]} strokeWidth={w} fill="none" strokeLinecap="round"
              // cross-cut boxes are not a step in the flow, so their ribbon is dashed
              strokeDasharray={p.node.cross ? "5 4" : undefined}
              opacity={p.node.cross ? 0.55 : undefined} />
          );
        })}
        {/* nodes */}
        {flat.map((p) => {
          const x = p.depth * (NODE_W + COL_GAP);
          const expandable = !!p.node.children;
          const isOpen = open.has(p.node.id);
          return (
            <g key={p.node.id} className="sk-node" onClick={() => toggle(p.node)} style={{ cursor: expandable ? "pointer" : "default" }}>
              <rect x={x} y={p.y} width={NODE_W} height={p.h} rx={Math.min(10, p.h / 3)}
                fill="#fff" stroke={TONE[p.node.tone]} strokeWidth={1.6}
                strokeDasharray={p.node.cross ? "4 3" : undefined} />
              <rect x={x} y={p.y} width={5} height={p.h} rx={2.5} fill={TONE[p.node.tone]} />
              {/* Heights are now proportional, so a small box has no room for two
                  lines: label and number share one line and the number right-aligns. */}
              {(() => {
                const twoLine = p.h >= 44;
                const labelY = twoLine ? p.y + 17 : p.y + p.h / 2 + 4;
                const numY = twoLine ? p.y + 36 : labelY;
                const num = p.node.n.toLocaleString("en-IN");
                return (
                  <>
                    <text x={x + 14} y={labelY} fontSize={11.5} fontWeight={600} fill="#5a6572">
                      {p.node.label}{expandable ? (isOpen ? "  ▾" : "  ▸") : ""}
                    </text>
                    {p.node.drill && qs ? (
                      <a href={`/drill?${qs}&${p.node.drill}`} onClick={(e) => e.stopPropagation()}>
                        <title>open the {num} students</title>
                        <text x={twoLine ? x + 14 : x + NODE_W - 12} y={numY}
                          textAnchor={twoLine ? "start" : "end"}
                          fontSize={twoLine ? 15 : 12.5} fontWeight={800}
                          fill="#101828" className="sk-num-link" textDecoration="underline">
                          {num}
                        </text>
                      </a>
                    ) : (
                      <text x={twoLine ? x + 14 : x + NODE_W - 12} y={numY}
                        textAnchor={twoLine ? "start" : "end"}
                        fontSize={twoLine ? 15 : 12.5} fontWeight={800} fill="#101828">
                        {num}
                      </text>
                    )}
                  </>
                );
              })()}
            </g>
          );
        })}
      </svg>
      <div className="cap" style={{ marginTop: 6 }}>
        click a box to split it further · click the number to open that student list
        {" · "}<span style={{ opacity: .75 }}>dashed boxes are offers and seats: a cross-cut, so they overlap their siblings rather than adding up to the parent</span>
      </div>
    </div>
  );
}
