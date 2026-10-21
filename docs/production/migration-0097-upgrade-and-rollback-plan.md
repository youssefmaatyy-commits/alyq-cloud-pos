# خطة الترقية الآمنة إلى الإنتاج وخطة التراجع واستعادة البيانات (Migration 0097)

> **حالة الإنتاج الحالية (محمية بالكامل ولم يتم لمسها):**
> - **Supabase Production (`zeaacjmmvyuwzmkgxhqf`)**: عند الهجرة `0096` (`96` هجرة) — يحتوي حالياً على `4` أقسام، `43` منتجاً (بما فيها `BR101`)، `8` متغيرات، `48` رصيد مخزون فرعي، ووردية واحدة مفتوحة.
> - **Vercel Production (`https://alyq-store.vercel.app`)**: عند الوسم `v-web-prod-ca18c27` (`ca18c27f34391eaaa07974b3cd73897a9aec02e3`).
> - **Android Official Release (`v2.0.0`)**: عند الوسم `v2.0.0` (`a04f07265879fdd2fd514fc7b5d930e5fa2d56b5`, المعرف `eg.alyq.management`).
> - **فرع `main`**: عند `38b8724f5a24d5fc57a31ede9ce9fd5e21c6a756`.

---

## ١. فحوصات ما قبل الترقية والنسخ الاحتياطي الإلزامي (Pre-Upgrade Checklist)

قبل تنفيذ أي خطوة على بيئة الإنتاج (`zeaacjmmvyuwzmkgxhqf`) بعد اعتمادك النهائي:

1. **تأكيد مزامنة جميع أجهزة الكاشير والهواتف (`Offline Sync Drain`)**:
   - فتح شاشة **مركز المزامنة (Offline Sync Center)** أو شريط حالة الكاشير في تطبيق `ALYQ POS v2.0.0` على الهاتف والتأكد من أن:
     - `Sync Pending = 0` (لا توجد مبيعات أو مرتجعات معلقة في صندوق الصادر المحلي `alyq.pos.offline_outbox.v1`).
     - لا توجد سلات معلقة غير محفوظة أثناء لحظة الترقية.
   - **تحذير صارم:** يمنع منعاً باتاً حذف أو إلغاء تثبيت تطبيق `ALYQ POS` الرسمي (`eg.alyq.management`) من الهاتف قبل التحقق من أن `Sync Pending = 0`.
2. **أخذ نسخة احتياطية مزدوجة لبيئة الإنتاج (`zeaacjmmvyuwzmkgxhqf`)**:
   - **النسخة الأولى (من داخل النظام):** الدخول إلى **الإعدادات ← النسخ الاحتياطي والاستعادة (Backup & Recovery)** وتشغيل `Create Snapshot` (`public.create_system_backup`) وتنزيل ملف النسخة الاحتياطية JSON الموقع.
   - **النسخة الثانية (على مستوى قاعدة البيانات):** التحقق من لقطة Supabase اليومية أو تصدير لقطة كاملة لبيانات الجداول الأساسية (`categories`, `products`, `product_variants`, `branch_stock_balances`, `sales`, `sale_items`, `online_orders`, `shifts`).

---

## ٢. الترتيب الدقيق لتنفيذ الترقية بدون توقف (Zero-Downtime Upgrade Sequence)

تتم الترقية بهذا الترتيب الحتمي حصراً لضمان عدم انقطاع الخدمة ثانية واحدة:

### الخطوة ١: تطبيق الهجرة `0097_shared_barcode_variant_models.sql` على قاعدة بيانات الإنتاج (`zeaacjmmvyuwzmkgxhqf`) أولاً
- **لماذا قاعدة البيانات أولاً؟**
  - الهجرة `0097` **إضافية بالكامل ومتوافقة رجعياً (Backward-Compatible)** مع كل من إصدار الويب الحالي (`v-web-prod-ca18c27`) وتطبيق الأندرويد الحالي (`v2.0.0`):
    - جميع الأعمدة الجديدة (`display_name_ar`, `display_name_en`, `images`, `variant_display_name`) تقبل `NULL` أو تملك قيمة افتراضية آمنة (`'[]'::jsonb`).
    - الدالة القديمة `public.storefront_branch_product_variants()` تظل تعمل جنباً إلى جنب مع الدالة الجديدة `public.storefront_branch_product_variants_v2()`.
    - جميع المنتجات الـ `43` الحالية والـ `8` متغيرات في `zeaacjmmvyuwzmkgxhqf` تظل تعمل دون أي تعديل على أرصدتها أو أسعارها.
- **التحقق الفوري بعد تطبيق `0097`:**
  - تشغيل فحص الصحة `select public.system_health_probe();` والتأكد من إرجاع:
    - `"migration": "0097_shared_barcode_variant_models.sql"`
    - `"migration_count": 97`
    - `"branch_context_valid": true`

