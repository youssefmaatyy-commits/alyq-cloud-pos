import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Badge, Button, Field, Modal, SelectInput } from "@/components/ui";
import { ChevronIcon, EditIcon, PlusIcon, RestoreIcon, TrashIcon } from "@/components/ui";
import { cn } from "@/utils/cn";
import type { CategoryNode } from "../types";
import { useCatalog } from "../hooks/CatalogProvider";
import { describeError } from "../services/catalogService";
import { useToast } from "@/components/ui";
import { CategoryFormModal } from "./CategoryFormModal";
import { ConfirmDialog } from "@/components/ui/Modal";
import { flattenCategoryTree } from "../services/categoryTree";

interface RowAction {
  label: string;
  onClick: () => void;
  tone?: "default" | "danger" | "success";
  icon: React.ReactNode;
  disabled?: boolean;
}

function TreeRow({
  node,
  expanded,
  onToggle,
  actions,
  onAddChild,
  onEdit,
  depth,
}: {
  node: CategoryNode;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  actions: (node: CategoryNode) => RowAction[];
  onAddChild: (node: CategoryNode) => void;
  onEdit: (node: CategoryNode) => void;
  depth: number;
}) {
  const { t, tPlural } = useI18n();
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);

  return (
    <li>
      <div
        className={cn(
          "group flex flex-wrap items-center gap-2 rounded-xl border border-transparent px-2 py-2 transition-colors hover:border-slate-300 hover:bg-slate-50",
          !node.active && "opacity-70",
        )}
        style={{ paddingInlineStart: `${depth * 1.25 + 0.5}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-label={isOpen ? t("categories.collapse") : t("categories.expand")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-200 hover:text-slate-900"
          >
            <ChevronIcon className={cn("h-4 w-4 transition-transform rtl:rotate-180", isOpen && "rotate-90 rtl:-rotate-90")} />
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" />
        )}

        <span
          aria-hidden
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm",
            node.active ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-500",
          )}
        >
          {node.active ? "📁" : "📁"}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            <span dir="rtl" className="me-2">
              {node.name_ar}
            </span>
            <span dir="ltr" className="font-medium text-slate-600">
              {node.name_en}
            </span>
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={node.active ? "success" : "neutral"}>
              {node.active ? t("common.active") : t("common.inactive")}
            </Badge>
            <Badge tone="info">{tPlural("categories.productCount", node.descendantProductCount)}</Badge>
            {hasChildren ? (
              <Badge>{tPlural("categories.childCount", node.children.length)}</Badge>
            ) : null}
            <span className="text-[11px] font-semibold text-slate-600">
              {t("categories.sortOrder")} {node.sort_order}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-80 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => onAddChild(node)}
            title={t("categories.add")}
            aria-label={t("categories.add")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            onClick={() => onEdit(node)}
            title={t("common.edit")}
            aria-label={t("common.edit")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-200 hover:text-slate-900"
          >
            <EditIcon />
          </button>
          {actions(node).map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.label}
              aria-label={action.label}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg disabled:opacity-30",
                action.tone === "danger"
                  ? "text-rose-500 hover:bg-rose-50"
                  : action.tone === "success"
                    ? "text-emerald-600 hover:bg-emerald-50"
                    : "text-slate-500 hover:bg-slate-200 hover:text-slate-900",
              )}
            >
              {action.icon}
            </button>
          ))}
        </div>
      </div>

      {hasChildren && isOpen ? (
        <ul className="mt-1 space-y-1 border-s border-slate-100 ms-4 ps-1">
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              expanded={expanded}
              onToggle={onToggle}
              actions={actions}
              onAddChild={onAddChild}
              onEdit={onEdit}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function CategoryTree({
  view = "all",
}: {
  /** Which lifecycle states to show. The page's Archived filter drives this. */
  view?: "active" | "archived" | "all";
}) {
  const { t, tPlural, pick } = useI18n();
  const toast = useToast();
  const { tree: fullTree, categories, deleteCategory, setCategoryActive, moveProductsAndDeleteCategory } =
    useCatalog();

  // Prune the tree to the requested view: "active" hides archived branches
  // entirely; "archived" shows only archived categories (their active
  // children stay hidden — they are on the Active tab).
  const tree = useMemo(() => {
    if (view === "all") return fullTree;
    const keep = view === "active";
    const walk = (nodes: CategoryNode[]): CategoryNode[] =>
      nodes
        .filter((node) => node.active === keep)
        .map((node) => ({ ...node, children: walk(node.children) }));
    return walk(fullTree);
  }, [fullTree, view]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);

  // Start with every root expanded once data arrives.
  useEffect(() => {
    if (initialized || tree.length === 0) return;
    setExpanded(new Set(tree.map((node) => node.id)));
    setInitialized(true);
  }, [tree, initialized]);

  const [editing, setEditing] = useState<{ open: boolean; category: CategoryNode | null; parentId?: string | null }>({
    open: false,
    category: null,
    parentId: null,
  });
  const [confirm, setConfirm] = useState<{
    open: boolean;
    node: CategoryNode | null;
    mode: "delete" | "deactivate";
    reason: { productCount: number; childCount: number } | null;
  }>({ open: false, node: null, mode: "delete", reason: null });
  // Phase 44: a category that still holds content gets the lifecycle dialog —
  // move its products to an active category and delete it in one transaction,
  // or archive it. The dialog states the server's real obstacle (the counts);
  // the server re-counts and decides.
  const [lifecycle, setLifecycle] = useState<{ open: boolean; node: CategoryNode | null }>({
    open: false,
    node: null,
  });
  const [moveTarget, setMoveTarget] = useState<string>("");
  const [lifecycleChoice, setLifecycleChoice] = useState<"move" | "archive">("move");
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const usageOf = (node: CategoryNode) => ({
    productCount: node.descendantProductCount,
    childCount: node.children.reduce((sum, child) => sum + 1 + child.descendantCount, 0),
  });

  // Move targets: every ACTIVE category except the source and its subtree.
  // Archived categories must not receive products (the server refuses them
  // too — this list only mirrors the rule).
  const moveTargets = useMemo(() => {
    if (!lifecycle.node) return [];
    return flattenCategoryTree(tree, { skipId: lifecycle.node.id });
  }, [tree, lifecycle.node]);

  const runDelete = async (node: CategoryNode) => {
    setBusy(true);
    try {
      await deleteCategory(node.id);
      toast.success(t("categories.deletedToast"));
    } catch (error) {
      toast.error(t(describeError(error).key as never));
    } finally {
      setBusy(false);
      setConfirm({ open: false, node: null, mode: "delete", reason: null });
    }
  };

  const runSetArchived = async (node: CategoryNode, archived: boolean) => {
    setBusy(true);
    try {
      await setCategoryActive(node.id, !archived);
      toast.success(t(archived ? "categories.archivedToast" : "categories.restoredToast"));
    } catch (error) {
      toast.error(t(describeError(error).key as never));
    } finally {
      setBusy(false);
      setConfirm({ open: false, node: null, mode: "deactivate", reason: null });
      setLifecycle({ open: false, node: null });
    }
  };

  const runMoveAndDelete = async (node: CategoryNode, targetId: string) => {
    setBusy(true);
    try {
      const { moved } = await moveProductsAndDeleteCategory(node.id, targetId);
      const targetName = categories.find((c) => c.id === targetId)?.name_en ?? targetId;
      toast.success(t("categories.movedToast", { count: moved, name: targetName }));
    } catch (error) {
      toast.error(t(describeError(error).key as never));
    } finally {
      setBusy(false);
      setLifecycle({ open: false, node: null });
    }
  };

  const makeActions = (node: CategoryNode): RowAction[] => {
    const usage = usageOf(node);
    const activeChildren = node.children.filter((c) => c.active).length;
    return [
      {
        label: node.active ? t("common.deactivate") : t("common.activate"),
        icon: node.active ? <ArchiveDeactivateIcon /> : <RestoreIcon />,
        tone: node.active ? "default" : "success",
        disabled: busy || (!node.active && activeChildren > 0),
        onClick: () =>
          setConfirm({ open: true, node, mode: "deactivate", reason: null }),
      },
      {
        label: t("common.delete"),
        icon: <TrashIcon />,
        tone: "danger",
        disabled: busy,
        onClick: () => {
          // Empty leaf: plain confirm. Anything else: the lifecycle dialog —
          // the server's refusal is anticipated here with the client's own
          // informational counts, but the decision stays with the server.
          if (usage.productCount > 0 || usage.childCount > 0) {
            setLifecycleChoice(usage.childCount > 0 ? "archive" : "move");
            setMoveTarget("");
            setLifecycle({ open: true, node });
          } else {
            setConfirm({ open: true, node, mode: "delete", reason: null });
          }
        },
      },
    ];
  };

  return (
    <>
      {tree.length === 0 ? null : (
        <ul className="space-y-1">
          {tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              expanded={expanded}
              onToggle={toggle}
              actions={makeActions}
              onAddChild={(node2) => setEditing({ open: true, category: null, parentId: node2.id })}
              onEdit={(node2) => setEditing({ open: true, category: node2, parentId: null })}
              depth={0}
            />
          ))}
        </ul>
      )}

      <CategoryFormModal
        open={editing.open}
        onClose={() => setEditing({ open: false, category: null, parentId: null })}
        category={editing.category}
        defaultParentId={editing.parentId}
      />

      <ConfirmDialog
        open={confirm.open && confirm.mode === "delete" && !confirm.reason}
        title={t("categories.deleteConfirmTitle")}
        body={t("categories.deleteConfirmBody", {
          name: confirm.node ? confirm.node.name_en : "",
        })}
        confirmLabel={t("common.delete")}
        loading={busy}
        onCancel={() => setConfirm({ open: false, node: null, mode: "delete", reason: null })}
        onConfirm={() => confirm.node && void runDelete(confirm.node)}
      />

      <ConfirmDialog
        open={confirm.open && confirm.mode === "delete" && Boolean(confirm.reason)}
        title={t("categories.deleteBlockedTitle")}
        body={t("categories.deleteBlockedBody", {
          name: confirm.node ? confirm.node.name_en : "",
          count: confirm.reason?.productCount ?? 0,
        })}
        confirmLabel={t("common.deactivate")}
        tone="primary"
        loading={busy}
        onCancel={() => setConfirm({ open: false, node: null, mode: "delete", reason: null })}
        onConfirm={() => confirm.node && void runSetArchived(confirm.node, true)}
      />

      <ConfirmDialog
        open={confirm.open && confirm.mode === "deactivate"}
        title={
          confirm.node?.active
            ? t("categories.deactivateConfirmTitle")
            : t("categories.activateConfirmTitle")
        }
        body={
          confirm.node?.active
            ? t("categories.deactivateConfirmBody", { name: confirm.node?.name_en ?? "" })
            : t("categories.activateConfirmBody", { name: confirm.node?.name_en ?? "" })
        }
        confirmLabel={confirm.node?.active ? t("common.deactivate") : t("common.activate")}
        tone="primary"
        loading={busy}
        onCancel={() => setConfirm({ open: false, node: null, mode: "deactivate", reason: null })}
        onConfirm={() => confirm.node && void runSetArchived(confirm.node, confirm.node.active)}
      />

      <Modal
        open={lifecycle.open && lifecycle.node !== null}
        onClose={() => setLifecycle({ open: false, node: null })}
        title={t("categories.lifecycleTitle", { name: lifecycle.node?.name_en ?? "" })}
        size="md"
      >
        {lifecycle.node ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {tPlural("categories.lifecycleContains", usageOf(lifecycle.node).productCount)}
              {usageOf(lifecycle.node).childCount > 0
                ? " " +
                  tPlural("categories.lifecycleChildren", usageOf(lifecycle.node).childCount)
                : ""}
            </p>

            <label
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                lifecycleChoice === "move"
                  ? "border-indigo-400 bg-indigo-50/60"
                  : "border-slate-200 hover:border-slate-300",
                usageOf(lifecycle.node).childCount > 0 && "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="radio"
                name="category-lifecycle"
                className="mt-1"
                checked={lifecycleChoice === "move"}
                disabled={usageOf(lifecycle.node).childCount > 0}
                onChange={() => setLifecycleChoice("move")}
              />
              <span className="flex-1 space-y-2">
                <span className="block text-sm font-semibold text-slate-900">
                  {t("categories.lifecycleMoveTitle")}
                </span>
                <span className="block text-xs text-slate-600">
                  {t("categories.lifecycleMoveHint")}
                </span>
                <Field label={t("categories.lifecycleTargetLabel")}>
                  <SelectInput
                    value={moveTarget}
                    onChange={(event) => setMoveTarget(event.target.value)}
                    disabled={lifecycleChoice !== "move" || busy}
                  >
                    <option value="">{t("categories.lifecycleTargetPlaceholder")}</option>
                    {moveTargets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {pick(target.name_ar, target.name_en)}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              </span>
            </label>

            <label
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                lifecycleChoice === "archive"
                  ? "border-indigo-400 bg-indigo-50/60"
                  : "border-slate-200 hover:border-slate-300",
              )}
            >
              <input
                type="radio"
                name="category-lifecycle"
                className="mt-1"
                checked={lifecycleChoice === "archive"}
                onChange={() => setLifecycleChoice("archive")}
              />
              <span>
                <span className="block text-sm font-semibold text-slate-900">
                  {t("categories.lifecycleArchiveTitle")}
                </span>
                <span className="block text-xs text-slate-600">
                  {t("categories.lifecycleArchiveHint")}
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <Button variant="secondary" onClick={() => setLifecycle({ open: false, node: null })} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button
                variant={lifecycleChoice === "move" ? "danger" : "primary"}
                disabled={busy || (lifecycleChoice === "move" && !moveTarget)}
                onClick={() => {
                  if (!lifecycle.node) return;
                  if (lifecycleChoice === "move") void runMoveAndDelete(lifecycle.node, moveTarget);
                  else void runSetArchived(lifecycle.node, true);
                }}
              >
                {lifecycleChoice === "move"
                  ? t("categories.lifecycleMoveConfirm")
                  : t("categories.lifecycleArchiveConfirm")}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function ArchiveDeactivateIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
    >
      <rect x="4" y="7" width="16" height="13" rx="2" />
      <path d="M9 11h6" />
      <path d="M9 4h6" />
    </svg>
  );
}
