# ADR-0003: چرخهٔ عمر و تأمین نقش‌های مدیر کاتالوگ

- وضعیت: **پیشنهاد معماری برای بررسی مالک؛ provider/bootstrap آفلاین و runtime wiring آماده، تأیید عملیاتی نشده است؛ مسیر HTTP bootstrap حذف شده است**
- تاریخ: 2026-10-26
- مرتبط: ADR-0001، ADR-0002، `src/catalog-admin-role-provider.js`، `src/catalog-admin-authorization.js`، `CATALOG_API_V1.md`

## زمینه و شواهد فعلی

API مدیریتی قراردادهای مستقلی برای تأیید هویت، بازیابی نقش و بررسی مجوز دارد. verifier باید هویت حداقلی `{ authenticated: true, subjectId }` را پس از تأیید معتبر بسازد؛ سپس `CatalogAdminRoleProvider.resolveRoles(subjectId)` نقش‌های مجاز را بازیابی می‌کند و policy موجود مجوز هر عملیات را بررسی می‌کند. نقش از درخواست HTTP پذیرفته نمی‌شود. شناسهٔ actor برای audit از principal تأییدشده می‌آید.

`createInMemoryCatalogAdminRoleProvider` فقط provider صریح آزمایشی است. منبع عملیاتی نقش، حساب مدیر، فرایند اعطای نقش، provisioning و لغو دسترسی وجود ندارد. Providerهای Firestore فعلی برای metadata کاتالوگ و رخدادهای همان کاتالوگ‌اند؛ هیچ‌یک role assignment را پیاده نمی‌کنند. API مدیریتی نیز endpoint اعطا، تغییر یا لغو نقش ندارد. این سند طراحی آینده است و وجود سرویس یا مجموعهٔ Firestore را ادعا نمی‌کند.

## تصمیم پیشنهادی

**پیشنهاد مشروط: assignment نقش در یک منبع backend-only و قابل‌تغییر نگهداری شود؛ Firestore نامزد پیشنهادی فعلی است.** در هر درخواست مدیریتی، backend پس از verify شدن هویت، نقش‌ها را از `CatalogAdminRoleProvider` می‌خواند و فقط roleهای allowlist فعلی را به policy می‌دهد. تا روشن‌شدن مالک پروژه، IAM، هزینه، نیازهای دسترس‌پذیری و فرایند عملیات، این انتخاب تصمیم اجرایی نهایی نیست.

هیچ endpoint عمومی یا مدیریتی برای self-registration، ارتقای نقش، bootstrap یا لغو نقش اضافه نمی‌شود. مسیر قدیمی `POST /api/v1/admin/catalog/bootstrap` نیز در API ثبت نشده است. تغییر assignment در آینده باید از فرایند provisioning مورداعتمادِ جدا از API عمومی انجام شود و همراه audit اتمیک باشد. Firebase Authentication به‌عنوان نامزد هویت در ADR-0002 باقی می‌ماند؛ این ADR IdP را انتخاب یا راه‌اندازی نمی‌کند.

## مقایسهٔ گزینه‌های نقش

