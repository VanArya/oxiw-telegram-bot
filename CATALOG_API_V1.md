# Catalog API v1 — قرارداد پیشنهادی

وضعیت: نمونهٔ محلی خواندنی پیاده‌سازی شده؛ منبع داده fixture است و API منتشر نشده است.
دامنه: خواندن کاتالوگ و دسته‌بندی‌های عمومی

## قواعد قرارداد

- Base path: /api/v1
- فرمت: JSON با UTF-8
- شناسه‌ها پایدارند و به شمارهٔ ردیف Sheet وابسته نیستند.
- فهرست‌های عمومی فقط محتوای منتشرشده را برمی‌گردانند.
- کشور سازنده با شناسه‌های taxonomy پایدار فیلتر می‌شود؛ ردیف فاقد کشور یا دارای مقدار نامعتبر در دستهٔ کشورمحور قرار نمی‌گیرد.
- فیلترها فقط روی فیلدهای مجاز اجرا می‌شوند؛ ورودی به‌عنوان کد یا expression ارزیابی نمی‌شود.
- DSL دسته‌بندی حداکثر ۸ سطح عمق و حداکثر ۳۲ شرط برای هر `all` یا `any` می‌پذیرد.
- فایل، Telegram file_id، token دانلود و شناسهٔ محرمانه در پاسخ کاتالوگ قرار نمی‌گیرند.
- هیچ endpoint تغییردهنده در نمونهٔ فعلی پیاده‌سازی نمی‌شود.

## قرارداد endpointها

### GET /api/v1/catalog/items

فهرست و فیلتر محتوا.

پارامترها:

| نام | نوع | معنا |
|---|---|---|
| kind | enum اختیاری | movie یا series |
| countryId | رشتهٔ taxonomy اختیاری | فیلتر کشور سازنده |
| genreId | رشتهٔ اختیاری | فعلاً رد می‌شود؛ mapper ژانر را به مدل دامنه نگاشت نمی‌کند |
| q | رشتهٔ اختیاری | فعلاً رد می‌شود؛ جست‌وجوی عنوان و نرمال‌سازی فارسی پیاده‌سازی نشده |
| year | عدد چهاررقمی اختیاری | تطبیق دقیق با `releaseYear`؛ فقط برای فیلم سینمایی |
| page | عدد صحیح مثبت، پیش‌فرض 1 | شمارهٔ صفحه |
| pageSize | عدد صحیح 1 تا 100، پیش‌فرض 20 | اندازهٔ صفحه |

پاسخ پیشنهادی:

- data: آرایه‌ای از خلاصهٔ Content
- meta: page، pageSize، total، filtersApplied

### GET /api/v1/catalog/items/{contentId}

جزئیات یک محتوای منتشرشده. برای series می‌تواند فصل‌ها و فهرست episodeها را برگرداند. مرجع خصوصی فایل و اطلاعات دانلود بازگردانده نمی‌شود.

### GET /api/v1/catalog/categories

فهرست CategoryDefinitionهای فعال و داده‌محور.

هر دسته شامل id، slug، localizedTitle، sortOrder و یک تعریف فیلتر محدود است. کلاینت‌ها عنوان و فهرست دسته را از این endpoint می‌گیرند؛ نام دسته در شرط ثابت هر رابط قرار نمی‌گیرد.

### GET /api/v1/catalog/taxonomies

taxonomyهای نمونه را برمی‌گرداند. `IR` و `US` در کد فعلی فقط fixtureهای محدود هستند، نه فهرست production. در معماری نهایی کشور و category definitions از منبع metadata جداگانه و از طریق interface مستقل خوانده می‌شوند؛ ژانر تا زمان نگاشت صریح آماده نیست.

### قالب پاسخ و خطا

موفق:

- data: نتیجه
- meta: صفحه‌بندی یا اطلاعات تکمیلی، در صورت نیاز

ناموفق:

- error.code: کد پایدار مانند INVALID_FILTER یا NOT_FOUND
- error.message: پیام غیرمحرمانه
- error.requestId: شناسهٔ رخداد تصادفی، بدون اطلاعات شخصی یا secret

کدهای خطای نمونهٔ محلی شامل `INVALID_FILTER`، `FILTER_NOT_READY`، `INVALID_PAGINATION`، `NOT_FOUND` و `INTERNAL_ERROR` هستند. خطای داخلی به پیام عمومی تبدیل می‌شود و stack یا جزئیات provider برگردانده نمی‌شود.

## DSL فیلتر دسته

نمونهٔ ساختاری، نه دادهٔ فعلی Sheet:

    {
      "all": [
        { "field": "kind", "op": "eq", "value": "movie" },
        { "field": "countryIds", "op": "contains", "value": "IR" }
      ]
    }

دستهٔ «فیلم سینمایی ایرانی» با kind برابر movie و countryIds شامل IR تعریف می‌شود. دستهٔ «سریال ایرانی» همان فیلتر کشور را با kind برابر series به کار می‌برد. این‌ها رکوردهای دسته‌اند، نه شرط‌های اختصاصی در رابط‌ها.

