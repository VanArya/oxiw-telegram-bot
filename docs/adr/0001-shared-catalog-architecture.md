# ADR-0001: معماری کاتالوگ مشترک OXIW

- وضعیت: پیشنهادی؛ نیازمند تأیید مالک و بررسی عملیاتی پیش از اتصال
- تاریخ: ۲۰۲۶-۱۰-۲۵
- دامنه: خواندن کاتالوگ، metadata و مدیریت آن؛ خارج از دامنه: انتقال پرداخت، کیف پول یا تحویل فایل

## مسئله

اطلاعات محتوای OXIW اکنون در چند جزء مصرف می‌شود. هدف، یک قرارداد خواندن واحد برای سایت، Android و ربات اصلی است، بدون تغییر ساختار Spreadsheet فعلی و بدون ادغام ناخواستهٔ جریان دانلود. کد Catalog Core شامل Core، API عمومی/مدیریتی و providerهای تزریق‌پذیر است، اما این اجزا هنوز به میزبان یا storage واقعی متصل نشده‌اند.

## شواهد محلی و مرز آن‌ها

برچسب‌ها در این سند چنین‌اند: **تأییدشده از سورس** یعنی مستقیماً در فایل محلی دیده شده؛ **پیشنهاد** یعنی تصمیم طراحی این ADR؛ **نیازمند تأیید** یعنی بدون دسترسی عملیاتی یا بررسی مالک قابل اثبات نیست.

| موضوع | وضعیت |
|---|---|
| Catalog Core | **تأییدشده از سورس:** `src/catalog-api.js` یک Express app خواندنی می‌سازد و Sheet adapter و metadata provider را تزریق می‌گیرد. Admin API جداگانه است. root `index.js` نقطهٔ ورود ربات اصلی است و Catalog API را composition نمی‌کند؛ پس Catalog API فعلاً برنامهٔ مستقرشدنیِ متصل به ربات نیست. |
| Google Sheets | **تأییدشده از سورس:** ربات اصلی مستقیماً با Google Sheets API کار می‌کند و عملیات نوشتن مربوط به داده‌های عملیاتی از جمله کیف پول/پرداخت و توکن دارد. Apps Script از `SpreadsheetApp.getActiveSpreadsheet()` استفاده می‌کند. Catalog Sheets provider فقط برای دو برگهٔ «سینمایی» و «سریال» read دارد. **تصمیم قطعی:** ساختار Sheets موجود تغییر نمی‌کند. |
| Apps Script و سایت | **تأییدشده از فایل محلی:** `Code.gs` ورودی‌های وب و فراخوانی‌های Spreadsheet دارد؛ `Index.html` از `google.script.run` برای backend استفاده می‌کند. manifest snapshot دسترسی وب را anonymous و اجرای آن را با هویت deployکننده اعلام می‌کند. **نیازمند تأیید:** این manifest نمایانگر deployment فعال نیست و وضعیت دسترسی واقعی، نسخه و URL فعال از آن نتیجه نمی‌شود. |
| Android | **تأییدشده از سورس:** برنامه در `MainActivity.kt` یک WebView می‌سازد و سایت Apps Script را بارگذاری می‌کند. Android فعلاً کلاینت native مستقل برای Catalog API نیست. |
| ربات دانلود | **تأییدشده از سورس محلی:** ربات مسیر `/start <token>`، اعتبارسنجی و مصرف توکن، دسترسی به Sheets و ارسال فایل از Telegram را دارد. این مسئولیت با API کاتالوگ یکی نیست. **نیازمند تأیید:** نسخهٔ فعال میزبان و تفاوت دقیق دادهٔ عملیاتی آن با فایل محلی. |
| Firestore و مجوزها | **تأییدشده از worktree:** adapter خواندنی/نوشتنی Firestore، version/ETag و audit sink به‌صورت کد تزریق‌پذیر وجود دارند؛ authorization فعلی policy آزمایشی است. **تأییدنشده:** هیچ پروژه، credential، IAM، پایگاه واقعی یا verifier هویت عملیاتی در این مرحله اثبات نشده است. |
| میزبانی | کد ربات‌ها به میزبان‌هایی اشاره دارد، اما این ارجاع‌ها deployment را اثبات نمی‌کنند. پیکربندی محلی Worker یا Render در بررسی‌های پیشین در دسترس نبود؛ وضعیت آنلاین نامعلوم است. |

