# ADR-0002: احراز هویت و مجوزدهی مدیر Catalog API

- وضعیت: **پیشنهاد معماری مشروط؛ composition و verifier آفلاین پیاده‌سازی شده، تأیید عملیاتی نشده است**
- تاریخ: 2026-10-26
- مرتبط: ADR-0001، `CATALOG_API_V1.md`، `src/catalog-admin-api.js`

## زمینه و شواهد محلی

Catalog API مسیر عمومی و مسیر مدیریتی را در یک Express app ترکیب می‌کند. API عمومی برای خواندن کاتالوگ طراحی شده و می‌تواند بدون ورود کاربر ارائه شود؛ مسیرهای `/api/v1/admin/catalog` برای خواندن metadata مدیریتی و تغییر metadata، تأیید، انتشار، دسته‌ها و taxonomy هستند.

`createCatalogAdminApi({ writableProvider, verifyAdminPrincipal, authorizePermission })` دو seam موجود را به‌کار می‌گیرد. verifier از request یک principal مورداعتماد برمی‌گرداند؛ API آن را به شکل محدود `{ authenticated: true, subjectId, roles }` نرمال می‌کند. policy مجوز لازم برای هر عملیات را بررسی می‌کند. نبود verifier/policy، principal نامعتبر یا خطای آن‌ها fail-closed است. نقش از body، query یا header معمولی ساخته نمی‌شود. actor رخداد audit از `principal.subjectId` می‌آید. نقش‌ها و policy محلی در `src/catalog-admin-authorization.js` فقط قرارداد و پیاده‌سازی آزمایشی‌اند.

`src/catalog-runtime-factory.js` وابستگی‌ها را از caller می‌گیرد و runtime تزریق‌شده می‌سازد؛ `src/catalog-operational-runtime-factory.js` نیز composition صریح Firebase Admin، ADC، verifier با بررسی revoked token و role provider را آماده می‌کند. این کد هنوز project/ADC/IAM واقعی، حساب مدیر، staging یا deployment را اثبات نمی‌کند. Apps Script، سایت و Android در این بررسی به endpoint مدیریتی متصل نشده‌اند.

## تصمیم پیشنهادی

**پیشنهاد مشروط: Firebase Authentication برای ورود کاربر و Firebase Admin SDK در backend برای اعتبارسنجی ID token؛ مجوزها از منبع نقش سمت سرور خوانده شوند.** API عمومی anonymous باقی بماند؛ احراز هویت فقط در middleware مسیر مدیریتی اعمال شود. Cloud Run/IAM برای محدودکردن دسترسی سرویس و هویت workload لایهٔ جداگانه‌ای است و جای verifier و policy سطح endpoint را نمی‌گیرد.

این گزینه فقط پس از تأیید روش ورود مشترک سایت و Android، امکان دریافت و ارسال امن ID token از هر دو کلاینت، مالکیت Firebase project، هزینه و روش نگهداری/ویرایش نقش‌ها انتخاب نهایی می‌شود. اگر این شرایط برقرار نیست، تصمیم باز می‌ماند و باید گزینهٔ IAP با سرویس مدیریتی جداگانه یا IdP دیگری ارزیابی شود. هیچ Firebase، IAP، حساب یا پروژه‌ای در این ADR ایجاد یا پیکربندی نشده است.

### چرا این گزینه، مشروط به بررسی کلاینت‌ها

- verifier سمت Node می‌تواند توکن صادرشده برای مخاطب مورد انتظار را با SDK مورد اعتماد بررسی و principal را در مرز فعلی `verifyAdminPrincipal(req)` تولید کند؛ خود Catalog Admin API تغییر قرارداد نمی‌خواهد.
- Firebase Auth مسیرهای وب و Android دارد و از نظر مفهومی می‌تواند برای ورود مدیر مشترک باشد؛ اما روش فعلی سایت Apps Script و ماهیت Android WebView در کدهای محلی اثبات نشده‌اند. نحوهٔ انتقال token در WebView باید جداگانه طراحی و تهدیدسنجی شود.
- نقش سمت سرور امکان تغییر و لغو دسترسی بدون اتکا به claim قدیمی در توکن را فراهم می‌کند؛ بهای آن یک lookup مجاز و قابل اتکا در هر درخواست مدیریتی است.
- API عمومی می‌تواند همچنان بدون Firebase login خواندنی باشد. در صورت عمومی‌بودن Cloud Run service، middleware مدیریتی باید روی همهٔ routeهای مدیریتی اجرا شود و دسترسی ناشناس را رد کند.

