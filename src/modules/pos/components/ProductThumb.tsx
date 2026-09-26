/**
 * A tiny product thumbnail for the register's compact surfaces — the search
 * result rows and the cart line rows.
 *
 * A product without a photo still gets its tile: a warm beige square carrying
 * the first letter of the name, so every row keeps the same rhythm and the
 * scan column and the sale table line up. The image is decorative (the name is
 * right beside it), hence `alt=""` + `aria-hidden` — a screen reader never
 * hears "image" twice per row.
 */
export function ProductThumb({
  url,
  name,
  className = "h-11 w-11",
}: {
  url: string | null | undefined;
  name: string;
  className?: string;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        loading="lazy"
        className={`${className} shrink-0 rounded-lg bg-white object-cover ring-1 ring-stone-200`}
      />
    );
  }
  const initial = name.trim().charAt(0) || "·";
  return (
    <span
      aria-hidden
      className={`${className} grid shrink-0 place-items-center rounded-lg bg-[#faf5ec] text-sm font-black text-[#8a6a3b] ring-1 ring-[#e7dcc7]`}
    >
      {initial}
    </span>
  );
}