## تصمیم پیشنهادی

**پیشنهاد هدف: گزینهٔ C — یک Catalog API مستقل Node.js/Express روی Google Cloud Run، با Google Sheets فقط‌خواندنی برای فیلدهای پایه و Firestore جداگانه برای metadata، taxonomy، category و audit.** هر دو provider در composition root سمت سرور تزریق می‌شوند و Catalog Core مسئول join، اعتبارسنجی و projection عمومی است. هیچ storage client یا credential در سایت، WebView یا ربات قرار نمی‌گیرد.

این تصمیم هنوز اجازهٔ ایجاد پروژه، فعال‌کردن billing، ایجاد Firestore، دسترسی IAM یا deployment نیست. انتخاب نهایی به تأیید مالک، منطقه/محل داده، بودجه، حساب ابری و نتیجهٔ ارزیابی عملیاتی بستگی دارد. تا آن زمان این ADR «پیشنهادی» باقی می‌ماند.

### چرا گزینهٔ C

- Express و interfaceهای provider موجود با سرویس مستقل Node سازگارند؛ Firestore adapter و transaction-based version/audit نیز در کد محلی آمادهٔ آزمون با fake هستند.
- Sheets موجود را می‌توان از backend با مجوز محدود فقط‌خواندنی مصرف کرد؛ metadata جدا می‌ماند و طرح شیت تغییر نمی‌کند.
- یک مرز سرور واحد اجازه می‌دهد مجوز مدیر، ETag، اعتبارسنجی و audit در backend اعمال شود. اپ‌ها مجوز نوشتن مستقیم نمی‌گیرند.
- Cloud Run و Firestore در یک پلتفرم امکان هویت سرویس و دسترسی محدود را فراهم می‌کنند؛ روش دقیق هویت Sheets، Secret Manager، IAM، region، هزینه و quota باید پیش از استقرار بررسی و تأیید شود.
- وابستگی عملیاتی تازه بیشتر از Apps Script خالص است؛ هزینه و پیچیدگی آن باید با گزینهٔ B مقایسه شود، نه اینکه رایگان یا موجود فرض شود.

## گزینه‌های بررسی‌شده

