# ممیزی محلی سازگاری ورود مدیر و کلاینت‌های OXIW

- تاریخ بررسی: 2026-10-26
- هدف: گردآوری شواهد برای تصمیم احراز هویت مدیر Catalog API؛ این سند اتصال یا قابلیت جدیدی را فعال نمی‌کند.
- وضعیت: فقط‌خواندنی؛ deploymentهای آنلاین و رفتار runtime بررسی نشده‌اند.

## دامنه و وضعیت Git

Catalog Core در مسیر `C:\Users\neo\Desktop\Codex\oxiw-catalog-core-worktree`، شاخهٔ `feature/oxiw-catalog-domain-core` و HEAD محلی `f2eeafc` بررسی شد. تغییرات ثبت‌نشدهٔ مراحل قبل حفظ شدند. فایل‌های Apps Script و Android فقط خوانده شدند؛ هیچ build، app، ربات، تست شبکه‌ای یا سرویس آنلاین اجرا نشد.

مسیرهای محلی بررسی‌شده:

- `C:\Users\neo\Desktop\Codex\oxiw-apps-script-local`
- `C:\Users\neo\Desktop\Codex\oxiw-apps-script-live-snapshot`
- `C:\Users\neo\AndroidStudioProjects\WhiteClub`
- `C:\Users\neo\Desktop\Codex\oxiw-main-bot-git-backup-2026-10-15`
- `C:\Users\neo\Desktop\Codex\oxiw-catalog-core-worktree`

هر پنج مسیر هنگام بررسی موجود بودند. وجود snapshot به‌تنهایی همگامی آن با deployment فعال را اثبات نمی‌کند.

## Apps Script و سایت عمومی

### فایل‌ها و جریان قابل مشاهده

| فایل محلی | شواهد کد |
|---|---|
| `oxiw-apps-script-local/Code.gs` | `doGet()` در ابتدای فایل صفحهٔ HTML را می‌سازد؛ `getDataJson()` از حدود خط 186 دادهٔ سایت را می‌خواند؛ `loginUser(phone, password)` از خط 326 اطلاعات حساب را از Sheet کاربران می‌خواند و مقدار ورودی را با مقدار ردیف مقایسه می‌کند؛ `registerUser()` از خط 411 مسیر ثبت حساب را دارد؛ توابع علاقه‌مندی و بازدید نیز سمت سرور قرار دارند. |
| `oxiw-apps-script-local/Index.html` | `logoutUser()` خط 3186، `checkLogin()` خط 3200، `loginUserClient()` خط 3263 و `loadLiveData()` خط 3932. کد مرورگر با `google.script.run` به توابع Apps Script فراخوانی می‌زند. |
| `oxiw-apps-script-local/appsscript.json` | manifest محلی `executeAs=USER_DEPLOYING` و `access=ANYONE_ANONYMOUS` را مشخص می‌کند. این مقادیر پیکربندی snapshot محلی‌اند و نسخه یا تنظیم فعال وب‌اپ را ثابت نمی‌کنند. |

در جریان فعلی، کاربر شماره تلفن و گذرواژه را به تابع Apps Script می‌دهد. تابع سمت سرور ردیف Sheet کاربران را می‌خواند و برابری مقدار را بررسی می‌کند؛ در کد بررسی‌شده verifier توکن Firebase/OIDC، `Session.getActiveUser()`, `Session.getEffectiveUser()` یا نقش مدیر وجود نداشت. مرورگر پس از ورود، نام و شماره را در `localStorage` نگه می‌دارد؛ `checkLogin()` وجود و شکل همین دادهٔ محلی را بررسی می‌کند. این الگو ورود کاربردی کاربران سایت است، نه principal قابل اعتماد برای Catalog Admin API. مقدار گذرواژه یا اطلاعات Sheet در این سند نمایش داده نمی‌شود.

دسترسی Web App و دسترسی به Spreadsheet دو مفهوم جدا هستند: manifest محلی اجازهٔ اجرای Web App را برای anonymous ذکر می‌کند؛ توابع Apps Script با زمینهٔ `USER_DEPLOYING` به Spreadsheet فعال دسترسی می‌گیرند. این تنظیم به معنی شناسایی هویت کاربر مرورگر نیست و اجرای تابع سمت سرور به‌تنهایی کاربر را احراز نمی‌کند. نسخهٔ فعال و مجوز واقعی Spreadsheet باید جداگانه توسط مالک بررسی شود.

