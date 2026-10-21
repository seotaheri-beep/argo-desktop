# Argo Desktop 0.3.0-preview source

Acceptance is incomplete: two mandatory two-hour connection soaks (proxy and full
mode), plus ordinary Administrator install/upgrade acceptance, are still pending.
Application and installer numeric Windows metadata remains `0.3.0.0`; the preview
label describes acceptance status.

Build on Windows x64 with the built-in .NET Framework C# compiler, Node.js 24,
NSIS 3.13 and a supplied compatible extracted/installed 0.2.1 application payload.
No Visual Studio is required. This tree contains the independent Windows code,
public keys and public configuration tests; it contains no session credentials or
decompiled Android application code.

Run from this source directory in PowerShell:

```powershell
.\build-source.ps1 -Makensis 'C:\Tools\NSIS\makensis.exe' -PayloadPath 'C:\ArgoDesktop-Payload'
```

On other machines pass the actual NSIS compiler and extracted/installed payload
paths through those same mandatory parameters. The build verifies the SHA-256
hashes in the supplied `integrity.json` for `runtime/node.exe`, `bin/sing-box.exe`
and `bin/wintun.dll` before copying the payload. It copies the original licenses
and matching sing-box source archive unchanged. No downloads or dependency
upgrades are performed. See `assets/THIRD-PARTY-NOTICES.txt` for component versions
and license locations.

Add `-NoSetup` to compile only the application. Both parameters are still required.
`app/` and `outputs/` are generated directories. Edit runtime JavaScript only in
`src/`; every `src/*.mjs` is copied and every `src/*.cs` is compiled during build.
The installer build uses UTF-8 input and writes
`outputs/ArgoDesktop-Setup-0.3.0-x64.exe`.

Run the full local Node.js suite (Node.js 24):

```powershell
$node = 'C:\Program Files\nodejs\node.exe'
$tests = @(Get-ChildItem -LiteralPath tests -Filter '*.test.mjs' -File | ForEach-Object FullName)
& $node --test --test-concurrency=1 --test-timeout=15000 @tests
if ($LASTEXITCODE -ne 0) { throw 'Node tests failed' }
```

Compile and run the isolated C# harnesses from this directory:

```powershell
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$work = Join-Path $PWD.Path 'work'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$guardExe = Join-Path $work 'RuntimeGuardTests.exe'
& $compiler /nologo /target:exe /platform:x64 ('/out:' + $guardExe) src/RuntimeGuard.cs tests/RuntimeGuardTests.cs
if ($LASTEXITCODE -ne 0) { throw 'RuntimeGuard harness compilation failed' }
# The existing work parent contains a fresh, nonexistent fixture child.
# The harness creates that child and refuses to reuse an existing fixture.
$fixture = Join-Path $work ('runtime-guard-fixture-' + [guid]::NewGuid().ToString('N'))
& $guardExe $fixture
if ($LASTEXITCODE -ne 0) { throw 'RuntimeGuard harness failed' }

$guiExe = Join-Path $work 'GuiLifecycleTests.exe'
$sources = @(Get-ChildItem -LiteralPath src -Filter '*.cs' -File | ForEach-Object FullName)
& $compiler /nologo /target:exe /platform:x64 /main:ArgoDesktop.GuiLifecycleTests ('/out:' + $guiExe) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll @sources tests/GuiLifecycleTests.cs
if ($LASTEXITCODE -ne 0) { throw 'GUI lifecycle harness compilation failed' }
& $guiExe
if ($LASTEXITCODE -ne 0) { throw 'GUI lifecycle harness failed' }
```

RuntimeGuard has 15 baseline checks. A non-Administrator run may report 15 passes and one
skipped file-symlink prerequisite when Windows returns error 1314
(`ERROR_PRIVILEGE_NOT_HELD`); with the prerequisite available, the preserved
config-symlink assertion also runs, producing 16 passes. Record this skip explicitly;
do not remove or weaken that assertion. GUI lifecycle tests exercise isolated form
and worker-event logic without connecting or starting a real engine.

Live proxy/full-mode and installer acceptance are separate from local tests. Full
mode requires UAC approval. Record unavailable acceptance as incomplete; configuration
flags do not prove leak prevention. Both two-hour soaks and ordinary Administrator
install/upgrade remain mandatory before release acceptance. The ordinary GUI is
the supported entry point; direct worker execution is reserved for isolated IPC
fixtures that never start a real engine. No live connection or installer acceptance
is claimed by these instructions or by a successful build.
