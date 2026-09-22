import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/utils/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  // Primary is charcoal with a restrained gold focus ring: clear in a busy
  // register without turning the application into a saturated colour system.
  primary: "alyq-btn-primary focus-visible:outline-[#b08d57]",
  secondary:
    "bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-[#faf7f2] hover:ring-stone-400 focus-visible:outline-stone-500",
  ghost: "text-stone-700 hover:bg-stone-100 focus-visible:outline-stone-500",
  danger:
    "bg-rose-600 text-white font-semibold shadow-md shadow-rose-200 hover:bg-rose-700 focus-visible:outline-rose-600",
  subtle: "bg-[#faf5ec] text-stone-800 ring-1 ring-[#d9c7a5] hover:bg-[#f4eadb] focus-visible:outline-[#b08d57]",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-11 px-5 text-sm gap-2 sm:h-11",
  icon: "h-9 w-9 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={rest.type ?? "button"}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonProps & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition-colors",
        "hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2",
        "focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