در فایل‌های بررسی‌شده صفحه یا تابع مشخصی برای مدیریت metadata کاتالوگ، نقش‌های مدیریتی، approval یا publication دیده نشد. وجود توابع حساب کاربری، علاقه‌مندی، بازدید یا وب‌هوک Telegram، پنل مدیریت کاتالوگ را اثبات نمی‌کند.

### مقایسهٔ پوشهٔ محلی و snapshot

- پوشهٔ قدیمی فایل‌های `Code.gs` و `TelegramBot.gs` دارد؛ snapshot فایل‌های متناظر `Code.js` و `TelegramBot.js` را دارد.
- `Index.html` و `appsscript.json` در هر دو موجودند. دو manifest از نظر بایت برابر بودند؛ هر دو مقدارهای `USER_DEPLOYING` و `ANYONE_ANONYMOUS` دارند.
- فایل‌های HTML و فایل‌های سرورِ متناظر در کل با هم متفاوت‌اند. نام و مجموعهٔ تابع‌های سطح بالا یکسان بود. پس از حذف string literalها برای جلوگیری از چاپ مقدار حساس، بدنهٔ توابع ورود/خروج و بارگذاری اصلی بررسی‌شده در دو نسخه هم‌ساختار بود؛ این مقایسه بررسی رفتار deployment نیست.
- تابع‌های `doGet`, `getDataJson`, `loginUser` و `registerUser` در فایل‌های سرورِ متناظر، و توابع `checkLogin`, `loginUserClient`, `logoutUser`, `getVisitorId`, `loadLiveData` در HTML، پس از پالایش رشته‌ها digest یکسان داشتند.
- `TelegramBot.gs` و `TelegramBot.js` نیز یکسان نبودند؛ تابع‌های ثبت webhook در آن‌ها تفاوت دارند. این تفاوت دربارهٔ مقصد/secret عملیاتی نتیجه‌ای نمی‌دهد و برای تصمیم ورود مدیر شاهدی محسوب نمی‌شود.

در نتیجه، snapshot در سطح فایل‌های کد با پوشهٔ قدیمی کاملاً یکسان نیست. این شواهد هیچ‌کدام مشخص نمی‌کنند کدام نسخه در Apps Script منتشر یا فعال است.

## Android

فایل اصلی بررسی‌شده: `C:\Users\neo\AndroidStudioProjects\WhiteClub\app\src\main\java\com\oxiw\clubwhite\MainActivity.kt`.

- اپ با ساخت `WebView` یک سایت HTTPS را بار می‌کند؛ scheme بررسی شد، URL کامل بازگو نمی‌شود.
- `javaScriptEnabled` و `domStorageEnabled` فعال‌اند. `WebViewClient` و `WebChromeClient` پیش‌فرض تنظیم می‌شوند.
- در `MainActivity.kt` پیاده‌سازی `shouldOverrideUrlLoading`, `CookieManager`, `addJavascriptInterface`, OAuth/Firebase login یا کلاینت مستقیم HTTP/API دیده نشد. وابستگی Firebase Auth، Google Sign-In، OkHttp و Retrofit نیز در `app/build.gradle.kts` پیدا نشد.
- override برای `shouldOverrideUrlLoading` وجود ندارد؛ کد بازکردن لینک خارجی در مرورگر سیستم را صریحاً پیاده نمی‌کند و رفتار runtime بدون اجرا قابل تعیین نیست.
- manifest مجوز اینترنت دارد؛ `usesCleartextTraffic` صریحاً در manifest یافت نشد. دربارهٔ defaults، runtime یا مقصد واقعی فراتر از سورس نتیجه‌گیری نمی‌شود.
- اپ فعلی از دید سورس یک پوستهٔ WebView است؛ ورود جداگانه یا دریافت و انتقال ID token در کد Android موجود نیست.

استفاده از OAuth داخل embedded WebView می‌تواند redirect، cookie/session، تشخیص مرورگر تعبیه‌شده و نگهداری token را پیچیده کند. `localStorage` وب‌سایت در WebView برای نشان‌دادن حالت ورود فعلی استفاده می‌شود، اما نباید محل نگهداری credential یا token مدیریتی جدید فرض شود. token نباید در URL، log، query، clipboard یا پل JavaScript عمومی قرار گیرد.

## ربات اصلی و عملیات مدیریتی موجود

فایل بررسی‌شده: `C:\Users\neo\Desktop\Codex\oxiw-main-bot-git-backup-2026-10-15\index.js`.

