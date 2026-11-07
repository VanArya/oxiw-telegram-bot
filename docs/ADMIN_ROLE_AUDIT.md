# قرارداد Audit برای چرخهٔ عمر نقش مدیر

وضعیت: **قرارداد، provider آفلاین Firestore-injected و composition runtime؛ بدون اتصال زنده یا provisioning فعال**. این سند مکمل `docs/adr/0003-admin-role-provisioning.md` است. هیچ assignment، حساب مدیر یا رخداد واقعی ایجاد نشده است. نام collection و schema assignment همچنان طرح پیشنهادی ADR هستند و پیش از بهره‌برداری به تصویب مالک نیاز دارند.

## مرز مسئولیت

- `CatalogAdminRoleProvider.resolveRoles(subjectId)` فقط نقش‌های مورداعتماد را برای یک هویت قبلاً تأییدشده می‌خواند.
- `src/firestore-catalog-admin-role-provider.js` پیاده‌سازی تزریقی برای resolve تازه و `changeAssignment()` دارد. نام collection قابل‌پیکربندی است؛ پیش‌فرض‌ها نام‌های پیشنهادی ADR هستند. composition عملیاتی آن را به runtime تزریق می‌کند، اما هیچ route provisioning وجود ندارد و bootstrap CLI بدون trusted actor و approval provider غیرفعال است.
- `changeAssignment()` از `expectedVersion` استفاده می‌کند و assignment و رخداد role-audit را در یک Firestore transaction می‌نویسد. actor باید از caller مورداعتماد بیاید؛ این adapter منشأ هویت را احراز نمی‌کند.
- `bootstrapAdministrator()` در همان provider یک assignment اولیه با نقش صریح `administrator`، سند کنترل bootstrap و رخداد `bootstrap.completed` را در یک transaction می‌سازد. برای سیاست تک‌مالک، actor و approval جداگانه تزریق می‌شوند و رخداد bootstrap با schema version 4 ثبت می‌شود. سند کنترل پیشنهادی فعلی شامل `bootstrapState`, `version` و `activeAdministratorCount` به‌همراه زمان/actor/approval است؛ این schema مصوب عملیاتی نیست.
- هر تغییر assignment سند کنترل را در همان transaction به‌روزرسانی می‌کند و شمارندهٔ مدیران فعال را از assignmentهای خوانده‌شده در transaction تطبیق می‌دهد. حذف یا غیرفعال‌سازی آخرین مدیر فعال با خطای `LAST_ADMINISTRATOR` رد می‌شود.
- قرارداد جدید `src/catalog-admin-role-audit.js` شکل رخداد lifecycle را اعتبارسنجی و interface زیر را تعریف می‌کند:

```js
CatalogAdminRoleAuditSink.appendInTransaction(transactionContext, event)
```

- ابزار/provider مسئول تغییر assignment باید context تراکنش را آغاز کند، تغییر assignment را در آن ثبت کند و همان context را به sink بدهد. sink حق ندارد تراکنش جداگانه بسازد یا پنهانی commit کند.
- `src/google-cloud-adc-trusted-actor-provider.js` seam تزریقی برای ADC دارد: فقط client از نوع عمومی `Impersonated` با principal برابر allowlist و موفقیت تبادل token پذیرفته می‌شود. provider مقدار access token را افشا نمی‌کند. provider خودش سازنده‌های SDK را دریافت می‌کند و runtime به آن وصل نشده است.
- مالک باید از `trustedApprovalProvider` مستقل و با Firebase ID Token معتبر بیاید؛ validator فقط شکل، مالکیت و وجود مرجع را می‌سنجد. منشأ عملیاتی توکن هنوز به CLI وصل نشده، پس تابع تزریقی fake برای استفاده واقعی کافی نیست. هیچ endpoint مدیریتی موجود برای نقش‌ها اضافه نشده است.

## رخدادهای موفق مجاز

`validateCatalogAdminRoleAuditEvent(event)` فقط رخدادهای کامل با `outcome: 'committed'` را می‌پذیرد:

| `operation` | معنای گذار |
|---|---|
| `assignment.created` | ایجاد assignment فعال از نسخهٔ صفر با حداقل یک نقش مجاز |
| `roles.changed` | تغییر غیرخالی مجموعهٔ نقش‌ها در assignment فعال |
| `role.revoked` | کم‌شدن مجموعهٔ نقش‌ها در assignment فعال |
| `assignment.disabled` | غیرفعال‌شدن assignment؛ فهرست نقش‌های ثبت‌شده حفظ می‌شود |
| `bootstrap.completed` | ایجاد یک‌بارهٔ assignment فعال اولیه با نقش `administrator` |

