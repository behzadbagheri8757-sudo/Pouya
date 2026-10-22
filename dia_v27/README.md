# DIA Business V2.8 — Phase 1 (Financial Integrity)

حسابداری و مدیریت کسب‌وکار مهندسی برق؛ Mobile First، SPA، Vanilla JS، IndexedDB و Offline/PWA.

## اجرا

پروژه را روی یک Static Server اجرا کنید یا مستقیماً روی GitHub Pages قرار دهید. تمام مسیرهای داخلی نسبی هستند و Backend لازم نیست.

## داده‌ها

داده‌های اصلی در IndexedDB با نام `DIA_Business_DB` ذخیره می‌شوند. نسخه دیتابیس V2 است؛ داده‌های نسخه‌های قبلی حفظ می‌شوند و مبالغ نسخه‌های قبلی که با تومان ذخیره شده‌اند، در اولین اجرای V2.7 Freeze Hardening یک‌بار به ریال تبدیل می‌شوند. و migration داده‌های V1 را پاک نمی‌کند.

## قابلیت‌های V2

- داشبورد موبایلی
- مشتریان و صورتحساب
- ساخت فاکتور از داخل صفحه مشتری
- جستجوی سریع کالا/خدمت در فاکتور
- محاسبه زنده جمع، تخفیف، مالیات و هزینه جانبی
- واحد پول ثابت و یکپارچه: ریال
- چاپ فاکتور A4 و صورتحساب مشتری
- خروجی JPG فاکتور با رندر مستقیم Canvas و مناسب اشتراک‌گذاری در iOS
- تاریخ فاکتور شمسی با انتخاب‌گر سال/ماه/روز
- محصولات، خدمات و پروژه‌ها
- تراکنش‌های درآمد/هزینه
- گزارش‌های مالی موجود در V1
- Backup/Restore به JSON
- Offline-first با Service Worker
- Bottom Sheet برای «بیشتر»
- Design System مرکزی و آیکون‌های SVG محلی
- فونت فارسی محلی Noto Kufi Arabic

## ساختار

```text
index.html
manifest.json
sw.js
css/
  style.css
  print.css
js/
  app.js
  router.js
  db.js
  utils.js
  validators.js
  components.js
  views/
assets/
  icons/
  fonts/
```

## توجه درباره Offline

برای نصب PWA، برنامه را از یک HTTPS static host مانند GitHub Pages اجرا کنید. Service Worker روی `file://` فعال نمی‌شود.

## V2.8 Phase 1 — یکپارچگی مالی و داده

- `js/finance.js`: تنها منبع قواعد مالی (Ledger، دریافت‌ها، وضعیت فاکتور، پروژه، سیاست پرداخت).
- تاریخ تراکنش (`date`) واقعاً ذخیره می‌شود؛ رکوردهای قدیمی بدون `date` به `createdAt` برمی‌گردند.
- ورود اعداد فارسی/عربی از مسیر مرکزی `parseNumber/toNumber/toMoney` (validators.js)؛ NaN هرگز ذخیره نمی‌شود (گارد در db.js).
- هر دریافت فقط یک‌بار شمرده می‌شود؛ فاکتور لغوشده، دریافت‌شده‌ها را به‌صورت بستانکاری مشتری نگه می‌دارد.
- مشتری/پروژه/کالا/خدمت دارای سابقه حذف نمی‌شوند؛ آرشیو می‌شوند (`archived:true`).
- Backup: اعتبارسنجی کامل (`app`، `version`، `dataVersion`، stores) قبل از Restore؛ فایل نامعتبر داده‌ای را تغییر نمی‌دهد.
- Inventory (کاهش موجودی با فاکتور) عمداً در این Phase نیست.