- ربات اصلی Google Sheets را برای کاتالوگ می‌خواند و در بخش‌های مختلف برای جریان‌های کاربری/تجاری Sheet می‌نویسد. وجود read/write در ربات به معنی API کاتالوگ مشترک نیست.
- ربات عملیات مدیریتی **پرداخت تلگرامی** دارد: توابعی با نام‌های `showAdminPayments`, `showAdminPaymentDetail`, `approvePayment`, `rejectPayment` و `processCallback` دیده شدند. `isAdmin(chatId)` بررسی جداگانه‌ای بر اساس شناسهٔ Telegram دارد. مقادیر شناسه و تنظیمات چاپ نشده‌اند.
- در فایل، قراردادهای Catalog Core مانند `approvalStatus`, `publicationStatus`, `verifyAdminPrincipal`, `authorizePermission` یا مسیر `/api/v1/admin/catalog` پیدا نشد. بنابراین مدیریت metadata کاتالوگ در ربات وجود ندارد؛ بررسی payment admin را نباید با approval/publication محتوا یکی گرفت.
- در نخستین rollout کاتالوگ، ربات می‌تواند بدون تغییر جریان‌های پرداخت و توکن همچنان Sheets را بخواند؛ مهاجرت خواندن کاتالوگ به API مشترک مرحله‌ای و جداگانه است. این انتخاب نیازمند آزمون parity و تصمیم cutover است.
- Telegram `chatId`/`userId` هویت Firebase مدیر نیست. اگر ربات در آینده به API مدیریتی متصل شود، باید هویت machine-to-machine مستقل و مجوز محدود داشته باشد؛ برای عملیات انجام‌شده به درخواست کاربر Telegram، نگاشت صریح و سمت‌سروری شناسهٔ Telegram به principal/role لازم است. `actorId` نباید از body یا callback data دلخواه گرفته شود. secret وب‌هوک، اگر درخواست را از Telegram معتبر کند، جای نقش و مجوز کاربر را نمی‌گیرد.

## مقایسهٔ گزینه‌های رابط و ورود

| گزینه | سایت عمومی Apps Script | Android WebView | API مدیریتی و نقش سمت سرور | ارزیابی محلی |
|---|---|---|---|---|
| **A. پنل وب مستقل با Firebase Authentication** | ورود پنل از مسیر جدا می‌آید و سایت عمومی فعلی نیاز به تغییر ورود ندارد. backend باید ID token را با Firebase Admin SDK بررسی کند؛ هیچ نقش یا tokenی از client قابل اعتماد نیست. | بهتر است پنل از مرورگر سیستم باز شود، یا در فاز جدا Android native auth استفاده کند. embedded WebView به‌تنهایی جریان Firebase ندارد. | با verifier موجود (`verifyAdminPrincipal`) سازگار است؛ نقش از منبع server-side می‌آید و `authorizePermission` همان policy فعلی را اجرا می‌کند. | گزینهٔ ورود محتمل، اما وابسته به تأیید Firebase project، مدیران و سازگاری کلاینت است. |
| **B. افزودن ورود مدیر به Apps Script فعلی** | UI را در همان `Index.html`/Apps Script نگه می‌دارد، اما سایت اکنون anonymous و دارای login کاربری سفارشی مبتنی بر Sheet/localStorage است. این session را نمی‌توان به‌عنوان هویت مدیر پذیرفت. Firebase JS token باید همچنان در backend مستقل verify شود؛ GAS execution identity یا `google.script.run` مجوز مدیریتی ایجاد نمی‌کند. | WebView می‌تواند همان HTML را ببیند، ولی token/session و redirectهای ورود در WebView ریسک و پیچیدگی بیشتری دارند. کد native فعلی auth ندارد. | فقط با اتصال واقعی یک bearer token معتبر از UI به backend و verification سمت Catalog API می‌تواند امن شود. خود Apps Script مرز مجوز مدیریتی API نیست. | از نظر تغییر UI ممکن است کم‌هزینه به نظر برسد، اما به مسیر عمومی و حساب‌های عادی گره می‌خورد؛ با توجه به وضعیت موجود توصیهٔ نخست نیست. |
| **C. پنل مدیریت جدا از سایت عمومی و Android WebView با backend مشترک** | سایت عمومی دست‌نخورده و anonymous می‌ماند؛ UI مدیر origin و lifecycle جدا دارد. | اپ عمومی می‌تواند بدون login مدیریت بماند. مدیر در ابتدا پنل را با مرورگر سیستم باز می‌کند؛ در صورت نیاز native flow در تصمیم بعدی بررسی می‌شود. | API مشترک token را verify و role را از منبع trusted می‌خواند. public endpoints می‌توانند anonymous و admin endpoints در همان سرویس با middleware محافظت شوند؛ جداسازی سرویس admin فقط در صورت انتخاب IAP/پالیسی میزبان لازم است. | بهترین مرز برای کاهش ریسک و rollout مستقل UI است. می‌تواند از Firebase Auth گزینهٔ A استفاده کند، اما Firebase همچنان مشروط است. |

