# ALYQ POS 6.1.0 — Final Blocker Closure

**تاريخ المراجعة:** 23 أكتوبر 2026 (Africa/Cairo)
**الفرع:** `arena/f498e340-alyq-cloud-pos` — نشط
**قرار الإطلاق:** **NO-GO** — لا دمج إلى `main` ولا نشر إلى Production.
**الإصدار داخل الحزمة:** `6.1.0-preview.1`؛ لم يُرقّ إلى الإصدار النهائي `6.1.0` في هذه المراجعة.

## حدود Git ومصدر الحالة

- تعذّر العثور على commit الاستمرار الذي ذكره الطلب، `91880c61742b6713c7ba57ef81ea1878cf9e2d9b`؛ ليس له كائن Git في هذا checkout.
- عند بدء المراجعة كان HEAD المحلي `f1d7ccb5937a7aa66e77e14a568f411fd30c8319`، مع تغييرات عمل متراكمة غير ملتزمة.
- بعد الجلب، كان `origin/arena/f498e340-alyq-cloud-pos` عند `c06389c4b4a3a277f3aff1b8f29410a634ba9daa`، مبنيًا فوق سلسلة التغييرات السابقة (ومنها `3f6abe1`). أُنشئ commit التنفيذ `21ebef0` ثم merge commit `b6854a0` لدمج تاريخ الفرع البعيد دون إسقاط أي عمل؛ حُلّت الملفات المتعارضة لصالح النسخة المحلية الأحدث بعد مقارنة النسختين، وكانت شجرة الدمج مطابقة للشجرة المختبرة. ظلّت الشجرة نظيفة. الدفع إلى فرع التطوير فقط ما زال ينتظر اكتمال مراجعة التقرير؛ لا تغيير على `main`.
- لا يثبت نص الوثيقة القديمة التي تشير إلى `3f6abe1` أن ذلك SHA موجود في تاريخ الفرع الحالي؛ لذلك لا أتعامل معه على أنه HEAD أو مصدر حالة أحدث من الشجرة والفرع اللذين جرى فحصهما.

## نتيجة E2E الكاملة وتحليل الإخفاقات

شُغّل `npm run test:e2e` منفردًا بعد تثبيت الاعتماديات بـ`npm ci`، وحُفظ السجل الكامل أثناء التحليل في `/tmp/alyq-final-e2e.log`. النتيجة: **27/33 suite ناجحة، و6/33 فاشلة**. هذا تشغيل كامل غير أخضر؛ لم تُعطّل الاختبارات ولم تُخفّف توقعاتها.

| Suite | النتيجة الحالية | التشخيص |
|---|---|---|
| `store` | فشل | يؤكد التدفق وجود وحدة Online في شريط POS، لكن التوقع لا يتحقق في المسار التاريخي. |
| `lifecycle` | فشل | انتهت مهلة انتظار حفظ المنتج والعودة إلى الكتالوج؛ بقيت صفحة المنتجات مفتوحة. |
| `storefront` | فشل | انتهت مهلة التدفق القديم للمتجر عند انتظار الرجوع إلى الكتالوج. |
| `promotions` | فشل | نجح إنشاء الطلب والخصم والإرجاع، ثم انتهت المهلة عند انتظار تفاصيل الإرجاع. |
| `final` | فشل | انتهت مهلة انتظار حفظ ضمن التدفق المتكامل. |
| `storepolish` | فشل | انتهت مهلة انتظار الرجوع إلى الكتالوج. |
| `storefront-v2` | **نجح كاملًا** | **63/63**؛ فشل المجموعة الكامل المسجل سابقًا لم يتكرر في تشغيل E2E الكامل الحالي. |
| `v2-cutover` | **نجح كاملًا** | **37/37**؛ يختبر فتح Mini Cart Drawer ورابط صفحة السلة دون تغيير التوقعات الوظيفية. |
| `poslayout` | **نجح في المجموعة الحالية** | لم يتكرر timeout حفظ المنتج الذي ظهر في تشغيل منفرد سابق وعلى نسخة الأساس النظيفة؛ لا أنسب ذلك إلى تعديل متجر. |
| بقية suites | ناجحة | شملت `smoke`, `auth`, `staff-entry`, `v2-journey` وغيرها؛ نتيجة المجموعة أعلاه تجمع كل 33 suite. |

الإخفاقات الستة هي المجموعة التاريخية الموثقة على `main`/التشغيلات السابقة، ولم يثبت أنها عيوب جديدة من هذه التغييرات. لا يُدّعى إغلاقها أو خضرة E2E. أما إخفاقا `storefront-v2` و`poslayout` السابقان فلم يتكررا في التشغيل الكامل الحالي، لذا صُنّفا **غير قابلين لإعادة الإنتاج هذه المرة** لا كنجاح دائم مضمون.

## الفحوصات المحلية