| معیار | A. API بر پایهٔ Apps Script | B. Node API روی Render + Firestore | C. Node API روی Google Cloud + Firestore |
|---|---|---|---|
| سازگاری با Catalog Core | کم تا متوسط؛ منطق موجود Node/Express باید به Apps Script منتقل یا از آن فراخوانی شود. اجرای Core در Apps Script بدون adapter جدا فرض نمی‌شود. | زیاد؛ Core/Express در یک Node service جا می‌گیرد. | زیاد؛ همان سرویس Node/Express روی Cloud Run قابل composition است. |
| Sheets پایه | Apps Script می‌تواند Spreadsheet فعال را بخواند؛ اما هویت spreadsheet و رفتار deployment باید قطعی شود. | Node backend با Google Sheets API و هویت Google مجاز؛ دسترسی/credential باید امن طراحی شود. | Node backend با Sheets API و هویت workload؛ دسترسی فقط‌خواندنی به spreadsheet. |
| metadata و audit | باید storage مستقل و transaction/version/audit مناسب انتخاب شود؛ Sheets metadata، اگر بررسی شود، انتخاب پیش‌فرض نیست. | Firestore جدا؛ transaction و audit در همان تراکنش طبق provider محلی. | Firestore جدا؛ transaction و audit در همان تراکنش طبق provider محلی. |
| احراز هویت مدیر | Apps Script فعلی طبق manifest snapshot anonymous است؛ برای نوشتن کافی نیست. verifier و نقش واقعی باید جدا طراحی شود. | باید verifier مورداعتماد و principal معتبر به سرویس تزریق شود؛ secretها در میزبان. | verifier/Identity Platform یا راهکار مورد تأیید باید مشخص شود؛ IAM سرویس به‌تنهایی جای مجوز مدیر محصول را نمی‌گیرد. |
| مرورگر و Android WebView | اتصال طبیعی به `google.script.run` برای UI موجود؛ برای کلاینت‌های بیرون Apps Script محدودیت قرارداد/دسترسی ایجاد می‌کند. | HTTPS و CORS لازم؛ originهای سایت/WebView باید معلوم و allowlist شوند. | HTTPS و CORS لازم؛ همان قرارداد در مرورگر و WebView. |
| ربات اصلی | آسان‌تر برای سایت موجود، ولی Node bot و Apps Script همچنان دو مسیر منطقی می‌مانند. | می‌تواند public Catalog API را بخواند؛ Sheets مستقیم ربات باید تدریجی و بدون انتقال خودکار عملیات مالی باقی بماند. | همین الگو؛ API مسئول composition کاتالوگ است، bot عملیات توکن/پرداخت را جدا نگه می‌دارد تا مهاجرت مستقلی تصویب شود. |
| ربات دانلود | خارج از دامنه؛ نباید برای تحویل فایل به API مدیریتی متصل شود. | همان. | همان؛ همچنان سرویس جدا و مالک جریان token/file است. |
| secret و دسترسی Google | Script Properties و دسترسی Apps Script؛ دامنهٔ دسترسی و deployer باید بازبینی شود. | Google service identity و چگونگی نگهداری key در Render نیازمند بررسی؛ workload identity ممکن است در دسترس نباشد و نباید فرض شود. | امکان هویت سرویس و Secret Manager؛ تنظیم و least privilege هنوز باید ایجاد/تأیید شود. |
| استقرار و بازگشت | به نسخه‌بندی و deployment Apps Script وابسته؛ rollback با deployment قبلی فقط پس از اثبات شناسایی نسخه. | مدیریت container/service، health، secrets، logs، backup Firestore و rollback میزبان لازم است. وجود Render فعال تأیید نشده است. | Cloud Run revision/traffic و Firestore backup/restore لازم؛ عملیات، quota، cost و region جدیدند. |
| هزینه و وابستگی تازه | هزینهٔ افزایشی شاید محدود باشد، اما quota و هزینهٔ واقعی حساب باید بررسی شود. | هزینهٔ میزبان Render، Firestore، ترافیک و Google API؛ pricing/region قرارداد نیازمند تأیید. | Cloud Run، Firestore، Secret Manager، logging/monitoring و احتمالاً egress؛ pricing باید با بار واقعی برآورد شود. |

گزینهٔ A می‌تواند برای سایت Apps Script یک façade انتقالی باشد، اما توصیه نمی‌شود Catalog Core به‌صورت دوم در GAS بازنویسی شود. گزینهٔ B fallback معتبر است اگر مالک Render موجود، هویت امن Google، CORS، backup و هزینه را تأیید کند. هیچ‌یک از دو میزبان موجود یا آنلاین بودنشان در این ADR فرض نشده است.

## قرارداد و مالکیت داده

1. **Google Sheets فعلی منبع فیلدهای پایه** باقی می‌ماند؛ هیچ ستون، نام برگه، سطر یا داده جابه‌جا/تغییر نمی‌کند.
2. **Metadata جداگانه** شامل `approvalStatus`، `publicationStatus`، شناسه‌های کشور و ژانر، category definitions و taxonomy terms است. Firestore گزینهٔ هدف پیشنهادی است، نه storage فعال.
3. **قانون نمایش عمومی:** تنها هنگامی که `approvalStatus === 'approved'` و `publicationStatus === 'published'` هر دو معتبر و صریح باشند. `unknown`، رکورد ناقص یا metadata مفقود عمومی نمی‌شود؛ هیچ وضعیت قدیمی از Sheets به‌صورت خودکار منتشر نمی‌شود.
4. **هویت محتوا:** شناسهٔ پایدار بر پایهٔ `kind + systemCode` مطابق `CATALOG_API_V1.md` است؛ عنوان و موقعیت ردیف کلید نیستند. duplicate/empty/invalid باید fail-closed بماند.
5. **Composition:** سرویس Catalog API در backend دادهٔ Sheets را از Google Sheets provider می‌خواند، metadata را از provider مستقل می‌گیرد، Core را اجرا و فقط DTO allowlist‌شده می‌سازد. این مسئولیت به کلاینت‌ها، Apps Script UI یا ربات‌ها تکثیر نمی‌شود.
6. **مجوز مدیریت:** role/principal از body، query یا header عادی پذیرفته نمی‌شود. فقط verifier مورداعتماد می‌تواند principal را فراهم کند؛ policy محلی فعلی verifier عملیاتی نیست. نوشتن بدون authorizer معتبر fail-closed است.
7. **نوشتن:** ETag/`If-Match` و `If-None-Match`، کنترل نسخه در provider و audit تراکنشی حفظ می‌شوند. approval و publication عملیات مستقل هستند.
8. **حریم داده:** کلاینت عمومی فقط فیلد لازم برای نمایش را می‌گیرد. `sourceRecord`، Telegram File ID، توکن دانلود، credential، دادهٔ مدیریتی و جزئیات خطا در DTO یا log عمومی قرار نمی‌گیرند.
9. **ربات دانلود:** با API مدیریت کاتالوگ ادغام نمی‌شود. تحویل فایل و مصرف توکن، تا تصویب پروژهٔ مجزای مهاجرت، در مرز موجود باقی می‌ماند.