گزینهٔ A روش هویت و ورود است؛ گزینهٔ C مرزبندی محصول و کلاینت است و می‌تواند A را به‌عنوان provider استفاده کند. در سرویس مشترک عمومی/مدیریتی، IAM/IAP سطح سرویس با permission سطح endpoint فرق دارد؛ محافظت کل سرویس با IAP ممکن است anonymous public API را نیز مسدود کند. در آن صورت مسیرها/سرویس‌ها باید جدا شوند. هیچ‌یک از گزینه‌ها با این ممیزی انتخاب یا پیاده‌سازی نشده است.

## پیشنهاد مشروط و نسبت آن به ADR-0002

شواهد تازه پیشنهاد ADR-0002 را از نظر هویت نامطمئن تقویت می‌کنند: ورود فعلی سایت، طبق سورس، app-level phone/password و localStorage است؛ Android فقط WebView است؛ ربات اصلی نیز Telegram payment admin جدا دارد. هیچ‌یک نقش Catalog Admin API را تأمین نمی‌کنند.

پیشنهاد اجرایی مشروط: **گزینهٔ C به‌عنوان مرز رابط مدیریت مستقل، همراه با Firebase Authentication از گزینهٔ A به‌عنوان نامزد IdP**؛ verifier سمت Catalog API Firebase ID token را بررسی کند و نقش‌ها را از منبع server-side مورداعتماد بخواند. ورود و تجربهٔ Android در ابتدا به WebView عمومی اضافه نشود. برای ربات اصلی، در صورت نیاز به خواندن Catalog API، مسیر anonymous read یا workload identity محدود جدا از نقش مدیر باشد. این پیشنهاد به معنی فعال‌بودن Firebase، داشتن حساب مدیر، آماده‌بودن verifier یا تأیید نهایی گزینه نیست.

پیشنهاد کلی نیاز به بازنگری ندارد، اما دامنه‌اش دقیق‌تر می‌شود: ساخت پنل مستقل مقدم بر افزودن login مدیریتی به سایت عمومی است. تصمیم نهایی Firebase در برابر IAP/IdP دیگر باز می‌ماند تا مالک ورود و هویت مدیران را تعیین کند.

## تصمیم‌های باز و پیش‌نیازها

1. فهرست مدیران و شناسهٔ پایدار هرکدام؛ آیا ورود Firebase و حساب‌های شخصی قابل قبول‌اند؟
2. روش ورود فعلی و نسخهٔ منتشرشدهٔ Apps Script؛ این از snapshot یا manifest محلی اثبات نمی‌شود.
3. مالک، منبع، schema، فرایند بازبینی و لغو roleها؛ ترجیح فعلی نقش server-side است تا تغییر role وابسته به عمر claim نباشد.
4. نحوهٔ دسترسی مدیر از موبایل: مرورگر سیستم برای پنل مستقل، یا نیاز واقعی به جریان native Android.
5. انتخاب Firebase، IAP با جداسازی route/service، یا IdP/OIDC دیگر؛ هزینه و dependencyهای backend.
6. مجازبودن عمومی API روی میزبان، originهای دقیق CORS، session/bearer model، MFA، rate limit و فرایند revoke.
7. نقش ربات اصلی: آیا فقط read کاتالوگ از API می‌خواهد یا عملیات مدیریتی؟ سورس فعلی فقط payment admin تلگرامی را نشان می‌دهد؛ نیاز مدیریتی Catalog برای ربات اثبات نشده است.

## معیارهای پذیرش احراز هویت در مرحلهٔ پیاده‌سازی آینده

