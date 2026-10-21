param(
 [Parameter(Mandatory=$true)][string]$Makensis,
 [Parameter(Mandatory=$true)][string]$PayloadPath,
 [switch]$NoSetup
)
$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$app = Join-Path $project 'app'
$output = Join-Path $project 'outputs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$gui = [IO.File]::ReadAllText((Join-Path $project 'src\ArgoDesktop.cs'))
$versionMatch = [regex]::Match($gui, 'public const string Version = "([0-9]+\.[0-9]+\.[0-9]+)";')
if (!$versionMatch.Success) { throw 'Application version was not found' }
$version = $versionMatch.Groups[1].Value
$numericVersion = $version + '.0'
if (!(Test-Path -LiteralPath $Makensis -PathType Leaf)) { throw 'NSIS compiler not found' }
$manifestPath = Join-Path $PayloadPath 'integrity.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($relative in @('runtime/node.exe','bin/sing-box.exe','bin/wintun.dll')) {
 $actual = (Get-FileHash -LiteralPath (Join-Path $PayloadPath $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
 if ($actual -ne $manifest.$relative) { throw "Payload hash failed: $relative" }
}
New-Item -ItemType Directory -Path $app,$output -Force | Out-Null
foreach ($folder in @('bin','runtime','licenses')) {
 Copy-Item -LiteralPath (Join-Path $PayloadPath $folder) -Destination $app -Recurse -Force
}
# Preserve the original public configuration, binary hashes, licenses and source archive.
foreach ($file in @('config-signed.txt','integrity.json')) {
 Copy-Item -LiteralPath (Join-Path $PayloadPath $file) -Destination (Join-Path $app $file) -Force
}
foreach ($file in @('app.ico','THIRD-PARTY-NOTICES.txt','README-fa.md')) {
 Copy-Item -LiteralPath (Join-Path $project "assets\$file") -Destination (Join-Path $app $file) -Force
}
Get-ChildItem -LiteralPath (Join-Path $project 'src') -Filter '*.mjs' -File | ForEach-Object {
 Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $app $_.Name) -Force
}
$sources = @(Get-ChildItem -LiteralPath (Join-Path $project 'src') -Filter '*.cs' -File | ForEach-Object FullName)
& $compiler /nologo /target:winexe /platform:x64 /optimize+ ('/out:'+(Join-Path $app 'ArgoDesktop.exe')) ('/win32icon:'+(Join-Path $app 'app.ico')) ('/win32manifest:'+(Join-Path $project 'src\app.manifest')) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll @sources
if ($LASTEXITCODE -ne 0) { throw 'C# compilation failed' }
if ($NoSetup) { Write-Output (Join-Path $app 'ArgoDesktop.exe'); return }
$setup = [IO.File]::ReadAllText((Join-Path $project 'setup.nsi'))
$setup = [regex]::Replace($setup, '(?m)^!define VERSION ".*"', '!define VERSION "'+$version+'"')
$setup = [regex]::Replace($setup, '(?m)^VIProductVersion ".*"', 'VIProductVersion "'+$numericVersion+'"')
$setup = [regex]::Replace($setup, '(?m)^(VIAddVersionKey "(?:FileVersion|ProductVersion)" )".*"', '${1}"'+$numericVersion+'"')
$installer = Join-Path $output "ArgoDesktop-Setup-$version-x64.exe"
$setup = [regex]::Replace($setup, '(?m)^OutFile ".*"', { param($match) 'OutFile "'+$installer+'"' })
$buildScript = Join-Path $project 'setup-build.nsi'
[IO.File]::WriteAllText($buildScript,$setup,(New-Object Text.UTF8Encoding($false)))
Push-Location $project
try {
 & $Makensis /INPUTCHARSET UTF8 /V3 $buildScript
 if ($LASTEXITCODE -ne 0) { throw 'NSIS compilation failed' }
} finally { Pop-Location }
Write-Output $installer
