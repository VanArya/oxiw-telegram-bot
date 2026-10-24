# Catalog API v1 — قرارداد پیشنهادی

وضعیت: پیشنهادی، هنوز پیاده‌سازی‌شده یا منتشرشده نیست
دامنه: خواندن کاتالوگ و دسته‌بندی‌های عمومی

## قواعد قرارداد

- Base path: /api/v1
- فرمت: JSON با UTF-8
- شناسه‌ها پایدارند و به شمارهٔ ردیف Sheet وابسته نیستند.
- فهرست‌های عمومی فقط محتوای منتشرشده را برمی‌گردانند.
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
| genreId | رشتهٔ taxonomy اختیاری | فیلتر ژانر |
| q | رشتهٔ اختیاری | جست‌وجوی عنوان در آینده؛ نیازمند تعریف نرمال‌سازی فارسی |
| year | عدد اختیاری | سال انتشار، پس از تأیید منبع |
| page | عدد صحیح مثبت، پیش‌فرض 1 | شمارهٔ صفحه |
| pageSize | عدد صحیح محدود، پیش‌فرض 20 | اندازهٔ صفحه |

پاسخ پیشنهادی:

- data: آرایه‌ای از خلاصهٔ Content
- meta: page، pageSize، total، filtersApplied

### GET /api/v1/catalog/items/{contentId}

جزئیات یک محتوای منتشرشده. برای series می‌تواند فصل‌ها و فهرست episodeها را برگرداند. مرجع خصوصی فایل و اطلاعات دانلود بازگردانده نمی‌شود.

### GET /api/v1/catalog/categories

فهرست CategoryDefinitionهای فعال و داده‌محور.

هر دسته شامل id، slug، localizedTitle، sortOrder و یک تعریف فیلتر محدود است. کلاینت‌ها عنوان و فهرست دسته را از این endpoint می‌گیرند؛ نام دسته در شرط ثابت هر رابط قرار نمی‌گیرد.

### GET /api/v1/taxonomies/{type}

مقادیر مجاز taxonomy برای typeهایی مانند country، genre و tag؛ فقط termهای فعال، با labelهای ترجمه‌شده و sortOrder.

### قالب پاسخ و خطا

موفق:

- data: نتیجه
- meta: صفحه‌بندی یا اطلاعات تکمیلی، در صورت نیاز

ناموفق:

- error.code: کد پایدار مانند INVALID_FILTER یا NOT_FOUND
- error.message: پیام غیرمحرمانه
- error.requestId: شناسهٔ رخداد تصادفی، بدون اطلاعات شخصی یا secret

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
- genreIds
- releaseYear، فقط پس از تأیید نگاشت
- posterAssetId یا URL عمومی کنترل‌شده، فقط پس از تعریف سیاست asset
- status در API عمومی فقط published است

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

## سازگاری و نسخه‌بندی

- تغییر ناسازگار در پاسخ یا فیلترها مسیر نسخهٔ جدید API می‌خواهد.
- افزودن فیلد اختیاری تا وقتی معنی و nullability آن مشخص باشد می‌تواند در v1 سازگار بماند.
- تغییر schema منبع داده نباید بی‌اعلان، شکل پاسخ v1 را عوض کند.
- مصرف‌کنندگان: سایت Apps Script، Android WebView/کلاینت آینده، ربات اصلی و در صورت نیاز ربات دانلود.
