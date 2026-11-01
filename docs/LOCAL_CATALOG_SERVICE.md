# سرویس HTTP کاتالوگ — راهنمای آزمایش محلی

وضعیت: **app factory، listener مستقل و composition factory عملیاتیِ fail-closed آمادهٔ آزمون محلی‌اند؛ deployment و اتصال زنده انجام نشده است.**

## اجزای موجود

- `src/catalog-http-service.js` با `createCatalogHttpService(...)` app واحد می‌سازد و APIهای موجود عمومی و مدیریتی را با همان مسیرها به هم متصل می‌کند.
- `src/catalog-http-server.js` listener مستقل و قابل توقف می‌سازد؛ host پیش‌فرض آن `0.0.0.0` است و پورت معتبر را از `PORT` می‌گیرد. پورت 0 فقط با `allowEphemeralPort: true` و host loopback برای تست مجاز است.
- `src/catalog-http-entrypoint.js` مرز عمومیِ تزریق‌پذیر CLI است و همچنان runtime factory صریح می‌خواهد. `src/catalog-operational-entrypoint.js` فرمان مستقل `catalog:start` را به `src/catalog-operational-runtime-factory.js` وصل می‌کند؛ فقط runtime با `runtimeMode: 'operational'` و providerهای علامت‌گذاری‌شدهٔ Google Sheets/Firestore پذیرفته می‌شود. providerهای in-memory و providerهای ناشناخته به‌عنوان runtime عملیاتی پذیرفته نمی‌شوند.
- `src/catalog-runtime-factory.js` providerهای موجود و HTTP app را با وابستگی‌های صریح می‌سازد. این تابع `env`، namespace مربوط به Google APIs، کلاینت Firestore، verifier، role provider، policy و readiness callback را از caller می‌گیرد؛ از global environment یا singleton استفاده نمی‌کند و runtime را فقط با `runtimeMode: 'injected'` برمی‌گرداند. این mode برای CLI عملیاتی پذیرفته نیست.
- API عمومی از `src/catalog-api.js` و API مدیریت از `src/catalog-admin-api.js` ساخته می‌شوند؛ routeهایشان دوباره‌نویسی نشده‌اند.
- Providerها و readiness check باید صریحاً تزریق شوند. هیچ provider حافظه‌ای به‌صورت خودکار ساخته نمی‌شود.
- `parseCatalogPort()` مقدار `PORT` را اعتبارسنجی می‌کند؛ مقدار ناموجود به 8080 می‌رسد و مقدار نامعتبر خطا می‌دهد. listener خطای bind را به خطای امن با کد شناخته‌شده تبدیل می‌کند.
- `package.json` فعلی `npm start` را به `node index.js` وصل می‌کند؛ آن entrypoint ربات اصلی است. برای اجرای آن فرمان، ربات شروع می‌شود؛ این فرمان برای Catalog HTTP service نیست.

## پیش‌نیازها و آزمون

Node.js مطابق `package.json` (نسخهٔ 18 یا بالاتر) و وابستگی‌های همین پروژه، از جمله Express، لازم‌اند. هیچ بسته‌ای برای این مرحله اضافه نشده است.

کل آزمون‌ها:

```powershell
node --test
```

آزمون ترکیبی HTTP:

```powershell
node --test test/catalog-http-service.test.js
```

فرمان CLI مستقل کاتالوگ:

```powershell
npm run catalog:start
```

این فرمان بدون متغیرهای معتبر و ADC قابل‌استفاده با خطای عمومی و کد خروج غیرصفر متوقف می‌شود؛ هیچ provider حافظه‌ای جایگزین نمی‌شود. composition عملیاتی در `src/catalog-operational-runtime-factory.js` فقط با فراخوانی صریح ساخته می‌شود و Firebase Admin، verifier واقعی، role provider و audit sink را به providerهای موجود تزریق می‌کند. `npm start` تغییر نکرده و همچنان فقط برای ربات اصلی است.

