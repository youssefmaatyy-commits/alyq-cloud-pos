# تقرير مستقل: حالة تطبيق Windows القابل للتثبيت، ونسخة iPhone PWA، وتطبيق iOS الأصلي

يوضح هذا التقرير الفروقات الدقيقة بين ما هو **منجز وموجود فعلياً في المستودع** وما **لا يزال مطلوباً** لكل منصة من المنصات الثلاث (`Windows Desktop`، `iPhone PWA`، `Native iOS App`).

---

## ١. تطبيق Windows القابل للتثبيت (`Windows Desktop App — Electron / NSIS`)

### ما تم إنجازه فعلياً في الكود (`desktop/` و`package.json`):
1. **غلاف سطح المكتب (`Electron 44.5.1`)**:
   - ملف العملية الرئيسية `desktop/main.mjs` (`20.2 KB`)، وجسر الأمان المعزول `desktop/preload.mjs` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`)، وعقود الاتصال `desktop/contracts.mjs`.
   - يدعم الطباعة الصامتة لإيصالات الكاشير الحرارية (`58mm / 80mm`) وملصقات الباركود عبر طابعات Windows المعرّفة في النظام (`webContents.print`)، وفتح درج النقدية (`Cash Drawer Kick`) عبر الطابعة، وحفظ تفضيلات الطابعة محلياً.
   - مجتاز لاختبارات أمان سطح المكتب (`src/lib/desktop/__tests__/security.selftest.ts` — `10/10`) واختبارات عتاد الكاشير (`src/modules/pos/__tests__/desktopHardware.selftest.ts` — `8/8`).
2. **إعدادات المثبّت (`electron-builder 26.15.3` في `package.json`)**:
   - مهيأ لبناء مثبّت Windows رسمي بصيغة **NSIS (`x64`)** بالاسم `ALYQ-POS-Setup-6.0.0-x64.exe` (`appId: "eg.alyq.pos"`, `productName: "ALYQ POS"`, `asar: true`) مع إنشاء اختصار على سطح المكتب وقائمة ابدأ وعدم مسح بيانات التطبيق عند إلغاء التثبيت (`deleteAppDataOnUninstall: false`).
   - جميع تعديلات الموديلات والباركود المشترك (`BR101`) تعمل تلقائياً داخل نسخة Windows لأنها تشترك في نفس حزمة الواجهة (`dist/`).

### ما لم يتم تنفيذه بعد وما هو مطلوب لإصدار ملف `.exe` النهائي:
1. **تجميع ملف المثبّت `ALYQ-POS-Setup-6.0.0-x64.exe` على بيئة `windows-latest`**:
   - لم نقم بعد بتشغيل `npm run desktop:package:win` على خادم بناء `windows-latest` في GitHub Actions لرفع ملف `.exe` القابل للتثبيت إلى صفحة Releases.
2. **شهادة توقيع كود Windows (`Authenticode Code Signing Certificate` — اختياري لكن موصى به)**:
   - بدون شهادة توقيع Windows تجارية (`OV / EV Code Signing`)، سيعمل ملف `ALYQ-POS-Setup-6.0.0-x64.exe` بشكل كامل على Windows 10/11، لكن شاشة `Windows Defender SmartScreen` ستظهر تنبيه *"Windows protected your PC → More info → Run anyway"* عند التثبيت لأول مرة.

---

## ٢. نسخة iPhone كـ Web App قابل للتثبيت (`iPhone Safari PWA — Add to Home Screen`)

### ما تم إنجازه فعلياً وجاهز للعمل فوراً:
1. **ملف تعريف التطبيق (`public/mobile.webmanifest`) وعامل الخدمة (`public/alyq-sw.js`)**:
   - مهيأ بالكامل كـ `Standalone PWA` (`"display": "standalone"`, `"start_url": "/#/mobile"`, `"scope": "/"`, مع أيقونات `192x192` و`512x512` ووسوم `apple-mobile-web-app-capable` في `index.html`).
   - يدعم إشعارات `Web Push` على iOS (`iOS 16.4+` عند إضافة الموقع إلى الشاشة الرئيسية `Add to Home Screen`) عبر الهجرات `0094` و`0095` وعامل الخدمة `public/alyq-sw.js`.
2. **التشغيل الكامل للكاشير والموديلات والمتجر على متصفح Safari في iPhone**:
   - عند فتح رابط HTTPS الخاص بـ ALYQ على iPhone من متصفح **Safari** ثم الضغط على **مشاركة (`Share`) ← إضافة إلى الشاشة الرئيسية (`Add to Home Screen`)**:
     - يظهر التطبيق بأيقونة مستقلة على شاشة الـ iPhone ويعمل بملء الشاشة بدون شريط عنوان المتصفح.
     - تعمل شاشة الكاشير (`#/dashboard/pos`)، ونافذة اختيار الموديلات (`BR101` — `شكل 1` / `شكل 2` / `شكل 3`)، وماسح الباركود بالكاميرا (عبر `getUserMedia` فوق HTTPS)، والمبيعات أوفلاين (`IndexedDB`).

