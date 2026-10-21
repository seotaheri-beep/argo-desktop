using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace ArgoDesktop {
    internal static class RuntimeGuardTests {
        private static int checks;
        private static int skippedPrerequisites;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool CreateSymbolicLink(string link, string target, int flags);

        private static void Check(bool condition, string message) {
            checks++;
            if (!condition) throw new Exception("CHECK FAILED: " + message);
            Console.WriteLine("PASS " + checks + ": " + message);
        }

        private static string Child(string parent, string name) {
            string path = Path.GetFullPath(Path.Combine(parent, name));
            if (!path.StartsWith(Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Fixture path escaped its parent: " + path);
            return path;
        }

        private static void Write(string path, string contents) { File.WriteAllText(path, contents); }

        private static void CreateJunction(string link, string target) {
            CreateLink(link, target, "Junction");
        }

        private static bool CreateFileSymbolicLink(string link, string target) {
            bool created = CreateSymbolicLink(link, target, 0x2);
            int error = Marshal.GetLastWin32Error();
            bool exists = File.Exists(link);
            Console.WriteLine("SYMLINK API result=" + created + ", Win32Error=" + error + ", pathExists=" + exists + ", path=" + link);
            if (exists) return true;
            if (error == 1314) {
                skippedPrerequisites++;
                Console.WriteLine("SKIP config-symlink behavior: Windows reports ERROR_PRIVILEGE_NOT_HELD and did not materialize the fixture link.");
                return false;
            }
            throw new IOException("File symlink fixture failed unexpectedly: API result=" + created + ", Win32 error=" + error + ", path exists=" + exists + ", path=" + link);
        }

        private static void CreateLink(string link, string target, string type) {
            string qlink = link.Replace("'", "''"), qtarget = target.Replace("'", "''");
            var start = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command \"New-Item -ItemType " + type + " -Path '" + qlink + "' -Target '" + qtarget + "' | Out-Null\"");
            start.UseShellExecute = false; start.CreateNoWindow = true;
            using (Process process = Process.Start(start)) {
                process.WaitForExit();
                if (process.ExitCode != 0) throw new Exception("Could not create fixture junction " + link + " (exit " + process.ExitCode + ")");
            }
        }

        private static bool IsReparse(string path) { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }

        private static void TestLeaseAndAcl(string root) {
            string data = Child(root, "lease-data"); Directory.CreateDirectory(data);
            RuntimeGuard first = RuntimeGuard.Open(data);
            try {
                bool locked = false;
                try { using (RuntimeGuard ignored = RuntimeGuard.Open(data)) { } }
                catch (IOException) { locked = true; }
                Check(locked, "second lease on the same runtime is rejected");

                string runtime = Child(data, "runtime");
                DirectorySecurity security = new DirectoryInfo(runtime).GetAccessControl(AccessControlSections.Access);
                Check(security.AreAccessRulesProtected, "runtime ACL blocks inherited rules");
                var expectedSids = new[] {
                    WindowsIdentity.GetCurrent().User,
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null)
                };
                var rules = security.GetAccessRules(true, false, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
                Check(rules.Length == 3, "runtime ACL contains exactly three explicit principals");
                foreach (SecurityIdentifier sid in expectedSids) {
                    Check(rules.Count(r => ((SecurityIdentifier)r.IdentityReference).Equals(sid) && r.AccessControlType == AccessControlType.Allow && r.FileSystemRights == FileSystemRights.FullControl && (r.InheritanceFlags & (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit)) == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) && r.PropagationFlags == PropagationFlags.None) == 1,
                        "runtime ACL grants inheritable full control only to " + sid.Value);
                }
                Check(!rules.Any(r => ((SecurityIdentifier)r.IdentityReference).Equals(new SecurityIdentifier(WellKnownSidType.WorldSid, null)) || ((SecurityIdentifier)r.IdentityReference).Equals(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null))), "runtime ACL has no Everyone or Users rule");
            } finally { first.Dispose(); }

            using (RuntimeGuard reacquired = RuntimeGuard.Open(data)) Check(true, "lease can be reacquired after Dispose");
        }

        private static void TestCleanup(string root) {
            string data = Child(root, "cleanup-data"); Directory.CreateDirectory(data);
            string runtime = Child(data, "runtime"); Directory.CreateDirectory(runtime);
            string stale = Child(runtime, "connection-Ab12"); Directory.CreateDirectory(stale);
            string config = Child(stale, "config.json"); Write(config, "owned config");
            string empty = Child(runtime, "connection-Empty1"); Directory.CreateDirectory(empty);
            string unrelated = Child(runtime, "user-files"); Directory.CreateDirectory(unrelated);
            string keep = Child(unrelated, "keep.txt"); Write(keep, "keep");
            // The delegate models the process-presence check without starting or killing an engine.
            int active = RuntimeGuard.Cleanup(runtime, () => true);
            Check(active == 0 && Directory.Exists(stale) && File.Exists(config) && Directory.Exists(empty), "active engine defers all stale cleanup");
            int removed = RuntimeGuard.Cleanup(runtime, () => false);
            Check(removed == 2 && !Directory.Exists(stale) && !File.Exists(config) && !Directory.Exists(empty), "inactive engine removes known configs and empty connection directories");
            Check(File.Exists(keep) && File.ReadAllText(keep) == "keep", "unrelated user files remain unchanged");

            string symlinkTarget = Child(root, "config-target.json"); Write(symlinkTarget, "symlink target");
            string symlinkDirectory = Child(runtime, "connection-Symcfg1"); Directory.CreateDirectory(symlinkDirectory);
            string configSymlink = Child(symlinkDirectory, "config.json");
            bool symlinkAvailable = CreateFileSymbolicLink(configSymlink, symlinkTarget);
            if (symlinkAvailable) {
                int symlinkCleanup = RuntimeGuard.Cleanup(runtime, () => false);
                Check(symlinkCleanup == 0 && IsReparse(configSymlink) && File.Exists(configSymlink) && File.ReadAllText(symlinkTarget) == "symlink target", "config symlink and its target are preserved");
            } else Directory.Delete(symlinkDirectory, false);

            string extra = Child(runtime, "connection-Extra1"); Directory.CreateDirectory(extra);
            Write(Child(extra, "config.json"), "known"); Write(Child(extra, "notes.txt"), "unknown");
            string nested = Child(runtime, "connection-Nested1"); Directory.CreateDirectory(nested);
            string inner = Child(nested, "inner"); Directory.CreateDirectory(inner);
            Write(Child(inner, "dummy"), "nested");
            int conservative = RuntimeGuard.Cleanup(runtime, () => false);
            Check(conservative == 0 && File.Exists(Child(extra, "config.json")) && File.Exists(Child(extra, "notes.txt")) && File.Exists(Child(inner, "dummy")), "extra files and nested directories prevent cleanup");
        }

        private static void TestJunctions(string root) {
            string target = Child(root, "junction-target"); Directory.CreateDirectory(target);
            string keep = Child(target, "keep.txt"); Write(keep, "external target remains");
            string dataLink = Child(root, "data-link"); CreateJunction(dataLink, target);
            bool rejected = false;
            try { using (RuntimeGuard ignored = RuntimeGuard.Open(dataLink)) { } }
            catch (IOException) { rejected = true; }
            Check(rejected, "data ancestor junction is rejected before runtime creation");
            Check(!Directory.Exists(Child(target, "runtime")) && File.ReadAllText(keep) == "external target remains", "data junction rejection does not create or alter target runtime files");

            string safeData = Child(root, "safe-link-data"); Directory.CreateDirectory(safeData);
            string safeRuntime = Child(safeData, "runtime"); Directory.CreateDirectory(safeRuntime);
            string runtimeTarget = Child(root, "runtime-link-target"); Directory.CreateDirectory(runtimeTarget);
            string targetFile = Child(runtimeTarget, "keep.txt"); Write(targetFile, "junction target remains");
            string link = Child(safeRuntime, "connection-Link1"); CreateJunction(link, runtimeTarget);
            using (RuntimeGuard ignored = RuntimeGuard.Open(safeData)) { }
            Check(IsReparse(link) && File.Exists(targetFile) && File.ReadAllText(targetFile) == "junction target remains", "runtime junction is skipped and its target file is preserved");
        }

        private static int Main(string[] args) {
            try {
                if (args.Length != 1) throw new ArgumentException("Pass one fresh fixture directory.");
                string root = Path.GetFullPath(args[0]);
                string fixtureParent = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!root.StartsWith(fixtureParent, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Fixture must stay under the harness work directory: " + root);
                if (Directory.Exists(root) || File.Exists(root)) throw new InvalidOperationException("Fixture must be fresh; refusing to overwrite " + root);
                Directory.CreateDirectory(root);
                TestLeaseAndAcl(root);
                TestCleanup(root);
                TestJunctions(root);
                Console.WriteLine("PASS " + checks + " RuntimeGuard checks; SKIP " + skippedPrerequisites + " unavailable fixture prerequisite(s)");
                return 0;
            } catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }
    }
}