در تست، sheet/metadata/writable providers و readiness check ساختگی‌اند. تست server را فقط روی `127.0.0.1` و پورت آزاد موقت باز می‌کند و در `finally` اتصال‌ها را می‌بندد. هیچ Google API، Sheets، Firestore، Telegram یا شبکهٔ خارجی فراخوانی نمی‌شود.

## Dependency injection و Health

نمونهٔ شکل فراخوانی app factory (صرفاً طرح؛ این فایل یک launcher یا دستور اجرا نیست):

```js
const app = createCatalogHttpService({
  provider,                 // readSheet(sheetName)
  metadataProvider,         // قرارداد خواندنی کاتالوگ
  writableProvider,         // قرارداد versioned مدیریتی
  verifyAdminPrincipal,     // verifier مورداعتماد میزبان
  roleProvider,             // resolveRoles(verifiedSubjectId)
  authorizePermission,      // سیاست مجوز مستقل
  readinessCheck,           // snapshot وضعیت وابستگی‌ها
  categories,
});
```

اگر Provider، readiness check یا dependency الزامی جا افتاده باشد، app factory خطا می‌دهد؛ fallback حافظه‌ای وجود ندارد. اگر verifier، role provider یا policy موجود نباشد، endpoint مدیریتی fail-closed با خطای پیکربندی می‌شود و `/health/ready` موفق نمی‌شود.

- `GET /health/live` فقط می‌گوید فرایند HTTP پاسخ می‌دهد؛ dependencyها را صدا نمی‌زند.
- `GET /health/ready` فقط وقتی 200 می‌دهد که `readinessCheck()` برای `sheetSource`، `metadataStore`، `writableStore` و `auditSink` مقدار دقیق `true` بدهد و verifier، role provider دارای `resolveRoles()` و authorizer تزریق شده باشند؛ در غیر این صورت 503 عمومی می‌دهد.
- این factory خودش سلامت واقعی Sheets/Firestore را probe نمی‌کند. callback محیط staging/production باید بر پایهٔ initialization/health قابل‌اتکای همان runtime تعریف شود؛ پاسخ ساختگی یا ثابت `true` readiness عملیاتی را ثابت نمی‌کند.
- listener در `src/catalog-http-server.js` مقدار معتبر `PORT` (یا 8080 هنگام نبود آن) و `0.0.0.0` را پیش‌فرض می‌گیرد. در تست‌ها listener واقعی روی `127.0.0.1` و پورت ephemeral اجرا می‌شود. `start()` promise server را می‌دهد و `stop()` اتصال‌ها را می‌بندد؛ entrypoint با SIGINT/SIGTERM توقف کنترل‌شده را درخواست می‌کند.
- composition factory عملیاتی و adapterهای provider آماده‌اند، اما اعتبارسنجی عملیاتی IAM، دسترسی واقعی، backup/monitoring و deployment هنوز انجام نشده است؛ بنابراین listener مستقل deploy-ready تلقی نمی‌شود. علامت نوع provider فقط پیاده‌سازی adapter را مشخص می‌کند و اتصال موفق به Google یا Firestore را ثابت نمی‌کند.

## ساخت runtime تزریق‌پذیر

`createCatalogRuntime()` در `src/catalog-runtime-factory.js` composition تزریق‌پذیر را انجام می‌دهد و این مقادیر را صریحاً می‌خواهد:

