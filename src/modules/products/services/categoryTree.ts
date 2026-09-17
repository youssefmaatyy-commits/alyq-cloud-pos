import { UNCATEGORIZED_ID, type Category, type CategoryNode, type Product } from "../types";

/**
 * Pure category-tree helpers. No side effects — safe to unit test and reuse
 * from both the categories page and the product form's category picker.
 */

export function buildCategoryTree(
  categories: Category[],
  products: Product[] = [],
): CategoryNode[] {
  const directCounts = new Map<string, number>();
  for (const product of products) {
    if (!product.category_id) continue;
    directCounts.set(product.category_id, (directCounts.get(product.category_id) ?? 0) + 1);
  }

  const nodes = new Map<string, CategoryNode>();
  for (const category of categories) {
    nodes.set(category.id, {
      ...category,
      children: [],
      depth: 0,
      productCount: directCounts.get(category.id) ?? 0,
      descendantProductCount: 0,
      descendantCount: 0,
    });
  }

  const roots: CategoryNode[] = [];
  const visited = new Set<string>();

  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Orphaned rows (parent deleted) become roots so nothing disappears.
  for (const node of nodes.values()) {
    if (node.parent_id && !nodes.has(node.parent_id) && !roots.includes(node)) {
      roots.push(node);
    }
  }

  const sortNodes = (list: CategoryNode[]) => {
    list.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.name_en.localeCompare(b.name_en);
    });
    list.forEach((node) => sortNodes(node.children));
  };
  sortNodes(roots);

  const measure = (node: CategoryNode, depth: number, ancestors: Set<string>): number => {
    node.depth = depth;
    let total = node.productCount;
    let descendantTotal = 0;
    for (const child of node.children) {
      const ancestorSet = new Set(ancestors);
      ancestorSet.add(node.id);
      if (ancestorSet.has(child.id)) continue; // cycle guard
      visited.add(child.id);
      total += measure(child, depth + 1, ancestorSet);
      descendantTotal += 1 + child.descendantCount;
    }
    node.descendantProductCount = total;
    node.descendantCount = descendantTotal;
    return total;
  };

  for (const root of roots) {
    if (!visited.has(root.id)) {
      visited.add(root.id);
      measure(root, 0, new Set());
    }
  }

  return roots;
}

/** Depth-first flattened view of the tree (used by pickers and lists). */
export function flattenCategoryTree(
  roots: CategoryNode[],
  options: { includeInactive?: boolean; skipId?: string } = {},
): CategoryNode[] {
  const out: CategoryNode[] = [];
  const walk = (nodes: CategoryNode[]) => {
    for (const node of nodes) {
      if (options.skipId && node.id === options.skipId) continue;
      if (options.includeInactive || node.active) out.push(node);
      if (options.skipId && node.id === options.skipId) continue;
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * Searchable text resolver: returns a category's own name plus all ancestor
 * names, so searching "jewellery" also finds products in Earrings.
 */
export function buildCategorySearchResolver(
  categories: Category[],
  pick: (ar: string, en: string) => string,
): (categoryId: string | null) => string {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const cache = new Map<string, string>();

  return (categoryId) => {
    if (!categoryId) return "";
    const cached = cache.get(categoryId);
    if (cached !== undefined) return cached;

    const parts: string[] = [];
    const guard = new Set<string>();
    let cursor = byId.get(categoryId);
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      parts.push(pick(cursor.name_ar, cursor.name_en));
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
    }
    const value = parts.join(" ");
    cache.set(categoryId, value);
    return value;
  };
}

export interface CategoryOption {
  id: string;
  label: string;
  depth: number;
  active: boolean;
  productCount: number;
}

export function toCategoryOptions(
  roots: CategoryNode[],
  pick: (ar: string, en: string) => string,
  options: { includeInactive?: boolean; skipId?: string } = {},
): CategoryOption[] {
  return flattenCategoryTree(roots, options).map((node) => ({
    id: node.id,
    label: `${"· ".repeat(node.depth)}${pick(node.name_ar, node.name_en)}`,
    depth: node.depth,
    active: node.active,
    productCount: node.descendantProductCount,
  }));
}

/** Map of categoryId → display name, plus the uncategorized bucket. */
export function categoryNameIndex(
  categories: Category[],
  pick: (ar: string, en: string) => string,
): Map<string, string> {
  return new Map(categories.map((c) => [c.id, pick(c.name_ar, c.name_en)]));
}

/**
 * The register's category-filter set: ACTIVE categories only (Phase 44). An
 * archived category keeps its products sellable, but the shelf itself leaves
 * the filter — the chips describe where a cashier can still shelve mentally,
 * not where products historically sat.
 */
export function sellableCategoryFilterIds(categories: Category[]): Set<string> {
  return new Set(categories.filter((c) => c.active).map((c) => c.id));
}

export { UNCATEGORIZED_ID };