فیلدهای DSL در نمونهٔ Core محدود به kind، countryIds، genreIds، status و releaseYear هستند. هر گسترش DSL باید با schema، تست و بازبینی انجام شود. ورودی دلخواه، property path دلخواه، regex یا کد اجرایی پذیرفته نمی‌شود.

## مدل‌های پاسخ پیشنهادی

### ContentSummary

- id
- kind
- title
- originCountryIds
- countries: شناسه و label فارسی از taxonomy فعال؛ فقط برای شناسه‌های معتبر
- genreIds
- releaseYear، فقط پس از تأیید نگاشت
- posterAssetId یا URL عمومی کنترل‌شده، فقط پس از تعریف سیاست asset
- status در API عمومی فقط published است

در schema فعلی شیت‌های «سینمایی» و «سریال» ستون کشور یا وضعیت انتشار ارائه نشده است و این شیت‌ها تغییر نمی‌کنند. کشور، category definitions و visibility آینده از metadata store جداگانه با کلید Content ID می‌آیند. هیچ وضعیت قدیمی حدس زده نمی‌شود؛ تا وقتی رفتار عمومی سرویس فعلی با شواهد read-only تأیید و parity خروجی بررسی نشده، API جدید جایگزین آن نمی‌شود. DTO نمونه فقط محتوای دارای وضعیت صریح `published` را می‌پذیرد.

### ContentDetail

همهٔ فیلدهای خلاصه به‌علاوهٔ synopsis، localizedTitles و ساختار سریال/قسمت؛ وجود و نگاشت این فیلدها در Sheet واقعی هنوز تأیید نشده است.

### CategoryDefinition

- id
- slug
- localizedTitle
- filters
- enabled
- sortOrder

### TaxonomyTerm

- id
- type
- localizedLabels
- enabled
- sortOrder

## احراز هویت و ایمنی

- خواندن کاتالوگ عمومی می‌تواند anonymous باشد، مشروط به اینکه پاسخ فقط دادهٔ مجاز و منتشرشده داشته باشد.
- نوشتن محتوا، مدیریت taxonomies، عملیات کاربر و صدور مجوز دانلود باید احراز هویت و مجوزدهی جداگانه داشته باشند؛ در این مرحله endpoint نوشتن طراحی اجرایی نشده است.
- در log نباید token، Telegram payload کامل، credential یا دادهٔ شخصی ثبت شود.
- Web App فعلی Apps Script در manifest دسترسی anonymous دارد؛ این وضعیت به‌تنهایی برای endpointهای تغییردهنده مجوز کافی نیست.

## پیاده‌سازی آزمایشی محلی

`createCatalogApi({ provider, categories })` یک Express app محلی می‌سازد و provider را به adapter موجود تزریق می‌کند. قرارداد provider همان `readSheet(sheetName) -> Promise<{ headers, rows }>` است. API از mapper و Core موجود استفاده می‌کند و fixture provider فقط دادهٔ ساختگی می‌خواند؛ اتصال Google Sheets پیاده‌سازی نشده است. ردیف خام، Telegram File ID، token و خطای provider وارد پاسخ نمی‌شوند. تا زمانی که وضعیت انتشار صریح و معتبر نباشد، DTO عمومی ساخته نمی‌شود.

endpointهای اجراشده در نمونه: `GET /api/v1/catalog/items`, `GET /api/v1/catalog/items/{id}`, `GET /api/v1/catalog/categories` و `GET /api/v1/catalog/taxonomies`. مسیرهای نوشتن و دانلود تعریف نشده‌اند. `genreId` و `q` در حال حاضر با `FILTER_NOT_READY` رد می‌شوند.

### منبع فرادادهٔ آینده

قرارداد پیشنهادی و مستقل از storage:

```text
CatalogMetadataProvider
  getContentMetadata(contentId) -> { countryIds?, genreIds?, visibility } | null
  listTaxonomyTerms(type) -> TaxonomyTerm[]
  listCategories() -> CategoryDefinition[]
```

نمونهٔ محلی هنوز این interface را به API متصل نکرده است. در staging آینده، metadata بر اساس شناسهٔ پایدار محتوا روی رکوردهای Google Sheets اعمال می‌شود. `visibility=approved` می‌تواند پس از اعتبارسنجی به `published` نگاشت شود؛ `unknown` و `hidden` عمومی نیستند. برای جلوگیری از پنهان‌شدن ناخواستهٔ محتوای جاری، تعویض consumer تا تأیید رفتار فعلی و تطبیق مجموعهٔ شناسه‌های public متوقف می‌ماند.

## سازگاری و نسخه‌بندی

- تغییر ناسازگار در پاسخ یا فیلترها مسیر نسخهٔ جدید API می‌خواهد.
- افزودن فیلد اختیاری تا وقتی معنی و nullability آن مشخص باشد می‌تواند در v1 سازگار بماند.
- تغییر schema منبع داده نباید بی‌اعلان، شکل پاسخ v1 را عوض کند.
- مصرف‌کنندگان: سایت Apps Script، Android WebView/کلاینت آینده، ربات اصلی و در صورت نیاز ربات دانلود.
