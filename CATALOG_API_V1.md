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
- endpointهای محلی مدیریت فراداده سیاست مجوزدهی جدا دارند؛ این نمونه هنوز token verifier یا احراز هویت عملیاتی ندارد و نباید به‌عنوان سرویس مستقرشده استفاده شود. عملیات کاربر و صدور مجوز دانلود خارج از دامنهٔ این API هستند.
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

پیش از نوشتن پایدار یا استفادهٔ عملیاتی از مدیریت فراداده، باید منبع احراز هویت مدیر و نقش‌ها پیاده‌سازی و تأیید شود، مجوز نوشتن فقط در backend مورداعتماد اعمال شود، دسترسی مستقیم کلاینت‌های عمومی به اسناد محدود بماند، ورودی‌ها و transitionهای هر دو وضعیت اعتبارسنجی شوند و ثبت audit/change history و روش بازیابی عملیاتی مشخص شود. credential یا مجوز مدیریتی هرگز در سایت عمومی یا اپ Android قرار نمی‌گیرد. API نوشتنی فعلی فقط نمونهٔ محلی است؛ API تولیدی یا ذخیره‌سازی پایدار فعال وجود ندارد.

## API مدیریتی — نمونهٔ محلی، نه آمادهٔ استقرار

`createCatalogAdminApi({ writableProvider, verifyAdminPrincipal, roleProvider, authorizePermission })` یک Express app جدا از API عمومی می‌سازد. `verifyAdminPrincipal(request)` فقط هویت تأییدشده با شکل `{ authenticated: true, subjectId }` را برمی‌گرداند؛ نقش در این مرحله پذیرفته نمی‌شود. API principal را از body، query، cookie یا header عادی استخراج نمی‌کند. پس از تأیید شناسه، `CatalogAdminRoleProvider.resolveRoles(subjectId)` نقش‌ها را از منبع trusted می‌خواند و فقط نقش‌های allowlist‌شده به policy موجود می‌رسند. فهرست خالی/کاربر بدون assignment، هویت معتبر ولی فاقد مجوز است و به `403 FORBIDDEN` می‌رسد؛ خطای resolver یا دادهٔ نقش ناقص/ناشناخته/تکراری fail-closed با `503 ROLE_RESOLUTION_UNAVAILABLE` است. verifier مفقود یا نامعتبر همان قرارداد `401`/`503` را دارد و جزئیات خام خطا افشا نمی‌شود.

`src/catalog-admin-role-provider.js` قرارداد `CatalogAdminRoleProvider.resolveRoles(subjectId) -> Promise<Role[]>` را تعریف می‌کند. principal نامعتبر هرگز به resolver داده نمی‌شود؛ resolver فقط subjectId نرمال‌شده می‌گیرد. `createInMemoryCatalogAdminRoleProvider(assignments)` یک fake صریح برای تست است، نه fallback runtime. منبع عملیاتی نقش، schema، provisioning مدیران و فرایند لغو نقش هنوز انتخاب/پیاده‌سازی نشده‌اند. `roleProvider` باید صریحاً به Admin API، HTTP service و Runtime Factory تزریق شود؛ نبود آن readiness و مسیر مدیریت را fail-closed می‌کند.

در صورت نیاز به تشخیص داخلی خطا، `reportRoleResolutionFailure(event)` اختیاری است و فقط `{ category: 'provider_error' | 'invalid_assignment' }` دریافت می‌کند؛ شناسهٔ principal، roleها و خطای خام به آن داده نمی‌شود. خطای callback نادیده گرفته می‌شود تا پاسخ fail-closed تغییر نکند. این hook منبع نقش یا احراز هویت عملیاتی ایجاد نمی‌کند.

`src/catalog-admin-authorization.js` قرارداد نقش و مجوز را مستقل از ارائه‌دهندهٔ ورود تعریف می‌کند. `createCatalogRoleAuthorizer()` نقش‌های principal تأییدشده را به مجوزهای محدود نگاشت می‌کند:

| نقش | مجوزها |
|---|---|
| `observer` | `catalog.admin.read` |
| `editor` | `catalog.admin.read`, `catalog.metadata.write` |
| `approver` | `catalog.admin.read`, `catalog.content.approve` |
| `publisher` | `catalog.admin.read`, `catalog.content.publish` |
| `taxonomy_manager` | `catalog.admin.read`, `catalog.categories.manage`, `catalog.taxonomies.manage` |
| `administrator` | همهٔ مجوزهای فهرست‌شده، فقط وقتی principal از verifier مورداعتماد معتبر شده باشد |