## گزینه‌ها

| گزینه | سازگاری با اجزای OXIW | مرز سرویس و endpoint | محدودیت‌ها و پیش‌نیازها |
|---|---|---|---|
| **۱. Firebase Authentication + Firebase Admin SDK** | مناسب برای Node API و بالقوه مشترک برای وب و Android. سایت Apps Script و WebView باید ورود، refresh و ارسال bearer ID token را پیاده کنند؛ این سازگاری هنوز تأیید نشده است. ربات اصلی فقط در صورت نیاز machine-to-machine هویت جدا می‌گیرد؛ کاربر انسانی یا ربات دانلود نباید با نقش مدیر مخلوط شوند. | Firebase ID token در middleware endpoint مدیریتی بررسی می‌شود. API عمومی می‌تواند anonymous بماند. Cloud Run invocation/IAM لایهٔ جداست؛ مجوز سرویس به‌تنهایی مجوز `catalog.*` نمی‌دهد. | نیازمند Firebase project/tenant، تنظیم کلاینت‌های web و Android، SDK سمت سرور، مدیریت نقش قابل اعتماد، فرایند دعوت/حذف مدیر، هزینه و آزمون refresh/revocation است. هیچ‌یک اکنون آماده فرض نمی‌شود. |
| **۲. Identity-Aware Proxy (IAP)** | می‌تواند برای یک سرویس یا مسیرِ پشت proxy دسترسی مبتنی بر هویت فراهم کند. برای Apps Script و WebView باید redirect/session، دامنه و دسترسی کاربر بررسی شود. ربات اصلیِ server-to-server به روش جداگانه نیاز دارد. | IAP در مرز ورودی سرویس/پروکسی است، نه policy نقش‌های داخلی Catalog. اگر public API و admin API روی همان سرویسی باشند که IAP کل آن را می‌بندد، خواندن anonymous هم بسته می‌شود. محافظت route مدیریتی به routing/proxy مناسب یا ترجیحاً سرویس مدیریتی جداگانه نیاز دارد؛ درون API همچنان authorization مجوزها لازم است. | به پیکربندی میزبان، دامنه، identity/group policy و تجربهٔ login مرورگر نیاز دارد. جریان IAP از Android WebView و Apps Script هنوز اثبات نشده است. جداسازی سرویس‌ها پیچیدگی و هزینهٔ عملیاتی می‌افزاید. |
| **۳. Google/OIDC با verifier اختصاصی** | قابل اتصال به Node و در صورت داشتن login سازگار به سایت/Android؛ سرویس‌دهندگان مختلف و audienceها باید دقیقاً تعیین شوند. ربات اصلی باید هویت workload جدا داشته باشد. | اعتبارسنجی امضا و claimها در middleware سطح endpoint انجام می‌شود؛ IAM/IAP سطح سرویس را جداگانه کنترل می‌کنند. برای سرویس مختلط public/admin، route عمومی همچنان anonymous می‌ماند و admin token لازم دارد. | باید issuer، audience، امضا/JWKS، انقضا، الگوریتم‌های مجاز، چرخش کلید، nonce/flow، replay و mapping پایدار subject را با کتابخانهٔ معتبر کنترل کرد. verifier دست‌ساز یا بررسی رشته‌ای JWT قابل قبول نیست. انتخاب IdP و library هنوز توجیه یا تصویب نشده است؛ سطح نگهداری و خطر پیاده‌سازی بیشتر است. |
| **۴. کلید مشترک ثابت برای مدیر انسانی** | برای سایت، Android WebView و ربات‌ها یک secret مشترک می‌طلبد؛ کلید داخل client قابل استخراج و بازپخش است. | کلید معمولاً فقط bearer secret است و هویت شخص، نقش و مرز بین سرویس و endpoint را اثبات نمی‌کند. اگر در سرویس مختلط استفاده شود، برای API عمومی هم خطر نشت/استفادهٔ مجدد ایجاد می‌کند. | **برای ورود و مدیریت انسانی رد می‌شود.** rotation، لغو دسترسی یک فرد، MFA، انتساب actor و audit فردی را فراهم نمی‌کند. secret مشترک داخل اپ یا سایت محرمانه نمی‌ماند. برای machine-to-machine نیز باید هویت مجزای قابل چرخش و محدودشده طراحی شود، نه کلید مدیر انسانی. |

