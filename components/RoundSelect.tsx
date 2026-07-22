"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useTransition } from "react";

// Topbar round shifter: segmented pills (NSAT-2/3/4, or BBA/BCA/Combined).
export default function RoundSelect({ options, current }: { options: string[]; current: string }) {
  return (
    <Suspense fallback={null}>
      <Inner options={options} current={current} />
    </Suspense>
  );
}

function Inner({ options, current }: { options: string[]; current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const cur = params.get("round") || current;

  const go = (v: string) => {
    if (v === cur) return;
    const q = new URLSearchParams(params.toString());
    q.set("round", v);
    startTransition(() => router.push(`${pathname}?${q.toString()}`));
  };

  return (
    <div className={`rounds${pending ? " busy" : ""}`}>
      {options.map((o) => (
        <button key={o} onClick={() => go(o)} className={o === cur ? "on" : undefined}>{o}</button>
      ))}
    </div>
  );
}