| گزینه | امنیت و سازگاری با API فعلی | لغو و زمان اعمال | Audit و عملیات | ارزیابی |
|---|---|---|---|---|
| **Assignment سمت سرور در Firestore** | با `resolveRoles(subjectId)` سازگار است. فقط backend دارای هویت workload مجاز به خواندن/نوشتن assignment باشد؛ کلاینت‌ها و قواعد دسترسی عمومی نباید بتوانند آن را بخوانند یا تغییر دهند. Firebase ID token فقط هویت را تأیید می‌کند؛ نقش همچنان از منبع server-side می‌آید. | با خواندن تازه در هر درخواست، پس از ثبت تراکنش، درخواست بعدی نقش جدید را می‌بیند. خرابی یا timeout منبع به `503` و رد دسترسی می‌رسد. cache می‌تواند پنجرهٔ نقش کهنه ایجاد کند و در نسخهٔ نخست توصیه نمی‌شود. | هزینهٔ read و وابستگی عملیاتی به Firestore دارد. تغییر assignment و audit باید در یک تراکنش commit شوند. نیازمند IAM محدود، backup، پایش، بررسی دسترسی و رویهٔ restore است. | **نامزد منتخب مشروط**؛ با interface فعلی سازگار و برای revoke سریع‌تر از claim مناسب است، اما هنوز ساخته یا متصل نشده است. |
| **Firebase custom claims** | با هویت Firebase قابل استفاده است، ولی verifier باید claim را فقط از ID token معتبر بخواند و validate کند. این راه مستلزم آن است که role mapping در claim مورداعتماد به verifier برسد؛ API فعلی عمداً role را از خروجی identity جدا می‌کند، پس استفاده از آن نیازمند adapter/تصمیم صریح است و نباید seam فعلی را دور بزند. | تغییر claim معمولاً در token تازه/refresh بعدی دیده می‌شود؛ token موجود ممکن است role قبلی را تا انقضا حفظ کند. revoke توکن‌ها یا تحمیل refresh نیاز عملیاتی جداگانه دارد. | lookup در هر درخواست کمتر است، اما ایجاد/چرخش claim به Firebase Admin privileges وابسته است. تاریخچهٔ تغییر و نتیجهٔ عملیات باید جدا ثبت شود؛ claim به‌تنهایی audit نیست. | برای roleهای کم‌تغییر و تحمل پنجرهٔ revoke قابل بررسی است؛ با نیاز فعلی به اعمال سریع تغییر نقش گزینهٔ نخست نیست. |
| **Allowlist در تنظیمات مورداعتماد سرور** | می‌تواند backend را محدود به UIDهای صریح کند؛ فقط از config محافظت‌شدهٔ میزبان خوانده شود، نه env/body قابل‌کنترل از کلاینت. برای چند UID ثابت ساده است، اما نگاشت نقش‌های متعدد و policy فعلی را به config وابسته می‌کند. | تغییر نیازمند تغییر امن config و احتمالاً rollout/restart است؛ سرعت revoke و رفتار instanceهای متعدد باید تضمین شود. | تغییر config باید review و audit خارجی داشته باشد. drift بین محیط‌ها، خطای deploy و نبود تاریخچهٔ دامنه‌ای دشوارتر است. | فقط برای bootstrap اضطراری محدود یا فهرست بسیار کوچک با مالکیت روشن قابل بحث است؛ **منبع عادی نقش‌های کاتالوگ پیشنهاد نمی‌شود**. نقش‌ها را در سورس یا config عمومی hardcode نکنید. |

## هویت، نقش و مرز اعتماد

1. در معماری آینده، verifier معتبر (برای نمونه پس از انتخاب Firebase، backend verifier) token را بررسی می‌کند و `subjectId` پایدار را از هویت تأییدشده می‌سازد. UID یا نقش ارسالی از کلاینت، URL، body، query، cookie یا header عادی منبع هویت/نقش نیست.
2. API فقط پس از موفقیت verifier، `subjectId` را به `CatalogAdminRoleProvider.resolveRoles(subjectId)` می‌دهد. provider assignment فعال را با نقش‌های شناخته‌شده برمی‌گرداند؛ API/policy همان مجوزهای موجود را اعمال می‌کنند.
3. assignment غایب یا کاربر ناشناخته با `[]` معادل «هویت معتبر ولی بدون مجوز» است و به رد مجوز (`403`) می‌رسد. مقدار نامعتبر، role ناشناخته/تکراری یا شکست منبع دسترسی نمی‌دهد؛ خطای role source با پاسخ عمومی امن `503` از فقدان مجوز تفکیک می‌شود. هیچ fallback به custom claim کهنه یا نقش administrator مجاز نیست.
4. نقش‌های پیاده‌شده همچنان `observer`، `editor`، `approver`، `publisher`، `taxonomy_manager` و `administrator` هستند. مجوزهای ویرایش metadata، تأیید، انتشار و مدیریت taxonomy مستقل می‌مانند. assignment نقش به‌خودی‌خود وضعیت محتوا را تغییر نمی‌دهد؛ انتشار عمومی همچنان به `approvalStatus === 'approved'` و `publicationStatus === 'published'` نیاز دارد.
5. actor رخداد provisioning باید از هویت معتبر اپراتور یا فرایند کنترل‌شده به دست آید. اگر ابزار provisioning خارج از HTTP API باشد، هویت workload/اپراتور باید از محیط مورداعتماد آن ابزار ثبت شود؛ مقدار `actorId` ورودی ناشناس کافی نیست.