- `env.CATALOG_SPREADSHEET_ID`: شناسهٔ Spreadsheet؛ مقدار خالی رد می‌شود و در خطا یا log چاپ نمی‌شود.
- `google`: namespace دارای `auth.GoogleAuth` و `sheets` از `googleapis`. Factory از Application Default Credentials با scope فقط‌خواندنی `https://www.googleapis.com/auth/spreadsheets.readonly` استفاده می‌کند و Sheets client نسخهٔ `v4` می‌سازد.
- `firestore`: یک کلاینت Firestore تزریق‌شده با `collection()` و `runTransaction()`. همان شیء به metadata reader، writable provider و audit sink داده می‌شود. collectionهای پیش‌فرض فقط همان نام‌های تثبیت‌شده در adapterها هستند.
- `verifyAdminPrincipal`, `roleProvider` و `authorizePermission`: همه باید صریحاً تزریق شوند؛ این factory verifier، منبع نقش یا policy واقعی ایجاد نمی‌کند.
- `roleProvider`: یک `CatalogAdminRoleProvider` صریح با متد `resolveRoles(subjectId)`؛ نقش‌های کاربر را پس از تأیید هویت می‌خواند. factory به‌طور خودکار fake یا نقش administrator انتخاب نمی‌کند.
- `readinessCheck`: callback صریح محیط برای readiness؛ صرف ساخته‌شدن clientها یا موفقیت `GoogleAuth.getClient()` دسترسی واقعی را اثبات نمی‌کند.

Factory هیچ `spreadsheets.values.get` یا عملیات دیگری را هنگام ساخت runtime اجرا نمی‌کند. خواندن Sheet فقط هنگام درخواست کاتالوگ رخ می‌دهد. تمام رفتارهای factory با Google/Firestore fake آزمایش می‌شود و هیچ دسترسی ADC واقعی در تست‌ها انجام نمی‌شود.

وابستگی‌های `googleapis` و `@google-cloud/firestore` در manifest و lockfile تعریف شده‌اند. Factory همچنان فقط interface کلاینت Firestore را تزریق می‌گیرد و خودش SDK یا client را نمی‌سازد؛ وجود SDK به‌تنهایی credential، IAM یا database واقعی را تأیید نمی‌کند.

خروجی `createCatalogRuntime()` با `runtimeMode: 'injected'` ساخته می‌شود. `createOperationalCatalogRuntime()` پس از ساخت Firebase Admin با ADC، verifier واقعی و providerهای علامت‌گذاری‌شده آن را به `runtimeMode: 'operational'` ارتقا می‌دهد؛ `catalog:start` فقط همین composition صریح را اجرا می‌کند و در نبود تنظیم معتبر یا ADC fail-closed می‌شود. هیچ fallback حافظه‌ای وجود ندارد و تزریق fakeها هرگز مجوز تغییر mode به `operational` نیست.

در Cloud Run، مقدار `PORT` را میزبان فراهم می‌کند و listener روی `0.0.0.0` گوش می‌دهد. `src/catalog-operational-runtime-factory.js` مقدار معتبر `CATALOG_GCP_PROJECT_ID`، شناسهٔ Spreadsheet و در صورت تعیین `CATALOG_FIRESTORE_DATABASE_ID` را می‌خواهد؛ نبود شناسهٔ database فقط به قرارداد فعلی `(default)` برمی‌گردد. احراز هویت Google باید از ADC هویت workload و حداقل مجوز استفاده کند؛ قرار دادن فایل credential یا کلید در سورس، image، log یا متغیر عمومی بخشی از این طرح نیست. این مستند هیچ credential یا IAM موجودی را تأیید نمی‌کند.

## تفاوت local و production

آزمون محلی از fixture و in-memory providers و verifier جعلی استفاده می‌کند؛ این فقط composition و قرارداد HTTP را می‌آزماید. هیچ credential، IAM، provider عملیاتی، readiness probe واقعی، دامنه، CORS production، quota، monitoring یا backup در این مرحله پیکربندی نشده است. `createCatalogHttpService` به‌تنهایی مجوز استفاده از fake provider در production نمی‌دهد.

## قرارداد آزمایشی نقش مدیر