## شکل هدف

```text
سایت Apps Script ─┐
Android WebView ───┼── HTTPS / Catalog API v1 ── Catalog Core
ربات اصلی ────────┘                              ├── Sheets provider (read-only)
                                                ├── Metadata provider (Firestore پیشنهادی)
                                                └── Admin API + verifier + audit (خصوصی)

ربات دانلود ── Telegram / token + file flow فعلی ── Sheets/Telegram
```

در انتقال، سایت و Android می‌توانند ابتدا همان UI و مسیر فعلی را نگه دارند و فقط منبع دادهٔ کاتالوگ را پشت facade عوض کنند. ربات اصلی نیز ابتدا فقط خواندن اطلاعات کاتالوگ را مهاجرت می‌دهد؛ تراکنش پرداخت، کیف پول، صدور/مصرف توکن و تحویل فایل بخشی از cutover کاتالوگ نیستند.

## پیامدها

### مزایا

- یک تعریف و فیلتر کاتالوگ و category/taxonomy برای مصرف‌کنندگان.
- عدم تغییر ساختار Sheets و جدایی فیلدهای پایه از تصمیم‌های تحریریه/انتشار.
- مرز server-side برای allowlist DTO، مجوزدهی، concurrency و audit.
- تعویض provider با dependency injection و امکان rollback در composition.

### هزینه‌ها و خطرها

- ایجاد backend و storage و پایش/backup جدید؛ هزینه‌ها هنوز برآورد نشده‌اند.
- تطبیق شناسه‌های واقعی و تعیین metadata برای محتوای جاری؛ بدون این کار fail-closed بودن می‌تواند محتوای فعلی را پنهان کند.
- سهمیه و latency Google Sheets و نیاز به cache/refresh policy.
- احراز هویت مدیر، CORS، محافظت از abuse و محدودیت نرخ هنوز عملیاتی نشده‌اند.
- parity نسخهٔ فعال Apps Script/Render/Cloudflare با سورس محلی اثبات نشده است؛ نباید cutover بر مبنای حدس انجام شود.

## گزینه‌های خارج از دامنه

- تغییر Sheet یا مهاجرت دادهٔ موجود.
- تغییر webhook، Apps Script deployment، سرویس‌های Render/Cloudflare یا اتصال آنلاین.
- انتقال جریان پرداخت/کیف پول/توکن به Catalog API.
- دسترسی مستقیم مرورگر یا Android به Firestore برای نوشتن.
- ادغام ربات دانلود در API کاتالوگ.

## پرسش‌های نیازمند تصمیم مالک

- تأیید مقصد Google Cloud و Cloud Run/Firestore یا انتخاب گزینهٔ دیگر، region و سقف هزینه.
- تأیید روش هویت مدیر، مالک نقش‌ها، چرخهٔ لغو دسترسی و روش MFA.
- تأیید spreadsheet/source فعال و account/service identity با read-only حداقلی.
- تعیین policy تصویب و انتشار برای metadata جدید و نقشهٔ رکوردهای فعلی بدون auto-publish.
- تأیید domainهای سایت، Android WebView و ربات برای CORS/HTTPS و مرحلهٔ cutover.
- تأیید معیار parity و rollback و نگه‌داری audit/backup.
