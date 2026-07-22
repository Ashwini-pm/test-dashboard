import type { ReactNode } from "react";

// Inline SVG line icons, copied from the design HTML files. No emojis anywhere.
const s = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

export const IconGrid = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);

export const IconFunnel = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M3 5h18l-7 8v6l-4 2v-8z" />
  </svg>
);

export const IconCall = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M2 8.5a10 5 0 1 0 20 0 10 5 0 1 0-20 0M4 8.5a8 3.5 0 0 0 16 0" />
    <circle cx="12" cy="8.5" r="1.5" />
  </svg>
);

export const IconMatrix = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 3v18M3 12h18" />
  </svg>
);

export const IconLeads = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </svg>
);

export const IconLoss = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M5 21V4M5 4h11l-1.5 3.5L16 11H5" />
  </svg>
);

export const IconUsers = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.5 20a6 6 0 0 1 13 0" />
    <path d="M16 5.5a3 3 0 0 1 0 5.4M21.5 20a5.6 5.6 0 0 0-3.5-4.9" />
  </svg>
);

export const IconPhone = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M20 5.5a3 3 0 0 0-2.6-1.5H6.6A2 2 0 0 0 4 5c0 8 7 15 15 15a2 2 0 0 0 1.8-2.6" />
  </svg>
);

export const IconCheck = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M4 12l5 5L20 6" />
  </svg>
);

export const IconAlert = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M12 9v4M12 17v.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);

export const IconCap = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M2 8l10-4 10 4-10 4z" />
    <path d="M6 10v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5" />
    <path d="M22 8v6" />
  </svg>
);

export const IconTest = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 8h6M9 12h6M9 16h3" />
  </svg>
);

export const IconTriangle = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 12 12" style={{ fill: "currentColor" }}>
    <path d="M6 2l4 7H2z" />
  </svg>
);

export const IconTick = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12l5 5L20 6" />
  </svg>
);

export const IconCross = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconArrowLeft = ({ className }: { className?: string }) => (
  <svg className={className} {...s}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

export const KPI_ICON: Record<string, (p: { className?: string }) => ReactNode> = {
  users: IconUsers,
  phone: IconPhone,
  check: IconCheck,
  alert: IconAlert,
  cap: IconCap,
  test: IconTest,
};