`verifyAdminPrincipal(request)` فقط هویت تأییدشدهٔ `{ authenticated: true, subjectId }` را برمی‌گرداند. سپس `CatalogAdminRoleProvider.resolveRoles(subjectId)` نقش‌ها را می‌آورد؛ نقش‌های داخل توکن/verifier یا دادهٔ درخواست پذیرفته نمی‌شوند. principal نامعتبر پیش از فراخوانی resolver رد می‌شود. resolver باید آرایه‌ای از roleهای allowlist‌شده برگرداند؛ `[]` برای principal معتبر یعنی assignment ندارد و policy آن را `403` می‌کند. خطای منبع یا آرایهٔ نامعتبر/دارای role ناشناخته با `503 ROLE_RESOLUTION_UNAVAILABLE` fail-closed است. برای گزارش داخلی امن می‌توان `reportRoleResolutionFailure` را تزریق کرد؛ فقط دستهٔ خطا را می‌گیرد و خطای خام، شناسه یا roleها را دریافت نمی‌کند. role provider Firestore در composition عملیاتی تزریق می‌شود؛ `createInMemoryCatalogAdminRoleProvider` فقط fake صریح تست است و provisioning CLI بدون trusted actor فعال نیست.

برای بهره‌برداری production هنوز باید credentials، IAM، readiness مبتنی بر وضعیت واقعی، backup/monitoring و فرایند migration/bootstrap جداگانه بازبینی و تأیید شوند. CLI در نبود تنظیم معتبر متوقف می‌شود و هیچ fake/in-memory provider برای اجرای ظاهراً عملیاتی انتخاب نمی‌کند.

## موارد باقی‌مانده

- تأیید عملیاتی credentials، IAM، project/database و readiness واقعی؛ تست‌ها همچنان فقط fake را به‌کار می‌گیرند.
- bootstrap واقعی نقش administrator و migration/reconciliation هنوز در این entrypoint عمداً expose نشده‌اند.
- readiness probe واقعی، HTTPS، CORS/originها، rate limit و تنظیمات health/runtime.
- انتخاب پروژه و region، هزینه، logging/monitoring، backup/restore و rollback.
- تأیید parity با نسخهٔ فعال Apps Script و سرویس فعلی پیش از اتصال کلاینت‌ها.

هیچ deployment یا اتصال زنده در این مرحله انجام نشده است.

## وضعیت SDK و بررسی اتصال Firestore — 2026-10-26

- SDK رسمی `@google-cloud/firestore@9.4.0` از metadata registry دریافت و با npm به‌عنوان تنها dependency مستقیم جدید اضافه شد. شرط نسخهٔ SDK، Node `>=22` است؛ Node محلی `24.22.1` سازگار است. manifest پروژه همچنان `engines.node >=18` را اعلام می‌کند؛ بنابراین محیط‌های Node 18 تا 21 با این SDK سازگار نیستند و نسخهٔ runtime میزبان Catalog باید پیش از staging جداگانه تأیید شود. Lockfile وابستگی‌های transitives لازم را اضافه کرد؛ بسته‌های قفل‌شدهٔ قبلی تغییر نسخه یا حذف نشدند.
- APIهای موردنیاز از declarationهای همان SDK قابل تطبیق‌اند: `Firestore.collection()`، `Firestore.runTransaction()`، `DocumentReference.get()` و عملیات `Transaction.get/create/set`. `Firestore.runTransaction()` context تراکنش را به callback می‌دهد و sink فعلی context را به‌صورت آرگومان می‌پذیرد. این بررسی فقط سازگاری سطح API و کد است و Providerها را با پایگاه واقعی اجرا نمی‌کند.
- مقصد واقعی Firestore از تنظیم محلی موجود قابل تعیین نیست: runtime factory برای Sheets فقط `CATALOG_SPREADSHEET_ID` دارد و Firestore client را تزریق‌شده می‌خواهد؛ project/database Firestore در قرارداد runtime تعیین نشده‌اند. در بررسی محیط، متغیرهای انتخاب پروژه/database و ADC environment تنظیم نبودند، فایل ADC پیش‌فرض ویندوز وجود نداشت و `gcloud` در دسترس نبود. این نتیجه صرفاً وضعیت همین محیط محلی است و دربارهٔ وجود پروژهٔ آنلاین چیزی ثابت نمی‌کند.
- چون project ID و database موردنظر از تنظیم معتبر و بی‌ابهام قابل تأیید نبودند، client واقعی ساخته نشد، `listCollections()` اجرا نشد و نام هیچ مجموعه‌ای در پایگاه آنلاین بررسی نشد. سند یا محتوای واقعی خوانده یا تغییر داده نشد.
- وضعیت‌ها را جدا نگه دارید: **۱) SDK نصب است؛ ۲) ADC و مقصد Firestore تأیید نشده و بررسی خواندنی واقعی انجام نشده؛ ۳) Providerها، verifier، role source و readiness عملیاتی همچنان نیازمند آماده‌سازی و آزمون مستقل‌اند.** برای مرحلهٔ اتصال، مالک باید project و database دقیق را در تنظیم معتبر runtime مشخص کند و ADC موجود را در همان محیط احراز کند؛ credential یا مقدار آن را در کد/گزارش نگذارید.

