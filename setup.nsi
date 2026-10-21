Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
Var IsolatedTest

!define PRODUCT "Argo Desktop"
!define VERSION "0.3.0"
Name "${PRODUCT}"
OutFile "outputs\ArgoDesktop-Setup-0.3.0-x64.exe"
InstallDir "$PROGRAMFILES64\Argo Desktop"
InstallDirRegKey HKLM "Software\ArgoDesktop" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "0.3.0.0"
VIAddVersionKey "ProductName" "Argo Desktop"
VIAddVersionKey "FileDescription" "Argo Desktop Setup"
VIAddVersionKey "FileVersion" "0.3.0.0"
VIAddVersionKey "ProductVersion" "0.3.0.0"
VIAddVersionKey "LegalCopyright" "Unofficial interoperability build"

!define MUI_ICON "app\app.ico"
!define MUI_UNICON "app\app.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "Farsi"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
 SetRegView 64
 ${GetParameters} $R0
 ClearErrors
 ${GetOptions} $R0 "/TESTINSTALL" $R1
 ${IfNot} ${Errors}
  StrCpy $IsolatedTest 1
 ${EndIf}
 ${IfNot} ${AtLeastWin10}
  MessageBox MB_ICONSTOP "Windows 10 or later is required."
  Abort
 ${EndIf}
 ${IfNot} ${IsNativeAMD64}
  MessageBox MB_ICONSTOP "This installer requires native Windows x64."
  Abort
 ${EndIf}
 ${If} $IsolatedTest != 1
  Call CheckRunning
 ${EndIf}
FunctionEnd

Function CheckRunning
 System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\ArgoDesktop-0.2") p .r0'
 ${If} $0 P<> 0
  System::Call 'kernel32::CloseHandle(p r0)'
  MessageBox MB_ICONEXCLAMATION "ابتدا اتصال را قطع و برنامه Argo Desktop را ببندید."
  Abort
 ${EndIf}
FunctionEnd

Section "Argo Desktop" SEC_MAIN
 SetShellVarContext all
 SetOutPath "$INSTDIR"
 File /r /x "*.log" /x "reports" "app\*.*"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 ${If} $IsolatedTest == 1
  FileOpen $0 "$INSTDIR\.isolated-test" w
  FileWrite $0 "ArgoDesktop packaging verification"
  FileClose $0
 ${Else}
 WriteRegStr HKLM "Software\ArgoDesktop" "InstallDir" "$INSTDIR"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop" "DisplayName" "Argo Desktop"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop" "DisplayVersion" "${VERSION}"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop" "Publisher" "Unofficial interoperability build"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop" "DisplayIcon" "$INSTDIR\ArgoDesktop.exe"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
 WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop" "NoModify" 1
 WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop" "NoRepair" 1
 CreateDirectory "$SMPROGRAMS\Argo Desktop"
 CreateShortcut "$SMPROGRAMS\Argo Desktop\Argo Desktop.lnk" "$INSTDIR\ArgoDesktop.exe"
 CreateShortcut "$SMPROGRAMS\Argo Desktop\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
 CreateShortcut "$DESKTOP\Argo Desktop.lnk" "$INSTDIR\ArgoDesktop.exe"
 ${EndIf}
SectionEnd

Function un.onInit
 SetRegView 64
 IfFileExists "$INSTDIR\.isolated-test" 0 +2
 StrCpy $IsolatedTest 1
 ${If} $IsolatedTest == 1
  Return
 ${EndIf}
 System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\ArgoDesktop-0.2") p .r0'
 ${If} $0 P<> 0
  System::Call 'kernel32::CloseHandle(p r0)'
  MessageBox MB_ICONEXCLAMATION "ابتدا اتصال را قطع و برنامه Argo Desktop را ببندید."
  Abort
 ${EndIf}
FunctionEnd

Section "Uninstall"
 SetShellVarContext all
 ${If} $IsolatedTest != 1
 Delete "$DESKTOP\Argo Desktop.lnk"
 Delete "$SMPROGRAMS\Argo Desktop\Argo Desktop.lnk"
 Delete "$SMPROGRAMS\Argo Desktop\Uninstall.lnk"
 RMDir "$SMPROGRAMS\Argo Desktop"
 ${EndIf}
 ; Delete only the known application payload; user reports are outside this directory.
 Delete "$INSTDIR\*.mjs"
 Delete "$INSTDIR\integrity.json"
 Delete "$INSTDIR\config-signed.txt"
 Delete "$INSTDIR\app.ico"
 Delete "$INSTDIR\ArgoDesktop.exe"
 Delete "$INSTDIR\README-fa.md"
 Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
 Delete "$INSTDIR\runtime\node.exe"
 Delete "$INSTDIR\runtime\NODE-LICENSE.txt"
 RMDir "$INSTDIR\runtime"
 Delete "$INSTDIR\bin\sing-box.exe"
 Delete "$INSTDIR\bin\wintun.dll"
 RMDir "$INSTDIR\bin"
 Delete "$INSTDIR\licenses\*.*"
 RMDir "$INSTDIR\licenses"
 Delete "$INSTDIR\Uninstall.exe"
 Delete "$INSTDIR\.isolated-test"
 RMDir "$INSTDIR"
 ${If} $IsolatedTest != 1
 DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ArgoDesktop"
 DeleteRegKey HKLM "Software\ArgoDesktop"
 ${EndIf}
SectionEnd
