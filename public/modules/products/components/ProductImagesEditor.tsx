import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useToast } from "@/components/ui";
import { Button } from "@/components/ui";
import { cn } from "@/utils/cn";
import { MAX_IMAGES } from "../constants";
import type { ProductImageItem } from "../types";
import { createLocalImageItem, revokeLocalPreviews, validateImageFile } from "../services/imageStorage";

/**
 * Product image uploader.
 *
 * - Pick files from desktop/mobile or drag & drop them onto the zone.
 * - Live previews (object URLs) before saving.
 * - First slot is the cover; reorder, replace or remove any slot.
 * - Rejects non-image files and over-size files at selection time.
 * - Up to {@link MAX_IMAGES} images per product.
 */
export function ProductImagesEditor({
  items,
  onChange,
  error,
}: {
  items: ProductImageItem[];
  onChange: (items: ProductImageItem[]) => void;
  error?: string;
}) {
  const { t } = useI18n();
  const toast = useToast();

  const inputRef = useRef<HTMLInputElement>(null);
  const intentRef = useRef<{ type: "add" } | { type: "replace"; index: number }>({ type: "add" });
  const [dragging, setDragging] = useState(false);

  // Revoke object URLs for removed/local items on unmount.
  useEffect(() => () => revokeLocalPreviews(itemsRef.current), []);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const atCapacity = items.length >= MAX_IMAGES;

  const handleFiles = (files: File[]) => {
    let list = [...items];
    let rejectedType = 0;
    let rejectedSize = 0;
    let rejectedLimit = 0;

    for (const file of files) {
      const fileError = validateImageFile(file);
      if (fileError === "type") {
        rejectedType += 1;
        continue;
      }
      if (fileError === "size") {
        rejectedSize += 1;
        continue;
      }
      if (list.length >= MAX_IMAGES) {
        rejectedLimit += 1;
        continue;
      }
      list = [...list, createLocalImageItem(file)];
    }

    if (rejectedType > 0) {
      toast.error(t("validation.imageType"));
    }
    if (rejectedSize > 0) {
      toast.error(t("validation.imageSize", { max: 5 }));
    }
    if (rejectedLimit > 0) {
      toast.push(t("validation.imageCount", { max: MAX_IMAGES }), "info");
    }

    if (list.length !== items.length) onChange(list);
  };

  const openPicker = (intent: { type: "add" } | { type: "replace"; index: number }) => {
    intentRef.current = intent;
    inputRef.current?.click();
  };

  const onInputChange = () => {
    const input = inputRef.current;
    if (!input?.files) return;
    const files = Array.from(input.files);
    const intent = intentRef.current;
    if (intent.type === "replace" && files[0]) {
      const index = intent.index;
      const prev = items[index];
      if (prev?.kind === "local") URL.revokeObjectURL(prev.previewUrl);
      const next = [...items];
      next[index] = createLocalImageItem(files[0]);
      onChange(next);
    } else {
      handleFiles(files);
    }
    // Reset so re-selecting the same file still fires `change`.
    input.value = "";
  };

  const remove = (index: number) => {
    const prev = items[index];
    if (prev?.kind === "local") URL.revokeObjectURL(prev.previewUrl);
    onChange(items.filter((_, i) => i !== index));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const makeCover = (index: number) => {
    if (index === 0) return;
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.unshift(item);
    onChange(next);
  };

  const replaceLabel = t("products.replaceImage");

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={onInputChange}
        aria-label={t("products.uploadImages")}
      />

      {/* Drop zone / picker */}
      <button
        type="button"
        onClick={() => openPicker({ type: "add" })}
        onDragOver={(event) => {
          event.preventDefault();
          if (!atCapacity) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer?.files?.length) {
            handleFiles(Array.from(event.dataTransfer.files));
          }
        }}
        disabled={atCapacity}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
          dragging
            ? "border-indigo-500 bg-indigo-50/70"
            : "border-slate-300 bg-slate-50/60 hover:border-indigo-400 hover:bg-indigo-50/40",
          atCapacity && "cursor-not-allowed opacity-60",
        )}
      >
        <span aria-hidden className="text-2xl">
          🖼
        </span>
        <span className="text-sm font-semibold text-slate-700">{t("products.dropHere")}</span>
        <span className="text-xs font-medium text-slate-600">
          {atCapacity
            ? t("validation.imageCount", { max: MAX_IMAGES })
            : `${t("products.browse")} · JPG, PNG, WebP, GIF · ≤ 5MB`}
        </span>
      </button>

      {items.length > 0 ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {items.map((item, index) => {
            const src = item.kind === "local" ? item.previewUrl : item.url;
            const isCover = index === 0;
            return (
              <div
                key={item.id}
                className={cn(
                  "group relative overflow-hidden rounded-xl border bg-slate-50",
                  isCover ? "border-indigo-300 ring-2 ring-indigo-100" : "border-slate-200",
                )}
              >
                <img
                  src={src}
                  alt={isCover ? t("products.cover") : `${index + 1}`}
                  className="aspect-square w-full object-cover"
                />
                {isCover ? (
                  <span className="absolute inset-x-0 top-0 bg-indigo-600 px-1.5 py-0.5 text-center text-[10px] font-bold uppercase text-white">
                    {t("products.cover")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => makeCover(index)}
                    title={t("products.makeCover")}
                    aria-label={t("products.makeCover")}
                    className="absolute inset-x-0 top-0 bg-slate-900/60 px-1.5 py-0.5 text-center text-[10px] font-semibold text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                  >
                    {t("products.makeCover")}
                  </button>
                )}

                {/* slot actions — always visible on touch devices, hover-revealed on desktop */}
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-slate-900/55 p-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <SlotButton label={t("products.moveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
                    ▲
                  </SlotButton>
                  <SlotButton
                    label={t("products.moveDown")}
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ▼
                  </SlotButton>
                  <SlotButton label={replaceLabel} onClick={() => openPicker({ type: "replace", index })}>
                    ⇄
                  </SlotButton>
                  <SlotButton label={t("products.removeImage")} danger onClick={() => remove(index)}>
                    ✕
                  </SlotButton>
                </div>
              </div>
            );
          })}

          {!atCapacity ? (
            <button
              type="button"
              onClick={() => openPicker({ type: "add" })}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-300 text-slate-500 transition-colors hover:border-indigo-400 hover:bg-indigo-50/40 hover:text-indigo-600"
            >
              <span aria-hidden className="text-xl">
                +
              </span>
              <span className="text-[11px] font-semibold">{t("products.addImage")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-xs font-semibold text-rose-700">⚠ {error}</p> : null}

      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-slate-600">
          {t("products.imagesHint", { max: MAX_IMAGES })}
        </p>
        {items.length > 0 && !atCapacity ? (
          <Button variant="secondary" size="sm" type="button" onClick={() => openPicker({ type: "add" })}>
            + {t("products.addImage")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SlotButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold text-white transition-colors disabled:opacity-30",
        danger ? "bg-rose-500/90 hover:bg-rose-600" : "bg-white/15 hover:bg-white/30",
      )}
    >
      {children}
    </button>
  );
}
