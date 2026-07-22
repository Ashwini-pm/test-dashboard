"use server";

import { revalidatePath } from "next/cache";
import { ensureFresh } from "@/lib/db";

// "Sync now" button: force a full data refresh (Supabase + Calls Booked sheet),
// then re-render every page with the fresh numbers.
export async function refreshData(): Promise<void> {
  await ensureFresh(true);
  revalidatePath("/", "layout");
}
