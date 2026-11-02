# مهاجرت امن نسخهٔ Metadata در Firestore

## تشخیص

Provider نوشتنی فعلی همیشه `_version` را به‌صورت عدد صحیح امن و حداقل `1`، داخل transaction و همراه audit می‌نویسد. خواندن نسخه‌دار نیز هر سندی را که این شرط را نداشته باشد رد می‌کند. بنابراین سند قدیمی، write خارج از provider یا مهاجرت ناقص می‌تواند کل فهرست مدیریتی را fail-closed کند؛ سند خراب نادیده گرفته نمی‌شود.

## اجرای امن

اسکریپت `scripts/migrate-firestore-metadata-versions.js` به‌طور پیش‌فرض dry-run است. بدون `--apply` هیچ write، transaction یا audit انجام نمی‌دهد. خروجی فقط summary است و محتوای سند، شناسهٔ خصوصی، token و credential را چاپ نمی‌کند.

پیش‌نیازها:

- بررسی read-only پروژه و database توسط مالک؛
- ADC/IAM محدود و خارج از Git؛
- backup یا نقطهٔ بازگشت مورد تأیید؛
- تطبیق تعداد و نوع خرابی با خروجی dry-run؛
- تعیین actor معتبر و قابل ممیزی توسط فرایند سازمانی. متغیر محیطی صرفاً حامل این تصمیم است و به‌تنهایی هویت انسانی را اثبات نمی‌کند.

اجرای dry-run:

```text
npm run catalog:migrate-metadata-versions
```

اجرای apply فقط پس از تأیید مستقل مالک و ثبت actor معتبر:

```text
CATALOG_MIGRATION_TRUSTED_ACTOR_ID=<approved-actor> CATALOG_MIGRATION_CONFIRM=REPAIR_INVALID_METADATA_VERSIONS npm run catalog:migrate-metadata-versions -- --apply
```

اسکریپت فقط اسنادی را اصلاح می‌کند که `_version` نامعتبر دارند و metadata کسب‌وکاری آن‌ها با قرارداد فعلی معتبر است. نسخه به `1` تنظیم می‌شود و تمام فیلدهای دیگر با spread کامل حفظ می‌شوند. اسناد دارای metadata کسب‌وکاری نامعتبر فقط گزارش و رد می‌شوند تا تصمیم migration جداگانه گرفته شود. هر repair و audit آن atomic است و اجرای دوبارهٔ آن سند سالم را تغییر نمی‌دهد.

## بازگشت و محدودیت

قبل از apply، backup قابل بازگردانی لازم است؛ rollback کد به‌تنهایی نسخهٔ داده را برنمی‌گرداند. اگر `_version` قدیمی مقدار عددی نامعتبر اما معناداری داشته باشد، این ابزار آن را حدس نمی‌زند. چنین اسنادی باید با تصمیم مالک و migration اختصاصی بررسی شوند. پس از repair، فهرست پنل باید با یک درخواست read-only و audit آن با reader جداگانه تأیید شود.
