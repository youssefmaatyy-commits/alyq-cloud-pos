import { lineKey, type CartDiscount, type CartLine } from "../types";

/** A cart line is identified by the *variant ID*, never by its displayed size. */
export function addCartLine(lines: readonly CartLine[], candidate: CartLine): { lines: CartLine[]; added: boolean } {
  const key = lineKey(candidate);
  const current = lines.find((line) => lineKey(line) === key);
  if (current) {
    // Use the latest shelf limit. A second scan cannot borrow a sibling's stock.
    if (current.qty >= candidate.max_qty) return { lines: [...lines], added: false };
    return {
      lines: lines.map((line) => lineKey(line) === key
        ? { ...line, qty: line.qty + 1, max_qty: candidate.max_qty }
        : line),
      added: true,
    };
  }
  if (candidate.max_qty < 1) return { lines: [...lines], added: false };
  return { lines: [...lines, candidate], added: true };
}

export function changeCartQuantity(lines: readonly CartLine[], key: string, change: 1 | -1): CartLine[] {
  return lines.flatMap((line) => {
    if (lineKey(line) !== key) return [line];
    const qty = line.qty + change;
    return qty < 1 ? [] : [{ ...line, qty: Math.min(qty, line.max_qty) }];
  });
}

export function removeCartLine(lines: readonly CartLine[], key: string): CartLine[] {
  return lines.filter((line) => lineKey(line) !== key);
}

export function discountCartLine(lines: readonly CartLine[], key: string, discount: CartDiscount): CartLine[] {
  return lines.map((line) => lineKey(line) === key ? { ...line, item_discount: discount } : line);
}