- backend فقط token صادرشده از issuer و audience تصویب‌شده را با SDK معتبر بررسی کند؛ `exp`, امضا، issuer، audience و خطاهای verifier آزمون شوند.
- user identity پایدار از principal اعتبارسنجی‌شده بیاید؛ roles فقط از claim امضاشدهٔ موردتأیید یا منبع server-side مورداعتماد بیایند، نه request fields.
- نبود/انقضای/اعتبار نامعتبر token و خطای role lookup همگی fail-closed شوند؛ verifier/policy خطای داخلی را افشا نکنند.
- roleها حداقل دسترسی داشته باشند؛ `observer`, `editor`, `approver`, `publisher`, `taxonomy_manager`, `administrator` در عملیات واقعی آزمون شوند. approval و publication مجوز جدا دارند.
- `actorId` audit از subject تأییدشده باشد. token، cookie، گذرواژه و credential در URL، body ذخیره‌شده، log یا audit ننشینند.
- API عمومی anonymous باقی بماند مگر تصمیم مالک خلاف آن باشد؛ هر route مدیریتی مستقل از UI در backend محافظت شود.
- CORS فقط originهای لازم را بپذیرد؛ اگر cookie/session انتخاب شد CSRF نیز بررسی شود. CORS به‌تنهایی authentication نیست.
- توکن در URL یا `localStorage` عمومی قرار نگیرد. برای Android، مرورگر سیستم و redirect امن یا native SDK با توکن کوتاه‌عمر در `Authorization` ارزیابی شود؛ bridge ناامن JavaScript به native به‌کار نرود.
- تست‌های fake قبلی تنها قرارداد policy را می‌سنجند؛ پذیرش عملیاتی به verifier واقعی در staging، آزمون revoke، مرور امنیتی و مجوز جداگانهٔ deploy نیاز دارد.

## قرارداد آزمایشی بازیابی نقش

در Catalog Core قرارداد identity verification و role resolution اکنون جداست. این توضیح، seam اجرایی را دقیق می‌کند؛ ADR-0002 همچنان پیشنهاد معماری مشروط است و در این مرحله بازنویسی نشده:

1. verifier فقط `{ authenticated: true, subjectId }` را پس از تأیید هویت می‌سازد. `subjectId` باید پایدار باشد. هر فیلد اضافه مانند `roles` در خروجی verifier پذیرفته نمی‌شود.
2. پس از موفقیت verifier، API فقط `subjectId` را به `CatalogAdminRoleProvider.resolveRoles(subjectId)` می‌دهد. body، query، cookie و header عادی منبع نقش نیستند.
3. assignment غایب یا آرایهٔ خالی برای هویت معتبر به مجوزی منجر نمی‌شود (`403`). نقش ناشناخته/تکراری یا شکل دادهٔ نامعتبر و نیز exception منبع به‌صورت fail-closed پاسخ `503 ROLE_RESOLUTION_UNAVAILABLE` می‌گیرند؛ جزئیات خام نمایش داده نمی‌شوند. برای گزارش داخلی می‌توان `reportRoleResolutionFailure` را تزریق کرد؛ این callback فقط دستهٔ خطا (`provider_error` یا `invalid_assignment`) را می‌گیرد و شناسه، roleها یا خطای خام دریافت نمی‌کند.
4. policy موجود و مجوزهای جداگانهٔ مشاهده، ویرایش، approval، publication و taxonomy دست‌نخورده‌اند. actor audit همچنان از subject تأییدشده گرفته می‌شود.
5. `createInMemoryCatalogAdminRoleProvider` فقط fake صریح تست است. Firestore role store، Firebase claim mapping، collection/schema، فهرست مدیران و فرایند provisioning/revoke پیاده‌سازی نشده‌اند؛ Runtime Factory بدون resolver صریح runtime را نمی‌سازد و resolver حافظه‌ای را خودکار انتخاب نمی‌کند.

این تغییر پیشنهاد ADR-0002 را به تصمیم عملیاتی تبدیل نمی‌کند. Firebase Auth، backend verifier، role source قابل اعتماد و شیوهٔ ورود کلاینت‌ها همچنان نیازمند انتخاب و setup جداگانه‌اند.

## محدودیت شواهد

این گزارش فقط از فایل‌های محلی نام‌برده استخراج شده است. manifest یا snapshot محلی وضعیت deployment، دامنه، کاربران واقعی، تنظیمات Firebase/IAP، نقش‌های آنلاین، secretهای میزبان یا نسخهٔ فعال ربات را ثابت نمی‌کند. هیچ credential، token، URL کامل یا مقدار محرمانه در این سند ثبت نشده است.