### الخطوة ٢: نشر تحديث الويب والمتجر الإلكتروني (`https://alyq-store.vercel.app`)
- بعد التأكد من نجاح الخطوة ١، يتم دمج الفرع المعتمد في `main` ليرتفع تلقائياً إلى `https://alyq-store.vercel.app`.
- التحقق الفوري من:
  - فتح المتجر العام (`https://alyq-store.vercel.app/#/store`) والتأكد من ظهور المنتجات واختيار الموديلات (`شكل 1`, `شكل 2`, ...) بتصميم Storefront V2 (البيج والذهبي `#F6F1E9` / `#C5A059`).
  - فتح شاشة الكاشير (`#/dashboard/pos`) وفحص حالة النظام (`System Health`: `97 / 97`).

### الخطوة ٣: ترقية تطبيق الأندرويد الرسمي (`eg.alyq.management` → `v2.1.0`)
- بناء إصدار الأندرويد الرسمي `v2.1.0` (`versionCode: 3`, `applicationId: "eg.alyq.management"`) المتصل بقاعدة الإنتاج `zeaacjmmvyuwzmkgxhqf.supabase.co`.
- **تثبيت التحديث فوق التطبيق الحالي (`In-Place Upgrade`)**:
  - لأن الحزمة تحمل نفس المعرف الرسمي `eg.alyq.management` ونفس شهادة التوقيع، يقوم نظام Android بترقية تطبيق `ALYQ POS v2.0.0` في مكانه **دون حذف التطبيق القديم ودون مسح أي بيانات محلية أو إعدادات فرع/كاشير**.
- بعد التأكد من عمل `v2.1.0` الرسمي، يمكنك حذف تطبيق الاختبار المنفصل `ALYQ POS Staging` (`eg.alyq.management.staging`) بأمان تام.

---

## ٣. خطة التراجع الآمن والتعامل مع البيانات الجديدة بعد الترقية (Rollback & Post-Upgrade Data Preservation)

### الحالة (أ): ظهور ملاحظة في واجهة الويب أو الأندرويد بعد الترقية (وقاعدة البيانات سليمة)
- **الإجراء:**
  - إعادة توجيه Vercel Production فوراً إلى الوسم المستقر `v-web-prod-ca18c27` (`ca18c27f34391eaaa07974b3cd73897a9aec02e3`)، والعودة على الهاتف إلى `v2.0.0` (`a04f07265879fdd2fd514fc7b5d930e5fa2d56b5`).
- **مصير البيانات التي دخلت بعد الترقية:**
  - **لا تُفقد أي عملية بيع أو مرتجع أو طلب أونلاين أو حركة مخزون** لأن `v-web-prod-ca18c27` و`v2.0.0` متوافقان بالكامل مع مخطط `0097`.

### الحالة (ب): الحاجة إلى التراجع عن قواعد الهجرة `0097` في قاعدة البيانات بعد إدخال مبيعات أو موديلات جديدة
- **القاعدة الذهبية:** **يُمنع منعاً باتاً استعادة نسخة احتياطية قديمة تمسح المبيعات أو الطلبات أو حركات المخزون التي تمت بعد الترقية!**
- بدلاً من ذلك، يتم تطبيق **سكربت التراجع غير المدمّر (Non-Destructive Rollback SQL)** التالي الذي يحافظ على **١٠٠٪ من الفواتير والطلبات والموديلات والأرصدة المضافة بعد الترقية**:

```sql
begin;

-- 1. لأي موديل أُنشئ بعد 0097 بدون باركود فرعي (لأنه يستخدم الباركود المشترك للأب)،
-- نملأ barcode بقيمة SKU الخاصة بالموديل حتى يتوافق مع قيود 0086 دون حذف الموديل أو رصيده:
update public.product_variants
   set barcode = upper(btrim(sku))
 where barcode is null
   and btrim(coalesce(sku, '')) <> '';

-- 2. لأي موديل يعتمد على display_name_ar / display_name_en فقط بدون لون أو مقاس،
-- ننسخ اسم الموديل إلى size_label / size_value حتى يظهر الاسم في واجهات 0079/v2.0.0 القديمة:
update public.product_variants
   set size_label = coalesce(nullif(btrim(display_name_ar), ''), nullif(btrim(display_name_en), '')),
       size_value = coalesce(nullif(btrim(display_name_ar), ''), nullif(btrim(display_name_en), ''))
 where nullif(btrim(coalesce(color_key, '')), '') is null
   and nullif(btrim(coalesce(size_value, '')), '') is null
   and (
     nullif(btrim(coalesce(display_name_ar, '')), '') is not null
     or nullif(btrim(coalesce(display_name_en, '')), '') is not null
   );

-- 3. الإبقاء على الأعمدة الإضافية (display_name_ar, display_name_en, images, variant_display_name)
-- حتى لا تضيع أي بيانات تاريخية في الفواتير أو الموديلات، مع إرجاع عداد system_health_probe إلى 96 إذا لزم.

commit;
```