## سطح سرویس در برابر سطح endpoint

- **احراز هویت سطح سرویس** تعیین می‌کند چه کسی اجازهٔ رسیدن به سرویس/رابطهٔ Cloud Run را دارد؛ نمونهٔ آن IAM یا IAP است. این لایه می‌تواند همهٔ مسیرها را ببندد، اما از روی role داخل محصول نمی‌فهمد کاربر مجاز به تأیید یا انتشار هست یا نه.
- **احراز هویت و مجوز سطح endpoint** در API، توکن کاربر را اعتبارسنجی می‌کند، principal می‌سازد و policy موجود را برای permission مشخص اجرا می‌کند. برای سرویسی که API عمومی anonymous و API مدیریتی را با هم میزبانی می‌کند، این لایه لازم است حتی اگر ورودی سرویس نیز محدود شده باشد.
- اگر IAP کل سرویس را محافظت کند، API عمومی anonymous دیگر anonymous نخواهد بود. برای حفظ آن باید مسیرهای public و admin در ورودی یا سرویس‌های جدا طوری route شوند که قاعدهٔ IAP فقط admin را محدود کند؛ این طراحی عملیاتی هنوز انتخاب نشده است.
- هویت workload ربات اصلی برای خواندن یا فراخوانی مجاز، در صورت نیاز، credential machine-to-machine جدا می‌خواهد. آن هویت هرگز به roleهای مدیر انسانی نگاشت نمی‌شود. ربات دانلود خارج از دامنهٔ Admin API باقی می‌ماند.

## قرارداد principal و اتصال به کد موجود

1. فقط verifier مورداعتماد میزبان/SDK token را از محل مشخص و امن درخواست می‌گیرد و صحت امضا، issuer، audience، زمان انقضا و وضعیت لازم را بررسی می‌کند. verifier بعد از اعتبارسنجی، principal حداقلی می‌سازد؛ API token خام را به policy یا audit نمی‌دهد.
2. `subjectId` از شناسهٔ پایدار صادرکنندهٔ هویت می‌آید (برای Firebase، UID معتبر پس از verify)، نه از body/query/header کاربر. شکل آن باید با محدودیت فعلی principal سازگار یا با تغییر مستند و آزموده‌شده توسعه داده شود.
3. `roles` در principal از منبع مورداعتماد تأمین می‌شود. پیشنهاد این ADR: منبع نقش سمت سرور و قابل تغییر/لغو باشد؛ middleware فقط پس از lookup موفق، نقش‌های allowlist‌شده را به قرارداد موجود تحویل دهد.
4. `authorizePermission(principal, permission)` همچنان policy مستقل و deny-by-default است. `observer` فقط خواندن مدیریتی دارد؛ `editor` ویرایش metadata؛ `approver` تأیید/رد؛ `publisher` انتشار/لغو انتشار؛ `taxonomy_manager` مدیریت taxonomy و دسته‌ها؛ `administrator` همهٔ مجوزهای تعریف‌شده. این ماتریس از کد محلی تأیید می‌شود، ولی تخصیص افراد/نقش واقعی هنوز تصمیم مالک است.
5. تأیید و انتشار مجوزهای مجزا هستند. مجازبودن عملیات مجوز دامنه‌ای `approvalStatus=approved AND publicationStatus=published` را دور نمی‌زند. API همین policy را در Core/provider نگه می‌دارد.
6. actor رخداد audit فقط از `principal.subjectId` نرمال‌شده می‌آید. نقش ادعایی کلاینت، `actorId` ارسالی، توکن خام، ایمیل/PII غیرضروری و credential وارد audit نمی‌شوند.
7. verifier مفقود، توکن بدامضا/منقضی/با audience نادرست، lookup نقش ناموفق، نقش ناشناخته یا خطای verifier/policy باید رد شود. خطای داخلی نباید جزئیات token، کلید یا stack را برگرداند. هیچ identity/role از body، query یا header عادی قابل اعتماد نیست.

