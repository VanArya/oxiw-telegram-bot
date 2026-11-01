# پنل مدیریت OXIW Catalog

`admin-web` رابط فارسی و RTL پنل Catalog Core است. رابط فقط از same-origin API درخواست می‌فرستد؛ Firebase Web SDK صرفاً برای Google Sign-In و گرفتن Firebase ID Token به‌کار می‌رود. role و permission فقط از `GET /api/v1/admin/catalog/me` پس از بررسی سرور دریافت می‌شوند.

## پیکربندی محیط

پنل Firebase Web را از `/admin/config.json` دریافت می‌کند. این endpoint فقط همین پنج مقدار عمومی Web App را برمی‌گرداند و اگر هرکدام خالی باشد یا project ID با `CATALOG_GCP_PROJECT_ID` برابر نباشد، با 503 fail-closed می‌شود:

- `CATALOG_FIREBASE_WEB_API_KEY`
- `CATALOG_FIREBASE_WEB_AUTH_DOMAIN`
- `CATALOG_FIREBASE_WEB_PROJECT_ID`
- `CATALOG_FIREBASE_WEB_MESSAGING_SENDER_ID`
- `CATALOG_FIREBASE_WEB_APP_ID`

این مقادیر را در Firebase Console از `Project settings → Your apps → Web app → SDK setup and configuration → Config` بردارید. این‌ها شناسه و پیکربندی عمومی Web App هستند و جای credential سرور نیستند. هرگز `GOOGLE_APPLICATION_CREDENTIALS`، JSON حساب سرویس یا کلید خصوصی را در UI/وب قرار ندهید. فایل legacy `firebase-config.js` پیکربندی ندارد و از مسیر static قابل دریافت نیست.

در Firebase Console، روش `Google` را در Authentication فعال و hostname واقعی سرویس (برای نمونه hostname اختصاص‌یافتهٔ Render) را در `Authentication → Settings → Authorized domains` ثبت کنید. نام hostname را از تنظیم خود سرویس بردارید؛ این مخزن آن را حدس نمی‌زند.

## اجرای Catalog

در محیط دارای Node مطابق `package.json` و تنظیم ADC/runtime، سرویس جداگانه با `npm run catalog:start` اجرا می‌شود. پنل در `/admin/` قرار دارد؛ `/admin` به آن هدایت می‌شود. `npm start` همچنان فرمان Main Bot است.

متغیرهای ADC، پروژه، Firestore و Spreadsheet موجود در `.env.example` نیز برای runtime لازم‌اند. پنل از API همان origin استفاده می‌کند و CORS عمومی اضافه نشده است. تنظیمات Render یا Firebase واقعی اینجا بررسی یا تغییر داده نشده‌اند.

## رفتار و مجوزها

- ورود با Google هویت حساب Firebase را احراز می‌کند؛ به‌تنهایی نقش مدیریتی ایجاد نمی‌کند.
- توکن از Firebase SDK برای هر درخواست گرفته و فقط در `Authorization: Bearer` ارسال می‌شود؛ برنامه آن را در URL، log، `localStorage` یا `sessionStorage` ذخیره نمی‌کند.
- API فقط assignmentهای سمت سرور را می‌پذیرد و هر عملیات را دوباره با permission مربوط کنترل می‌کند.
- Google Sheets فقط برای فهرست‌کردن/نمایش فیلدهای allowlist‌شده خوانده می‌شود. پنل به Sheets نمی‌نویسد و به Firestore مستقیم متصل نیست.
- محتوای فاقد metadata به‌صورت `unknown` و بدون انتشار نشان داده می‌شود. ایجاد metadata از مقدارهای `pending`/`draft` شروع می‌شود.
- ویرایش، تأیید و انتشار مسیرهای مستقل و versioned دارند. stale ETag به کاربر اعلام می‌شود و عملیات خودکار retry نمی‌شود.
- پنل مدیر نخستین را bootstrap نمی‌کند. ابزار bootstrap فعلی تا تعریف منبع trusted برای actor و تأیید مستقل owner/approver عمداً غیرفعال است؛ بنابراین کاربر بدون assignment پیام نبود دسترسی می‌بیند.
- فهرست Audit فقط رویدادهای metadata، دسته‌ها و taxonomy را می‌خواند؛ audit نقش‌ها در collection و مسیر جدا می‌ماند.

## بررسی

تست‌ها با fake/mock و فقط loopback اجرا می‌شوند؛ اعتبارنامهٔ Firebase، دادهٔ واقعی Sheets/Firestore یا شبکهٔ عملیاتی لازم نیست. پیش از استفاده واقعی، متغیرهای web و runtime، پروژه‌های یکسان، ADC/IAM، assignment مدیران، Authorized domains و مالکیت/rollback سرویس باید توسط مالک بررسی شوند.