Firebase Authentication، custom claims، Firestore، Cloud Run و IAM در این مرحله راه‌اندازی نشده‌اند. ساختار و سطح اعتماد این بخش‌ها نیازمند تصمیم و مجوز جداگانه است.

## فرایند پیشنهادی ایجاد اولین مدیر

اولین administrator با ثبت‌نام عادی، endpoint عمومی، body درخواست یا self-service ساخته نمی‌شود. فرایند پیشنهادی پس از تصویب مالک:

1. مالک پروژه، یک مدیر مشخص را از مسیر خارج از سامانه تأیید کند و approval قابل‌بازبینی (برای مثال شمارهٔ درخواست تغییر در سامانهٔ موردتأیید سازمان) ثبت شود. این ADR هیچ شخص یا شناسه‌ای را تعیین نمی‌کند.
2. اپراتور مجاز، حساب را در کنسول/دایرکتوری مورداعتماد IdP پیدا و وضعیت آن را بررسی کند؛ `subjectId` از رکورد هویتی معتبر گرفته شود، نه از مقدار تأییدنشدهٔ کلاینت. ایمیل فقط برای یافتن/تأیید حساب است و کلید سند نقش نباشد.
3. ابزار یک‌بارهٔ bootstrap، با workload identity محدود و بدون endpoint عمومی، وضعیت bootstrap و نبود assignment قبلی را بررسی کند. سپس در یک transaction، اولین assignment فعال را با `administrator` بسازد، رخداد audit و نشانگر `bootstrapCompleted` را ایجاد کند. `create` اتمیک باید تکرار هم‌زمان یا اجرای دوباره را رد کند.
4. bootstrap پس از موفقیت غیرقابل‌تکرار عادی باشد. اجرای مجدد باید بی‌اثر/رد شود؛ بازگشایی آن فقط از رویهٔ break-glass با تأیید مالک، تغییر کنترل‌شده و audit جداگانه انجام شود.
5. اپراتور دوم یا بازبینی‌کننده، نتیجه و audit را از کانال read-only تأیید کند. ابزار bootstrap پس از استفاده غیرفعال یا حذف شود و مجوز موقت آن لغو شود.

این فرایند هنوز ابزار، سرویس، حساب، هویت workload یا نشانگر واقعی ندارد. پیش از پیاده‌سازی باید مالک، تأیید دو نفره، منبع identity، محل نگهداری approval، دسترسی bootstrap و روش بازیابی مشخص شوند.

## تغییر نقش، غیرفعال‌سازی و بازیابی

| رخداد | رفتار پیشنهادی |
|---|---|
| اعطای نقش یا تغییر نقش | فقط provisioning مورداعتماد؛ نقش‌ها allowlist و کمینه باشند. تغییر assignment و audit در یک تراکنش انجام شود. اعمال تغییر پیش از پاسخ موفق تأیید و در lookup بعدی قابل‌مشاهده باشد. |
| لغو یک نقش | assignment باقی بماند و role از فهرست فعال حذف شود؛ رخداد revoke ثبت شود. درخواست بعدی که همان permission را می‌خواهد رد شود. |
| غیرفعال‌کردن کل دسترسی | assignment soft-disable شود؛ resolver برای آن `[]` برگرداند. سابقه حذف نشود و account identity از سیستم IdP حذف/دست‌کاری نشود. |
| subject ناشناخته | assignment ندارد؛ پاسخ مدیریتی همانند کاربر بدون نقش رد شود تا وجود حساب‌ها افشا نشود. |
| منبع نقش در دسترس نیست یا داده خراب است | `503` عمومی، رد دسترسی و رویداد/metric داخلی دسته‌بندی‌شده؛ از نقش cache‌شده یا claim قدیمی fallback نشود. |
| لغو administrator با بالاترین دسترسی | تغییر حساس با بازبینی دو نفره و کنترل «حداقل یک مسیر بازیابی تأییدشده» انجام شود. administrator نباید تنها مسیر مدیریت یا تنها راه لغو خودش باشد. |
| لغو اشتباه یا خطر قفل‌شدن | رویهٔ break-glass خارج از API عمومی، مبتنی بر مالکیت Cloud IAM و دو تأیید، assignment را با نسخهٔ جدید بازیابی کند و audit اصلاحی append کند؛ هیچ دورزدن بی‌ردپا یا reset داده‌ای انجام نشود. |