### نقش داخل توکن یا منبع سمت سرور

| روش | مزیت | محدودیت و خطر |
|---|---|---|
| claim نقش در ID token امضاشده | یک lookup کمتر و تأخیر کمتر؛ policy نقش را با principal یک‌جا دریافت می‌کند. Claim فقط وقتی معتبر است که issuer و token به‌درستی verify شوند و claim فقط از سرویس privileged صادر شده باشد. | تغییر/لغو نقش ممکن است تا صدور توکن تازه یا انقضای token قدیمی دیده نشود. Custom claim جای فهرست مدیران و فرایند revoke را نمی‌گیرد. نباید role claim از کلاینت پذیرفته شود. |
| نقش از منبع سمت سرور پس از verify هویت | تغییر و لغو نقش سریع‌تر اثر می‌کند؛ انتخاب نقش تحت کنترل backend/مالک است؛ نقش‌ها می‌توانند مستقل از session باشند. | هر درخواست مدیریتی به lookup نیاز دارد؛ دسترس‌پذیری/تأخیر منبع نقش، cache، consistency و audit تغییر نقش باید طراحی شود. خطای lookup باید fail-closed باشد. |

پیشنهاد فعلی منبع سمت سرور است، به شرط انتخاب محل امن و پایداری که مالک بتواند نقش‌ها را بازبینی و لغو کند. محل، schema، مدیران، cache TTL و عملیات تغییر نقش باز هستند؛ نام collection یا claim جدید در این ADR فرض نمی‌شود. اگر بعداً claim امضاشده انتخاب شد، lifetime، refresh، token revocation و پنجرهٔ باقی‌ماندن نقش قدیمی باید معیار پذیرش مستقل داشته باشند.

## جریان پیشنهادی ورود و درخواست

```text
مدیر → ورود در IdP تأییدشده → کلاینت ID token کوتاه‌عمر را می‌گیرد
      → درخواست HTTPS به /api/v1/admin/catalog با Authorization: Bearer <token>
      → verifier سمت سرور token را بررسی می‌کند و subject پایدار را می‌سازد
      → backend نقش‌های allowlist‌شده را از منبع مورداعتماد می‌خواند
      → principal حداقلی به policy موجود داده می‌شود
      → permission همان عملیات بررسی می‌شود
      → API اعتبارسنجی، ETag/transaction را اجرا و actor معتبر را audit می‌کند
```

مسیر عمومی `/api/v1/catalog` می‌تواند بدون ورود بماند. هیچ token در URL، query، local fixture، log، پیام خطا یا body ثبت نمی‌شود. روش ذخیرهٔ session/token در Apps Script و Android WebView تا تصویب threat model کلاینت تعیین نشده است.

## تهدیدها و کنترل‌های لازم

- سرقت token از WebView/storage/log: کوتاه‌عمر، TLS، عدم log، storage امن کلاینت، logout/refresh و سیاست XSS/CSRF متناسب با bearer یا cookie flow.
- token معتبر با audience/issuer نادرست: audience و issuer دقیق و allowlist‌شده؛ اعتبارسنجی امضا/الگوریتم و انقضا با SDK معتبر.
- نقش قدیمی یا ارتقای نقش توسط کاربر: نقش فقط از token تأییدشده یا منبع سمت سرور؛ برای پیشنهاد حاضر منبع سمت سرور، fail-closed و مسیر revoke.
- اشتباه‌گرفتن IAP/IAM با role محصول: کنترل سرویس و permission endpoint جداگانه آزموده شوند.
- API عمومی روی سرویس عمومی: همهٔ routeهای مدیریتی باید middleware را اجرا کنند؛ مسیرهای ناشناخته و خطاهای verifier رد شوند.
- credential service account در client: ممنوع؛ هویت workload backend با least privilege جدا از هویت انسانی است.
- CSRF در صورت cookie-based login، CORS و origin spoofing: فقط پس از انتخاب session model، origin allowlist و CSRF mitigation آزموده شوند؛ CORS به‌تنهایی مجوز نیست.
- replay، brute force و سوءاستفاده از endpoint: rate limit، audit، alert، token revocation و پاسخ عمومی بی‌جزئیات لازم‌اند.

