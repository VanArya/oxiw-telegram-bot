# Runbook راه‌اندازی اولیه مدیر Catalog

وضعیت: **Bootstrap تک‌مالک با Firebase Authentication و رمز یک‌بارمصرف سرور**.

## سازوکار

راه‌اندازی اولیه از مسیر محافظت‌شدهٔ `POST /api/v1/admin/catalog/bootstrap` انجام می‌شود.
ابتدا Firebase ID Token با Firebase Admin اعتبارسنجی می‌شود؛ سپس UID باید دقیقاً با
`CATALOG_ADMIN_BOOTSTRAP_UID` برابر باشد و رمز محرمانهٔ
`CATALOG_ADMIN_BOOTSTRAP_SECRET` نیز صحیح باشد.

سرور فقط UID استخراج‌شده از توکن معتبر را به `bootstrapFirstAdministrator()` می‌دهد.
UID یا نقش از بدنهٔ درخواست پذیرفته نمی‌شود. تخصیص مدیر، سند کنترل و رخداد audit
با schema v3 در یک تراکنش Firestore ساخته می‌شوند. اگر کنترل یا هر assignment قدیمی
وجود داشته باشد، bootstrap متوقف می‌شود؛ اجرای مجدد نیز رد خواهد شد.

## تنظیمات Render

در Environment (ترجیحاً Linked Environment Group متصل به سرویس) دو متغیر اضافه شود:

- `CATALOG_ADMIN_BOOTSTRAP_UID`: UID حساب Firebase مالک.
- `CATALOG_ADMIN_BOOTSTRAP_SECRET`: رمز تصادفی حداقل ۳۲ کاراکتری.

رمز را با password manager تولید کن. آن را در گفتگو، Git، URL یا log قرار نده.
این متغیرها فقط برای راه‌اندازی اولیه‌اند.

## اجرای اولیه

1. دو متغیر بالا را در Render تنظیم و deploy کن.
2. با همان حساب Google مالک وارد `/admin/` شو.
3. در صفحهٔ «دسترسی مدیریتی تخصیص داده نشده»، رمز راه‌اندازی را وارد و فعال‌سازی را اجرا کن.
4. پس از نمایش داشبورد، هر دو متغیر Bootstrap را از Render حذف کن و deploy مجدد انجام بده.
5. در تاریخچهٔ پنل و Firestore بررسی کن که رخداد `bootstrap.completed` ثبت شده و شمارندهٔ مدیران فعال برابر یک است.

حذف رمز پس از موفقیت، مسیر Bootstrap را غیرفعال می‌کند؛ نقش ثبت‌شده باقی می‌ماند.

## توقف امن

- هیچ assignment یا نقش را دستی در Firestore ایجاد یا اصلاح نکن.
- اگر marker، assignment قدیمی یا شمارنده ناسازگار وجود دارد، مسیر را متوقف کن؛ reset یا پاک‌سازی خودکار وجود ندارد.
- رمز Bootstrap را بعد از موفقیت نگه ندار.
- این روش برای راه‌اندازی یک مالک مشخص طراحی شده است. اعطای نقش‌های دیگر باید از مسیر مدیریتی مورداعتماد و audit‌شده انجام شود.