همهٔ GETهای مدیریتی به `catalog.admin.read` نیاز دارند. PUT metadata به `catalog.metadata.write` نیاز دارد؛ اگر مقدار `approvalStatus` یا `publicationStatus` نسبت به رکورد فعلی تغییر کند، مجوز مستقل `catalog.content.approve` یا `catalog.content.publish` هم لازم است. هنگام ایجاد، مقدارهای پایهٔ `pending` و `draft` برای editor مجازند؛ ایجاد با وضعیت دیگر به مجوز مربوط نیاز دارد. PATCH تأیید، PATCH انتشار، PUT دسته و PUT taxonomy به‌ترتیب به مجوزهای `catalog.content.approve`، `catalog.content.publish`، `catalog.categories.manage` و `catalog.taxonomies.manage` نیاز دارند. بنابراین `metadata.write` به‌تنهایی امکان تأیید یا انتشار نمی‌دهد. تأیید و انتشار همچنان وضعیت‌های جدا هستند و شرط عمومی‌شدن `approved AND published` تغییر نمی‌کند.

بدنهٔ JSON فقط پس از احراز و مجوز route parse می‌شود. شناسهٔ عامل در گزینه‌های write از `principal.subjectId` معتبر به Provider داده می‌شود؛ ورودی کاربر برای `actorId` مبنا نیست. verifier، role provider حافظه‌ای و authorizer این مرحله fake/تزریق‌شده‌اند؛ هیچ JWT verifier، منبع نقش عملیاتی، ارائه‌دهندهٔ هویت یا credential عملیاتی پیاده‌سازی نشده است. این قرارداد جایگزین احراز هویت واقعی یا بررسی امنیت عملیاتی نیست.

### آزمون یکپارچهٔ محلی

`node --test test/catalog-end-to-end.test.js` یک مسیر کامل را با fake Google Sheets، یک fake Firestore مشترک برای Provider خواندنی و نوشتنی، verifier ساختگی و APIهای محلی اجرا می‌کند. سرور HTTP تست فقط روی loopback (`127.0.0.1`) باز می‌شود؛ هیچ Google، Firestore، Telegram یا سرویس خارجی فراخوانی نمی‌شود. `node --test` این سناریو را همراه کل suite اجرا می‌کند. Fakeها سازگاری قرارداد و rollback/تعارض را در این پیاده‌سازی می‌سنجند و جایگزین تست SDK، IAM، احراز هویت یا استقرار واقعی نیستند.

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

### پیش‌شرط نسخه برای مدیریت

GET تک‌رکورد metadata، دسته و taxonomy، ETag قوی پاسخ می‌دهد. قالب یکسان است: `"catalog-v1.<identity-base64url>.v<version>"`؛ identity از نوع منبع و شناسهٔ پایدار آن ساخته می‌شود و version عدد `_version` Provider است. نسخه فقط در هدر است و در JSON یا metadata قابل ویرایش قرار نمی‌گیرد.

ویرایش metadata، PATCH تأیید/انتشار، و ویرایش دسته یا taxonomy باید `If-Match` با ETag دقیق و فعلی بفرستند. ایجاد metadata، دسته یا taxonomy باید `If-None-Match: *` بفرستد. پیش‌شرط مفقود `428 PRECONDITION_REQUIRED`، قالب نامعتبر `400 INVALID_PRECONDITION`، نسخهٔ منقضی/متعلق به رکورد دیگر `412 PRECONDITION_FAILED`، و تلاش ایجاد روی رکورد موجود `409 ALREADY_EXISTS` می‌دهد. Provider هم expectedVersion را داخل transaction مقایسه می‌کند؛ تعارض provider به `412` تبدیل می‌شود. درخواست stale هرگز با نسخهٔ جدید خودکار retry نمی‌شود.

## ذخیره‌سازی نوشتنی آزمایشی

`WritableCatalogMetadataProvider` از interface خواندنی `CatalogMetadataProvider` جداست. `createInMemoryWritableCatalogMetadataProvider(...)` هر دو قرارداد را برای همان اجرای آزمایشی فراهم می‌کند؛ داده‌ها تا پایان process در Map می‌مانند و با restart از بین می‌روند. API عمومی می‌تواند همان instance را به‌عنوان `metadataProvider` دریافت کند تا تغییرات مجاز همان اجرا را بخواند. provider حافظه‌ای سادهٔ قبلی برای fixtureهای صرفاً خواندنی همچنان قابل استفاده است.

