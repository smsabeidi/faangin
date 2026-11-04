; electron-builder includes this file from buildResources for the NSIS installer and uninstaller.
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\faangin" "" "URL:Faangin"
  WriteRegStr SHCTX "Software\Classes\faangin" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\faangin\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
!macroend

; Electron's app.setLoginItemSettings writes a Run value (and a StartupApproved value when the user
; disables it in Task Manager) named after the AppUserModelId, which equals the appId. The generated
; uninstaller never removes them, so a user who uninstalled with "Launch at login" on kept a startup
; entry for an executable that no longer exists. An update runs the old uninstaller too, and must keep them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
    ReadRegStr $0 SHCTX "Software\Classes\faangin\shell\open\command" ""
    ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
      DeleteRegKey SHCTX "Software\Classes\faangin"
    ${endIf}
  ${endIf}
!macroend
