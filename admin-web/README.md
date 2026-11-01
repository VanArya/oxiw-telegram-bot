# پنل ورود آزمایشی مدیران

این پوشه یک صفحهٔ استاتیک مستقل برای آزمایش ورود با Firebase Authentication و
Google Sign-In است. این صفحه عمداً هیچ درخواست API، Firestore، endpoint، نقش‌دهی
خودکار یا اتصال به runtime مخزن ندارد.

## پیکربندی Firebase

1. در [Firebase Console](https://console.firebase.google.com/) پروژهٔ موردنظر را
   باز کنید.
2. به `Project settings` بروید، در بخش `Your apps` یک Web App را انتخاب یا ثبت
   کنید و در `SDK setup and configuration` گزینهٔ `Config` را باز کنید.
3. شیء پیکربندی Web App را در `firebase-config.js` قرار دهید؛ این فایل از روی
   `firebase-config.example.js` قابل ساخت است. مقدار واقعی پروژه در این مخزن
   حدس زده نشده است.
4. در `Authentication > Sign-in method`، ارائه‌دهندهٔ Google را فعال کنید.
5. دامنه‌ای که صفحه از آن سرو می‌شود (برای آزمایش محلی معمولاً `localhost`) را
   در `Authentication > Settings > Authorized domains` مجاز کنید.

`firebase-config.js` باید فقط پیکربندی عمومی Web App را داشته باشد. توکن ID،
کلید خصوصی و service-account credential هرگز نباید در این پوشه قرار بگیرد.

## اجرای محلی

صفحه را با یک static server محلی سرو کنید؛ بازکردن مستقیم فایل با `file://` ممکن
است برای OAuth popup مناسب نباشد. برای نمونه، از هر static server مورداعتماد
محلی استفاده کنید و سپس `admin-web/index.html` را در همان origin باز کنید.

## مرزهای امنیتی

ورود موفق فقط Firebase user را احراز می‌کند و به‌هیچ‌وجه اثبات‌کنندهٔ نقش
`administrator` نیست. این پنل نقش را نمی‌خواند و هیچ عملیات مدیریتی انجام نمی‌دهد.
در اتصال عملیاتی آینده، سرور باید توکن ID را خودش اعتبارسنجی کند، شناسهٔ کاربر را
از توکن معتبر استخراج کند و نقش را از منبع مجاز بررسی کند؛ مقدار واردشده در رابط
نباید مبنای مجوز باشد.

نسخهٔ CDN در این نمونه `13.1.0` است. در صورت تغییر نسخهٔ پایدار Firebase، URLهای
ماژولار `firebase-app.js` و `firebase-auth.js` را هماهنگ و پس از بررسی سازگاری
به‌روزرسانی کنید.