| الفحص | النتيجة في هذه المراجعة |
|---|---|
| `npm ci` | اكتمل: 564 حزمة، و0 ثغرات مدققة من npm. |
| `npm test` (logic) | **79/79 suites ناجحة**. |
| `npm run typecheck` | ناجح. |
| `npm run build` | ناجح؛ Vite أنتج `dist/index.html`، دون نشر. |
| `npm run db:check` | ناجح محليًا؛ **98 migration** طُبّقت مرتين في PGlite مع فحوص التكافؤ. لم تُنفذ migration على Supabase. |
| `npm run lint` | exit 0: **0 أخطاء، 40 تحذيرًا**؛ التحذيرات لا تمنع CI الحالي. |
| `npm run production:preflight` | ناجح على شجرة نظيفة بعد الدمج: **26/26**، بلا `--allow-dirty`. |
| GitHub CI على آخر commit تنفيذ | لم يُشغّل بعد؛ سيبدأ عند الدفع إلى فرع التطوير فقط. تُضاف نتيجة run/SHA بعد اكتماله، ولا يُدّعى نجاح قبل ظهور نتيجته. |

## مراجعة معايير المتجر السبعة

اللقطات الفعلية Before/After (21 لقطة) موجودة في [`../../evidence/storefront-7-improvements/`](../../evidence/storefront-7-improvements/). المعاينة المرئية المسجلة محليًا لا تعادل معاينة مستضافة أو UAT حديثًا.

| # | المعيار | الحالة / الدليل / القيد |
|---:|---|---|
| 1 | Hero | **ناجح في أدلة Chromium المحلية السابقة.** الصورة الأصلية والعنوان والـCTA المحليان محفوظان؛ لا صورة مولدة ولا عبارة الحملة المحذوفة. [EN Before](../../evidence/storefront-7-improvements/hero-before-en-desktop.png) · [EN After](../../evidence/storefront-7-improvements/hero-after-en-desktop.png) · [AR After](../../evidence/storefront-7-improvements/hero-after-ar-desktop.png). لا معاينة مستضافة متاحة الآن. |
| 2 | Product Cards | **ناجح في اختبارات DOM والأدلة المحلية.** السعر والاسم والتوفر وعدد الموديلات وlazy loading والـfallback المحايد؛ لا تعديل بيانات أو صور وهمية. [Before](../../evidence/storefront-7-improvements/product-cards-before-en-desktop.png) · [EN After](../../evidence/storefront-7-improvements/product-cards-after-en-desktop.png) · [AR After](../../evidence/storefront-7-improvements/product-cards-after-ar-desktop.png). |
| 3 | Collection / Model Gallery | **ناجح على fixture Staging للقراءة فقط؛ فحص الصور الخارجية غير مكتمل.** اللقطات والـfixture يحتفظان بـSKU/UUID/الأسماء والمخزون الحقيقي المسجل (M01/M02/M03: 4/3/5). Chromium منع تحميل صور HTTPS الخارجية، لذا الصور البعيدة تُعرض كـfallback محايد؛ لم تُستبدل بصور مصطنعة. [Before](../../evidence/storefront-7-improvements/model-gallery-before-en-desktop.png) · [EN After](../../evidence/storefront-7-improvements/model-gallery-after-en-desktop.png) · [AR After](../../evidence/storefront-7-improvements/model-gallery-after-ar-desktop.png). |
| 4 | Category Cards | **ناجح في الأدلة المحلية.** بطاقات نصية مع فحص RTL/LTR والفئات المؤرشفة، دون تعديل أسماء أو بيانات. [Before](../../evidence/storefront-7-improvements/categories-before-en-desktop.png) · [EN After](../../evidence/storefront-7-improvements/categories-after-en-desktop.png) · [AR After](../../evidence/storefront-7-improvements/categories-after-ar-desktop.png). |
| 5 | Mini Cart | **ناجح في تشغيل E2E الحالي.** `storefront-v2` اجتاز 63/63 و`v2-cutover` اجتاز 37/37؛ يغطيان السلة المشتركة، الكمية والحذف والإجمالي، drawer، ومسار السلة الكامل. فشل انتظار Drawer في تشغيل سابق لم يتكرر. [Before](../../evidence/storefront-7-improvements/mini-cart-before-en-desktop.png) · [EN After](../../evidence/storefront-7-improvements/mini-cart-after-en-desktop.png) · [AR After](../../evidence/storefront-7-improvements/mini-cart-after-ar-desktop.png). |
| 6 | Mobile | **ناجح بمحاكاة Chromium السابقة؛ جهاز فعلي غير مختبر.** الأدلة المسجلة تغطي 360/390/768/1366/1920px وEN/AR دون overflow أفقي. محاكاة viewport لا تثبت اللمس أو سلوك جهاز حقيقي. [Before 390](../../evidence/storefront-7-improvements/mobile-purchase-before-en-390.png) · [EN After 390](../../evidence/storefront-7-improvements/mobile-purchase-after-en-390.png) · [AR After 390](../../evidence/storefront-7-improvements/mobile-purchase-after-ar-390.png). |
| 7 | New Arrivals | **جزئي.** اختُبر ترتيب وأهلية المنتج الوحيد المتاح وعدم التكرار والتمركز. لم تتوفر بيانات حقيقية كافية لاختبار حالات 2 أو 3 منتجات؛ لم تُنشأ بيانات وهمية. [Before](../../evidence/storefront-7-improvements/new-arrivals-before-en-desktop.png) · [EN After](../../evidence/storefront-7-improvements/new-arrivals-after-en-desktop.png) · [AR After](../../evidence/storefront-7-improvements/new-arrivals-after-ar-desktop.png). |