## Probe تشخیصی Firestore از محیط سرویس

`src/catalog-operational-runtime-factory.js` فقط هنگام فراخوانی صریح `catalog:start` Firebase Admin را با ADC می‌سازد؛ import شدن module به‌تنهایی client یا listener ایجاد نمی‌کند. `scripts/probe-firestore-readonly.js` ابزار مستقل برای تشخیص مسیر دسترسی است و در این کار اجرا نشده است. فرمان آن `npm run catalog:probe-firestore` است؛ `npm start` همچنان ربات اصلی را اجرا می‌کند.

- برای خود probe، مقدار صریح و معتبر `CATALOG_GCP_PROJECT_ID` و `CATALOG_FIRESTORE_DATABASE_ID` لازم است؛ برخلاف runtime عملیاتی، probe مقدار database را از پیش‌فرض حدس نمی‌زند. اسکریپت project یا database را از ADC یا metadata server حدس نمی‌زند.
- SDK رسمی Firestore از ADC خود محیط اجرا استفاده می‌کند. وجود متغیر credential یا سرویس identity در Render فرض نمی‌شود؛ اپراتور باید پیش از اجرا، ADC را در همان process/container به‌شکل موردتأیید Render فراهم کند. credential نباید در سورس، command line، log یا گزارش چاپ شود.
- تنها درخواست داده‌ای `listCollections()` است؛ هیچ سندی خوانده نمی‌شود و هیچ write API، migration یا تراکنشی فراخوانی نمی‌شود. خروجی فقط یک category و در موفقیت تعداد مجموعه‌هاست؛ شناسه‌های مقصد، نام collectionها، سندها و خطای خام چاپ نمی‌شوند.
- خروجی‌های محدود: `SUCCESS`، `INCOMPLETE_CONFIGURATION`، `AUTHENTICATION_FAILED`، `PERMISSION_DENIED`، `NETWORK_OR_TIMEOUT` یا `UNKNOWN_ERROR`. فرایند برای موفقیت exit code صفر و برای نتیجه‌های دیگر exit code غیرصفر می‌دهد. مهلت خواندن ۱۵ ثانیه است و client در پایان به‌طور محدود terminate می‌شود.
- برای اثبات دسترسی Render، فرمان باید از همان محیط server-side اجرا شود که متغیرهای صریح و ADC معتبر سرویس را می‌بیند (برای نمونه shell/one-off execution موردتأیید در همان service). اجرای محلی از شبکهٔ ایران فقط دسترسی همان دستگاه و شبکه را می‌سنجد و موفقیت یا شکست مسیر Render را ثابت نمی‌کند.

تست `test/firestore-readonly-probe.test.js` از fake constructor صریح استفاده می‌کند؛ هیچ تستی Firestore واقعی یا ADC را فراخوانی نمی‌کند. `SUCCESS` در fake فقط قرارداد ابزار را می‌آزماید، نه دسترسی عملیاتی.