### القيود التقنية لنسخة iPhone PWA وما هو مطلوب:
1. **الطباعة من iPhone PWA**:
   - في متصفح Safari / PWA على iPhone، تتم طباعة الإيصالات عبر نافذة **`AirPrint`** الخاصة بنظام iOS (تتطلب طابعة تدعم `AirPrint` على نفس شبكة الـ Wi-Fi أو حفظ الإيصال كـ PDF). لا يدعم متصفح iOS الاتصال المباشر بطابعات البلوتوث الحرارية (`ESC/POS SPP/BLE`).
2. **عزل التخزين في iOS**:
   - يفصل نظام iOS بين جلسة Safari العادية وبين أيقونة `Home Screen PWA`، لذلك يلزم تسجيل الدخول مرة واحدة من داخل أيقونة الـ PWA بعد إضافتها للشاشة الرئيسية.

---

## ٣. تطبيق iOS الأصلي (`Native iOS App — Capacitor / Xcode / App Store`)

### ما تم إنجازه فعلياً في المستودع (`ios/`):
1. **هيكل مشروع Capacitor iOS الأساسي (`ios/App/`)**:
   - يوجد مشروع Xcode الأساسي (`ios/App/App.xcodeproj`, `AppDelegate.swift`, `Info.plist`) ومربوط بـ 6 إضافات Capacitor (`@capacitor/app`, `@capacitor/browser`, `@capacitor/device`, `@capacitor/network`, `@capacitor/preferences`, `@capacitor/push-notifications`).

### ما لم يُنجز بعد ولماذا لا يُعد تطبيق iOS الأصلي جاهزاً للنشر حالياً:
1. **تصريح الكاميرا في `ios/App/App/Info.plist`**:
   - ملف `ios/App/App/Info.plist` الحالي لا يحتوي بعد على مفتاح `NSCameraUsageDescription` الإلزامي في نظام iOS للسماح لمكون `WKWebView` بفتح الكاميرا لمسح الباركود.
2. **طباعة الإيصالات الأصلية على iOS (`UIPrintInteractionController`)**:
   - على عكس تطبيق Android الذي أضفنا له جسر طباعة أصلي (`window.ALYQAndroidPrint` في `MainActivity.java`)، فإن `AppDelegate.swift` في مشروع iOS هو القالب الافتراضي لـ Capacitor ولا يتضمن جسراً أصلياً للطباعة الحرارية.
3. **متطلبات التجميع والتوقيع الإلزامية من شركة Apple (`macOS + Apple Developer Account`)**:
   - لا يسمح نظام iOS بتثبيت ملفات تطبيقات مباشرة (مثل `.apk` في أندرويد).
   - لبناء وتثبيت ملف `.ipa` أصلي على أجهزة iPhone (عبر **TestFlight** أو **App Store**)، يلزم توفر:
     - حساب مطور Apple مدفوع (**Apple Developer Program — $99/سنة**).
     - شهادة توزيع (`Apple Distribution Certificate`) وملف تعريف (`Provisioning Profile`) للمعرف `eg.alyq.management` مع تفعيل خدمة `Push Notifications (APNs)`.
     - تجميع المشروع عبر `xcodebuild` على خادم `macos-latest` ورفعه إلى `App Store Connect / TestFlight`.
