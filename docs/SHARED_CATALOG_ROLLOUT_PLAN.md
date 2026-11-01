# برنامهٔ rollout کاتالوگ مشترک OXIW

وضعیت: **طرح اجرایی پیشنهادی؛ هیچ مرحلهٔ عملیاتی در این نوبت اجرا نشده است.**

این برنامه بر ADR-0001 و قرارداد `CATALOG_API_V1.md` تکیه دارد. ساختار Google Sheets فعلی تغییر نمی‌کند. سرویس فعال تا عبور از gateهای پذیرش منبع ارائهٔ محتوا باقی می‌ماند. نبود پیکربندی در فایل‌های محلی، نبود سرویس آنلاین را ثابت نمی‌کند.

## اصول مشترک و gateهای غیرقابل‌حذف

- Sheets موجود، source of truth فیلدهای پایه است؛ metadata از storage جدا می‌آید.
- Catalog API سمت سرور composition و projection را انجام می‌دهد. کلاینت‌ها فقط قرارداد عمومی را می‌خوانند.
- انتشار عمومی تنها با زوج معتبر `approvalStatus=approved` و `publicationStatus=published` مجاز است. وضعیت‌های قدیمی حدس زده نمی‌شوند.
- نویسندهٔ مدیریتی بدون principal معتبر از verifier مورداعتماد و مجوز لازم fail-closed است. identity/role از ورودی عادی HTTP پذیرفته نمی‌شود.
- نوشتن با ETag/version و audit سازگار حفظ می‌شود؛ audit و تغییر داده باید در provider پایدار اتمیک باشند.
- ربات دانلود از کاتالوگ/پنل مدیریت جدا می‌ماند؛ این rollout مجوز مهاجرت پرداخت یا download-token نیست.
- هیچ staging/production اتصال یا تغییر webhook بدون تأیید جداگانه انجام نمی‌شود.

## مرحلهٔ ۱ — تثبیت قرارداد API و baseline

**پیش‌نیازها:** تأیید ADR، بررسی review تغییرهای محلی مرحله‌های ۱۰ تا ۱۳، تعیین owner قرارداد و نمونه‌های ساختگی کافی.

**کارها:** قرارداد عمومی و مدیریتی، schema validation، خطاها، فیلترها، pagination، ETag، principal seam، taxonomy و DTO allowlist را تثبیت کن. آزمون‌های Core/API/Provider و end-to-end محلی را اجرا کن. تعریف baseline از شناسه‌ها و پاسخ‌های فعلی را با fixtureها مستند کن؛ دادهٔ واقعی را وارد fixture یا Git نکن.

**آزمون‌ها:** `node --test`؛ syntax checks؛ `git diff --check`; منفی‌های approval/publication، stale ETag، duplicate identity، untrusted role، provider failure و DTO leakage.

**پذیرش:** قرارداد یک نسخهٔ مشخص دارد؛ تمام رفتارهای مستند آزمون می‌شوند؛ routeهای عمومی فقط read هستند؛ نوشتن به Sheets وجود ندارد؛ تغییرات قبلی حفظ شده‌اند.

**خطر/توقف:** ناسازگاری نسخهٔ API، هویت کلید محتوا، نقش‌ها یا تفاوت رفتار آزمون با قرارداد. تا حل آن‌ها هیچ کلاینتی متصل نشود.

## مرحلهٔ ۲ — انتخاب و آماده‌سازی امن محیط سرویس (مجوز جداگانه)

**پیش‌نیازها:** تأیید مالک برای گزینهٔ میزبانی، حساب/پروژه، region، budget cap، مالک عملیات، DNS/domain و دسترسی‌های لازم. این‌ها اکنون تأییدشده نیستند.

**کارها:** بر اساس ADR، گزینهٔ هدف Cloud Run + Firestore را با Render + Firestore و Apps Script مقایسهٔ هزینه/عملیات نهایی کن. پروژهٔ staging، runtime، secret storage، log redaction، health/readiness، quota/alerts، backup/restore و retention را فقط پس از مجوز جداگانه ایجاد کن. در CI فقط secret references قرار گیرند.

**آزمون‌ها:** IaC/config review، secret scanning، permissions review، restore drill در sandbox، health check و نبود credential در image/log.

**پذیرش:** مالک پلتفرم، region و هزینه را تأیید کرده؛ سرویس staging ایزوله و قابل rollback است؛ هیچ production route یا webhook تغییر نکرده است.

**خطر/توقف:** billing نامعلوم، region/محل دادهٔ نامناسب، نبودن backup/monitoring، credential قابل چرخش نیست، یا محیط staging از production جدا نیست.

