//! 앱이 그리는 창 제목 표시줄(decorations: false)을 Windows 기본 제목 표시줄처럼 — 우클릭 시스템 메뉴.
//!
//! Alt+Space·작업 표시줄 메뉴는 Windows 가 그대로 처리한다. 제목 표시줄 우클릭만 WebView 가 받으므로
//! 여기서 같은 시스템 메뉴(이전 크기로·이동·크기 조정·최소화·최대화·닫기)를 커서 위치에 띄운다.

/// 제목 표시줄 우클릭 — 시스템 메뉴를 커서 위치에 띄우고, 고른 항목을 창에 그대로 보낸다(WM_SYSCOMMAND).
#[tauri::command]
pub fn window_system_menu(window: tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        let Ok(hwnd) = window.hwnd() else { return };
        let hwnd = hwnd.0 as isize;
        // 메뉴가 떠 있는 동안 메시지 루프를 돌리므로 IPC 처리와 분리해 창 스레드에서 연다.
        let _ = window.run_on_main_thread(move || unsafe { show_system_menu(hwnd as _) });
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
unsafe fn show_system_menu(hwnd: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    let menu = GetSystemMenu(hwnd, 0);
    if menu.is_null() {
        return;
    }
    // 항목 상태는 Windows 기본 제목 표시줄과 같게 — 최대화 상태면 '이전 크기로' 만, 아니면 이동·크기 조정·최대화.
    let maximized = IsZoomed(hwnd) != 0;
    let state = |enabled: bool| MF_BYCOMMAND | if enabled { MF_ENABLED } else { MF_GRAYED };
    EnableMenuItem(menu, SC_RESTORE, state(maximized));
    EnableMenuItem(menu, SC_MOVE, state(!maximized));
    EnableMenuItem(menu, SC_SIZE, state(!maximized));
    EnableMenuItem(menu, SC_MINIMIZE, state(true));
    EnableMenuItem(menu, SC_MAXIMIZE, state(!maximized));
    EnableMenuItem(menu, SC_CLOSE, state(true));
    SetMenuDefaultItem(menu, SC_CLOSE, 0);

    let mut cursor = POINT { x: 0, y: 0 };
    if GetCursorPos(&mut cursor) == 0 {
        return;
    }
    let command = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, cursor.x, cursor.y, 0, hwnd, std::ptr::null());
    if command != 0 {
        PostMessageW(hwnd, WM_SYSCOMMAND, command as usize, 0);
    }
}