پیشنهاد اولیه برای هم‌زمانی این است که هر خواندن مدیریتی نقش را تازه و سمت سرور resolve کند؛ در این صورت لغو پس از commit در درخواست بعدی اعمال می‌شود، با فرض دسترس‌پذیری و consistency منبع منتخب. این یک هدف طراحی است، نه تضمین عملیاتی فعلی. cache در نسخهٔ اول استفاده نشود. اگر برای هزینه/latency بعداً cache لازم شد، TTL حداکثر، invalidation، رفتار revoke و آزمون تأخیر باید پیش از فعال‌سازی تصویب شود. منبع خراب همیشه fail-closed است.

برای جلوگیری از قفل‌شدن، provisioning باید پیش از commit بررسی کند که حذف/غیرفعال‌سازی assignment آخرین administrator فعال را باقی نمی‌گذارد، مگر آنکه همان عملیات به‌طور جداگانه و مستندانه bootstrap/recovery را جایگزین کند. کنترل «آخرین مدیر» با transaction و شمارش/ساختار قابل‌اتکا نیازمند طراحی جزئی‌تر است؛ query ساده و هم‌زمانی‌ناامن کافی نیست. این قاعده تا زمانی که پیاده‌سازی و تست نشده، تضمین‌شده فرض نشود.

## طرح دادهٔ پیشنهادی برای بررسی

نام‌های زیر صرفاً **طرح پیشنهادی** هستند، نه نام مجموعه یا schema موجود:

### `catalogAdminRoleAssignments/{subjectId}`

```text
subjectId: شناسهٔ پایدار IdP؛ برابر کلید سند
roles: فهرست نقش‌های allowlist‌شده
active: boolean
version: عدد صحیح افزایشی برای کنترل هم‌زمانی
createdAt, updatedAt: زمان UTC/Firestore server timestamp
createdBy, updatedBy: actor معتبر اپراتور یا workload
```

کلید سند UID پایدار است، نه ایمیل، نام نمایشی یا مقدار client-controlled. `active=false` assignment را لغو می‌کند؛ سابقه حذف یا reuse نمی‌شود. نقش ناشناخته، آرایهٔ خالیِ نامنتظره در سند active، نسخهٔ نامعتبر یا سند ناقص به fail-closed منجر می‌شود. رشتهٔ token، credential، session، secret و اطلاعات ورود در سند ذخیره نمی‌شوند. حداقل‌سازی PII و retention باید با مالک و سیاست سازمانی تأیید شود.

### `catalogAdminRoleAuditEvents/{eventId}`

طرح رخداد append-only شامل `eventId`, `operation`, `occurredAt`, `outcome`, `actorId`, `targetSubjectId`, `changedRoles`, `previousVersion`, `version` و `approvalReference` است. فقط delta نقش لازم ثبت شود؛ token خام، credential، header، ایمیل غیرضروری یا payload درخواست ثبت نشود. نوشتن assignment و رخداد موفق باید اتمیک باشد. شکست audit باید assignment را هم rollback کند؛ رخداد شکست می‌تواند از مسیر امن عملیات/پایش جدا ثبت شود، بدون اینکه عملیات موفق وانمود شود.

قرارداد آفلاین فعلی role-audit، رخدادهای قبلی بدون `schemaVersion` را به‌عنوان نسخهٔ
۱ حفظ می‌کند. برای bootstrap، نسخهٔ ۲ فیلدهای `actorType`, `identitySource`,
`ownerId`, `approverId` و `approvalReference` را اجباری می‌کند. منبع actor پیشنهادی
یک service account مستقل و allowlist‌شده با ADC impersonation است؛ حساب
`oxiw-catalog-runtime` نباید استفاده شود. این توسعه فقط طرح/کد آفلاین است، نه تصویب
schema Firestore یا اثبات approval. `ownerId` و `approverId` باید از یک سامانهٔ
تأیید سازمانی مورداعتماد به دست آیند؛ شناسهٔ CLI/config به‌تنهایی مدرک نیست.

پیاده‌سازی ADC تزریقی به API عمومی `Impersonated.getTargetPrincipal()` و موفقیت
`getAccessToken()` تکیه می‌کند و فقط principal برابر allowlist را می‌پذیرد. این
تبادل هنگام اجرای provider با IAM Credentials API انجام می‌شود؛ در تست fake اجرا
نمی‌شود. مصرف‌کننده باید سازنده‌های `google-auth-library` را صریح تزریق کند. نسخهٔ
11.3.1 نصب‌شده در ریشه Node 22+ می‌خواهد، درحالی‌که دامنهٔ پروژه Node 18+ است؛ نسخهٔ
10.5.0 توکار Node 18+ را پشتیبانی می‌کند. وابستگی مستقیم سازگار و تصمیم دربارهٔ
نسخهٔ پشتیبانی‌شده پیش از wiring عملیاتی باقی است.

