; PLAN-A Memo — Tauri NSIS installerHooks (tauri.conf.json bundle.windows.nsis.installerHooks)
;
; 설치 모드는 currentUser(관리자 권한 없이 사용자 폴더에 설치)다. 이 훅은 Windows 권한 정책을 우회하지 않고,
; 권한이 없는 폴더에서 '조용히 실패' 하던 것을 미리 알려 멈춘다.
;
;  * 설치 전: 고른 폴더에 실제로 파일을 쓰고 지울 수 있는지 확인한다. 못 하면(예: 관리자가 만든 C:\plan_a_work,
;    C:\Program Files) 안내하고 멈춘다 — 파일 일부만 복사된 채 남지 않게.
;  * 제거 전: 설치 폴더의 파일을 지울 수 있는지 확인한다. 관리자 권한으로 설치했던 폴더라 못 지우면 안내하고
;    멈춘다 — 파일은 남았는데 '제거 완료' 가 뜨고 등록 정보만 지워지는 불일치를 막는다.
;  * 제거 후: 실행 파일이 남아 있으면(실행 중·권한) 위치를 알려 준다.
;
; 메모 데이터(사용자 폴더의 'PLAN-A Memo')는 설치 폴더 밖에 있어 설치·업데이트·제거가 건드리지 않는다.
; 이 파일은 UTF-8(BOM) 이어야 한글 안내가 깨지지 않는다.

!macro PLANA_PROBE_WRITE DIR
  ; $R9 = 1(쓰고 지울 수 있음) / 0(없음)
  StrCpy $R9 0
  ClearErrors
  FileOpen $R8 "${DIR}\.plana-write-test" w
  ${IfNot} ${Errors}
    FileClose $R8
    ClearErrors
    Delete "${DIR}\.plana-write-test"
    ${IfNot} ${Errors}
    ${AndIfNot} ${FileExists} "${DIR}\.plana-write-test"
      StrCpy $R9 1
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PLANA_PROBE_WRITE "$INSTDIR"
  ${If} $R9 <> 1
    ${If} $LANGUAGE = 1042
      MessageBox MB_ICONSTOP|MB_OK "선택한 폴더에 파일을 쓸 권한이 없습니다.$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\n관리자만 쓸 수 있는 폴더(C:\ 바로 아래에 관리자가 만든 폴더, Program Files 등)입니다.$\r$\n기본 위치(사용자 폴더) 또는 쓰기 권한이 있는 폴더를 선택해 다시 설치해주세요.$\r$\n$\r$\n메모 데이터는 바뀌지 않았습니다." /SD IDOK
    ${Else}
      MessageBox MB_ICONSTOP|MB_OK "You do not have permission to write to the selected folder.$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nChoose the default location (your user folder) or another folder you can write to, then run the installer again.$\r$\nYour memo data has not been changed." /SD IDOK
    ${EndIf}
    DetailPrint "PLAN-A Memo: no write permission for $INSTDIR"
    SetErrorLevel 5
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PLANA_PROBE_WRITE "$INSTDIR"
  ${If} $R9 <> 1
    ${If} $LANGUAGE = 1042
      MessageBox MB_ICONSTOP|MB_OK "설치 폴더의 파일을 지울 권한이 없어 제거를 멈췄습니다.$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\n관리자 권한으로 설치한 폴더라면 이 폴더의 uninstall.exe 를 마우스 오른쪽 버튼 → [관리자 권한으로 실행]으로 제거해주세요.$\r$\n아무것도 지우지 않았고, 메모 데이터도 그대로입니다." /SD IDOK
    ${Else}
      MessageBox MB_ICONSTOP|MB_OK "Uninstall stopped: you do not have permission to delete files in$\r$\n$INSTDIR$\r$\n$\r$\nIf it was installed as administrator, right-click uninstall.exe in that folder and choose 'Run as administrator'.$\r$\nNothing was removed and your memo data is unchanged." /SD IDOK
    ${EndIf}
    SetErrorLevel 5
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} $LANGUAGE = 1042
      MessageBox MB_ICONEXCLAMATION|MB_OK "일부 프로그램 파일을 지우지 못했습니다(실행 중이거나 권한 없음).$\r$\n$INSTDIR$\r$\n$\r$\n앱을 닫은 뒤 이 폴더를 직접 삭제해주세요. 메모 데이터는 이 폴더에 없으며 그대로입니다." /SD IDOK
    ${Else}
      MessageBox MB_ICONEXCLAMATION|MB_OK "Some program files could not be removed:$\r$\n$INSTDIR$\r$\nClose the app and delete this folder manually. Your memo data is not in this folder." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
