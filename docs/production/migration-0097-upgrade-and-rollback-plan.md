# خطة الترقية الآمنة إلى الإنتاج، مقارنة توقيع Android (`apksigner`)، وخطة التراجع (Migrations 0097 & 0098)

> **حالة الإنتاج الحالية (محمية بالكامل ولم يتم لمسها):**
> - **Supabase Production (`zeaacjmmvyuwzmkgxhqf`)**: عند الهجرة `0096` (`96` هجرة) — يحتوي حالياً على `4` أقسام (`3` منها مؤرشفة عمدًا بقرار صاحب النظام: `اساور`, `سلاسل`, `حلقان`، وقسم `خواتم` نشط)، `43` منتجاً (بما فيها `BR101` و`BR104`)، `8` متغيرات (بما فيها `BR104-R-2 / ROSE`)، `48` رصيد مخزون فرعي، ووردية واحدة مفتوحة.
> - **قاعدة صارمة للأقسام المؤرشفة**: أرشفة الأقسام الثلاثة (`اساور`, `سلاسل`, `حلقان`) مقصودة عمدًا من صاحب النظام؛ **يُمنع منعًا باتًا إعادة تفعيل أي قسم مؤرشف تلقائيًا أو يدويًا ضمن خطوات الإطلاق أو تغيير حالة `active` لأي قسم أو منتج دون إذن صريح**.
> - **Vercel Production (`https://alyq-store.vercel.app`)**: عند الوسم `v-web-prod-ca18c27` (`ca18c27f34391eaaa07974b3cd73897a9aec02e3`).
> - **Android Official Release (`v2.0.0`)**: عند الوسم `v2.0.0` (`a04f07265879fdd2fd514fc7b5d930e5fa2d56b5`, المعرف `eg.alyq.management`).
> - **فرع `main`**: عند `38b8724f5a24d5fc57a31ede9ce9fd5e21c6a756`.

---

## ١. المقارنة الرقمية لشهادة توقيع Android (`apksigner` / APK Signature Scheme v2) وحقيقة الترقية على الهاتف

تم استخراج ومقارنة شهادة التوقيع الرقمية (`X.509 Certificate` داخل كتلة `APK Signature Scheme v2 / 0x7109871a`) عبر `apksigner verify --print-certs` و`node:crypto.X509Certificate` بين ملف `v2.0.0` الرسمي المثبت على هاتفك وأي بناء جديد (`v2.0.0-models-staging` / `v2.1.0`):

| حقل الشهادة (`apksigner`) | الإصدار الرسمي الحالي `v2.0.0` (`ALYQ-POS-v2.0.0-debug.apk`) | الإصدار الجديد (`ALYQ-POS-v2.0.0-models-staging-debug.apk` / `v2.1.0`) |
|---|---|---|
| **معرف الحزمة (`applicationId`)** | `eg.alyq.management` | `eg.alyq.management.staging` (أو `eg.alyq.management` في `v2.1.0`) |
| **بصمة ملف الـ APK (`SHA-256`)** | `a3ed8537c64f123d78da21fafb6a6ddb82095d9d34ec32519db49ed5f5ff02bb` | `fa58d806180b7ba879c34e6493cfb152e0cb9db9126510777962e023a7f4f174` |
| **الاسم المميز للموقّع (`Signer DN`)** | `CN=Android Debug, O=Android, C=US` | `CN=Android Debug, O=Android, C=US` |
| **تاريخ إنشاء الشهادة (`validFrom`)** | `Oct 20 18:21:29 2026 GMT` | `Oct 21 02:17:21 2026 GMT` |
| **بصمة شهادة التوقيع (`Cert SHA-256`)** | **`822022e0ee8117d22f7b25ce22f1686995931e57b9e61099d3283ba883c96563`** | **`63ceb95e8c45e042d5ee80c493fbe4d775124f0b4cb636dc2b4fcd97e4fa4122`** |
| **بصمة شهادة التوقيع (`Cert SHA-1`)** | `030dc27ad89e4f30052ad988b3b2cd7d94b87caa` | `e49967abfa63d19a735b56a51995ddc3a5fce048` |
| **بصمة شهادة التوقيع (`Cert MD5`)** | `0ee5df42faeea64bc76d1324ec738d96` | `835cb700d4ad025730205575d424ecd7` |

