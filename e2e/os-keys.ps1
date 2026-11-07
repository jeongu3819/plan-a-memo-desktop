# 실제 Windows 키 입력(OS → IME → WebView2) — e2e/editor-edge-clip.mjs --os-ime 전용.
#   -Keys 15,44   가상 키 코드(16진수)를 차례로 누른다(15 = 한/영, 44 = D → 2벌식 'ㅇ').
# 안전: 테스트 창을 앞으로 가져온 뒤, 누를 때마다 앞 창이 테스트 앱인지 확인하고 아니면 멈춘다(종료 코드 2).
param([Parameter(Mandatory = $true)][int]$AppPid, [string]$Keys = '')
Add-Type -Namespace PlanaE2e -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
$hwnd = (Get-Process -Id $AppPid).MainWindowHandle
function ForegroundPid { $p = 0; [void][PlanaE2e.Keys]::GetWindowThreadProcessId([PlanaE2e.Keys]::GetForegroundWindow(), [ref]$p); return $p }
# 다른 앱이 앞에 있으면 SetForegroundWindow 가 거절된다 — 앞 창의 입력 스레드에 잠깐 붙어서 넘겨받는다.
for ($i = 0; $i -lt 5 -and (ForegroundPid) -ne $AppPid; $i++) {
  $ignored = 0
  $fgThread = [PlanaE2e.Keys]::GetWindowThreadProcessId([PlanaE2e.Keys]::GetForegroundWindow(), [ref]$ignored)
  $me = [PlanaE2e.Keys]::GetCurrentThreadId()
  [void][PlanaE2e.Keys]::AttachThreadInput($me, $fgThread, $true)
  [void][PlanaE2e.Keys]::ShowWindow($hwnd, 5)
  [void][PlanaE2e.Keys]::BringWindowToTop($hwnd)
  [void][PlanaE2e.Keys]::SetForegroundWindow($hwnd)
  [void][PlanaE2e.Keys]::AttachThreadInput($me, $fgThread, $false)
  Start-Sleep -Milliseconds 300
}
foreach ($key in ($Keys -split ',')) {
  if (-not $key) { continue }
  $fg = ForegroundPid
  if ($fg -ne $AppPid) { Write-Output "NOT_FOREGROUND $fg"; exit 2 }
  $vk = [Convert]::ToByte($key, 16)
  [PlanaE2e.Keys]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [PlanaE2e.Keys]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
}
if ((ForegroundPid) -ne $AppPid) { Write-Output 'NOT_FOREGROUND'; exit 2 }
Write-Output 'OK'