رخدادهای نسخهٔ ۱ بدون `schemaVersion` ذخیره شده‌اند و برای سازگاری پذیرفته می‌شوند. فیلدهای آن‌ها دقیقاً عبارت‌اند از:

- `eventId`: UUID رخداد؛
- `operation`: یکی از عملیات بالا؛
- `occurredAt`: زمان UTC در قالب canonical ISO؛
- `outcome`: فقط `committed`؛
- `actorId`: شناسهٔ پایدار actor مورداعتماد؛
- `targetSubjectId`: شناسهٔ پایدار هدف؛
- `rolesBefore`, `rolesAfter`: snapshot نقش‌های مجاز پیش و پس از تغییر؛
- `activeBefore`, `activeAfter`: وضعیت assignment؛
- `previousVersion`, `version`: نسخهٔ قبل و بعد با افزایش دقیقاً یک واحد.

فیلد اضافه رد می‌شود. roleها باید از allowlist فعلی (`observer`, `editor`, `approver`, `publisher`, `taxonomy_manager`, `administrator`) باشند و تکراری نباشند. تغییرات خالی، ناسازگار با نوع عملیات، version نادرست یا payload ناقص پیش از فراخوانی sink رد می‌شوند. رخداد موفق برای ورودی نامعتبر تولید نمی‌شود.

### نسخهٔ ۴ برای bootstrap تک‌مالک با هویت service account

نسخهٔ ۲ تمام فیلدهای پایه را نگه می‌دارد و approval دوطرفهٔ قدیمی را توصیف می‌کند؛ نسخهٔ ۴ برای سیاست تک‌مالک این فیلدهای اجباری را اضافه می‌کند:

- `schemaVersion`: عدد ثابت `4`؛
- `actorType`: فعلاً فقط `service_account`؛
- `identitySource`: فعلاً فقط `google_cloud_adc_service_account_impersonation`؛
- `ownerId`: شناسهٔ پایدار مالک؛
- `ownerIdentitySource`: برابر `firebase_admin_id_token`؛
- `approvalReference`: مرجع غیرخالی و محدود به 256 نویسه؛
- `actorId`: ایمیل principal ازپیش allowlist‌شده با دامنهٔ `iam.gserviceaccount.com`.

نسخهٔ ۱، ۲ و ۳ همچنان معتبرند؛ نسخهٔ ۴ برای bootstrap تک‌مالک لازم است. این
validator نمی‌تواند ثابت کند توکن واقعاً از مالک آمده یا approval واقعاً
تأیید کرده‌اند. این ادعا فقط وقتی معتبر است که `trustedActorProvider` و
`trustedApprovalProvider` موردبازبینی‌شده باشند. کد فعلی ADC از API عمومی
`Impersonated.getTargetPrincipal()` و تبادل access token استفاده می‌کند. provider مالک
Firebase فقط به‌صورت تزریقی و آفلاین آماده است؛ چون منبع واقعی توکن و UID مالک به CLI
وصل نشده، اجرای واقعی همچنان غیرفعال است.

## اتمیک‌بودن و شکست

معنای موردنیاز اتمیک‌بودن این است که assignment و رخداد موفق یا هر دو commit شوند یا هیچ‌کدام. sink فقط context تراکنش را دریافت می‌کند و append را در همان context ثبت می‌کند. اگر تغییر assignment، اعتبارسنجی audit، append رخداد یا commit تراکنش شکست بخورد، caller باید کل تراکنش را abort کند؛ موفقیت تغییر نقش یا audit نباید اعلام شود.

آزمون fake در `test/catalog-admin-role-audit.test.js` و `test/firestore-catalog-admin-role-provider.test.js` همکاری sink و rollback هر دو write در شکست write یا audit را آزمایش می‌کند. این فقط رفتار transaction fake را تأیید می‌کند؛ اتمیک‌بودن Firestore عملیاتی را ثابت نمی‌کند. provider به SDK یا credential واقعی متصل نمی‌شود.

## داده‌های ممنوع و رخدادهای ناموفق

