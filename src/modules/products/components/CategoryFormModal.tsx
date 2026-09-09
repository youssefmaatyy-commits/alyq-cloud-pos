import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useToast } from "@/components/ui";
import { Button, Field, Modal, SelectInput, TextInput, ToggleSwitch } from "@/components/ui";
import { MAX_NAME_LENGTH } from "../constants";
import type { Category } from "../types";
import {
  EMPTY_CATEGORY_FORM,
  categoryToForm,
  fieldErrorKey,
  validateCategoryDraft,
  type CategoryFormValues,
  type FieldErrors,
} from "../validation";
import { useCatalog } from "../hooks/CatalogProvider";
import { toCategoryOptions } from "../services/categoryTree";
import { describeError } from "../services/catalogService";

export interface CategoryFormModalProps {
  open: boolean;
  onClose: () => void;
  /** Category being edited, or `null`/`undefined` to create a new one. */
  category?: Category | null;
  /** Pre-selected parent when adding a subcategory. */
  defaultParentId?: string | null;
}

export function CategoryFormModal({
  open,
  onClose,
  category,
  defaultParentId,
}: CategoryFormModalProps) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const { categories, tree, saveCategory } = useCatalog();

  const [values, setValues] = useState<CategoryFormValues>(EMPTY_CATEGORY_FORM);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(
      category
        ? categoryToForm(category)
        : { ...EMPTY_CATEGORY_FORM, parent_id: defaultParentId ?? "" },
    );
    setTouched({});
    setSubmitAttempted(false);
  }, [open, category, defaultParentId]);

  const errors: FieldErrors = useMemo(
    () => validateCategoryDraft(values, { categories, currentId: category?.id }).errors,
    [values, categories, category?.id],
  );

  const showError = (field: string) =>
    touched[field] || submitAttempted ? errors[field] : undefined;

  const parentOptions = useMemo(
    () => toCategoryOptions(tree, pick, { includeInactive: true, skipId: category?.id }),
    [tree, pick, category?.id],
  );

  const handleSave = async () => {
    setSubmitAttempted(true);
    if (Object.keys(errors).length > 0) {
      toast.error(t("validation.fixErrors"));
      return;
    }
    setSaving(true);
    try {
      const { isNew } = await saveCategory(values, category?.id);
      toast.success(t(isNew ? "categories.createdToast" : "categories.updatedToast"));
      onClose();
    } catch (error) {
      const described = describeError(error);
      toast.error(t(described.key as never));
      if (described.field) {
        setTouched((prev) => ({ ...prev, [described.field as string]: true }));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={category ? t("categories.edit") : t("categories.add")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("categories.nameAr")}
            required
            dir="rtl"
            error={
              showError("name_ar")
                ? t(fieldErrorKey(showError("name_ar")!) as never, { max: MAX_NAME_LENGTH })
                : undefined
            }
            htmlFor="cat-name-ar"
          >
            <TextInput
              id="cat-name-ar"
              dir="rtl"
              lang="ar"
              maxLength={MAX_NAME_LENGTH}
              name="name_ar"
              value={values.name_ar}
              invalid={Boolean(showError("name_ar"))}
              onBlur={() => setTouched((p) => ({ ...p, name_ar: true }))}
              onChange={(e) => setValues((p) => ({ ...p, name_ar: e.target.value }))}
              placeholder="التصنيف بالعربية"
            />
          </Field>
          <Field
            label={t("categories.nameEn")}
            required
            dir="ltr"
            error={
              showError("name_en")
                ? t(fieldErrorKey(showError("name_en")!) as never, { max: MAX_NAME_LENGTH })
                : undefined
            }
            htmlFor="cat-name-en"
          >
            <TextInput
              id="cat-name-en"
              dir="ltr"
              maxLength={MAX_NAME_LENGTH}
              name="name_en"
              value={values.name_en}
              invalid={Boolean(showError("name_en"))}
              onBlur={() => setTouched((p) => ({ ...p, name_en: true }))}
              onChange={(e) => setValues((p) => ({ ...p, name_en: e.target.value }))}
              placeholder="Category in English"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("categories.parent")}
            hint={showError("parent_id") ? undefined : t("categories.parentRoot")}
            error={showError("parent_id") ? t(fieldErrorKey(showError("parent_id")!) as never) : undefined}
            htmlFor="cat-parent"
          >
            <SelectInput
              id="cat-parent"
              name="parent_id"
              value={values.parent_id}
              invalid={Boolean(showError("parent_id"))}
              onChange={(e) => setValues((p) => ({ ...p, parent_id: e.target.value }))}
            >
              <option value="">{t("categories.parentRoot")}</option>
              {parentOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field
            label={t("categories.sortOrder")}
            hint={t("categories.sortHint")}
            error={showError("sort_order") ? t(fieldErrorKey(showError("sort_order")!) as never) : undefined}
            htmlFor="cat-sort"
          >
            <TextInput
              id="cat-sort"
              dir="ltr"
              inputMode="numeric"
              name="sort_order"
              value={values.sort_order}
              invalid={Boolean(showError("sort_order"))}
              onBlur={() => setTouched((p) => ({ ...p, sort_order: true }))}
              onChange={(e) => setValues((p) => ({ ...p, sort_order: e.target.value }))}
              placeholder="0"
            />
          </Field>
        </div>

        <ToggleSwitch
          label={t("common.active")}
          hint={values.active ? t("products.activeBadge") : t("products.inactiveBadge")}
          checked={values.active}
          onChange={(checked) => setValues((p) => ({ ...p, active: checked }))}
        />
      </div>
    </Modal>
  );
}
