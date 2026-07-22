"use client";

import { useMemo, useState } from "react";
import type { SNode } from "@/lib/v2";

// Click-to-expand funnel sankey. A node with children shows a chevron; click
// toggles its split. Ribbon width ∝ students. Numbers only (no drill to lists).

const TONE: Record<string, string> = {
  good: "#1f8a5b", bad: "#c0392b", warn: "#a07c00", info: "#2c5f8a", neutral: "#101828",
};
const NODE_W = 168;
const COL_GAP = 84;
const H = 430;
const PAD = 10;

interface Placed { node: SNode; depth: number; y: number; h: number; parent?: Placed; }

export default function Sankey({ root }: { root: SNode }) {
  const [open, setOpen] = useState<Set<string>>(new Set([root.id]));

  const placed = useMemo(() => {
    const cols: Placed[][] = [];
    const walk = (n: SNode, depth: number, parent?: Placed) => {
      const p: Placed = { node: n, depth, y: 0, h: 0, parent };
      (cols[depth] ||= []).push(p);
      if (n.children && open.has(n.id)) for (const c of n.children) walk(c, depth + 1, p);
    };
    walk(root, 0);
    // per-column vertical stacking, height ∝ n (per-column scale keeps it fitting)
    for (const col of cols) {
      const total = col.reduce((s, p) => s + Math.max(1, p.node.n), 0);
      const avail = H - PAD * 2 - (col.length - 1) * 14;
      let y = PAD;
      for (const p of col) {
        p.h = Math.max(30, (Math.max(1, p.node.n) / total) * avail);
        p.y = y;
        y += p.h + 14;
      }
      // if overflow, squeeze
      const over = y - 14 + PAD - H;
      if (over > 0) {
        const k = (H - PAD * 2 - (col.length - 1) * 14) / (y - 14 - PAD);
        let yy = PAD;
        for (const p of col) { p.h = Math.max(24, p.h * k); p.y = yy; yy += p.h + 14; }
      }
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
    <div className="sankey-wrap">
      <svg viewBox={`0 0 ${width} ${H}`} style={{ width: "100%", height: "auto" }}>
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
              stroke={TONE[p.node.tone]} strokeWidth={w} fill="none" strokeLinecap="round" />
          );
        })}
        {/* nodes */}
        {flat.map((p) => {
          const x = p.depth * (NODE_W + COL_GAP);
          const expandable = !!p.node.children;
          const isOpen = open.has(p.node.id);
          return (
            <g key={p.node.id} className="sk-node" onClick={() => toggle(p.node)} style={{ cursor: expandable ? "pointer" : "default" }}>
              <rect x={x} y={p.y} width={NODE_W} height={p.h} rx={10}
                fill="#fff" stroke={TONE[p.node.tone]} strokeWidth={1.6} />
              <rect x={x} y={p.y} width={5} height={p.h} rx={2.5} fill={TONE[p.node.tone]} />
              <text x={x + 14} y={p.y + Math.min(20, p.h / 2 - 2)} fontSize={11.5} fontWeight={600} fill="#5a6572">
                {p.node.label}{expandable ? (isOpen ? "  ▾" : "  ▸") : ""}
              </text>
              <text x={x + 14} y={p.y + Math.min(20, p.h / 2 - 2) + 17} fontSize={15} fontWeight={800} fill="#101828">
                {p.node.n.toLocaleString("en-IN")}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="cap" style={{ marginTop: 6 }}>click a box to split it further · red = dropped, blue = communicated (human)</div>
    </div>
  );
}