### الشعار والهوية والعمليات

- بقي ملف الشعار الرسمي القديم `public/alyq-logo.png` دون تغيير لتوافق الإيصالات. تستخدم واجهة المتجر الأصل الشفاف ثنائي اللغة `public/brand/alyq-logo-transparent.png`؛ لا تغيير على artwork الذهبي أو النسبة أو fallback شعار التاجر.
- اختبار Chromium السابق `scripts/rendered-v2-header.flow.mjs` تحقّق من Desktop/Mobile EN وAR/RTL، الشفافية، النسبة، التمركز وعدم التداخل. لم يُعَد تشغيله في هذه الجولة لعدم وجود Preview/خادم محلي قائم؛ لا أصفه كفحص جديد.
- الحفاظ على `logpos` ودخول العملاء والموظفين ومعرفات الموديلات والسلة والطلبات؛ في الاختبارات المحلية الحالية اجتازت `staff-entry`, `v2-journey`, `auth`، و`storefront-v2` كاملًا. لم تُستخدم بيانات دخول Staging الحقيقية.
- قيد موحد للصور: طلبات HTTPS الخارجية كانت محظورة في Chromium عند الالتقاط السابق؛ fallback محايد أصلي وليس صورة بديلة. لا يمكن الآن إعادة فحص الشبكة لأن لا توجد معاينة Vercel ولا خادم محلي قائم.

## Staging: WEB-000005 والحجز

- آخر قراءة ناجحة سابقة (SELECT فقط بتاريخ 23 أكتوبر) سجلت `WEB-000005` بحالة `pending`، دون `sale_id`، وreservation واحدة لـ`BR101-M01`: on-hand 4، reserved 1، available 3.
- محاولة القراءة الأحدث عبر Supabase فشلت بـ`provider_unavailable` وHTTP 502. لم أكرر الاستعلام نفسه؛ لذلك **لا أؤكد أن الحالة الحالية ما زالت pending**، ولا أستنتج تحرير الحجز.
- لم تُنشأ أو تُلغَ طلبات، ولم يُعدّل المخزون. لا تتوفر جلسة Staging مخولة للإلغاء. يلزم مستخدم مخول أن يستخدم Online Orders الرسمي، ثم يتحقق من الحالة `cancelled` والحجز `released` وعودة المتاح إلى 4 مع بقاء on-hand 4. لا تجاوز للصلاحيات ولا تعديل يدوي.

## المعاينة المستضافة وWindows

- أظهر استعلام Vercel لهذه المراجعة **0 مشاريع** مطابقة لـ`alyq` و**0 Preview deployments** في النطاق المتاح. الخادم المحلي `127.0.0.1:4173` كان متوقفًا؛ لا أصف رابطًا أو Preview على أنها متاحة حاليًا ولا أدّعي فحص الصور البعيدة الآن.
- Windows workflow السابق `39835400652` نجح لترقية تجريبية معزولة 6.0.0→6.1.0 على GitHub runner. هذا ليس اختبار جهاز Windows فعلي ولا تحققًا من EXE جديد. لا EXE جديد في هذه الجولة؛ ولم تُنشأ APK.

## موانع الإصدار والخطوات التالية

1. تشغيل CI على commit التنفيذ الحالي وتحليل كل job. المتوقع أن يظل E2E غير أخضر بسبب suites الستة الموروثة؛ لا تُخفى ولا تُعطّل.
2. إكمال `production:preflight` على شجرة نظيفة بعد commit.
3. إعادة التحقق من `WEB-000005` عندما تتوفر Supabase؛ وإذا كان pending، الإلغاء فقط من جلسة Staging مخولة عبر التدفق الرسمي والتحقق من تحرير الحجز.
4. إجراء UAT مستضاف معتمد وفحص الصور الخارجية إذا أُتيح Preview؛ واختبار الجهاز الحقيقي وNew Arrivals مع 2–3 عناصر حقيقية عند توفرها.
5. إبقاء الحزمة عند `6.1.0-preview.1` وقرار **NO-GO** حتى مراجعة الموانع. لا merge إلى `main`، ولا نشر Vercel/Production، ولا migrations إنتاجية، ولا GitHub Release دون موافقة صريحة.

**الخلاصة:** تحقق محلي قوي من الأنواع والبناء والـlogic والمخطط ومعظم مسارات المتجر؛ لكن التشغيل الكامل ما زال **6/33 فشلًا**، حالة الطلب/الحجز الحالية غير قابلة للتحقق بسبب 502، ولا توجد معاينة مستضافة متاحة. لا يعتبر هذا التقرير تصريحًا بالدمج أو النشر.
