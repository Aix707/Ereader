!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\66c4950e-0e91-5277-829b-a9431eec8afc" "UninstallString"
  ${If} $R0 != ""
    ReadRegStr $R2 HKCU "Software\66c4950e-0e91-5277-829b-a9431eec8afc" "InstallLocation"
    ${If} $R2 != ""
      StrCpy $INSTDIR $R2
    ${Else}
      MessageBox MB_ICONSTOP "无法确认旧版 Ereader 的安装目录，安装已停止。"
      Abort
    ${EndIf}
    ; _?= keeps the old uninstaller in this process: wait for removal to finish
    ; before writing the new application into the same directory.
    ExecWait '$R0 /S _?=$R2' $R1
    ${If} $R1 != 0
      MessageBox MB_ICONSTOP "旧版 Ereader 未能关闭或卸载，请关闭旧版后重新安装。"
      Abort
    ${EndIf}
    Delete "$R2\Uninstall Ereader.exe"
  ${EndIf}
  ; Tauri sets the output directory before this hook. Refresh it after adopting
  ; the legacy location so the executable and uninstaller land together.
  SetOutPath "$INSTDIR"
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
