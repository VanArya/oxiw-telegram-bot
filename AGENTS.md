# دستورالعمل Codex برای OXIW Main Bot

## پیش از کار

- پیش از هر تغییر، `git status --short --branch`، شاخه و HEAD را بررسی کن. تغییرهای موجود کاربر را حفظ کن و فقط فایل‌های مرتبط را ویرایش کن.
- تغییرات را روی شاخهٔ کاری جدا انجام بده؛ `main` را بازنویسی یا force-push نکن.
- ابتدا کد واقعی را بررسی کن. موارد بیرون مخزن (Render، Google Apps Script، ربات دانلود، credentialها) را تأییدشده فرض نکن.

## امنیت و داده‌ها

- secretها و credentialها را از فایل‌ها، environment، log، خطای ابزار و diff چاپ یا وارد مستندات/تست‌ها نکن. در گزارش فقط نام متغیرها و وضعیت حضور را در صورت نیاز بنویس.
- هرگز به Telegram/Google Sheets با دادهٔ واقعی، پرداخت واقعی، یا کاربر واقعی درخواست آزمایشی نفرست. از mock استفاده کن.
- وب‌هوک فقط با `TELEGRAM_WEBHOOK_SECRET` معتبر باید به parser و handler برسد. نبود secret در production باید fail-closed بماند؛ برای فعال‌سازی عملیاتی، وجود secret میزبان باید خارج از Git توسط مالک تأیید شود.
- لاگ‌ها باید پالایش‌شده و حداقلی باشند؛ Update کامل، file id، URL دارای token، token ربات، پاسخ کامل API، رکورد Sheets و اشیای خام خطا را log نکن.
- قبل از افزودن/ویرایش routeهای مدیریتی یا آزمایشی، دسترسی، احراز هویت و غیرفعال‌سازی در محیط عمومی را بررسی کن.

## تست و اجرا

- آزمون‌ها: `npm test` یا `node --test`؛ unit: `node --test test/security.unit.test.js`; Express integration: `node --test test/webhook-security.test.js`.
- قبل از اجرای آزمون، سورس را بررسی کن تا مطمئن شوی فقط mock/localhost استفاده می‌شود. اگر test مسیر واقعی Telegram، Google Sheets، credential یا برنامهٔ `index.js` را اجرا می‌کند، متوقف شو و گزارش بده.
- اجرای `npm start`, `node index.js`, deploy و tunnel کردن server می‌تواند سرویس بیرونی را تغییر دهد یا به آن متصل شود؛ بدون مجوز صریح و بررسی اثر اجرا نکن.
- پیش از افزودن وابستگی، lockfile و `node_modules` محلی را بررسی کن. بدون نیاز و اجازه، نصب شبکه‌ای انجام نده.
- پس از هر مرحله `git diff --check` و diff مربوط را بازبینی کن؛ تست مرتبط را اجرا و خروجی واقعی را گزارش کن.

## تغییرات، Git و تحویل

- secrets، فایل‌های `.env`، credential JSON، `node_modules` و خروجی build نباید stage شوند. قبل از commit، staged diff و فهرست فایل‌ها را بازبینی کن.
- commit/push/PR/deploy فقط در محدودهٔ مجوز صریح همان کار انجام شود. هیچ force push یا تغییر مستقیم `main` انجام نده.
- اگر دسترسی به GitHub یا محیط عملیاتی موجود نیست، کد و بررسی محلی را کامل کن و مانع واقعی را دقیق گزارش بده؛ برای دورزدن دسترسی تلاش نکن.
- گزارش فارسی و روشن بده: فایل‌های تغییرکرده، منطق، تست/فرمان‌های اجراشده و نتیجه، وضعیت شاخه/Git، محدودیت‌ها و اقدام لازم از مالک.

## نقاط ورود و وابستگی‌های این مخزن

- برنامه: `index.js`; middlewareهای وب‌هوک و log پالایش‌شده: `security.js`.
- آزمون‌ها در `test/`؛ `test/webhook-security.test.js` فقط localhost و mock دارد.
- نام‌های محیطی: `PORT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS`. مقادیر را در مخزن قرار نده.
- معماری و محدودیت‌ها: `OXIW_ARCHITECTURE.md`; وضعیت انتقال: `OXIW_MIGRATION_CHECKLIST.md`; پیکربندی secret وب‌هوک: `SECURITY_ROLLOUT.md`.