اعتبارسنجی مشترک در `src/catalog-metadata-validation.js` متمرکز است. شناسهٔ محتوا باید canonical و ترکیبی `kind + systemCode` باشد؛ body نمی‌تواند کلید دیگری جایگزین کند. شناسه‌های کشور/ژانر باید یکتا و عضو taxonomy فعال باشند، slug دسته تکراری مجاز نیست، DSL فیلتر همان Core محدود را رعایت می‌کند و غیرفعال‌کردن taxonomy مورد استفاده رد می‌شود. این نمونه تاریخچهٔ تغییرات durable ندارد. پیش از استفادهٔ واقعی باید احراز هویت و نقش‌ها، audit trail، ثبت زمان/عامل تغییر، سیاست concurrency، قواعد backend/IAM و بازیابی طراحی شوند.

## Provider نوشتنی Firestore — mock-only

`createFirestoreWritableCatalogMetadataProvider({ firestore, auditEventSink })` گسترش نسخه‌دار `WritableCatalogMetadataProvider` را پیاده می‌کند؛ Firebase SDK به آن وابسته نیست و کلاینت و sink از بیرون تزریق می‌شوند. مجموعه‌های پیشنهادی همان `catalogContentMetadata`، `catalogCategories` و `catalogTaxonomies` هستند؛ رخدادها در `catalogAuditEvents` ذخیره می‌شوند. این نام‌ها قرارداد پیشنهادی‌اند و هیچ collection واقعی ساخته نشده است.

هر سند دارای `_version` عددی داخلی است. خواندن نسخه‌دار به شکل `{ value, version }` و نوشتن به شکل `{ value, version }` انجام می‌شود؛ نسخه در metadata عمومی یا DTO برنمی‌گردد. تمام متدهای نوشتن گزینهٔ اجباری `{ expectedVersion }` می‌گیرند: مقدار `0` فقط ایجاد در نبود سند را می‌پذیرد و مقدار مثبت فقط وقتی update می‌کند که نسخهٔ ذخیره‌شده دقیقاً مطابق باشد. عدم تطابق، سند مفقود هنگام update یا وجود سند هنگام create با تعارض امن رد می‌شود. خواندن، مقایسه، نوشتن سند و ثبت رخداد در یک transaction انجام می‌شود تا به‌روزرسانی هم‌زمان بی‌صدا overwrite نشود.

API مدیریتی محلی ETag را به expectedVersion تبدیل و به Provider منتقل می‌کند؛ provider حافظه‌ای نیز همین قرارداد را در process اعمال می‌کند. API و Provider Firestore در تست‌های mock هماهنگ‌اند، اما این به معنی آماده‌بودن authentication، Firestore یا staging عملیاتی نیست.

## رخدادهای audit

قرارداد `CatalogAuditEventSink.appendInTransaction(transaction, event)` مستقل است و `createFirestoreCatalogAuditEventSink` فقط رخداد allowlist‌شده را در همان تراکنش ایجاد می‌کند. رخدادهای موفق شامل `eventId`, `operation`, `entityType`, `entityId`, `occurredAt`, `outcome=committed`, `previousVersion`, `version` و نام فیلدهای تغییرکرده است؛ operation برای approval و publication وضعیت مقصد را به‌شکل `approval.approved` یا `publication.archived` مشخص می‌کند، بدون ذخیرهٔ مقدارهای دیگر metadata. `actorId` اختیاری و فقط برای شناسهٔ opaque دریافتی از احراز هویت مورداعتماد است. مقدارهای قبلی/جدید، snapshot کامل، token، Telegram File ID و credential ذخیره نمی‌شوند. شکست تراکنش رخداد موفقی ایجاد نمی‌کند؛ ثبت تلاش‌های ناموفق و تغییرات مجوز باید در سیاست audit عملیاتی جداگانه طراحی شود. ساعت فعلی از تابع تزریق‌شده می‌آید؛ پیش از production باید منبع زمان مورداعتماد و سیاست retention مشخص شود.

Provider و sink جدید فقط با fake Firestore آزمایش شده‌اند. هیچ credential، SDK، پروژه یا اتصال واقعی Firestore آماده نیست. برای استفادهٔ عملیاتی، احراز هویت مدیر و نقش‌ها، کنترل دسترسی backend/IAM، انتقال نسخه از مسیر API، audit امن، backup و rollback لازم‌اند.

## سازگاری و نسخه‌بندی

- تغییر ناسازگار در پاسخ یا فیلترها مسیر نسخهٔ جدید API می‌خواهد.
- افزودن فیلد اختیاری تا وقتی معنی و nullability آن مشخص باشد می‌تواند در v1 سازگار بماند.
- تغییر schema منبع داده نباید بی‌اعلان، شکل پاسخ v1 را عوض کند.
- مصرف‌کنندگان: سایت Apps Script، Android WebView/کلاینت آینده، ربات اصلی و در صورت نیاز ربات دانلود.