## پیش‌نیازهای تصمیم و اجرا

پیش از انتخاب نهایی مالک باید مشخص کند:

1. حساب‌های مدیر چه کسانی هستند، آیا حساب مشترک/Workspace دارند، و ورود فعلی یا مطلوب سایت و Android چیست.
2. آیا هر دو کلاینت می‌توانند از Firebase Authentication استفاده کنند؛ به‌ویژه سازگاری WebView، callback/redirect، token refresh و logout.
3. روش تأمین، بازبینی، تغییر و لغو نقش‌ها و مالک عملیاتی آن؛ آیا منبع نقش server-side موجودی هست یا باید جداگانه ایجاد شود.
4. اینکه API عمومی و admin در یک Cloud Run service بمانند یا برای IAP، جداسازی سرویس/مسیر انتخاب شود.
5. هزینه و dependencyهای مجاز برای Firebase Admin SDK، پروژه/tenant، region، logging، rate limit و backup؛ هیچ‌کدام در این مرحله ایجاد نشده‌اند.
6. CORS/originهای واقعی سایت و Android، session model، MFA، retention audit و رویهٔ incident/revoke.

## Rollout پیشنهادی و معیار توقف

1. **تثبیت نیازمندی‌ها:** مالک، مدیران، کلاینت‌ها، IdP، subject پایدار، منبع نقش و ماتریس role/permission را تأیید کند. توقف اگر ورود یا مالک نقش معلوم نیست.
2. **نمونهٔ verifier آفلاین:** `src/firebase-admin-id-token-verifier.js` با Firebase Admin Auth و آزمون token معتبر/منقضی/لغوشده/خطای verifier آماده است؛ هیچ token واقعی در fixture قرار نمی‌گیرد. پذیرش staging و تنظیمات IdP هنوز جداگانه لازم است.
3. **منبع نقش و audit:** تغییر/لغو نقش، actor معتبر و عدم پذیرش role client را در محیط محلی/آزمایشی پوشش بده؛ fail-closed در نبود role source معیار پذیرش است.
4. **Staging جداگانه پس از مجوز مالک:** verifier واقعی، CORS/session، secret handling، service identity و policy با حداقل دسترسی تنظیم شود؛ routeهای public/admin و نقش‌های کم‌دسترسی آزمون پذیرش شوند. توقف اگر readiness واقعی، logging امن یا revoke کار نمی‌کند.
5. **اتصال تدریجی کلاینت‌ها:** ابتدا یک مدیر آزمایشی و یک client، سپس Apps Script/Android مطابق روش ورود تصویب‌شده؛ مسیر rollback به API قبلی برقرار باشد. هیچ token یا role مدیریتی در build عمومی قرار نگیرد.
6. **بازبینی و rollout تولید:** تأیید امنیت، backup/restore و عملیات revoke؛ سپس مجوز جداگانهٔ استقرار. این ADR به‌تنهایی اجازهٔ اتصال یا deployment نیست.

## وضعیت تصمیم‌ها

- **پیشنهاد مشروط:** Firebase Authentication + Firebase Admin ID-token verification، نقش server-side و authorization در endpoint. API عمومی anonymous می‌ماند.
- **باز:** انتخاب Firebase در برابر IAP/split-service یا IdP دیگر؛ وضعیت ورود فعلی Apps Script و Android؛ مدیران واقعی؛ منبع/مالک نقش؛ هزینه و dependency؛ محل استقرار و سیاست token/session.
- **انجام‌نشده:** project/credential/IAM واقعی، حساب مدیر، staging acceptance، تنظیم IAM/IAP/Firebase و deployment؛ کد verifier و composition به‌تنهایی اتصال زنده یا هویت فراخواننده را اثبات نمی‌کنند.
- **حکم امنیتی:** کلید مشترک ثابت برای مدیر انسانی انتخاب نمی‌شود. هیچ‌یک از fakeهای محلی اثبات احراز هویت عملیاتی نیستند.
