# راه‌اندازی پنل مدیریت Catalog

## معماری

- `/admin/` فایل‌های استاتیک همین پوشه را سرو می‌کند؛ فایل‌های dot و دو فایل legacy پیکربندی Firebase از طریق static قابل دریافت نیستند. `/admin/config.json` endpoint عمومی فقط‌خواندنی است و تنها پنج مقدار عمومی Web App را از محیط runtime برمی‌گرداند.
- پیکربندی وب از `CATALOG_FIREBASE_WEB_API_KEY`, `CATALOG_FIREBASE_WEB_AUTH_DOMAIN`, `CATALOG_FIREBASE_WEB_PROJECT_ID`, `CATALOG_FIREBASE_WEB_MESSAGING_SENDER_ID`, `CATALOG_FIREBASE_WEB_APP_ID` خوانده می‌شود. همه باید حاضر باشند و project ID وب دقیقاً با `CATALOG_GCP_PROJECT_ID` برابر باشد. پیکربندی ناقص یا ناهمسان با پاسخ 503 به صفحه گزارش می‌شود.
- Google Sign-In از Firebase Web SDK موجود در صفحه استفاده می‌کند. Firebase ID Token فقط در header درخواست same-origin به backend می‌رود. verifier موجود Firebase Admin سمت سرور اعتبار و revoked بودن توکن را بررسی می‌کند؛ role از provider سمت سرور می‌آید.
- هیچ endpoint مدیریتی به‌صورت ناشناس در دسترس نیست. `GET /api/v1/admin/catalog/me`, فهرست مدیریتی محتوا و Audit همگی پشت همان authentication و permission `catalog.admin.read` هستند. مسیرهای write فعلی و کنترل‌های ETag/permission در backend مرجع نهایی‌اند.

## قابلیت‌های پنل

- نمای کلی شاخص‌های کل، فیلم، سریال، pending، approved، published، draft و فاقد metadata را از فهرست واقعی API دریافت می‌کند.
- فهرست مدیریتی، تمام ردیف‌های دو Sheet را می‌خواند، status/metadata متناظر را join می‌کند و با عنوان یا کد سیستم جست‌وجو، فیلتر نوع/status و صفحه‌بندی ارائه می‌دهد. DTO مدیریتی فیلدهای محدود دارد و Telegram File ID/رکورد خام را خارج می‌گذارد. اطلاعات اصلی Sheet در پنل فقط‌خواندنی‌اند.
- ایجاد metadata با `pending`/`draft` و ویرایش country/genre با PUT و پیش‌شرط `If-None-Match: *` یا `If-Match` انجام می‌شود. تأیید و رد فقط با permission تأیید و endpoint مستقل؛ انتشار، بازگشت به draft و بایگانی فقط با permission انتشار انجام می‌شوند. backend انتشار محتوای تأییدنشده را رد می‌کند.
- taxonomy کشور/ژانر و دسته‌ها از مسیرهای فعلی مدیریت می‌شوند. حذف نداریم؛ غیرفعال‌سازی از طریق `enabled=false` است و محدودیت backend برای term مورد استفاده حفظ می‌شود. فیلترساز ساده شرط‌های مجاز DSL را تولید می‌کند؛ فیلتر پیچیده فقط با JSON قابل parse ارسال می‌شود و backend آن را اعتبارسنجی می‌کند.
- Audit فقط collection و schema رویدادهای کاتالوگ را می‌خواند؛ رویدادهای role در آن مخلوط نمی‌شوند. پاسخ فقط فیلدهای allowlist‌شده و صفحه‌بندی محدود دارد.

## پیکربندی میزبان

1. Firebase Web config را از Firebase Console در تنظیمات runtime سرویس Catalog وارد کنید؛ آن را در Git یا credential فایل قرار ندهید.
2. `CATALOG_FIREBASE_WEB_PROJECT_ID` را با `CATALOG_GCP_PROJECT_ID` تطبیق دهید.
3. hostname واقعی سرویس را در Firebase Authentication Authorized domains ثبت کنید.
4. سرویس مستقل Catalog باید با فرمان موجود `npm run catalog:start` اجرا شود. `npm start` برای Main Bot می‌ماند.
5. سرویس را در `/admin/` و health routeهای موجود بررسی کنید. در این تغییر deploy یا بررسی Render انجام نشده است.

## مانع مدیر نخستین

ورود Firebase هرگز assignment مدیر تولید نمی‌کند. پنل تنها roleهای فعال و معتبر provider را نشان می‌دهد. Bootstrap CLI همچنان fail-closed است تا منشأ قابل‌اعتماد actor، approval مستقل owner و approver، schema نهایی assignment/control، migration و audit آن‌ها تصویب و در محیط محدودشده اجرا شوند. هیچ email/UID، ورودی UI، متغیر محیط یا argument به‌عنوان مدرک مدیرسازی پذیرفته نمی‌شود.

## محدودیت عملیاتی

تست‌ها با fakeها هستند. پیش از بهره‌برداری، مالک باید تنظیم Render/شاخه و فرمان start، همهٔ متغیرها، project/database و ADC/IAM، Firebase Authorized domains، assignmentهای واقعی role، rules/backend-only access، readiness، backup/rollback و دسترسی audit را بررسی کند. هیچ دادهٔ live یا تنظیم میزبان در این مرحله تأیید نشده است.
