import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

export const SearchIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const PlusIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const EditIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </svg>
);

export const EyeIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12S18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
);

export const ArchiveIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
);

export const RestoreIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <path d="M4 10a8 8 0 1 1 2.3 5.7" />
    <path d="M4 5v5h5" />
  </svg>
);

export const ChevronIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const CloseIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const MenuIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const GlobeIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.5 9h17M3.5 15h17M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
  </svg>
);

export const BoxIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
    <path d="m3 8 9 5 9-5M12 13v8" />
  </svg>
);

export const LayersIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </svg>
);

export const GridIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

export const TrashIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </svg>
);

export const WarehouseIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <path d="M3 9.5 12 4l9 5.5V20H3z" />
    <path d="M7 20v-7h10v7" />
    <path d="M7 13h10" />
  </svg>
);

export const PlusCircleIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);

export const MinusCircleIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12h8" />
  </svg>
);

export const HistoryIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const AlertIcon = (props: IconProps) => (
  <svg {...base} width="16" height="16" {...props}>
    <path d="M12 3 2 21h20z" />
    <path d="M12 10v4" />
    <path d="M12 18h.01" />
  </svg>
);

export const ShoppingCartIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <circle cx="9" cy="20" r="1.4" />
    <circle cx="18" cy="20" r="1.4" />
    <path d="M2 3h3l2.6 12.4a1.5 1.5 0 0 0 1.5 1.1h9.2a1.5 1.5 0 0 0 1.5-1.2L21.5 7H6" />
  </svg>
);

export const ReceiptIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <path d="M5 3h14v18l-2.3-1.5L14.4 21l-2.4-1.5L9.6 21l-2.3-1.5L5 21z" />
    <path d="M9 8h6M9 12h6M9 16h4" />
  </svg>
);

export const UsersIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const RotateCcwIcon = (props: IconProps) => (
  <svg {...base} width="18" height="18" {...props}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
