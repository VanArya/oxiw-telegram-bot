# معماری OXIW Main Bot

## دامنه و فایل‌های اصلی

این مخزن، برنامهٔ اصلی Node.js/Express را در `index.js` نگه می‌دارد. قواعد احراز هویت وب‌هوک و ثبت امن خطا و پاسخ Telegram در `security.js` قرار دارد. `package.json` و `package-lock.json` وابستگی‌ها و فرمان‌ها را تعریف می‌کنند.

در این checkout فایل `TelegramBot.gs`، سورس ربات دانلود، و endpointهای `/setup-webhook` یا `/test-download` وجود ندارد. بنابراین پیاده‌سازی Apps Script و تنظیمات Render از این مخزن قابل تأیید نیستند. گزارش مالک مبنی بر اینکه ثبت وب‌هوک از Apps Script انجام می‌شود، اطلاعات بیرون از مخزن است.

## راه‌اندازی و درخواست HTTP

1. `index.js` Express را می‌سازد و متغیرهای محیطی را می‌خواند.
2. `GET /` فقط پاسخ health ساده می‌دهد.
3. `registerTelegramWebhook` از `security.js` در انتهای راه‌اندازی route ثبت می‌کند. middleware عمومی آن، فقط برای `POST /telegram` (با slash انتهایی اختیاری) هدر `X-Telegram-Bot-Api-Secret-Token` را پیش از `express.json()` بررسی می‌کند.
4. نبود `TELEGRAM_WEBHOOK_SECRET` با `503` و نبود/عدم تطابق هدر با `403` رد می‌شود. مقایسه برای طول‌های برابر با `crypto.timingSafeEqual` است. درخواست‌های دیگر از این بررسی عبور می‌کنند و سپس JSON parser به آن‌ها اعمال می‌شود.
5. پس از احراز هویت و parse موفق JSON، handler وب‌هوک بلافاصله پاسخ `200 OK` می‌دهد و سپس `callback_query` یا `message` را به پردازشگر متناظر می‌فرستد. خطای پردازش بعد از پاسخ HTTP فقط به شکل پالایش‌شده log می‌شود؛ Telegram ممکن است از پاسخ موفق مطلع شده باشد، حتی اگر عملیات داخلی بعداً شکست بخورد.

ثبت secret در Render و ارسال همان مقدار هنگام ثبت وب‌هوک Telegram، شرط پردازش update است. کد محلی fail-closed است: بدون secret برنامه می‌تواند بالا بیاید، ولی هیچ update وب‌هوکی پذیرفته نمی‌شود.

## ارتباط‌های بیرونی

- **Telegram Bot API:** تابع‌های ارسال پیام و تصویر با `TELEGRAM_BOT_TOKEN` درخواست می‌فرستند. پاسخ‌های API از `logTelegramApiResult` می‌گذرند که فقط وضعیت `ok` و کد خطای عددی را ثبت می‌کند.
- **Google Sheets API:** `getGoogleSheets()` از `googleapis` و فایل JSON حساب سرویس استفاده می‌کند. مسیر فایل از `GOOGLE_APPLICATION_CREDENTIALS` می‌آید؛ در صورت نبود مقدار، مسیر میزبانی `/etc/secrets/google-service-account.json` استفاده می‌شود. شناسهٔ Sheet در کد ثابت است و در این سند تکرار نمی‌شود.
- **ربات دانلود:** ربات اصلی token دانلود می‌سازد، در Sheets نگه می‌دارد و لینک deep-link تلگرام را به کاربر می‌دهد. سورس ربات مقصد در این مخزن نیست؛ اعتبارسنجی و مصرف token در آن قابل ممیزی نیست.
- **Google Apps Script و Render:** هیچ فایل یا دسترسی پیکربندی deployment در این مخزن وجود ندارد. تطبیق secret بین Script Properties، Telegram webhook و Render باید توسط مالک در محیط‌های مربوط بررسی شود؛ این پروژه آن تنظیمات را تغییر نمی‌دهد.

## جریان‌های داده و پرداخت

- فهرست فیلم و سریال از Sheets خوانده می‌شود؛ اطلاعات بازدید، wallet و token دانلود نیز در Sheets خوانده/ثبت می‌شوند.
- درخواست خرید token ثبت می‌شود. تصویر رسید کاربر به شکل شناسهٔ فایل Telegram در ردیف درخواست ذخیره می‌شود و مدیر از callbackهای درون پیام Telegram آن را تأیید یا رد می‌کند.
- تأیید پرداخت، تغییر موجودی کیف پول، append تراکنش و تغییر وضعیت درخواست را در چند درخواست جداگانهٔ Sheets انجام می‌دهد. این عملیات در کد تراکنش اتمیک/قفل مشترک ندارد؛ خطا یا اجرای هم‌زمان می‌تواند به وضعیت نیازمند بررسی دستی منجر شود. این سند فقط رفتار موجود را ثبت می‌کند.
- رد پرداخت وضعیت درخواست را تغییر می‌دهد و برای مدیر و کاربر پیام می‌فرستد.
- وضعیت مکالمه در حافظهٔ فرایند نگه‌داری می‌شود؛ restart برنامه آن state حافظه‌ای را از بین می‌برد.

## تنظیمات و داده‌های حساس

نام‌های محیطی خوانده‌شده از کد: `PORT`، `TELEGRAM_BOT_TOKEN`، `TELEGRAM_WEBHOOK_SECRET` و `GOOGLE_APPLICATION_CREDENTIALS`. `.env.example` فقط نام‌ها را فهرست می‌کند و برنامه `.env` را خودکار بارگذاری نمی‌کند. هیچ مقدار secret در مستندات قرار ندهید.

`.gitignore` فایل‌های `.env*` (به‌جز `.env.example`)، پوشه‌های اعتبارنامه و فایل‌های رایج service-account/credential را کنار می‌گذارد. credential را بیرون از مخزن نگه دارید و پیش از stage کردن، `git status` و staged diff را بررسی کنید.

## توسعه و آزمون

- نصب تکرارپذیر وابستگی‌ها: `npm ci` (نیازمند registry فقط در زمان نصب).
- همهٔ آزمون‌ها: `npm test` یا `node --test`.
- unit بدون Express: `node --test test/security.unit.test.js`.
- integration محلی Express: `node --test test/webhook-security.test.js`; listener فقط به `127.0.0.1` وصل می‌شود و handler واقعی برنامه را بارگذاری نمی‌کند.
- `npm start` یا اجرای `index.js` آزمون محسوب نمی‌شود و ممکن است به Telegram و Google Sheets متصل شود؛ برای بررسی امن از mockهای آزمون استفاده کنید.
