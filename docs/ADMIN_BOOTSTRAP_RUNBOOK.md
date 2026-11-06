# Runbook راه‌اندازی اولیه مدیر Catalog

وضعیت: **ابزار مستقل provisioning؛ بدون endpoint HTTP و بدون فعال‌سازی عملیاتی**.

## سیاست

راه‌اندازی اولین مدیر از مسیر عمومی یا پنل انجام نمی‌شود. مسیر
`POST /api/v1/admin/catalog/bootstrap` عمداً وجود ندارد. Firebase Authentication
فقط برای احراز هویت کاربران عادی پنل است و به‌تنهایی مجوز ساخت نقش مدیر ایجاد
نمی‌کند.

ابزار مستقل `catalog:bootstrap-admin` تنها از طریق `bootstrapAdministrator()` در
Role Provider کار می‌کند. این ابزار تا زمانی که trusted actor مبتنی بر ADC و
Service Account Impersonation و همچنین منبع مستقل تأیید مالک/نفر دوم به آن تزریق
نشوند، fail-closed و غیرقابل‌اجرا است.

## پیش‌نیازهای تصمیم و دسترسی

- تصویب مالک پروژه برای حساب هدف؛
- Service Account اختصاصی provisioning، جدا از حساب runtime، با مجوز موقت و محدود؛
- اثبات هویت مؤثر از ADC impersonation، نه مقدار argv یا environment؛
- تأیید مستقل owner و approver با مرجع قابل ممیزی؛
- تأیید پروژه، دیتابیس، schema پیشنهادی، backup و روش rollback؛
- اجرای ابزار در محیط مورداعتماد و خارج از مسیر عمومی HTTP.

هیچ‌یک از این منابع سازمانی در این مخزن به‌صورت عملیاتی متصل نیستند. بنابراین
وجود کد و تست fake به‌معنای آمادگی اجرای Production نیست.

## اجرای کنترل‌شده پس از تصویب

پس از اتصال و بازبینی منابع trusted، ابزار فقط با تأیید صریح اجرا می‌شود:

```text
npm run catalog:bootstrap-admin -- --target-subject-id <approved-subject> --confirm BOOTSTRAP_FIRST_ADMIN
```

`<approved-subject>` باید از منبع هویتی مورداعتماد بیاید؛ مقدار آزاد CLI مدرک
هویت نیست. ابزار باید پیش از mutation تنظیمات، actor، approval و وضعیت خالی
سیستم را بررسی کند.

عملیات موفق در یک تراکنش مشترک assignment اولیه با نقش `administrator`، control
marker/count و audit event را ثبت می‌کند. وجود هر assignment قبلی، marker نامعتبر
یا شمارندهٔ ناسازگار باید عملیات را متوقف کند.

## بررسی پس از اجرا

فقط از کانال read-only موردتأیید بررسی کنید که:

1. رخداد `bootstrap.completed` ثبت شده است؛
2. assignment هدف فعال و دارای نقش `administrator` است؛
3. شمارندهٔ مدیران فعال با assignmentها سازگار است؛
4. هیچ token، credential یا secret در audit/log ثبت نشده است.

## توقف امن و rollback

- در وضعیت مبهم یا خطای audit، عملیات را تکرار یا marker را دستی reset نکنید.
- ابزار را پس از استفاده غیرفعال و مجوز موقت Service Account را لغو کنید.
- recovery یا rollback فقط با approval مستقل، backup معتبر و runbook جداگانه انجام شود.
- تغییر دستی assignment یا audit در Firestore مجاز نیست.

نام collectionها و schemaهای Role/Audit در ADR همچنان پیشنهادی‌اند و تا تصویب
مالک، قرارداد عملیاتی محسوب نمی‌شوند.
