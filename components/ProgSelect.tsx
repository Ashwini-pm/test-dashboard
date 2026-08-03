"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useTransition } from "react";

// Programme bifurcation for the CSAT All tab. Only shown there: the BBA and BCA
// tabs are already a programme split, so a second control on them would be two
// filters meaning the same thing.
//
// Counts sit in the labels so you can see the split without switching. Clearing
// goes back to All programmes rather than leaving a dead param in the URL.

export interface ProgOption { value: string; label: string; n: number }

export default function ProgSelect({ options, current }: { options: ProgOption[]; current: string }) {
  return (
    <Suspense fallback={null}>
      <Inner options={options} current={current} />
    </Suspense>
  );
}

function Inner({ options, current }: { options: ProgOption[]; current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const cur = params.get("prog") || current || "";
  const nf = (n: number) => n.toLocaleString("en-IN");

  const go = (v: string) => {
    const q = new URLSearchParams(params.toString());
    if (v) q.set("prog", v);
    else q.delete("prog");
    startTransition(() => router.push(`${pathname}?${q.toString()}`));
  };

  return (
    <label className={`progsel${pending ? " busy" : ""}`}>
      <span>Programme</span>
      <select value={cur} onChange={(e) => go(e.target.value)}>
        <option value="">All programmes</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label} ({nf(o.n)})
          </option>
        ))}
      </select>
    </label>
  );
}
