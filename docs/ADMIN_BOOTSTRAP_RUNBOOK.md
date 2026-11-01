# Runbook راه‌اندازی اولیه مدیر Catalog

وضعیت این runbook: **ابزار مستقل وجود دارد، اما اجرای عملیاتی عمداً غیرفعال است.**

## مرز ابزار

فرمان پیشنهادی `catalog:bootstrap-admin` فقط یک مسیر CLI مستقل است؛ endpoint یا
route عمومی ایجاد نمی‌کند و `npm start` را تغییر نمی‌دهد. منطق mutation داخل ابزار
وجود ندارد و ابزار فقط باید `runtime.roleProvider.bootstrapAdministrator()` را
فراخوانی کند. آن متد assignment، سند کنترل و `bootstrap.completed` را در یک
transaction می‌سازد.

نام collectionها و فیلدهای فعلی (`catalogAdminRoleAssignments`،
`catalogAdminControl/bootstrap` و audit collection) هنوز schema پیشنهادی adapter
هستند، نه schema مصوب production. پیش از هر اجرای واقعی باید مالک storage آن‌ها
را بازبینی و تصویب کند.

## پیش‌نیازهای لازم

1. مالک نقش‌ها، مدیر هدف، approver دوم و روش break-glass مشخص و ثبت شوند.
2. پروژه، database، Spreadsheet، ADC و IAM حداقلی در محیط جداگانه تأیید شوند؛
   هیچ credential در Git، command line یا log قرار نگیرد.
3. وضعیت assignmentها، marker bootstrap و شمارنده با ابزار read-only بررسی شود.
   نبود marker همراه assignment قبلی یا شمارندهٔ ناسازگار باید متوقف‌کننده باشد؛
   حدس‌زدن خالی‌بودن سیستم مجاز نیست.
4. قرارداد audit، retention و دسترسی read-only برای بررسی رخداد تأیید شود.

## تأیید اپراتور و actor

آرگومان `--confirm BOOTSTRAP_FIRST_ADMIN` فقط تأیید صریح intent است و هویت نیست.
`--target-subject-id` نیز فقط هدف assignment است. ابزار عمداً هیچ `--actor-id` یا
متغیر محیطی actor را قبول نمی‌کند.

کد آفلاین `src/google-cloud-adc-trusted-actor-provider.js` اکنون seam تزریقی برای
`GoogleAuth.getClient()` و کلاس عمومی `Impersonated` کتابخانه دارد. فقط ADCای را
می‌پذیرد که client آن نمونهٔ `Impersonated` باشد، `getTargetPrincipal()` آن دقیقاً
با service account مستقل allowlist‌شده برابر باشد و فراخوانی `getAccessToken()`
موفق شود. access token فقط برای اثبات موفقیت تبادل استفاده می‌شود و برگردانده یا
ثبت نمی‌شود. این کد به‌تنهایی منبع تأیید مالک/نفر دوم را پیاده‌سازی نمی‌کند.

entrypoint برای اجرا علاوه بر actor به `trustedApprovalProvider` مستقل نیاز دارد؛
نبود آن، خطای provider یا owner/approver یکسان پیش از ساخت runtime متوقف می‌شود.
هیچ provider تأیید به CLI واقعی وصل نشده است، پس فرمان اجرایی هنوز عمداً fail-closed
است. `ownerId`، `approverId` یا `approvalReference` از argv و environment گرفته
نمی‌شوند. تزریق یک تابع دلخواه در کد production منبع اعتماد محسوب نمی‌شود؛ مالک باید
کانال approval سازمانی، احراز هویت هر دو تأییدکننده و مرجع قابل‌بازبینی را تعیین کند.

نسخهٔ فعلی SDK مستند عمومی `Impersonated.getTargetPrincipal()` را فراهم می‌کند.
provider فقط ADC مستقیم از نوع impersonated client را می‌پذیرد؛ credentialهای
External Account که impersonation را داخل خود پیکربندی می‌کنند به علت نداشتن همان
قرارداد عمومی فعلاً پذیرفته نمی‌شوند. کتابخانه در این مخزن transitive است: نسخهٔ
11.3.1 نصب‌شده در ریشه Node 22+ می‌خواهد و نسخهٔ 10.5.0 توکار Node 18+ را پشتیبانی
می‌کند. افزودن وابستگی مستقیم در حالت offline ممکن نشد؛ بنابراین مصرف‌کننده باید
سازنده‌های SDK سازگار را صریح تزریق کند و پیش از wiring، نسخهٔ مستقیم و دامنهٔ Node
را تصویب کند. همچنین `@google-cloud/firestore@9.4.0` در lockfile خودش Node 22+ را
اعلام می‌کند؛ `engines` فعلی package که Node 18+ می‌گوید باید پیش از بهره‌برداری
با وابستگی‌های موجود تطبیق داده شود. `GoogleAuth` و `Impersonated` باید از همان
نسخه/کپی SDK ساخته شوند تا بررسی `instanceof` fail-closed اشتباه نکند.

شناسهٔ actor در این مسیر ایمیل principal سرویس حساب allowlist‌شده است، نه شناسهٔ
اپراتور انسانی و نه `oxiw-catalog-runtime`. دریافت token از impersonation API هنگام
فراخوانی provider نیازمند دسترسی شبکه و IAM است؛ هیچ تبادل واقعی در تست‌ها یا این
مرحله انجام نشده است.

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
