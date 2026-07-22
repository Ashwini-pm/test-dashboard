"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { refreshData } from "@/app/actions";

// One-click data sync: forces a fresh pull (Supabase + sheet) and re-renders.
// Spinner shows while the refresh runs so it's obvious something is happening.
export default function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      className={`refresh-btn${pending ? " busy" : ""}`}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await refreshData();
          router.refresh();
        })
      }
      aria-label="Sync data from sources"
    >
      <svg className={`refresh-ic${pending ? " spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
      <span className="nav-label">{pending ? "Syncing…" : "Sync now"}</span>
    </button>
  );
}
