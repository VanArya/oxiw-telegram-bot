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

`createCatalogApi({ provider, categories, metadataProvider })` یک Express app محلی می‌سازد و دو provider را به adapter موجود تزریق می‌کند. قرارداد محتوا همان `readSheet(sheetName) -> Promise<{ headers, rows }>` است؛ metadata با `getContentMetadata(contentId)`, `listCategories()` و `listTaxonomyTerms(type)` خوانده می‌شود. provider حافظه‌ای برای تست‌ها و نمونه‌های ساختگی آماده است؛ Google Sheets provider جداگانه فقط‌خواندنی است. `src/firestore-catalog-metadata-provider.js` نیز adapter محلی آمادهٔ تزریق دارد، اما نه Firestore و نه هیچ اتصال واقعی در این مرحله ایجاد یا فعال نشده است. ردیف خام، Telegram File ID، token و خطای provider وارد پاسخ نمی‌شوند. فقط زوج دقیق `approvalStatus=approved` و `publicationStatus=published` منتشر می‌شود.

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

`createFirestoreCatalogMetadataProvider({ firestore })` همین interface را با کلاینت تزریق‌شده پیاده می‌کند و فقط `collection/doc/get` می‌خواند. تست‌ها از fake client استفاده می‌کنند؛ SDK، credential و شبکه لازم نیست. provider حافظه‌ای همچنان گزینهٔ پیش‌فرض fixtureهاست و Core هیچ وابستگی‌ای به نوع storage ندارد. در staging بعدی می‌توان فقط `metadataProvider` را در composition root به provider حافظه‌ای یا Firestore تغییر داد؛ برای بازگشت، همان تزریق staging دوباره به provider حافظه‌ای/آزمایشی برگردانده می‌شود. این کار نیازمند تغییر Core نیست و در این مرحله composition زنده‌ای ساخته نشده است.

پیش از نوشتن پایدار یا استفادهٔ عملیاتی از مدیریت فراداده، باید روش احراز هویت مدیر و نقش‌ها انتخاب شود، مجوز نوشتن فقط در backend مورداعتماد اعمال شود، دسترسی مستقیم کلاینت‌های عمومی به اسناد محدود بماند، ورودی‌ها و transitionهای هر دو وضعیت اعتبارسنجی شوند و ثبت audit/change history و روش بازیابی مشخص شود. credential یا مجوز مدیریتی هرگز در سایت عمومی یا اپ Android قرار نمی‌گیرد. تنها API نوشتنی فعلی همان نمونهٔ محلی حافظه‌ای در بخش بعد است؛ API تولیدی یا ذخیره‌سازی پایدار وجود ندارد.

## API مدیریتی — نمونهٔ محلی، نه آمادهٔ استقرار

`createCatalogAdminApi({ writableProvider, authorizeAdmin })` یک Express app جدا از API عمومی می‌سازد. هر درخواست، از جمله GETهای مدیریتی، از `authorizeAdmin(request)` عبور می‌کند؛ فقط نتیجهٔ boolean دقیق `true` مجوز می‌دهد. اگر authorizer داده نشود، همهٔ درخواست‌ها با `503 ADMIN_AUTH_NOT_CONFIGURED` رد می‌شوند؛ پاسخ دیگر با `403 FORBIDDEN` رد می‌شود. استثنای authorizer به خطای عمومی تبدیل می‌شود. این seam تست‌پذیر است و هنوز روش ورود مدیر یا credential واقعی ندارد.

Endpointهای نمونه:

