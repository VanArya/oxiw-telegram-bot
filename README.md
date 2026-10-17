# OXIW Telegram Bot — local setup

## پیش‌نیازها و وابستگی‌ها

- Node.js حداقل ۱۸؛ محیط قابل‌حمل محلی Node.js `24.22.0` است.
- وابستگی‌های manifest: Express و `googleapis`؛ در محیط مستقل `C:\Users\neo\Tools\oxiw-main-bot-env` نصب شده‌اند (Express `4.22.3`، Google APIs `144.0.0`). lockfile و `node_modules` این محیط بیرون مخزن قرار دارند.
- `index.js` برنامه را اجرا می‌کند و `security.js` middleware وب‌هوک را فراهم می‌کند.

## Configuration names

The process reads `PORT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and
`GOOGLE_APPLICATION_CREDENTIALS`.
`PORT` has a source-defined default. The webhook secret must match the value used
when registering the Telegram webhook. `.env.example` lists variable names only;
the application does not load `.env` automatically, so supply values through the
process environment or the hosting environment.

کد به فایل JSON حساب سرویس Google نیاز دارد. مسیر آن از `GOOGLE_APPLICATION_CREDENTIALS`
خوانده می‌شود؛ اگر متغیر تنظیم نشده باشد، پیش‌فرض میزبانی
`/etc/secrets/google-service-account.json` استفاده می‌شود. اگر فایل در مسیر انتخاب‌شده
وجود نداشته باشد، برنامه خطای روشن و بدون نمایش مسیر می‌دهد. شناسهٔ Sheets همچنان از
مقدار ثابت داخل کد می‌آید، نه از environment. فایل اعتبارنامه را بیرون از مخزن نگه دارید
و مسیر خصوصی یا محتوای آن را در Git یا این راهنما قرار ندهید.

## بررسی تنظیمات بدون نمایش مقدارها

در PowerShell، فقط وجود متغیرها را بررسی کنید:

```powershell
@('PORT','TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET','GOOGLE_APPLICATION_CREDENTIALS') | ForEach-Object {
  [pscustomobject]@{ Name = $_; Present = [bool][Environment]::GetEnvironmentVariable($_) }
}
```

وجود فایل JSON را با بررسی محلی `Test-Path` روی مقدار تنظیم‌شده بسنجید، اما خود مسیر
را در گزارش یا Git چاپ نکنید. `.env.example` فقط قالب است و برنامه فایل `.env` را
خودکار بارگذاری نمی‌کند.

## راه‌اندازی محلی

پس از تأمین امن تنظیمات و اعتبارنامه، وابستگی‌ها از محیط مستقل با `NODE_PATH` موقت
قابل دسترسی‌اند:

```powershell
$env:NODE_PATH = 'C:\Users\neo\Tools\oxiw-main-bot-env\node_modules'
& 'C:\Users\neo\Tools\node-v24.22.0\node.exe' 'C:\Users\neo\Desktop\Codex\oxiw-main-bot-git-backup-2026-10-15\index.js'
Remove-Item Env:NODE_PATH
```

این فرمان سرور ربات را اجرا می‌کند و با رسیدن درخواست‌ها ممکن است به Telegram یا Google
دسترسی پیدا کند؛ فقط در زمان مجاز اجرا شود. برای اتصال واقعی، مالک باید secret میزبان
و secret ثبت‌شده برای Telegram را با هم تطبیق دهد. این README هیچ تنظیم آنلاین را
تأیید یا تغییر نمی‌دهد.