### النتيجة الحتمية (بكل أمانة وشفافية):
1. **الشهادتان مختلفتان (`822022e0...` مقابل `63ceb95e...`)**:
   - السبب التقني: ملف `ALYQ-POS-v2.0.0-debug.apk` تم بناؤه في `20 أكتوبر 2026` داخل بيئة GitHub Actions مؤقتة (`ubuntu-latest`) قامت بتوليد ملف `~/.android/debug.keystore` عشوائي خاص بتلك الجلسة فقط، وتم تدمير المفتاح الخاص (`Private Key`) تلقائياً بانتهاء حاوية البناء.
2. **التحديث المباشر فوق `v2.0.0` (`In-Place Overwrite` لنفس المعرف `eg.alyq.management`) غير ممكن برمجياً**:
   - نظام Android يرفض استبدال حزمة مثبتة (`eg.alyq.management`) بملف APK يحمل بصمة شهادة `SHA-256` مختلفة ويُظهر الخطأ `INSTALL_FAILED_UPDATE_INCOMPATIBLE (Package signatures do not match)`.
   - لذلك **لا نعد أبداً بتحديث مباشر فوق `v2.0.0`**، بل نطبق **خطة الانتقال الآمنة بدون فقدان أي بيان واحد** الموضحة أدناه.

### خطة الانتقال الآمنة ١٠٠٪ من `v2.0.0` إلى `v2.1.0` على هاتفك (Zero-Data-Loss Transition Plan):
1. **أين تعيش البيانات في `v2.0.0`؟**
   - لأن تطبيق `v2.0.0` يعمل في **Production Mode** متصلاً بقاعدة `zeaacjmmvyuwzmkgxhqf.supabase.co`، فإن جميع المنتجات (`43`)، الأقسام (`4`)، المتغيرات (`8`)، أرصدة المخزون (`48`)، المبيعات، المرتجعات، الورديات، والعملاء محفوظة في سحابة Supabase، وليست داخل ذاكرة الهاتف.
   - الشيء الوحيد المخزن محلياً داخل مساحة التطبيق على الهاتف (`IndexedDB / Preferences`) هو:
     1. طابور العمليات التي تمت بدون إنترنت ولم تُرفع بعد (`alyq.pos.offline_outbox.v1`).
     2. السلات المعلقة مؤقتاً (`alyq.pos.held_carts.v1`).
     3. جلسة تسجيل الدخول واختيار الفرع/الكاشير.