## مرحلهٔ ۳ — احراز هویت واقعی مدیر و مجوزها

**پیش‌نیازها:** انتخاب IdP و verifier، فهرست مدیران، مالک نقش‌ها، MFA/session policy، CORS originها و فرایند لغو دسترسی. authorization آزمایشی موجود به‌تنهایی کافی نیست.

**کارها:** verifier واقعی سمت backend پیاده و با principal معتبر به policy تزریق شود. سطح دسترسی GET مدیریتی، metadata write، approval، publication، category و taxonomy جدا بماند. مدیر/actor فقط از principal تأییدشده به audit برسد. هیچ role از Android/WebView، body، query یا header عادی پذیرفته نشود.

**آزمون‌ها:** verifier نامعتبر/منقضی، نبود identity، نقش کم‌دسترسی، دست‌کاری client claims، cross-origin، CSRF در صورت cookie-based auth، rate limits و audit actor.

**پذیرش:** verifier و policy در staging fail-closed؛ عملیات هر role مطابق ماتریس مجوز؛ secret/credential در client نیست؛ آزمون‌های منفی و audit مستقل review شده‌اند.

**خطر/توقف:** منبع principal مورداعتماد مشخص نیست، نقش‌ها قابل revoke نیستند، policy در client اجرا می‌شود یا endpoint نوشتنی anonymous باقی می‌ماند.

## مرحلهٔ ۴ — اتصال آزمایشی Sheets و Firestore با حداقل دسترسی

**پیش‌نیازها:** مرحله‌های ۱ تا ۳ پذیرفته؛ spreadsheet فعال و دسترسی مالکانهٔ آن read-only تأییدشده؛ Firestore staging و IAM مجزا و تأییدشده؛ دادهٔ metadata آزمایشی با تصمیم صریح دربارهٔ محتوا.

**کارها:** فقط backend staging، Sheets provider را با scope/read permission حداقلی به برگه‌های تأییدشده وصل کند. metadata provider و audit sink به Firestore staging تزریق شود. هیچ ساختار/سلول Sheet تغییر نکند. قبل از انتشار، duplicate/empty systemCode و missing metadata را گزارش کن و برای هیچ محتوایی approval یا publication نساز.

**آزمون‌ها:** connectivity read-only؛ header/row parsing؛ stale/duplicate identities؛ transaction conflict؛ audit atomicity؛ دو status مستقل؛ metadata غایب/نامعتبر؛ Sheets quota/error handling؛ cache invalidation.

**پذیرش:** سرویس staging به داده‌های موردتأیید دسترسی حداقلی دارد؛ هیچ write به Sheet رخ نمی‌دهد؛ audit و version با Firestore fake و staging proof برقرارند؛ metadata فاقد تأیید عمومی نیست.

**خطر/توقف:** spreadsheet/نسخهٔ فعال نامعلوم، permission بیش‌ازحد، row identity collision، rate/quota یا mapping فیلد نامشخص. بر اساس نام ستون‌ها حدس نزن.

## مرحلهٔ ۵ — استقرار staging و آزمون پذیرش

**پیش‌نیازها:** release candidate بازبینی‌شده، stage 2–4، مالک آزمون و معیار rollback.

**کارها:** سرویس مستقل staging را deploy کن؛ هیچ webhook یا consumer production را عوض نکن. تست قراردادی و E2E با دادهٔ ساختگی انجام بده. در صورت مجوز read-only، خروجی قابل‌نمایش فعلی و خروجی candidate را با شناسه‌های پایدار مقایسه کن؛ محتوای تأییدنشده/نامشخص باید در API عمومی نیاید. تست‌های نوشتنی فقط بر metadata staging انجام شوند.

**آزمون‌ها:** قرارداد API، load/latency/error budget، CORS از originهای مصوب، WebView، Android، ربات اصلی با fake client، auth negative paths، logs/metrics، backup/restore و rollback smoke test.

**پذیرش:** صفر افشای فیلد داخلی؛ تمام status/access gates؛ parity یا فهرست اختلاف‌های مورد تأیید مالک؛ SLA/هزینه/پایش قابل مشاهده؛ دستور rollback آزمایش شده.

**خطر/توقف:** اختلاف فهرست محتوای عمومی، رفتار سرویس فعلی تأیید نشده، CORS/identity نامشخص، ETag/audit شکست‌خورده، یا هیچ owner on-call/rollback وجود ندارد.

## مرحلهٔ ۶ — اتصال تدریجی کلاینت‌ها و بازگشت

**پیش‌نیازها:** stage 5 پذیرفته، feature flag و owner کلاینت‌ها، سازگاری نسخهٔ API و روش rollback.

