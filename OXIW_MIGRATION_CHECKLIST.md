# چک‌لیست انتقال و آمادگی OXIW

آخرین بررسی محلی: ۲۰ اکتبر ۲۰۲۶. وضعیت‌ها فقط بر پایهٔ فایل‌های checkout یا نتیجهٔ عملی ذکرشده‌اند.

## تأییدشده در این checkout

- [x] هویت پروژه: `oxiw-main-bot`، برنامهٔ اصلی Node.js/Express؛ entry point برابر `index.js`.
- [x] شاخهٔ کاری جدا ساخته شد: `codex/oxiw-independent-dev`، از `main` با HEAD برابر `c1a8e1f36748b8e1e9778a0c68cd3ff739caf6c1`.
- [x] در شروع کار `main` با `origin/main` برابر بود؛ پس از `git fetch origin` نیز `origin/main` و شاخهٔ کاری از نظر commit برابر ماندند.
- [x] `package-lock.json` موجود است، lockfile version 3 است و root package/dependencies با `package.json` تطبیق دارد.
- [x] محیط checkout دارای Node `v24.19.0` و `node_modules` محلی است؛ نسخه‌های قابل resolve شده Express `4.22.3` و googleapis `144.0.0` بودند. نصب جدیدی انجام نشد.
- [x] هشت آزمون موجود با `node --test` در محیط محلی موفق شدند (۴ unit و ۴ Express integration؛ ۰ شکست). آزمون integration فقط localhost و handler mock را استفاده می‌کند.
- [x] `security.js` secret را قبل از JSON parser بررسی می‌کند؛ secret غایب fail-closed با 503 است و هدر غایب/نامعتبر 403 می‌گیرد.
- [x] الگوهای پر اطمینان برای Telegram bot token، private key، Google API key، AWS key و Slack token در فایل‌های فعلی و تاریخچهٔ قابل دسترس Git نتیجه‌ای ندادند. این scan تضمین نبود همهٔ انواع secret نیست.
- [x] `.env.example` فقط نام متغیرها را دارد. `.gitignore` `.env`، credential folders و انواع رایج فایل service-account را نادیده می‌گیرد.
- [x] اسکریپت `npm test` و workflow برای push/PR به این branch/task افزوده شده‌اند (اجرای workflow پس از push به GitHub نیاز دارد).

## نیازمند تأیید مالک یا محیط استقرار

- [ ] وجود و مقدار `TELEGRAM_WEBHOOK_SECRET` در Render؛ مقدار آن باید با secret استفاده‌شده هنگام ثبت Telegram webhook برابر باشد. مقدار را در Git/گزارش منتشر نکنید.
- [ ] مالک قبلاً گزارش کرده اصلاح `setTelegramWebhookRender()` مشکل 403 را برطرف کرده و ربات پاسخ داده است؛ کد Apps Script و وضعیت زنده در این بررسی در دسترس نبود و این گزارش مستقل تأیید نشد.
- [ ] تأمین امن service-account JSON و grant دسترسی Sheets برای حساب Google محیط مقصد؛ این فایل خارج مخزن است و در این ممیزی باز یا نمایش داده نشد.
- [ ] سورس و قرارداد token میان ربات اصلی و ربات دانلود؛ پروژهٔ مقصد در این مخزن نیست.
- [x] PR [شمارهٔ ۱](https://github.com/VanArya/oxiw-telegram-bot/pull/1) با مقصد `main` باز است و شاخهٔ `codex/oxiw-independent-dev` را به آن پیشنهاد می‌کند؛ این وضعیت از GitHub بررسی شد.
- [x] وضعیت PR در GitHub `mergeable=true` است؛ هنگام بررسی، امکان ادغام بدون conflict گزارش شد. PR ادغام نشده است.
- [x] جدیدترین بررسی PR در GitHub Actions، run شمارهٔ `39439649686` برای commit `3dfa437977f8672644c36bae89672bb17acc9392`، با نتیجهٔ `success` تمام شد. هر چهار job (`test (18)`, `test (20)`, `test (22)`, `test (24)`) و گام اجرای تست موفق بودند.
- [ ] endpointهای `/setup-webhook` و `/test-download` در این checkout پیدا نشدند. اگر در سرویس زنده یا Apps Script وجود دارند، محافظت آن‌ها باید در همان سورس/محیط جداگانه بررسی شود.

## باقی‌مانده برای انتقال مستقل کامل

- [ ] مالک secrets و فایل credential را در Render/محیط امن تأیید کند؛ Codex نباید مقادیر را بخواند یا تغییر دهد.
- [x] push شاخه و ساخت PR شمارهٔ ۱ تأیید شدند؛ ادغام هنوز انجام نشده است.
- [ ] سورس Apps Script و ربات دانلود در مخزن/محیط قابل دسترسی قرار گیرد یا مالک اجازهٔ دسترسی جداگانه بدهد.
- [x] CI مربوط به PR شمارهٔ ۱ در run ثبت‌شدهٔ بالا موفق شد. هر push جدید، run تازه‌ای ایجاد می‌کند و باید نتیجهٔ آن جداگانه بررسی شود.
- [ ] هر پرداخت، دادهٔ کاربران یا وب‌هوک عملیاتی فقط با مجوز صریح و برنامهٔ برگشت‌پذیر بررسی شود؛ آزمون‌های این checkout دادهٔ واقعی را تغییر نمی‌دهند.
