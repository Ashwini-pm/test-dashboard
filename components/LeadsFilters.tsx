"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Friendly names for the derived stage keys.
const STAGE_NAMES: Record<string, string> = {
  lead: "Not registered",
  registration: "Registered, no test",
  before_test: "Before test",
  test: "Appeared, result pending",
  result: "Result out (pass/fail)",
  slot_form: "Slot booked",
  counselling: "Counselled",
  offer_letter: "Offer released",
  seat_payment: "Seat booked",
};

export default function LeadsFilters({
  rounds,
  stages,
  current,
}: {
  rounds: string[];
  stages: string[];
  current: { round: string; stage: string; q: string };
}) {
  const router = useRouter();
  const [round, setRound] = useState(current.round);
  const [stage, setStage] = useState(current.stage);
  const [q, setQ] = useState(current.q);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    const p = new URLSearchParams();
    if (round !== "all") p.set("round", round);
    if (stage !== "all") p.set("stage", stage);
    if (q.trim()) p.set("q", q.trim());
    p.set("page", "1");
    router.push(`/leads?${p.toString()}`);
  }

  return (
    <form className="filters" onSubmit={apply}>
      <label>
        Round
        <select value={round} onChange={(e) => setRound(e.target.value)}>
          <option value="all">All rounds</option>
          {rounds.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label>
        Current stage
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="all">All stages</option>
          {stages.map((s) => (
            <option key={s} value={s}>
              {STAGE_NAMES[s] ?? s}
            </option>
          ))}
        </select>
      </label>
      <label>
        Search
        <input
          type="text"
          placeholder="Name or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      <label>
        &nbsp;
        <button type="submit">Apply</button>
      </label>
    </form>
  );
}
