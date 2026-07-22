"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useTransition } from "react";

// Topbar round switcher: NSAT -> All / NSAT-2 / NSAT-3 / NSAT-4,
// CSAT -> All / BBA / BCA / Combined. "All" drops the param.
export default function RoundSelect({ options }: { options: string[] }) {
  return (
    <Suspense fallback={null}>
      <Inner options={options} />
    </Suspense>
  );
}

function Inner({ options }: { options: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const cur = params.get("round") || "All";

  const go = (v: string) => {
    const q = new URLSearchParams(params.toString());
    if (v === "All") q.delete("round");
    else q.set("round", v);
    const qs = q.toString();
    startTransition(() => router.push(`${pathname}${qs ? `?${qs}` : ""}`));
  };

  return (
    <div className={`round-select${pending ? " busy" : ""}`}>
      <select value={cur} onChange={(e) => go(e.target.value)} aria-label="Round">
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}