**ترتیب پیشنهادی:**

1. سایت Apps Script: adapter محدود برای list/detail/category API؛ مسیر قدیمی را به‌عنوان fallback نگه دار.
2. Android WebView: ابتدا همان سایت/facade را مصرف کند؛ اگر API مستقیم لازم شد، HTTPS، CORS/origin، cookie/token lifecycle و WebView navigation را جدا review کن.
3. ربات اصلی: فقط خواندن فهرست/جزئیات کاتالوگ را از Catalog API بگیرد. تراکنش‌های خرید، پرداخت، کیف پول، صدور و مصرف download token تا تصمیم مهاجرت مستقل باقی بمانند.
4. ربات دانلود: خارج از cutover کاتالوگ؛ فقط در صورتی تغییر کند که قرارداد تحویل فایل جداگانه تصویب و طراحی شود.

**آزمون‌ها:** canary کاربر/دستهٔ محدود، parity response، latency، unavailable API fallback، version mismatch و rollback flag؛ بدون پرداخت یا download واقعی.

**پذیرش:** هر consumer به‌نوبت فعال؛ rollback هرکدام به مسیر قبلی بدون تغییر Sheet یا webhook ممکن؛ metric خطا/مصرف دیده می‌شود؛ هیچ تغییر غیرمجاز در download flow رخ نداده است.

**خطر/توقف:** افت parity، latency/quota، وابستگی به API بدون fallback، شکستن نسخهٔ Android قدیمی یا اضافه‌شدن ناخواستهٔ endpoint عملیاتی.

## مرحلهٔ ۷ — تأیید نهایی و مستندسازی عملیات

**پیش‌نیازها:** همهٔ کلاینت‌های موردنظر با پذیرش مالک مهاجرت کرده‌اند و بازهٔ پایش بدون خطای blocker گذشته است.

**کارها:** runbookهای deploy/rollback، rotation secret، restore، incident، audit export/retention، quota/cost dashboards، ownership و ماتریس دسترسی را تکمیل کن. وضعیت واقعی Apps Script، Render/Cloud Run، Firestore، domain/CORS و webhookها را با read-only evidence ثبت کن؛ از روی فایل محلی یا deployment ID تنها نسخهٔ فعال را حدس نزن.

**آزمون‌ها:** disaster recovery، account revoke/rotate، restore check، authorization re-review، API compatibility و data reconciliation.

**پذیرش:** مالک محصول و عملیات هرکدام امضا می‌کنند؛ runbook قابل اجراست؛ backup قابل بازیابی، مسئول پاسخ‌گو و بودجه ثبت شده‌اند؛ drift میان source و deployment مستند است.

**خطر/توقف:** نسخهٔ فعال قابل اثبات نیست، recovery آزمایش نشده، audit ناقص است یا مالک هیچ‌یک از سرویس‌ها مشخص نیست.

## مسیر rollback مشترک

- تا عبور از stage 5، production consumer به مسیر فعلی می‌ماند.
- برای هر کلاینت، feature flag/adapter انتخاب می‌کند که خواندن از API جدید یا مسیر قبلی انجام شود؛ rollback همان flag را برمی‌گرداند.
- metadata آزمایشی به Sheet بازنویسی یا dual-write نمی‌شود. هیچ schema change در Sheet نیست.
- Firestore rollback با revision کد به‌تنهایی کامل نیست؛ backup/restore و سازگاری نسخهٔ schema باید جداگانه تمرین شود.
- هیچ rollback شامل حذف داده، جابه‌جایی webhook، reset secret یا تغییر deployment عملیاتی بدون مجوز مستقل نیست.

## مواردی که پیش از هر اتصال آنلاین باید تأیید شوند

1. Source و نسخهٔ فعال Apps Script، Spreadsheet متصل و رفتار واقعی public listing.
2. میزبان/نسخهٔ فعال ربات‌ها و وجود یا مسیر واقعی Cloudflare Worker؛ ارجاع کد، اثبات استقرار نیست.
3. مقصد cloud، region، مالک، billing و سقف هزینه.
4. هویت Google read-only برای spreadsheet و IAM محدود برای Firestore.
5. IdP، verifier مدیر، role ownership، CORS origins و محافظت از session.
6. سیاست انسانی برای approval/publication محتوای موجود؛ هیچ auto-publish مجاز نیست.
7. معیار parity، backup/restore، monitoring و rollback.

تا تأیید این موارد، API و Providerها فقط local/test محسوب می‌شوند؛ این سند مجوز اتصال، ایجاد پروژه، نوشتن، deployment یا تغییر سرویس نیست.
