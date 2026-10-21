using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ArgoDesktop {
    static class GuiLifecycleTests {
        static int assertions;
        [STAThread]
        static int Main() {
            try {
                StopCoalescesTwoCallers().GetAwaiter().GetResult();
                StopClearsAfterSynchronousCompletion().GetAwaiter().GetResult();
                StopClearsAfterFaultAndReentrantCompletion().GetAwaiter().GetResult();
                ClosingAwaitsInFlightStop();
                ReportsRequireCurrentCompletedSuccessfulWorker();
                CurrentConnectedEventUsesActualPort();
                StaleQueuedEventCannotChangeCurrentConnection();
                ConnectedWhileStoppingOrClosingCannotRestoreConnection();
                ReconnectingShowsUsefulDetailAndActions();
                Console.WriteLine("PASS GuiLifecycleTests " + assertions);
                return 0;
            } catch (Exception ex) { Console.Error.WriteLine("FAIL GuiLifecycleTests: " + ex); return 1; }
        }
        static void Check(bool condition, string message) { assertions++; if (!condition) throw new Exception(message); }
        static Type StopType() {
            Type type = typeof(MainForm).Assembly.GetType("ArgoDesktop.StopCoordinator");
            Check(type != null, "production stop coordinator must exist");
            return type;
        }
        static Task Stop(object stop, Func<Task> action) {
            return (Task)stop.GetType().GetMethod("Run", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Invoke(stop, new object[] { action });
        }
        static object NewStop() { return Activator.CreateInstance(StopType(), true); }
        static async Task StopCoalescesTwoCallers() {
            object stop = NewStop(); var cleanup = new TaskCompletionSource<bool>(); int calls = 0;
            Func<Task> action = delegate { calls++; return cleanup.Task; };
            Task first = Stop(stop, action), second = Stop(stop, action);
            Check(Object.ReferenceEquals(first, second), "both stop callers must await the same task");
            Check(!first.IsCompleted && !second.IsCompleted, "stop callers must remain pending through cleanup");
            Check(calls == 1, "stop action must run once");
            cleanup.SetResult(true); await Task.WhenAll(first, second);
        }
        static async Task StopClearsAfterSynchronousCompletion() {
            object stop = NewStop(); int calls = 0;
            Func<Task> action = delegate { calls++; return Task.FromResult(true); };
            await Stop(stop, action); await Stop(stop, action);
            Check(calls == 2, "synchronous completion must clear the cache for the next operation");
        }
        static async Task StopClearsAfterFaultAndReentrantCompletion() {
            object stop = NewStop(); int calls = 0;
            Task failed = Stop(stop, delegate { calls++; throw new InvalidOperationException("stop failed"); });
            try { await failed; throw new Exception("fault was lost"); }
            catch (InvalidOperationException) { }
            await Stop(stop, delegate { calls++; return Task.FromResult(true); });
            Check(calls == 2, "fault must clear the stop cache");
            var pending = new TaskCompletionSource<bool>();
            Task first = Stop(stop, delegate { calls++; return pending.Task; });
            Task reentrant = null;
            Task continuation = first.ContinueWith(delegate { reentrant = Stop(stop, delegate { calls++; return Task.FromResult(true); }); }, TaskContinuationOptions.ExecuteSynchronously);
            pending.SetResult(true); await first; await continuation;
            Check(reentrant != null && reentrant.IsCompleted && calls == 4, "completed stop must clear cache before reentrant callers run");
        }
        static void ClosingAwaitsInFlightStop() {
            using (var form = new MainForm(false, 10808, 0)) {
                object stop = Field(form, "stopCoordinator");
                var cleanup = new TaskCompletionSource<bool>();
                Stop(stop, delegate { return cleanup.Task; });
                var args = new FormClosingEventArgs(CloseReason.UserClosing, false);
                SynchronizationContext previous = SynchronizationContext.Current;
                try {
                    SynchronizationContext.SetSynchronizationContext(null);
                    typeof(MainForm).GetMethod("OnClosing", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly, null, new[] { typeof(object), typeof(FormClosingEventArgs) }, null).Invoke(form, new object[] { form, args });
                } finally { SynchronizationContext.SetSynchronizationContext(previous); }
                Check(args.Cancel, "close must be deferred while cleanup is pending");
                Check(!(bool)Field(form, "allowClose"), "close must not be allowed before cleanup finishes");
                cleanup.SetResult(true);
                Check(SpinWait.SpinUntil(delegate { return (bool)Field(form, "allowClose"); }, 2000), "close must become allowed after the same stop finishes");
            }
        }
        static bool Success(Dictionary<string, object> report, int exitCode) {
            MethodInfo method = typeof(Program).GetMethod("IsSuccessfulTestReport", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Check(method != null, "production self-test report predicate must exist");
            return (bool)method.Invoke(null, new object[] { report, exitCode });
        }
        static Dictionary<string, object> GoodReport() {
            return new Dictionary<string, object> { { "version", "0.3.0" }, { "tunnelVerified", true }, { "lastStage", "disconnected" }, { "completedAt", "2026-10-20T00:00:00Z" }, { "stopReason", "test-complete" } };
        }
        static void ReportsRequireCurrentCompletedSuccessfulWorker() {
            Check(Success(GoodReport(), 0), "completed verified current report and exit zero must pass");
            Check(!Success(GoodReport(), 1), "worker exit one must reject even a previously verified report");
            var report = GoodReport(); report["version"] = "0.2.1"; Check(!Success(report, 0), "old report version must reject");
            report = GoodReport(); report.Remove("completedAt"); Check(!Success(report, 0), "uncompleted report must reject");
            report = GoodReport(); report["lastStage"] = "connected"; Check(!Success(report, 0), "still connected report must reject");
            report = GoodReport(); report["errorCode"] = "REPORT_WRITE_FAILED"; Check(!Success(report, 0), "report error code must reject");
            report = GoodReport(); report["tunnelVerified"] = false; Check(!Success(report, 0), "unverified report must reject");
            report = GoodReport(); report["stopReason"] = "requested"; Check(!Success(report, 0), "self-test must reject an unrelated completed stop");
        }
        static object Field(object target, string name) { return target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(target); }
        static void SetField(object target, string name, object value) { target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(target, value); }
        static void Queued(MainForm form, WorkerRunner source, string json) {
            MethodInfo method = typeof(MainForm).GetMethod("HandleQueuedEvent", BindingFlags.Instance | BindingFlags.NonPublic);
            Check(method != null, "queued production handler must verify its worker source");
            method.Invoke(form, new object[] { source, json });
        }
        static MainForm FormWithWorker(out WorkerRunner worker) {
            var form = new MainForm(false, 10808, 0); worker = new WorkerRunner(); SetField(form, "worker", worker); return form;
        }
        static void CurrentConnectedEventUsesActualPort() {
            WorkerRunner worker; using (var form = FormWithWorker(out worker)) {
                Queued(form, worker, "{\"type\":\"state\",\"stage\":\"connected\",\"port\":10819,\"country\":\"DE\"}");
                Check(((NumericUpDown)Field(form, "port")).Value == 10819, "connected state must show actual selected port");
                Check(((Button)Field(form, "copy")).Enabled, "copy must enable for current connection");
                Check(((Label)Field(form, "statusDetail")).Text.Contains("127.0.0.1:10819"), "connected address must show actual port");
            }
        }
        static void StaleQueuedEventCannotChangeCurrentConnection() {
            WorkerRunner old; using (var form = FormWithWorker(out old)) {
                var current = new WorkerRunner(); SetField(form, "worker", current);
                Queued(form, old, "{\"type\":\"state\",\"stage\":\"connected\",\"port\":10819,\"country\":\"DE\"}");
                Check(((NumericUpDown)Field(form, "port")).Value == 10808, "old worker queued event must not change current port");
                Check(!((Button)Field(form, "copy")).Enabled, "old worker queued event must not enable copy");
            }
        }
        static void ConnectedWhileStoppingOrClosingCannotRestoreConnection() {
            foreach (string state in new[] { "stopping", "closing" }) {
                WorkerRunner worker; using (var form = FormWithWorker(out worker)) {
                    SetField(form, state, true);
                    Queued(form, worker, "{\"type\":\"state\",\"stage\":\"connected\",\"port\":10819,\"country\":\"DE\"}");
                    Check(((NumericUpDown)Field(form, "port")).Value == 10808, "connected event during " + state + " must not change port");
                    Check(!((Button)Field(form, "copy")).Enabled, "connected event during " + state + " must not enable copy");
                    Check(((Label)Field(form, "status")).Text != "متصل", "connected event during " + state + " must not show connected status");
                }
            }
        }
        static void ReconnectingShowsUsefulDetailAndActions() {
            WorkerRunner worker; using (var form = FormWithWorker(out worker)) {
                ((Button)Field(form, "copy")).Enabled = true;
                Queued(form, worker, "{\"type\":\"state\",\"stage\":\"reconnecting\"}");
                Check(!((Button)Field(form, "copy")).Enabled, "copy must disable during recovery");
                Check(((Button)Field(form, "connect")).Enabled, "disconnect must stay available during recovery");
                string detail = ((Label)Field(form, "statusDetail")).Text;
                Check(detail.Length > 12 && !detail.EndsWith("تلاش "), "missing round needs meaningful recovery detail");
                Queued(form, worker, "{\"type\":\"state\",\"stage\":\"reconnecting\",\"round\":2}");
                Check(((Label)Field(form, "statusDetail")).Text.Contains("2"), "available recovery round must appear in detail");
            }
        }
    }
}