| روش و مسیر | عملیات |
|---|---|
| `GET /api/v1/admin/catalog/items/{contentId}/metadata` | خواندن metadata یک شناسهٔ پایدار |
| `PUT /api/v1/admin/catalog/items/{contentId}/metadata` | ایجاد یا جایگزینی metadata کامل؛ statusهای تأیید و انتشار هر دو لازم‌اند |
| `PATCH /api/v1/admin/catalog/items/{contentId}/approval` | تغییر مستقل `approvalStatus` |
| `PATCH /api/v1/admin/catalog/items/{contentId}/publication` | تغییر مستقل `publicationStatus` |
| `GET /api/v1/admin/catalog/categories` | فهرست دسته‌ها، شامل غیرفعال‌ها |
| `GET /api/v1/admin/catalog/categories/{categoryId}` | دریافت یک تعریف دسته |
| `PUT /api/v1/admin/catalog/categories/{categoryId}` | ایجاد یا ویرایش تعریف دسته |
| `GET /api/v1/admin/catalog/taxonomies/{type}` | فهرست کشور یا ژانر، شامل غیرفعال‌ها |
| `GET /api/v1/admin/catalog/taxonomies/{type}/{termId}` | دریافت یک اصطلاح taxonomy |
| `PUT /api/v1/admin/catalog/taxonomies/{type}/{termId}` | ایجاد یا ویرایش اصطلاح taxonomy |

هیچ DELETE، حذف محتوا یا پاک‌کردن تاریخچه‌ای پیاده‌سازی نشده است. انتشار با `publicationStatus=published` تا زمانی که metadata فعلی `approvalStatus=approved` نباشد با `409 APPROVAL_REQUIRED` رد می‌شود. تأیید محتوا به‌تنهایی publication را تغییر نمی‌دهد. اگر approval از approved به حالت دیگری برود، publication ذخیره‌شده دست‌نخورده می‌ماند اما API عمومی به دلیل شرط دوگانه محتوا را پنهان می‌کند. DTO مدیریتی نیز allowlist دارد و فیلد ناشناخته، توکن یا Telegram File ID را نمی‌پذیرد یا برنمی‌گرداند. پاسخ خطاها request ID دارند و جزئیات خام را افشا نمی‌کنند.

## ذخیره‌سازی نوشتنی آزمایشی

`WritableCatalogMetadataProvider` از interface خواندنی `CatalogMetadataProvider` جداست. `createInMemoryWritableCatalogMetadataProvider(...)` هر دو قرارداد را برای همان اجرای آزمایشی فراهم می‌کند؛ داده‌ها تا پایان process در Map می‌مانند و با restart از بین می‌روند. API عمومی می‌تواند همان instance را به‌عنوان `metadataProvider` دریافت کند تا تغییرات مجاز همان اجرا را بخواند. provider حافظه‌ای سادهٔ قبلی برای fixtureهای صرفاً خواندنی همچنان قابل استفاده است.

اعتبارسنجی مشترک در `src/catalog-metadata-validation.js` متمرکز است. شناسهٔ محتوا باید canonical و ترکیبی `kind + systemCode` باشد؛ body نمی‌تواند کلید دیگری جایگزین کند. شناسه‌های کشور/ژانر باید یکتا و عضو taxonomy فعال باشند، slug دسته تکراری مجاز نیست، DSL فیلتر همان Core محدود را رعایت می‌کند و غیرفعال‌کردن taxonomy مورد استفاده رد می‌شود. این نمونه تاریخچهٔ تغییرات durable ندارد. پیش از استفادهٔ واقعی باید احراز هویت و نقش‌ها، audit trail، ثبت زمان/عامل تغییر، سیاست concurrency، قواعد backend/IAM و بازیابی طراحی شوند.

## سازگاری و نسخه‌بندی

- تغییر ناسازگار در پاسخ یا فیلترها مسیر نسخهٔ جدید API می‌خواهد.
- افزودن فیلد اختیاری تا وقتی معنی و nullability آن مشخص باشد می‌تواند در v1 سازگار بماند.
- تغییر schema منبع داده نباید بی‌اعلان، شکل پاسخ v1 را عوض کند.
- مصرف‌کنندگان: سایت Apps Script، Android WebView/کلاینت آینده، ربات اصلی و در صورت نیاز ربات دانلود.