پیشنهاد IAM برای مرحلهٔ واقعی: service account اختصاصی provisioning؛ مجوز موقت
`roles/iam.serviceAccountTokenCreator` فقط روی همان حساب برای operator مجاز؛ دسترسی
Firestore حداقلی و جداگانه؛ ثبت دو تأییدکنندهٔ متفاوت در سامانهٔ approval مستقل؛ و
لغو bindingهای موقت بلافاصله پس از bootstrap. هنوز حساب، IAM، approval provider یا
روش احراز هویت owner/approver انتخاب و پیکربندی نشده است.

قرارداد فعلی `CatalogAuditEventSink` برای entityهای `content`, `category`, `taxonomy` و عملیات کاتالوگ allowlist دارد؛ `admin_role` را نمی‌پذیرد. بنابراین رخداد نقش نباید با دورزدن validator یا جعل رخداد taxonomy در sink فعلی نوشته شود. پیش از کار عملیاتی، یک contract/sink مستقل یا گسترش نسخه‌دار و آزموده‌شدهٔ audit لازم است؛ transaction باید هم سند assignment و هم رخداد را پوشش دهد. schema قطعی audit نقش در این مرحله انتخاب نشده است.

### `catalogAdminControl/bootstrap`

نشانگر one-time bootstrap با state/version، زمان تکمیل و reference تأیید پیشنهاد می‌شود. ساخت assignment اولیه و نشانگر باید transactionally و با `create` انجام شود تا اجرای تکراری/رقابتی موفق نشود. امکان reset این marker نباید مسیر عادی API باشد و recovery آن نیازمند تأیید مالک و audit است.

تمام نام‌ها و شکل اسناد بالا باید با هزینه، query pattern، محدودیت transaction، IAM و retention بازبینی شوند؛ هیچ سند یا collection اکنون ایجاد نشده است.

## کنترل‌های امنیتی ضروری

- Firestore security rules باید دسترسی client به assignment و audit نقش را deny کنند؛ backend workload نیز فقط مجوزهای موردنیاز را بگیرد. Firestore server SDK معمولاً با IAM کنترل می‌شود و rules جای IAM را نمی‌گیرند؛ تنظیم دقیق باید برای runtime منتخب تأیید شود.
- تنها ابزار provisioning/سرویس کنترل‌شده حق تغییر role assignment داشته باشد. API مدیریتی فعلی نباید مسیر role management پیدا کند مگر ADR و threat model جداگانه تصویب شوند.
- نقش‌ها از enum فعلی policy اعتبارسنجی شوند؛ `administrator` یک assignment صریح است و به‌طور ضمنی از نقش دیگر یا مالکیت حساب نتیجه نمی‌شود.
- تغییرات role با ETag/version یا precondition تراکنشی اجرا شوند؛ stale write رد شود. Audit موفق در همان transaction ذخیره شود.
- هیچ cache نقش در نسخهٔ اول؛ خطای resolver یا assignment نامعتبر `deny` است، نه استفاده از نقش قبلی.
- دسترسی bootstrap و break-glass حداقلی، محدود به افراد مشخص، قابل‌چرخش و تحت بازبینی دوره‌ای باشد. دو مدیر فعال یا مسیر recovery تأییدشده پیش از لغو آخرین administrator لازم است.
- رخدادهای grant/change/revoke/disable/bootstrap/recovery شامل actor مورداعتماد، target، زمان، نتیجه، مرجع تأیید و نسخه باشند. اطلاعات خام authentication هرگز وارد audit/log نشود.
- مانیتورینگ باید خطای role source، assignment نامعتبر، رد مجوز، اجرای bootstrap و تلاش برای تغییر آخرین administrator را بدون ثبت token یا اطلاعات غیرضروری گزارش کند.

## مراحل بعدی و معیار پذیرش

