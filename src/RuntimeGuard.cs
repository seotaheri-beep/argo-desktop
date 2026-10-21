using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;

namespace ArgoDesktop {
    internal sealed class RuntimeGuard : IDisposable {
        private const string LockFileName = ".owner.lock";
        private static readonly Regex ConnectionDirectory = new Regex("^connection-[A-Za-z0-9]+$", RegexOptions.CultureInvariant);
        private FileStream lease;

        private RuntimeGuard(FileStream heldLease) { lease = heldLease; }

        internal static RuntimeGuard Open(string data) {
            if (String.IsNullOrWhiteSpace(data)) throw new ArgumentException("A data directory is required.", "data");
            string runtime = Path.GetFullPath(Path.Combine(data, "runtime"));

            // Validate every existing node before CreateDirectory, since it follows junctions.
            RejectExistingReparseAncestors(runtime);
            Directory.CreateDirectory(runtime);
            RejectExistingReparseAncestors(runtime);

            ApplyPrivateAcl(runtime);
            FileStream heldLease = null;
            try {
                heldLease = new FileStream(Path.Combine(runtime, LockFileName), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                Cleanup(runtime, HasEngineProcess);
                return new RuntimeGuard(heldLease);
            } catch {
                if (heldLease != null) heldLease.Dispose();
                throw;
            }
        }

        private static void RejectExistingReparseAncestors(string path) {
            var nodes = new List<string>();
            string current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current)) {
                nodes.Add(current);
                string parent = Path.GetDirectoryName(current);
                if (String.IsNullOrEmpty(parent) || String.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) break;
                current = parent;
            }
            for (int i = nodes.Count - 1; i >= 0; i--) {
                string node = nodes[i];
                FileAttributes attributes;
                try { attributes = File.GetAttributes(node); }
                catch (FileNotFoundException) { continue; }
                catch (DirectoryNotFoundException) { continue; }
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Runtime path contains a reparse point: " + node);
                if ((attributes & FileAttributes.Directory) == 0 && i != nodes.Count - 1)
                    throw new IOException("Runtime path ancestor is not a directory: " + node);
            }
        }

        private static void ApplyPrivateAcl(string runtime) {
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            AddFullControl(security, WindowsIdentity.GetCurrent().User);
            AddFullControl(security, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null));
            AddFullControl(security, new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
            new DirectoryInfo(runtime).SetAccessControl(security);
        }

        private static void AddFullControl(DirectorySecurity security, SecurityIdentifier sid) {
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
        }

        private static bool HasEngineProcess() {
            Process[] processes = Process.GetProcessesByName("sing-box");
            bool found = processes.Length != 0;
            foreach (Process process in processes) process.Dispose();
            return found;
        }

        internal static int Cleanup(string runtime, Func<bool> hasEngine) {
            if (String.IsNullOrEmpty(runtime) || hasEngine == null) throw new ArgumentNullException();
            string root = Path.GetFullPath(runtime);
            try {
                if (hasEngine()) return 0;
            } catch {
                // If process inspection is uncertain, preserve every stale directory.
                return 0;
            }
            if (!Directory.Exists(root) || IsReparsePoint(root)) return 0;

            int removed = 0;
            string[] candidates;
            try { candidates = Directory.GetDirectories(root); }
            catch { return 0; }
            foreach (string candidate in candidates) {
                try {
                    string full = Path.GetFullPath(candidate);
                    if (!String.Equals(Path.GetDirectoryName(full), root, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!ConnectionDirectory.IsMatch(Path.GetFileName(full)) || IsReparsePoint(full)) continue;

                    string[] directories = Directory.GetDirectories(full);
                    if (directories.Length != 0) continue;
                    string[] files = Directory.GetFiles(full);
                    if (files.Length > 1) continue;
                    if (files.Length == 1) {
                        string config = files[0];
                        if (!String.Equals(Path.GetFileName(config), "config.json", StringComparison.Ordinal) || IsReparsePoint(config)) continue;
                        File.Delete(config);
                    }
                    Directory.Delete(full, false);
                    removed++;
                } catch {
                    // Races, access errors, and unexpected layouts are preserved conservatively.
                }
            }
            return removed;
        }

        private static bool IsReparsePoint(string path) {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }

        public void Dispose() {
            FileStream heldLease = lease;
            lease = null;
            if (heldLease != null) heldLease.Dispose();
        }
    }
}