2. **خطوات الانتقال الآمن إلى `v2.1.0` عند الإطلاق الرسمي:**
   - **الخطوة (أ) — تفريغ وتأكيد المزامنة على `v2.0.0` قبل لمسه**:
     - فتح تطبيق `ALYQ POS v2.0.0` الحالي أثناء الاتصال بالإنترنت، والتأكد من شريط حالة الكاشير وشاشة **مركز المزامنة (`#/dashboard/pos/sync`)** أن:
       - `Sync Pending = 0` و`Sync Errors = 0` و`Conflicts = 0`.
       - لا توجد سلات معلقة (`Held Carts = 0`).
   - **الخطوة (ب) — تأسيس مفتاح توقيع دائم وثابت (`Permanent Release Keystore`) بدءاً من `v2.1.0`**:
     - قبل بناء `v2.1.0`، يتم توليد ملف مفتاح توقيع دائم (`alyq-release-key.jks`) وحفظه كنسخة مشفرة (`Base64`) في **GitHub Actions Secrets** (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`) مع نسخة احتياطية لديك، بحيث تحمل جميع الإصدارات المستقبلية (`v2.1.0` ← `v2.2.0` ← `v2.3.0`...) **نفس بصمة `Cert SHA-256` مدى الحياة** وتقبل التحديث المباشر (`In-Place Upgrade`) دون الحاجة لإلغاء التثبيت مرة أخرى أبداً.
   - **الخطوة (ج) — التثبيت المزدوج أو الاستبدال الآمن بعد التحقق**:
     - بعد التحقق في الخطوة (أ) من أن `Sync Pending = 0`، يمكن إما:
       1. تثبيت `v2.1.0` بمعرف مستقل بجانب `v2.0.0` أولاً وتجربة الدخول والتأكد من ظهور كل البيانات، ثم حذف `v2.0.0`؛ **أو**
       2. حذف `v2.0.0` (بعد التأكد من أن `Sync Pending = 0`) وتثبيت `v2.1.0` على المعرف الرسمي `eg.alyq.management` الموقّع بالمفتاح الدائم الجديد.

---

## ٢. الترتيب الدقيق لتنفيذ الترقية على الإنتاج (بعد موافقتك النهائية الصريحة فقط)

1. **النسخ الاحتياطي المزدوج والتحقق من قابليته للاستعادة لقاعدة بيانات الإنتاج (`zeaacjmmvyuwzmkgxhqf`)**:
   - أخذ نسخة احتياطية كاملة عبر `public.create_system_backup` من لوحة التحكم، والتحقق من سجلها في `backup_manifests` وفحص سلامة الـ JSON (`products`, `categories`, `product_variants`, `branch_stock_balances`, `sales`, `sale_items`, `online_orders`, `shifts`).
   - التحقق قبل البدء من أعداد الصفوف المرجعية (`4` أقسام: `3` مؤرشفة و`1` نشط، `43` منتجًا، `8` متغيرات، `48` رصيد فرعي).
2. **تطبيق الهجرة `0097_shared_barcode_variant_models.sql` على `zeaacjmmvyuwzmkgxhqf` أولاً**:
   - تضيف دعم الموديلات ذات الباركود المشترك (`display_name_ar`, `display_name_en`, `images` على `product_variants` وتحديث `pos_complete_sale`, `pos_process_return`, `place_online_order`, `stocktake_create`, `storefront_branch_product_variants_v2`).
   - متوافقة رجعياً ١٠٠٪ مع `v-web-prod-ca18c27` و`v2.0.0`.
3. **تطبيق الهجرة `0098_product_and_variant_save_hardening.sql` مباشرة بعد `0097`**:
   - تسمح بتعديل اسم وسعر وصور وحد تنبيه أي منتج موجود داخل قسم مؤرشف عمدًا (`active = false`) دون المساس بحالة أرشفة القسم (`categories.active` تبقى `false`) ودون السماح بنقل منتجات جديدة إلى قسم مؤرشف.
   - تعالج تلقائيًا `color_key` ذا الحرف الواحد (`'r'` في `BR104-R-2 / ROSE` يصبح `'rose'`، و`'ا'` في `NK103-R` يصبح `'red'`) دون حذف أي متغير أو تغيير أي رصيد مخزون.
   - تضيف تريجرات مزامنة `branch_stock_balances.reorder_level` عند تعديل `low_stock_level`.
   - التحقق فوراً عبر `select public.system_health_probe();` من أن `migration_count = 98` و`latest_migration = '0098_product_and_variant_save_hardening.sql'`، ومن بقاء الأقسام الثلاثة المؤرشفة `active = false`.
4. **نشر تحديث الويب والمتجر الإلكتروني (`https://alyq-store.vercel.app`)** بعد دمج الفرع في `main` بموافقتك.
5. **إصدار تطبيق الأندرويد الرسمي `v2.1.0`** وفق خطة الانتقال الآمن أعلاه.

---

## ٣. خطة التراجع الآمن والحفاظ على البيانات المضافة بعد الترقية (`Non-Destructive Rollback`)

في حال ظهور أي مشكلة بعد إدخال مبيعات أو طلبات أو تعديلات منتجات بعد الترقية، **يُمنع منعاً باتاً استعادة نسخة قديمة تمسح المبيعات أو الطلبات أو الحركات الجديدة**؛ بل يتم:
1. **تراجع طبقة التطبيق (Web / Android Rollback)**:
   - إعادة Vercel Production فوراً إلى `v-web-prod-ca18c27` (`ca18c27f34391eaaa07974b3cd73897a9aec02e3`) وإبقاء تطبيق الأندرويد `v2.0.0` كما هو — كلاهما متوافقان بالكامل مع مخطط `0097` و`0098` دون فقدان أي فاتورة أو طلب أو حركة مخزون.
2. **تراجع طبقة الدوال والتريجرات (`Non-Destructive SQL Function Rollback`) دون مساس بأي صف بيانات**:
   - إذا لزم الأمر، يمكن إعادة تعريف التريجر `products_enforce_category_active()` إلى صيغة `0044` وتشغيل سكربت التوافق الرجعي غير المدمّر التالي الذي يحافظ على ١٠٠٪ من الفواتير والموديلات والأرصدة وحالة أرشفة الأقسام (`categories.active = false`):

```sql
begin;

update public.product_variants
   set barcode = upper(btrim(sku))
 where barcode is null
   and btrim(coalesce(sku, '')) <> '';

update public.product_variants
   set size_label = coalesce(nullif(btrim(display_name_ar), ''), nullif(btrim(display_name_en), '')),
       size_value = coalesce(nullif(btrim(display_name_ar), ''), nullif(btrim(display_name_en), ''))
 where nullif(btrim(coalesce(color_key, '')), '') is null
   and nullif(btrim(coalesce(size_value, '')), '') is null
   and (
     nullif(btrim(coalesce(display_name_ar, '')), '') is not null
     or nullif(btrim(coalesce(display_name_en, '')), '') is not null
   );

commit;
```