1. **تصمیم مالک:** IdP، حساب‌های مدیر، مالک نقش، تأیید دو نفره، نقش‌های قابل اعطا و فرایند revoke/recovery تصویب شوند. معیار توقف: مالک/approver یا منبع subject پایدار مشخص نیست.
2. **جزئیات طراحی و threat review:** schema پیشنهادی، IAM، transaction/last-admin invariant، audit و retention مشخص شوند. قرارداد فعلی audit یا sink مستقل به‌صورت نسخه‌دار طراحی شود. معیار پذیرش: نبود راه self-assignment و شکست امن در تمام خطاها.
3. **پیاده‌سازی آفلاین:** `CatalogAdminRoleProvider` و provisioning/audit fake تست شوند؛ هیچ SDK یا credential واقعی لازم نباشد. آزمون‌ها race bootstrap، نقش ناشناخته، منبع خراب، revoke، stale version، rollback audit و آخرین مدیر را پوشش دهند.
4. **محیط آزمایشی با مجوز جداگانه:** فقط پس از تأیید پروژه، region، budget، IAM و backup، role store staging ساخته شود. اول bootstrap کنترل‌شده، بعد آزمون grant/change/revoke و بازیابی؛ هیچ دادهٔ تولیدی بدون مجوز وارد نشود.
5. **اتصال verifier و پایش:** verifier واقعی پس از تصویب روش ورود ساخته شود؛ پس از هر درخواست identity verify و role fresh-read اجرا شود. آزمون منفی توکن منقضی/نامعتبر، ناشناخته، revoke و قطع منبع انجام شود.
6. **آمادگی بهره‌برداری:** owner، اپراتور و reviewer خروجی audit، runbook break-glass، backup/restore، alert و rollback را تأیید کنند. این ADR به‌تنهایی مجوز هیچ اتصال یا استقرار نیست.

## تصمیم‌های باز برای مالک

- آیا Firebase Authentication همچنان IdP منتخب است و چه حساب‌های مدیریتی مجازند؟
- چه کسی owner فهرست نقش‌ها و approver اعطای administrator است؟ آیا تأیید دو نفره برای grant/revoke مدیر لازم است؟
- پروژه/region و مدل هزینهٔ Firestore، IAM workload و دسترسی اپراتور چیست؟
- آیا دادهٔ role در Firestore backend-only قابل‌قبول است یا policy سازمانی منبع دیگری می‌خواهد؟
- نام و schema نهایی role assignment، audit retention، دورهٔ بازبینی نقش و محدودیت آخرین مدیر چیست؟
- چه کانال و runbookی برای break-glass و بازیابی پس از حذف اشتباه administrator تصویب می‌شود؟
- آیا reporting hook فعلی برای پایش کافی است یا باید event sink/metric استاندارد عملیاتی انتخاب شود؟

## وضعیت

- **پیشنهاد:** نقش‌های server-side در Firestore، lookup تازه پس از verify هویت، تغییر فقط از مسیر provisioning کنترل‌شده و audit اتمیک.
- **پیاده‌سازی آفلاین موجود:** provider تزریقی Firestore، bootstrap اتمیک، شمارندهٔ مدیران فعال و حفاظت از آخرین administrator با fake محلی آزموده شده‌اند؛ این‌ها اتصال عملیاتی یا تصویب schema نیستند.
- **ابزار مستقل آفلاین:** `src/catalog-admin-bootstrap-entrypoint.js` تأیید هدف/intent، actor ADC تزریقی و seam `bootstrapAdministrator()` را آماده می‌کند. اجرای CLI همچنان fail-closed است چون actor و به‌خصوص approval provider سازمانی به executable وصل نیستند؛ actor/owner/approver از argv/env پذیرفته نمی‌شوند.
- **مرز HTTP:** پنل و API هیچ مسیر Bootstrap ندارند؛ Firebase authenticated user، owner UID یا secret پنل نمی‌توانند نقش اول را ایجاد کنند.
- **انجام‌نشده:** حساب مدیر، Firestore/IAM واقعی، schema مصوب، migration/reconciliation، bootstrap کنترل‌شدهٔ production، revoke/recovery عملیاتی و استقرار؛ verifier و runtime wiring موجود فقط کد قابل‌آزمایش‌اند.
- **نتیجه:** دسترسی مدیریتی واقعی تا تکمیل و تأیید مراحل بالا فعال‌شدنی تلقی نمی‌شود. آزمون‌های fake اثبات امنیت عملیاتی نیستند.
