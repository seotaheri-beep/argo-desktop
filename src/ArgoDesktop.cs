using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ArgoDesktop {
    static class Program {
        public const string Version = "0.3.0";
        public static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
        public static readonly string Data = String.IsNullOrEmpty(Environment.GetEnvironmentVariable("ARGO_DATA_DIR")) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArgoDesktop") : Environment.GetEnvironmentVariable("ARGO_DATA_DIR");
        public static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        public static bool IsAdmin { get { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); } }
        public static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
        public static string Value(Dictionary<string, object> data, string key) { object value; return data.TryGetValue(key, out value) && value != null ? value.ToString() : ""; }

        [STAThread]
        static int Main(string[] args) {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Directory.CreateDirectory(Data);
            if (args.Length >= 3 && args[0] == "--self-test") {
                string mode = args[1], report = Path.GetFullPath(args[2]);
                if (mode == "full" && !IsAdmin) {
                    try {
                        Process.Start(new ProcessStartInfo(Application.ExecutablePath, "--self-test full " + Quote(report) + (args.Length >= 4 ? " " + Quote(args[3]) : "") + (args.Length >= 5 ? " " + Quote(args[4]) : "")) { UseShellExecute = true, Verb = "runas", WorkingDirectory = Root });
                        return 0;
                    } catch (Win32Exception ex) {
                        File.WriteAllText(report, Json.Serialize(new { error = "Windows elevation was not approved", code = ex.NativeErrorCode }), Encoding.UTF8);
                        return 2;
                    }
                }
                int seconds = 5; if (args.Length >= 4) Int32.TryParse(args[3], out seconds);
                int testPort = 10819; if (args.Length >= 5) Int32.TryParse(args[4], out testPort);
                return RunTest(mode, report, Math.Min(7200, Math.Max(1, seconds)), testPort);
            }
            bool elevateStart = Array.IndexOf(args, "--start-full") >= 0;
            int initialPort = 10808, initialProfile = 0;
            for (int i = 0; i + 1 < args.Length; i++) {
                if (args[i] == "--port") { int parsed; if (Int32.TryParse(args[i + 1], out parsed) && parsed >= 1024 && parsed <= 65535) initialPort = parsed; }
                if (args[i] == "--profile" && args[i + 1] == "ir") initialProfile = 1;
            }
            using (Mutex mutex = new Mutex(false, "Local\\ArgoDesktop-0.2")) {
                bool owns = false;
                try { owns = mutex.WaitOne(elevateStart ? 20000 : 0); } catch (AbandonedMutexException) { owns = true; }
                if (!owns) { MessageBox.Show("برنامه از قبل باز است.", "Argo Desktop", MessageBoxButtons.OK, MessageBoxIcon.Information); return 0; }
                try {
                    using (MainForm form = new MainForm(elevateStart, initialPort, initialProfile)) {
                        if (args.Length == 2 && args[0] == "--preview") {
                            form.RenderPreview(args[1]); return 0;
                        }
                        Application.Run(form);
                    }
                } finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }

        internal static bool IsSuccessfulTestReport(Dictionary<string, object> report, int exitCode) {
            return exitCode == 0 && Value(report, "version") == Version &&
                Value(report, "tunnelVerified") == "True" && Value(report, "errorCode") == "" &&
                Value(report, "lastStage") == "disconnected" && Value(report, "completedAt") != "" &&
                Value(report, "stopReason") == "test-complete";
        }

        static int RunTest(string mode, string reportPath, int seconds, int requestedPort) {
            Directory.CreateDirectory(Path.GetDirectoryName(reportPath));
            using (WorkerRunner worker = new WorkerRunner()) {
                string eventsPath = reportPath + ".events.txt";
                object sync = new object();
                Action<string> log = delegate(string text) { lock (sync) File.AppendAllText(eventsPath, text + Environment.NewLine, Encoding.UTF8); };
                try {
                    worker.Start(new { cmd = "start", mode = mode, profile = "global", port = requestedPort, testSeconds = seconds, reportPath = reportPath }, log);
                    if (!worker.Exited.Wait((seconds + 300) * 1000)) { worker.StopAsync().GetAwaiter().GetResult(); return 3; }
                    if (!File.Exists(reportPath)) return 4;
                    var result = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(reportPath));
                    return IsSuccessfulTestReport(result, worker.ExitCode) ? 0 : 5;
                } catch (Exception ex) {
                    log(ex.ToString());
                    File.WriteAllText(reportPath, Json.Serialize(new { error = ex.Message }), Encoding.UTF8);
                    return 6;
                }
            }
        }
    }

    sealed class WindowsJob : IDisposable {
        IntPtr handle;
        [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS { public BASIC_LIMITS BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        public WindowsJob() {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new Win32Exception();
            var limits = new EXTENDED_LIMITS(); limits.BasicLimitInformation.LimitFlags = 0x2000;
            int size = Marshal.SizeOf(limits); IntPtr ptr = Marshal.AllocHGlobal(size);
            try { Marshal.StructureToPtr(limits, ptr, false); if (!SetInformationJobObject(handle, 9, ptr, (uint)size)) throw new Win32Exception(); }
            finally { Marshal.FreeHGlobal(ptr); }
        }
        public void Add(Process process) { if (!AssignProcessToJobObject(handle, process.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to protect the network process lifecycle"); }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }

    sealed class WorkerRunner : IDisposable {
        Process process; WindowsJob job; RuntimeGuard runtimeGuard; bool disposed;
        readonly TaskCompletionSource<bool> ended = new TaskCompletionSource<bool>();
        public Task Exited { get { return ended.Task; } }
        public int ExitCode { get { return process.ExitCode; } }
        public bool Running { get { try { return process != null && !process.HasExited; } catch { return false; } } }
        public void Start(object command, Action<string> callback) {
            var integrity = Program.Json.Deserialize<Dictionary<string, string>>(File.ReadAllText(Path.Combine(Program.Root, "integrity.json")));
            string node = Path.Combine(Program.Root, "runtime", "node.exe");
            using (var sha = SHA256.Create()) using (var input = File.OpenRead(node)) {
                string digest = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                if (digest != integrity["runtime/node.exe"]) throw new InvalidDataException("فایل برنامه تغییر کرده است؛ نصب مجدد را انجام دهید.");
            }
            var start = new ProcessStartInfo(node, Program.Quote(Path.Combine(Program.Root, "worker.mjs"))) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = Program.Root
            };
            start.EnvironmentVariables["ARGO_DATA_DIR"] = Program.Data;
            start.EnvironmentVariables.Remove("NODE_OPTIONS"); start.EnvironmentVariables.Remove("NODE_PATH"); start.EnvironmentVariables.Remove("SSLKEYLOGFILE");
            process = new Process(); process.StartInfo = start; process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) callback(e.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) callback(Program.Json.Serialize(new { type = "error", message = e.Data })); };
            process.Exited += delegate { ended.TrySetResult(true); };
            try {
                runtimeGuard = RuntimeGuard.Open(Program.Data);
                job = new WindowsJob();
                process.Start();
                // The worker waits for stdin before launching any network engine.
                job.Add(process);
                process.BeginOutputReadLine(); process.BeginErrorReadLine();
                process.StandardInput.WriteLine(Program.Json.Serialize(command)); process.StandardInput.Flush();
            } catch { if (Running) process.Kill(); Dispose(); throw; }
        }
        public async Task StopAsync() {
            if (!Running) return;
            try { process.StandardInput.WriteLine("{\"cmd\":\"stop\"}"); process.StandardInput.Flush(); } catch { }
            await Task.WhenAny(ended.Task, Task.Delay(9500));
            if (Running && job != null) { job.Dispose(); await Task.WhenAny(ended.Task, Task.Delay(500)); }
        }
        public void Dispose() {
            if (disposed) return; disposed = true;
            if (job != null) job.Dispose();
            if (process != null) process.Dispose();
            if (runtimeGuard != null) runtimeGuard.Dispose();
        }
    }

    sealed class StopCoordinator {
        readonly object gate = new object();
        Task inFlight;
        public bool Active { get { lock (gate) return inFlight != null; } }
        public Task Run(Func<Task> action) {
            var completion = new TaskCompletionSource<bool>();
            Task published = completion.Task;
            lock (gate) {
                if (inFlight != null) return inFlight;
                inFlight = published;
            }
            try {
                Task work = action();
                if (work == null) throw new InvalidOperationException("Stop action returned no task");
                work.ContinueWith(delegate(Task finished) { Finish(published, completion, finished); }, TaskContinuationOptions.ExecuteSynchronously);
            } catch (Exception ex) {
                lock (gate) { if (Object.ReferenceEquals(inFlight, published)) inFlight = null; }
                completion.TrySetException(ex);
            }
            return published;
        }
        void Finish(Task published, TaskCompletionSource<bool> completion, Task finished) {
            lock (gate) { if (Object.ReferenceEquals(inFlight, published)) inFlight = null; }
            if (finished.IsFaulted) completion.TrySetException(finished.Exception.InnerExceptions);
            else if (finished.IsCanceled) completion.TrySetCanceled();
            else completion.TrySetResult(true);
        }
    }

    sealed class MainForm : Form {
        readonly Color navy = Color.FromArgb(15, 45, 57), teal = Color.FromArgb(13, 111, 117), muted = Color.FromArgb(95, 114, 121);
        readonly RadioButton proxyMode = new RadioButton(), fullMode = new RadioButton();
        readonly NumericUpDown port = new NumericUpDown();
        readonly ComboBox profile = new ComboBox();
        readonly Button connect = new Button(), copy = new Button(), details = new Button();
        readonly Label status = new Label(), statusDetail = new Label(), modeHelp = new Label();
        readonly TextBox log = new TextBox();
        WorkerRunner worker; bool stopping, closing, allowClose; readonly bool startFull;
        readonly StopCoordinator stopCoordinator = new StopCoordinator();
        public MainForm(bool startFull, int initialPort, int initialProfile) {
            this.startFull = startFull;
            Text = "Argo Desktop"; ClientSize = new Size(760, 690); MinimumSize = new Size(740, 700);
            Font = new Font("Segoe UI", 10F); AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(244, 248, 249);
            RightToLeft = RightToLeft.Yes; RightToLeftLayout = true;
            if (File.Exists(Path.Combine(Program.Root, "app.ico"))) Icon = new Icon(Path.Combine(Program.Root, "app.ico"));
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(24), BackColor = BackColor };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 105)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 185));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 114)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 64));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            Controls.Add(root);
            var header = new Panel { Dock = DockStyle.Fill, BackColor = navy, Padding = new Padding(20) };
            var title = LabelAt("Argo Desktop", 0, 8, 660, 34, new Font("Segoe UI", 22, FontStyle.Bold), Color.White);
            header.Padding = new Padding(14); title.Height = 40;
            title.Dock = DockStyle.Top; title.TextAlign = ContentAlignment.MiddleRight; header.Controls.Add(title);
            var subtitle = LabelAt("دو روش اتصال به اینترنت، در یک پنجره", 0, 52, 660, 28, Font, Color.FromArgb(190, 220, 225));
            subtitle.Height = 24; subtitle.Dock = DockStyle.Bottom; subtitle.TextAlign = ContentAlignment.MiddleRight; header.Controls.Add(subtitle); root.Controls.Add(header, 0, 0);
            var settings = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 3, Padding = new Padding(0, 14, 0, 0) };
            settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); settings.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            settings.RowStyles.Add(new RowStyle(SizeType.Absolute, 69)); settings.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); settings.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            ConfigureRadio(proxyMode, "حالت پراکسی", "فقط برنامه‌های دارای تنظیم پراکسی");
            ConfigureRadio(fullMode, "تمام ترافیک ویندوز", "پوشش برنامه‌ها و DNS سیستم");
            settings.Controls.Add(proxyMode, 0, 0); settings.Controls.Add(fullMode, 1, 0);
            // RadioButtons share the same parent so exactly one mode is selected.
            var portRow = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Padding = new Padding(0, 5, 0, 0) };
            portRow.Controls.Add(new Label { Text = "پورت پراکسی", AutoSize = true, Padding = new Padding(0, 5, 0, 0) });
            port.Minimum = 1024; port.Maximum = 65535; port.Value = initialPort; port.Width = 94; port.TextAlign = HorizontalAlignment.Center; portRow.Controls.Add(port);
            settings.Controls.Add(portRow, 0, 1);
            var profileRow = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Padding = new Padding(0, 5, 0, 0) };
            profileRow.Controls.Add(new Label { Text = "فهرست سرورها", AutoSize = true, Padding = new Padding(0, 5, 0, 0) });
            profile.DropDownStyle = ComboBoxStyle.DropDownList; profile.Items.AddRange(new object[] { "عمومی", "ایران" }); profile.SelectedIndex = initialProfile; profile.Width = 110; profileRow.Controls.Add(profile);
            settings.Controls.Add(profileRow, 1, 1);
            modeHelp.Dock = DockStyle.Fill; modeHelp.ForeColor = muted; modeHelp.TextAlign = ContentAlignment.MiddleRight;
            settings.Controls.Add(modeHelp, 0, 2); settings.SetColumnSpan(modeHelp, 2); root.Controls.Add(settings, 0, 1);
            var state = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(18) };
            status.Dock = DockStyle.Top; status.Height = 38; status.Font = new Font("Segoe UI", 16, FontStyle.Bold); status.ForeColor = navy;
            statusDetail.Dock = DockStyle.Bottom; statusDetail.Height = 38; statusDetail.ForeColor = muted;
            state.Controls.Add(status); state.Controls.Add(statusDetail); root.Controls.Add(state, 0, 2);
            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Padding = new Padding(0, 10, 0, 0) };
            ConfigureButton(connect, "اتصال", teal, Color.White, 205); ConfigureButton(copy, "کپی نشانی پراکسی", Color.White, navy, 172); ConfigureButton(details, "گزارش اتصال", Color.White, navy, 132); copy.Enabled = false;
            actions.Controls.Add(connect); actions.Controls.Add(copy); actions.Controls.Add(details); root.Controls.Add(actions, 0, 3);
            log.Dock = DockStyle.Fill; log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical; log.BackColor = Color.FromArgb(233, 241, 243); log.BorderStyle = BorderStyle.None; log.Font = new Font("Segoe UI", 9); root.Controls.Add(log, 0, 4);
            root.Controls.Add(new Label { Text = "نسخه غیررسمی ویندوز  " + Program.Version, Dock = DockStyle.Fill, ForeColor = muted, TextAlign = ContentAlignment.MiddleRight }, 0, 5);
            proxyMode.CheckedChanged += ModeChanged; fullMode.CheckedChanged += ModeChanged;
            proxyMode.Checked = !startFull; fullMode.Checked = startFull; ModeChanged(null, EventArgs.Empty);
            connect.Click += async delegate { if (worker == null) await StartAsync(); else await StopAsync(); };
            copy.Click += delegate { Clipboard.SetText("127.0.0.1:" + port.Value); statusDetail.Text = "نشانی پراکسی کپی شد."; };
            details.Click += delegate { Directory.CreateDirectory(Path.Combine(Program.Data, "reports")); Process.Start("explorer.exe", Program.Quote(Path.Combine(Program.Data, "reports"))); };
            FormClosing += OnClosing;
            Shown += async delegate { if (startFull) await StartAsync(); };
            SetStatus("آماده اتصال", "حالت موردنظر را انتخاب و روی اتصال کلیک کنید.", navy);
        }
        static Label LabelAt(string text, int x, int y, int width, int height, Font font, Color color) { return new Label { Text = text, Location = new Point(x, y), Size = new Size(width, height), Font = font, ForeColor = color }; }
        void ConfigureRadio(RadioButton button, string title, string description) {
            button.Text = title + Environment.NewLine + description; button.Dock = DockStyle.Fill; button.BackColor = Color.White; button.Appearance = Appearance.Button;
            button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderSize = 1; button.FlatAppearance.BorderColor = Color.FromArgb(213, 225, 229); button.TextAlign = ContentAlignment.MiddleCenter; button.Margin = new Padding(4); button.Font = new Font("Segoe UI", 10, FontStyle.Bold);
        }
        void ConfigureButton(Button button, string text, Color background, Color foreground, int width) { button.Text = text; button.Width = width; button.Height = 42; button.BackColor = background; button.ForeColor = foreground; button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderSize = 0; button.Margin = new Padding(4); button.Cursor = Cursors.Hand; }
        void ModeChanged(object sender, EventArgs e) {
            proxyMode.BackColor = proxyMode.Checked ? Color.FromArgb(218, 239, 238) : Color.White;
            fullMode.BackColor = fullMode.Checked ? Color.FromArgb(218, 239, 238) : Color.White;
            modeHelp.Text = fullMode.Checked ? "این حالت برای ساخت تونل شبکه، مجوز Administrator ویندوز را درخواست می‌کند." : "پورت اشغال باشد، پورت آزاد انتخاب می‌شود. پس از اتصال، نشانی پراکسی را کپی کنید.";
            copy.Visible = proxyMode.Checked;
        }
        void SetStatus(string text, string detail, Color color) { status.Text = text; status.ForeColor = color; statusDetail.Text = detail; }
        static string FriendlyError(string text) {
            if (text.Contains("local-proxy") && text.Contains("bind:")) return "پورت پراکسی در دسترس نیست. پورت دیگری انتخاب و دوباره تلاش کنید.";
            if (text.Contains("No local proxy port")) return "پورت آزاد برای پراکسی پیدا نشد. دوباره تلاش کنید یا پورت دیگری انتخاب کنید.";
            if (text.Contains("No available server")) return "هیچ‌یک از سرورها پاسخ مناسب ندادند. دوباره تلاش کنید یا فهرست سرورها را تغییر دهید.";
            if (text.Contains("Internet traffic checks") || text.Contains("Tunnel reference check")) return "ارتباط با سرور برقرار شد، اما عبور اینترنت تأیید نشد. دوباره تلاش کنید.";
            if (text.Contains("integrity check")) return "یکی از فایل‌های برنامه تغییر کرده است. برنامه را دوباره نصب کنید.";
            if (text.Contains("Network engine exited")) return "موتور شبکه بسته شد. دوباره اتصال را آغاز کنید.";
            if (text.Contains("ENOTFOUND") || text.Contains("EAI_AGAIN")) return "نشانی سرور پیدا نشد. اتصال اینترنت و DNS را بررسی کنید.";
            if (text.Contains("ETIMEDOUT") || text.IndexOf("timeout", StringComparison.OrdinalIgnoreCase) >= 0) return "زمان انتظار اتصال به پایان رسید. دوباره تلاش کنید.";
            return text;
        }
        void Append(string text) { log.AppendText(DateTime.Now.ToString("HH:mm:ss") + "   " + text + Environment.NewLine); if (log.TextLength > 15000) log.Text = log.Text.Substring(log.TextLength - 12000); }
        async Task StartAsync() {
            if (worker != null) return;
            if (fullMode.Checked && !Program.IsAdmin) {
                try { Process.Start(new ProcessStartInfo(Application.ExecutablePath, "--start-full --port " + ((int)port.Value).ToString() + " --profile " + (profile.SelectedIndex == 1 ? "ir" : "global")) { UseShellExecute = true, Verb = "runas", WorkingDirectory = Program.Root }); allowClose = true; Close(); }
                catch (Win32Exception ex) { SetStatus("اتصال شروع نشد", ex.NativeErrorCode == 1223 ? "مجوز ویندوز تأیید نشد. می‌توانید دوباره تلاش کنید یا حالت پراکسی را انتخاب کنید." : ex.Message, Color.Firebrick); }
                return;
            }
            proxyMode.Enabled = fullMode.Enabled = port.Enabled = profile.Enabled = false; copy.Enabled = false; connect.Text = "قطع اتصال";
            SetStatus("در حال اتصال…", "دریافت تنظیمات و انتخاب سرور", teal);
            worker = new WorkerRunner(); WorkerRunner current = worker;
            try {
                current.Start(new { cmd = "start", mode = fullMode.Checked ? "full" : "proxy", profile = profile.SelectedIndex == 1 ? "ir" : "global", port = (int)port.Value }, delegate(string text) { Receive(current, text); });
                await current.Exited;
            } catch (Exception ex) { string message = FriendlyError(ex.Message); SetStatus("اتصال برقرار نشد", message, Color.Firebrick); Append(message); }
            finally {
                current.Dispose(); if (worker == current) worker = null;
                if (!IsDisposed) { connect.Text = "اتصال"; connect.Enabled = true; copy.Enabled = false; proxyMode.Enabled = fullMode.Enabled = port.Enabled = profile.Enabled = true; if (!closing && status.ForeColor != Color.Firebrick) SetStatus("اتصال قطع شد", "برای اتصال مجدد روی اتصال کلیک کنید.", navy); }
            }
        }
        void Receive(WorkerRunner source, string text) {
            if (IsDisposed) return;
            try { BeginInvoke((Action)delegate { HandleQueuedEvent(source, text); }); } catch (InvalidOperationException) { }
        }
        void HandleQueuedEvent(WorkerRunner source, string text) {
            if (IsDisposed || worker != source) return;
            HandleEvent(text);
        }
        void HandleEvent(string text) {
            try {
                var data = Program.Json.Deserialize<Dictionary<string, object>>(text); string type = Program.Value(data, "type"), stage = Program.Value(data, "stage");
                if (type == "error") { string message = FriendlyError(Program.Value(data, "message")); Append(message); SetStatus("خطا در اتصال", message, Color.Firebrick); return; }
                if (type != "state") return;
                switch (stage) {
                    case "port-selected":
                        int selectedPort;
                        if (Int32.TryParse(Program.Value(data, "port"), out selectedPort) && selectedPort >= 1024 && selectedPort <= 65535) port.Value = selectedPort;
                        if (Program.Value(data, "changed") == "True") Append("پورت " + Program.Value(data, "previousPort") + " در دسترس نبود؛ پورت " + port.Value + " انتخاب شد.");
                        break;
                    case "reconnecting": copy.Enabled = false; connect.Enabled = !stopping && !closing; SetStatus("در حال بازیابی اتصال", Program.Value(data, "round") == "" ? "در حال تلاش دوباره برای برقراری اتصال…" : "تلاش " + Program.Value(data, "round") + " برای بازیابی اتصال", teal); break;
                    case "loading": Append("بررسی تنظیمات امضاشده"); statusDetail.Text = "دریافت و بررسی تنظیمات"; break;
                    case "authenticating": statusDetail.Text = "در حال مذاکره با سرور؛ تلاش " + Program.Value(data, "attempt"); break;
                    case "preparing": Append(fullMode.Checked ? "آماده‌سازی تونل ویندوز" : "آماده‌سازی پراکسی"); statusDetail.Text = "آماده‌سازی مسیر اتصال"; break;
                    case "verifying": statusDetail.Text = "آزمایش عبور ترافیک اینترنت"; break;
                    case "connected":
                        if (stopping || closing) break;
                        int connectedPort;
                        if (Int32.TryParse(Program.Value(data, "port"), out connectedPort) && connectedPort >= 1024 && connectedPort <= 65535) port.Value = connectedPort;
                        copy.Enabled = true; SetStatus("متصل", "خروجی: " + Program.Value(data, "country") + (fullMode.Checked ? "  |  پوشش ترافیک ویندوز" : "  |  پراکسی 127.0.0.1:" + port.Value), teal); Append("اتصال و آزمون اینترنت موفق بود."); break;
                    case "stopping": copy.Enabled = false; if (status.ForeColor != Color.Firebrick) statusDetail.Text = "در حال قطع و بازگرداندن مسیر شبکه…"; break;
                    case "disconnected": if (status.ForeColor != Color.Firebrick) SetStatus("اتصال قطع شد", "مسیر اتصال بسته شد.", navy); Append("قطع اتصال و بستن موتور شبکه"); break;
                }
            } catch { Append(text); }
        }
        Task StopAsync() {
            if (worker == null && !stopCoordinator.Active) return Task.FromResult(true);
            return stopCoordinator.Run(delegate {
                WorkerRunner current = worker;
                if (current == null) return Task.FromResult(true);
                stopping = true; connect.Enabled = false;
                return StopCurrentAsync(current);
            });
        }
        async Task StopCurrentAsync(WorkerRunner current) {
            try { await current.StopAsync(); }
            finally { stopping = false; if (!IsDisposed && !closing) connect.Enabled = true; }
        }
        async void OnClosing(object sender, FormClosingEventArgs e) {
            if (allowClose || (worker == null && !stopCoordinator.Active)) return;
            e.Cancel = true; if (closing) return; closing = true;
            await StopAsync(); allowClose = true; Close();
        }
        public void RenderPreview(string path) {
            ShowInTaskbar = false; Opacity = 0; Show(); Application.DoEvents(); PerformLayout(); Update();
            using (var bitmap = new Bitmap(Width, Height)) { DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png); }
            Hide();
        }
    }
}
