# Catalog API v1 — قرارداد پیشنهادی

وضعیت: نمونهٔ محلی خواندنی پیاده‌سازی شده؛ منبع داده fixture است و API منتشر نشده است.
دامنه: خواندن کاتالوگ و دسته‌بندی‌های عمومی

## قواعد قرارداد

- Base path: /api/v1
- فرمت: JSON با UTF-8
- شناسهٔ عمومی با قالب `movie:<encoded-systemCode>` یا `series:<encoded-systemCode>` ساخته می‌شود. `systemCode` به رشته تبدیل، Unicode آن به NFC نرمال، trim و با `encodeURIComponent` کدگذاری می‌شود؛ حروف بزرگ/کوچک حفظ می‌شوند و نوع فقط `movie` یا `series` است. عنوان و شمارهٔ ردیف در شناسه نقشی ندارند.
- مالک تأیید کرده «کد سیستم» پس از ثبت ثابت می‌ماند و دوباره استفاده نمی‌شود. کد خالی/نامعتبر یا شناسهٔ تکراری در همان نوع باعث خطای fail-closed امن می‌شود؛ کد برابر میان movie و series مجاز است چون namespace جداست.
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
| genreId | رشتهٔ taxonomy اختیاری | فقط با metadata provider و taxonomy ژانر فعال؛ در غیر این صورت `FILTER_NOT_READY` |
| category | slug اختیاری | انتخاب یک دستهٔ فعال داده‌محور؛ با فیلترهای kind/countryId/genreId/year قابل ترکیب نیست |
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

taxonomyهای فعال را برمی‌گرداند. در composition محلی با metadata provider، کشور و ژانر از همان provider می‌آیند؛ بدون metadata provider مسیر سازگاری فقط country fixtures محدود را نشان می‌دهد. تمام این داده‌ها نمونه‌ای هستند، نه فهرست production.

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

فیلدهای DSL در نمونهٔ Core محدود به kind، countryIds، genreIds و releaseYear هستند. هر گسترش DSL باید با schema، تست و بازبینی انجام شود. وضعیت‌های تأیید و انتشار فیلد قابل فیلتر عمومی نیستند. ورودی دلخواه، property path دلخواه، regex یا کد اجرایی پذیرفته نمی‌شود.

## مدل‌های پاسخ پیشنهادی

### ContentSummary

- id
- kind
- title
- countries: شناسه و label فارسی از taxonomy فعال؛ فقط برای شناسه‌های معتبر
- genres: شناسه و label فارسی ژانر از taxonomy فعال؛ فقط در صورت تزریق metadata provider
- genreIds
- releaseYear، فقط پس از تأیید نگاشت
- posterAssetId یا URL عمومی کنترل‌شده، فقط پس از تعریف سیاست asset
- فقط محتوایی عمومی است که هم `approvalStatus=approved` و هم `publicationStatus=published` داشته باشد
- این دو فیلد عملیاتی در DTO عمومی بازگردانده نمی‌شوند

در schema فعلی شیت‌های «سینمایی» و «سریال» ستون کشور یا وضعیت انتشار ارائه نشده است و این شیت‌ها تغییر نمی‌کنند. کشور، category definitions، تأیید محتوا و انتشار عمومی از metadata store جداگانه با کلید Content ID می‌آیند. هیچ وضعیت قدیمی حدس زده نمی‌شود؛ تا وقتی رفتار عمومی سرویس فعلی با شواهد read-only تأیید و parity خروجی بررسی نشده، API جدید جایگزین آن نمی‌شود. وضعیت تأیید (`pending | approved | rejected | unknown`) و وضعیت انتشار (`draft | published | archived | unknown`) مستقل‌اند و هر دو باید صریحاً مقدار مجاز داشته باشند. ترکیب‌های دیگر، فیلدهای مفقود و metadata نامعتبر fail-closed می‌شوند. مقدار قدیمی `visibility=approved` یا `status=published` به‌تنهایی مجوز انتشار نیست.

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

