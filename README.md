# Argo Desktop

[فارسی](#فارسی) · [English](#english) · [Downloads / دریافت برنامه](https://github.com/seotaheri-beep/argo-desktop/releases) · [Build instructions](REBUILD.md)

## فارسی

**Argo Desktop** یک کلاینت دسکتاپ غیررسمی برای اتصال به ArgoVPN در ویندوز است؛ با رابط فارسی، حالت پراکسی HTTP/SOCKS5 و حالت تونل برای تمام ترافیک ویندوز.

این پروژه مستقل است و به سازندگان ArgoVPN وابسته نیست و از طرف آن‌ها تأیید نشده است.

### وضعیت نسخه

نسخهٔ فعلی **0.3.0-preview** است. این نسخه برای بررسی و بازخورد منتشر می‌شود؛ آزمون‌های پذیرش آن هنوز کامل نشده‌اند. نسخهٔ اجرایی منتشرشده مخصوص **Windows 10/11، معماری x64** است. این ریپازیتوری فعلاً فایل نصب قابل استفاده برای macOS یا Linux ارائه نمی‌کند.

### امکانات

- رابط فارسی برای اتصال، قطع اتصال، انتخاب حالت و مشاهدهٔ وضعیت.
- پراکسی محلی HTTP و SOCKS5 روی `127.0.0.1` با نمایش پورت واقعی.
- انتخاب پورت آزاد در صورت اشغال بودن پورت پیش‌فرض `10808`.
- حالت «تمام ترافیک ویندوز» با تونل TUN و مجوز Administrator.
- بررسی عبور ترافیک پیش از اعلام وضعیت «متصل» و تلاش برای سرور بعدی در صورت شکست.
- بازیابی خودکار با تعداد تلاش محدود، امکان لغو و پاک‌سازی فرایندها و فایل‌های موقت اتصال.
- دریافت و بررسی امضای تنظیمات عمومی سرورها و ثبت گزارش اتصال برای عیب‌یابی.

### دریافت و نصب

1. از [صفحهٔ Releases](https://github.com/seotaheri-beep/argo-desktop/releases) فایل `ArgoDesktop-Setup-0.3.0-preview-x64.exe` را دریافت کنید.
2. اگر نسخهٔ قبلی باز است، اتصالش را قطع کنید و برنامه را ببندید.
3. فایل نصب را اجرا کنید. نصب به مجوز Administrator نیاز دارد.
4. برنامه را از منوی Start یا میان‌بر دسکتاپ باز کنید، حالت اتصال را انتخاب کنید و «اتصال» را بزنید.
5. پس از نمایش «متصل»، از اتصال استفاده کنید. برای پایان، «قطع اتصال» را بزنید و منتظر تکمیل پاک‌سازی بمانید.

Node.js و اجزای اجرایی مورد نیاز همراه فایل نصب هستند. برنامه و نصاب امضای ناشر تجاری ندارند؛ ویندوز ممکن است ناشر را `Unknown Publisher` نمایش دهد. برای بررسی فایل دانلودشده، هش SHA-256 آن را با فایل `SHA256SUMS.txt` همان Release مقایسه کنید.

### تنظیم پراکسی

در حالت «پراکسی»، نشانی `127.0.0.1` و **پورت نمایش‌داده‌شده در برنامه** را در تنظیمات HTTP یا SOCKS5 برنامهٔ مقصد وارد کنید. نام کاربری و رمز عبور خالی هستند. فقط برنامه‌هایی که پراکسی آن‌ها تنظیم شده از این اتصال استفاده می‌کنند. برای عبور DNS از پراکسی، گزینهٔ remote DNS برنامهٔ مقصد یا `socks5h` را به کار ببرید.

### محدودیت‌های شناخته‌شده

- این نسخه **Kill Switch ندارد**؛ هنگام قطع اتصال یا بازیابی، ترافیک مستقیم ممکن است برقرار شود.
- آزمون جامع جلوگیری از نشت DNS و IPv6 تکمیل نشده و تضمینی برای جلوگیری از نشت ترافیک ارائه نمی‌شود.
- دو آزمون اتصال مداوم دوساعته، و پذیرش نصب و ارتقای عادی با Administrator هنوز تکمیل نشده‌اند.
- برخی درخواست‌های مستقیم DNS روی UDP در آزمون حالت سراسری پاسخ نگرفتند؛ سازگاری این سناریو هنوز نیازمند بررسی است.

جزئیات آزمون‌های ثبت‌شده در [گزارش اعتبارسنجی](docs/VALIDATION.md) آمده است.

### گزارش مشکل

با دکمهٔ «گزارش اتصال»، پوشهٔ `%LOCALAPPDATA%\ArgoDesktop\reports` باز می‌شود. برای گزارش باگ، در [Issues](https://github.com/seotaheri-beep/argo-desktop/issues) نسخهٔ ویندوز، نسخهٔ برنامه، حالت اتصال و مراحل تکرار مشکل را بنویسید. پیش از اشتراک‌گذاری گزارش‌ها، اطلاعات شخصی و اطلاعات نشست را بررسی و حذف کنید.

### ساخت از سورس

کد مستقل برنامه در `src/`، آزمون‌ها در `tests/` و فایل‌های نصب در `setup.nsi` و `build-source.ps1` هستند. برای پیش‌نیازها، آماده‌سازی payload و اجرای آزمون‌ها، [REBUILD.md](REBUILD.md) را بخوانید. فایل‌های اجرایی وابستگی‌ها داخل تاریخچهٔ Git قرار ندارند و همراه بستهٔ نصب عرضه می‌شوند.

## English

**Argo Desktop** is an unofficial Windows desktop client for ArgoVPN, with a Persian user interface, a local HTTP/SOCKS5 proxy, and a system-wide TUN mode. It is independent of, unaffiliated with, and not endorsed by the ArgoVPN developers.

The current version is **0.3.0-preview**, for **Windows 10/11 x64**. Release acceptance is incomplete. No usable macOS or Linux installer is provided by this repository at this time.

### Install and use

Download the Windows installer from [Releases](https://github.com/seotaheri-beep/argo-desktop/releases), disconnect and close any previous version, then run the installer. Administrator permission is required for installation and system-wide mode. The required Node.js runtime is bundled. The app and installer are not commercially code-signed.

In proxy mode, configure your application to use HTTP or SOCKS5 at `127.0.0.1` and the port shown in Argo Desktop. No proxy username or password is needed. The default port is `10808`; a different available port is selected when necessary. Use remote DNS or `socks5h` when supported by the target application.

The client checks actual traffic before reporting a connection, tries alternative servers, and performs bounded automatic recovery. **There is no kill switch**: direct traffic may be possible during disconnection or recovery. Comprehensive DNS/IPv6 leak testing, two-hour connection soaks, and ordinary Administrator install/upgrade acceptance remain incomplete. See [validation notes](docs/VALIDATION.md).

### Development

- `src/`: C# WinForms interface, runtime guard, and JavaScript connection engine.
- `tests/`: isolated Node.js tests and C# harnesses.
- `assets/`: app icon, Persian usage guide, and third-party notices.
- `build-source.ps1`, `setup.nsi`: Windows compilation and NSIS packaging.
- [REBUILD.md](REBUILD.md): build requirements, commands, and test instructions.

Third-party executables are distributed with release installers rather than committed to Git. The supplied payload is checked against its integrity manifest during the build. The installer includes the relevant component licenses and the exact corresponding source archive for the bundled sing-box version.

### Third-party components and licensing

The Windows payload uses Node.js, sing-box, and Wintun. Their versions, notices, license locations, and source information are listed in [THIRD-PARTY-NOTICES.txt](assets/THIRD-PARTY-NOTICES.txt). Those components retain their respective licenses. A license for the original Argo Desktop code has not yet been declared in this repository.
