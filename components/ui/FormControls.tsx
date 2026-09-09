import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

const BASE_CONTROL =
  "w-full rounded-xl border bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-sm outline-none transition placeholder:font-normal placeholder:text-slate-500 focus:ring-4";

function controlTone(invalid?: boolean): string {
  return invalid
    ? "border-rose-400 focus:border-rose-600 focus:ring-rose-100"
    : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-100";
}

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Text shown as a faint "optional" tag, or `true` to render a bullet. */
  optional?: string | boolean;
  /** Text direction applied to the label row (bilingual forms). */
  dir?: "ltr" | "rtl";
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}

export function Field({
  label,
  hint,
  error,
  required,
  optional,
  dir,
  children,
  htmlFor,
  className,
}: FieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <label
          htmlFor={htmlFor}
          dir={dir}
          className="flex items-center gap-1.5 text-xs font-bold text-slate-800"
        >
          <span>{label}</span>
          {required ? <span className="text-rose-500">*</span> : null}
          {optional ? (
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
              {optional === true ? "•" : optional}
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="flex items-center gap-1 text-xs font-semibold text-rose-700">
          <span aria-hidden>⚠</span>
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs font-medium text-slate-600">{hint}</p>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  leading?: ReactNode;
}

export function TextInput({ invalid, leading, className, ...rest }: TextInputProps) {
  const control = (
    <input
      className={cn(BASE_CONTROL, controlTone(invalid), leading && "ps-9", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
  if (!leading) return control;
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-slate-500">
        {leading}
      </span>
      {control}
    </div>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function TextArea({ invalid, className, rows = 3, ...rest }: TextAreaProps) {
  return (
    <textarea
      rows={rows}
      className={cn(BASE_CONTROL, controlTone(invalid), "resize-y", className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function SelectInput({ invalid, className, children, ...rest }: SelectInputProps) {
  return (
    <div className="relative">
      <select
        className={cn(
          BASE_CONTROL,
          controlTone(invalid),
          "appearance-none pe-9",
          className,
        )}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-slate-500"
      >
        ▾
      </span>
    </div>
  );
}

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  id?: string;
}

export function ToggleSwitch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  id,
}: ToggleSwitchProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-300 bg-white px-3 py-2.5 shadow-sm">
      <div className="min-w-0">
        <label htmlFor={inputId} className="block text-sm font-semibold text-slate-900">
          {label}
        </label>
        {hint ? <p className="mt-0.5 text-xs font-medium text-slate-600">{hint}</p> : null}
      </div>
      <button
        id={inputId}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500",
          checked ? "bg-indigo-600" : "bg-slate-400",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "start-[1.375rem]" : "start-0.5",
          )}
        />
      </button>
    </div>
  );
}