`createCatalogApi({ provider, categories, metadataProvider })` یک Express app محلی می‌سازد و دو provider را به adapter موجود تزریق می‌کند. قرارداد محتوا همان `readSheet(sheetName) -> Promise<{ headers, rows }>` است؛ metadata با `getContentMetadata(contentId)`, `listCategories()` و `listTaxonomyTerms(type)` خوانده می‌شود. provider حافظه‌ای فقط fixture ساختگی دارد؛ Google Sheets provider جداگانه فقط‌خواندنی است و هیچ live composition یا اتصال واقعی در این مرحله ساخته نشده است. ردیف خام، Telegram File ID، token و خطای provider وارد پاسخ نمی‌شوند. فقط زوج دقیق `approvalStatus=approved` و `publicationStatus=published` منتشر می‌شود.

endpointهای محلی: `GET /api/v1/catalog/items`, `GET /api/v1/catalog/items/{id}`, `GET /api/v1/catalog/categories` و `GET /api/v1/catalog/taxonomies`. مسیرهای نوشتن و دانلود تعریف نشده‌اند. `q` با `FILTER_NOT_READY` رد می‌شود. `genreId` فقط وقتی metadata provider تزریق شده و شناسه در taxonomy فعال باشد پذیرفته می‌شود.

### منبع فرادادهٔ آینده

قرارداد پیشنهادی و مستقل از storage:

```text
CatalogMetadataProvider
  getContentMetadata(contentId) -> Promise<{
    countryIds?, genreIds?, approvalStatus, publicationStatus
  } | null>
  listTaxonomyTerms(type) -> Promise<TaxonomyTerm[]>
  listCategories() -> Promise<CategoryDefinition[]>
```

`approvalStatus` اجباری و محدود به `pending | approved | rejected | unknown` است؛ `publicationStatus` اجباری و محدود به `draft | published | archived | unknown`. این‌ها دو تصمیم مستقل‌اند: `approved` فقط تأیید محتوا را بیان می‌کند و به‌تنهایی اجازهٔ نمایش نمی‌دهد. API تنها با هر دو مقدار `approved` و `published` رکورد را عمومی می‌کند. مقدار قدیمی `visibility=approved`، `status=published`، فیلد مفقود، enum نامعتبر یا metadata غایب رد می‌شود و به وضعیت عمومی نگاشت نمی‌شود. اگر رکورد metadata نامعتبر باشد یا شناسه‌های country/genre به taxonomy فعال تعلق نداشته باشند، محتوا عمومی نمی‌شود. `listTaxonomyTerms` باید اصطلاحات فعال و دارای `id`, `labelFa`, `enabled: true` برگرداند. `listCategories` تعریف‌های Category را برمی‌گرداند؛ فیلتر هر دسته فقط با DSL محدود Core اعتبارسنجی می‌شود. این interface عملیات نوشتن ندارد.

نمونهٔ محلی این interface را از طریق `createCatalogSheetAdapter(provider, { metadataProvider })` متصل می‌کند. metadata فقط با ID ترکیبی دقیق join می‌شود. فقط زوج معتبر `approvalStatus=approved` و `publicationStatus=published` عمومی است؛ `approved` در وضعیت تأیید، `published` در وضعیت انتشار، مقدارهای قدیمی `visibility`/`status`، وضعیت نامعلوم، metadata ناقص/نامعتبر و کدهای تکراری مجوز عمومی نمی‌دهند. در حالت metadata، کشور/ژانر ستون‌های source را override نمی‌کنند و فقط از metadata دارای taxonomy فعال می‌آیند. این رفتار fixtureمحور است؛ برای جلوگیری از پنهان‌شدن ناخواستهٔ محتوای جاری، تعویض consumer تا تأیید رفتار سرویس فعلی و تطبیق مجموعهٔ شناسه‌های public متوقف می‌ماند.

## سازگاری و نسخه‌بندی

- تغییر ناسازگار در پاسخ یا فیلترها مسیر نسخهٔ جدید API می‌خواهد.
- افزودن فیلد اختیاری تا وقتی معنی و nullability آن مشخص باشد می‌تواند در v1 سازگار بماند.
- تغییر schema منبع داده نباید بی‌اعلان، شکل پاسخ v1 را عوض کند.
- مصرف‌کنندگان: سایت Apps Script، Android WebView/کلاینت آینده، ربات اصلی و در صورت نیاز ربات دانلود.
