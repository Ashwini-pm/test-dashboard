"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, useTransition } from "react";
import { IconGrid, IconLeads, IconMatrix } from "./icons";
import RefreshButton from "./RefreshButton";

// V2: one dropdown (NSAT | CSAT), three tabs. Rounds are not products —
// NSAT-2/3/4 are all just NSAT; the pages decide which rounds are "active".
const TABS = [
  { href: "/", label: "Overview", icon: IconGrid, match: (p: string) => p === "/" },
  { href: "/students", label: "Students", icon: IconLeads, match: (p: string) => p.startsWith("/students") },
  { href: "/comms", label: "Communication", icon: IconMatrix, match: (p: string) => p.startsWith("/comms") },
];

export default function Sidebar() {
  return (
    <Suspense fallback={<aside className="sidebar" />}>
      <SidebarInner />
    </Suspense>
  );
}

function SidebarInner() {
  const pathname = usePathname();
  const params = useSearchParams();
  const ctx = params.get("ctx") === "CSAT" ? "CSAT" : "NSAT";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState("");
  const qs = (c: string) => (c === "NSAT" ? "" : `?ctx=${c}`);

  const switchCtx = (c: string) => {
    if (c === ctx) return;
    setTarget(c);
    startTransition(() => router.push(`${pathname}${qs(c)}`));
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">N</div>
        <div className="brand-text">
          <b>{ctx}</b>
          <small>Command · Sunstone</small>
        </div>
      </div>
      <div className="ctx-select">
        <select value={ctx} onChange={(e) => switchCtx(e.target.value)} aria-label="Switch product">
          <option value="NSAT">NSAT</option>
          <option value="CSAT">CSAT</option>
        </select>
      </div>
      {pending ? (
        <div className="section-loading">
          <span className="spinner" aria-hidden="true" />
          loading {target}…
        </div>
      ) : null}
      <nav className="nav">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <Link key={t.label} href={`${t.href}${qs(ctx)}`} className={t.match(pathname) ? "active" : undefined} title={t.label}>
              <Icon className="ic" />
              <span className="nav-label">{t.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <RefreshButton />
      </div>
    </aside>
  );
}
