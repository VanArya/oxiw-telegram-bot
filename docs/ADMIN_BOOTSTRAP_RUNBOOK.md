# Runbook راه‌اندازی اولیه مدیر Catalog

وضعیت این runbook: **Bootstrap تک‌مالک با Firebase Authentication و رمز یک‌بارمصرف سرور**.

## روش عملیاتی فعلی

راه‌اندازی اولیه از مسیر محافظت‌شدهٔ `POST /api/v1/admin/catalog/bootstrap` انجام می‌شود.
این مسیر endpoint عمومیِ اعطای نقش نیست: ابتدا Firebase ID Token با Firebase Admin
اعتبارسنجی می‌شود، سپس UID باید دقیقاً با `CATALOG_ADMIN_BOOTSTRAP_UID` برابر باشد
و رمز محرمانهٔ `CATALOG_ADMIN_BOOTSTRAP_SECRET` نیز باید صحیح باشد.

پس از این دو کنترل، سرور فقط UID استخراج‌شده از توکن معتبر را به
`bootstrapFirstAdministrator()` می‌دهد. UID یا نقش از بدنهٔ درخواست پذیرفته نمی‌شود.
تخصیص مدیر، سند کنترل و رخداد audit با schema v3 در یک تراکنش Firestore ساخته
می‌شوند. اگر کنترل یا هر assignment قدیمی وجود داشته باشد، bootstrap متوقف می‌شود؛
تکرار درخواست نیز با تعارض رد خواهد شد.

## تنظیمات Render

در Environment (ترجیحاً Linked Environment Group متصل به سرویس) دو متغیر اضافه شود:

- `CATALOG_ADMIN_BOOTSTRAP_UID`: UID حساب Firebase مالک که پس از ورود Google نمایش داده می‌شود.
- `CATALOG_ADMIN_BOOTSTRAP_SECRET`: رمز تصادفی حداقل ۳۲ کاراکتری؛ فقط در Render ذخیره شود و در Git، پیام، URL یا log قرار نگیرد.

رمز را با password manager تولید کن. آن را در گفتگو یا کد منبع ارسال نکن.
این متغیرها فقط برای راه‌اندازی اولیه‌اند؛ پس از موفقیت، هر دو را از Render حذف کن
و یک deploy انجام بده. حذف رمز، مسیر Bootstrap را غیرفعال می‌کند؛ نقش ثبت‌شده باقی می‌ماند.

## اجرای اولیه

1. متغیرهای بالا را در Render تنظیم و deploy کن.
2. با همان حساب Google مالک وارد `/admin/` شو.
3. در صفحهٔ «دسترسی مدیریتی تخصیص داده نشده»، رمز راه‌اندازی را وارد و فعال‌سازی را اجرا کن.
4. پس از نمایش داشبورد، هر دو متغیر Bootstrap را از Render حذف کن و deploy مجدد انجام بده.
5. در صفحهٔ تاریخچه و Firestore بررسی کن که رخداد `bootstrap.completed` ثبت شده و فقط یک مدیر فعال وجود دارد.

## توقف امن

- هیچ نقش یا assignment را دستی در Firestore ایجاد یا اصلاح نکن.
- اگر marker، assignment قدیمی یا شمارنده ناسازگار وجود دارد، مسیر را متوقف کن؛ reset یا پاک‌سازی خودکار وجود ندارد.
- رمز Bootstrap را بعد از موفقیت نگه ندار.
- این روش برای راه‌اندازی یک مالک مشخص طراحی شده است؛ بعد از bootstrap، اعطای نقش‌های دیگر باید از مسیر مدیریتی مورداعتماد و audit‌شده انجام شود.

---

## IAM موقت پیشنهادی

این‌ها پیش‌شرط طراحی‌اند، نه تنظیمات موجود یا تأییدشده:

1. مالک Cloud یک service account اختصاصی provisioning با ایمیل ثبت‌شده در کد/تنظیم
   مورداعتماد انتخاب کند؛ `oxiw-catalog-runtime` برای bootstrap مجاز نیست.
2. IAM Credentials API در پروژهٔ مصوب فعال باشد. فقط اپراتورهای نام‌برده و زمان‌دار
   مجوز `roles/iam.serviceAccountTokenCreator` روی همان service account بگیرند؛
   مجوز را به کل پروژه یا حساب runtime تعمیم ندهند.
3. مجوزهای Firestore لازم برای bootstrap جداگانه و حداقلی تعیین شوند. چون نقش‌های
   IAM Firestore ممکن است granularity سندی نداشته باشند، مالک باید دامنهٔ دسترسی
   واقعی را قبل از اجرا بررسی و ثبت کند.
4. هیچ کلید JSON بلندمدت ساخته نشود. ADC باید از زنجیرهٔ اعتبارنامهٔ موردتأیید
   اپراتور به impersonation کوتاه‌عمر برسد.
5. مالک و approver دوم از کانال مستقل سازمانی تأیید کنند؛ دو هویت باید متفاوت باشند.
   مرجع تغییر و هویت تأییدکنندگان در سامانهٔ مورداعتماد ثبت و سپس در audit نسخهٔ ۲
   منعکس شوند. این منبع تأیید هنوز انتخاب یا پیاده‌سازی نشده است.
6. پس از بررسی read-only audit و assignment، binding موقت Token Creator و هر مجوز
   موقت Firestore لغو و لغوشدن آن ثبت شود.

## اجرای یک‌بارهٔ آینده

پس از تصویب schema، dependency/runtime سازگار، منبع تأیید معتبر و wiring موردبازبینی،
اجرای کنترل‌شده در محیط مجاز قابل بررسی است. در وضعیت فعلی اجرای زیر باید پیش از
ساخت runtime با کد `TRUSTED_ACTOR_SOURCE_UNCONFIGURED` متوقف شود:

```text
npm run catalog:bootstrap-admin -- --target-subject-id <approved-subject> --confirm BOOTSTRAP_FIRST_ADMIN
```

پیش از اجرای mutation، ابزار باید config، شناسهٔ هدف و confirmation را بررسی کند؛
سپس فقط `bootstrapAdministrator()` را صدا بزند. اجرای دوباره باید با
`BOOTSTRAP_ALREADY_COMPLETED` رد شود. خطای audit یا وضعیت ناسازگار نباید پیام موفقیت
تولید کند.

## پس از اجرا و توقف امن

- رخداد `bootstrap.completed` و سند کنترل را از مسیر read-only با دو نفر بررسی کنید؛
  token، credential و payload خام را ثبت نکنید.
- وجود دقیق یک assignment فعال با نقش `administrator` و شمارندهٔ هماهنگ را بررسی
  کنید.
- پس از موفقیت، مجوز موقت provisioning را لغو و ابزار/دسترسی آن را غیرفعال کنید.
- reset marker، self-registration، اعطای نقش از API و حذف آخرین مدیر مسیر عادی نیستند.
- در وضعیت نامشخص، اجرا را متوقف کنید و migration/reconciliation مصوب را جداگانه
  طراحی کنید؛ assignment یا audit را دستی و خارج از transaction تغییر ندهید.