رخداد lifecycle نباید token، credential، secret، authorization header، cookie، متن درخواست احراز هویت یا payload خام درخواست را در خود داشته باشد. schema فقط مقادیر allowlist‌شده را می‌پذیرد. شناسه‌های actor و هدف دادهٔ حساس‌اند و باید با دسترسی محدود و retention مصوب نگهداری شوند.

رخدادهای lifecycle بالا فقط تغییر موفق assignment را ثبت می‌کنند. تلاش ناموفق برای ورود، role lookup ناموفق، درخواست غیرمجاز، ورودی نامعتبر یا خطای زیرساختی نباید به‌عنوان `committed` ثبت شود. این موارد به مسیر امنیتی جداگانهٔ logging/metrics/alert تعلق دارند؛ چنین sink عملیاتی در این مرحله ساخته نشده است. hook تشخیصی فعلی بازیابی نقش، در صورت تزریق، فقط دستهٔ خطا را دریافت می‌کند و جای audit پایدار یا سامانهٔ امنیتی را نمی‌گیرد.

## سازگاری با audit فعلی کاتالوگ

`CatalogAuditEventSink` فعلی فقط entityهای `content`, `category`, `taxonomy` و operationهای همان حوزه را می‌پذیرد؛ role event را قبول نمی‌کند. validator فعلی نباید دور زده شود و رخداد role نباید با جعل taxonomy/content ثبت شود. این قرارداد role مستقل است و sink تزریقی role context تراکنش را مصرف می‌کند؛ storage زنده، IAM و schema نهایی هنوز بازبینی نشده‌اند.

## آنچه برای مرحلهٔ عملیاتی باقی است

1. تصویب مالک نقش‌ها، approverها، bootstrap، break-glass، آخرین administrator، retention و فرایند revoke؛
2. انتخاب و پیکربندی مورداعتماد IdP/verifier و منبع نقش؛
3. طراحی IAM و storage backend-only، versioning و تراکنش مشترک role/audit؛
4. تصویب schema و ساخت provider/sink عملیاتی با تست transaction و آزمون مجوزها در staging؛ provider فعلی فقط آفلاین و مبتنی بر proposal است؛
5. پایش امن رخدادهای ناموفق، backup/restore و runbook بازیابی.

تا تکمیل و بازبینی این موارد، قرارداد و تست‌های fake آمادگی عملیاتی ایجاد نمی‌کنند.

Provider آفلاین فعلی از schema پیشنهادی `catalogAdminRoleAssignments/{subjectId}` استفاده می‌کند (فیلدهای `subjectId`, `roles`, `active`, `version` و metadata زمان/actor) و رخدادها را در collection پیشنهادی audit می‌نویسد. این انتخاب برای تست adapter و composition runtime است، نه تصویب schema. ADC actor provider با fakeها آزموده می‌شود؛ credential واقعی، IAM، منبع معتبر approval و اتصال زنده وجود ندارند.

### کنترل bootstrap و migration/reconciliation

در adapter آزمایشی، سند کنترل پیشنهادی `catalogAdminControl/bootstrap` پس از bootstrap موفق شامل `bootstrapState: "completed"`، `version`، `activeAdministratorCount`، `completedAt`، `completedBy`، `updatedAt` و `updatedBy` است. این نام‌ها و شکل سند برای تست انتخاب شده‌اند و تصویب schema یا قرارداد عملیاتی محسوب نمی‌شوند.

اگر سند کنترل مفقود باشد و assignmentی وجود داشته باشد، provider وضعیت را `ROLE_CONTROL_MISSING` می‌داند و bootstrap یا دسترسی مدیریتی را خودکار فعال نمی‌کند. اگر شمارنده با assignmentهای فعال دارای نقش `administrator` برابر نباشد، وضعیت `ROLE_CONTROL_INCONSISTENT` و fail-closed است. راهکار مجاز برای محیط واقعی، ابزار migration/reconciliation جداگانه با دسترسی محدود است که ابتدا assignmentها را read-only بررسی و مالک/approver آن را تأیید کند، سپس در یک تغییر کنترل‌شده marker و شمارنده را با audit مناسب بازسازی کند؛ این ابزار و فرایند در این مرحله پیاده‌سازی نشده‌اند. شمارش خارج از transaction یا حدس‌زدن خالی‌بودن سیستم جایگزین امنی نیست.
