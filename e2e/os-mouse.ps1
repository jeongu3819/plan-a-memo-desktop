# 실제 Windows 마우스 입력 — e2e/drag-os.mjs 전용. 표준 입력으로 한 줄씩 명령을 받아 한 줄로 답한다.
#   origin            테스트 창 클라이언트 영역의 화면 좌표(물리 픽셀)
#   hold              테스트 창을 맨 위로(끝나면 release)
#   move X Y          커서를 옮긴다(직전 위치에서 사람이 커서를 움직였으면 ABORT)
#   down / up         왼쪽 버튼(down 은 커서 아래가 테스트 창일 때만)
#   wheel N           휠, esc  Esc 키
#   size W H          창 크기(물리 픽셀)
# 안전: 커서 아래가 테스트 창이 아니면 누르지 않는다. 끝날 때 눌린 버튼을 놓고 커서를 원래 자리로 되돌린다.
param([Parameter(Mandatory = $true)][int]$AppPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Os {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int cy, uint f);
}
"@
[void][Os]::SetProcessDPIAware()
$hwnd = (Get-Process -Id $AppPid).MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('ERROR no-window'); exit 1 }
$TOPMOST = [IntPtr](-1); $NOTOPMOST = [IntPtr](-2)
$NOSIZE = 1; $NOMOVE = 2
$start = New-Object Os+POINT; [void][Os]::GetCursorPos([ref]$start)
$last = $start
$pressed = $false

function Over-App {
  $p = New-Object Os+POINT; [void][Os]::GetCursorPos([ref]$p)
  $root = [Os]::GetAncestor([Os]::WindowFromPoint($p), 2)
  return $root -eq $hwnd
}
function Moved-Outside {
  $p = New-Object Os+POINT; [void][Os]::GetCursorPos([ref]$p)
  return ([Math]::Abs($p.X - $last.X) -gt 2) -or ([Math]::Abs($p.Y - $last.Y) -gt 2)
}

try {
  [Console]::Out.WriteLine('READY')
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $a = $line.Split(' ')
    switch ($a[0]) {
      'origin' {
        $o = New-Object Os+POINT; [void][Os]::ClientToScreen($hwnd, [ref]$o)
        [Console]::Out.WriteLine("OK $($o.X) $($o.Y)")
      }
      'hold' { [void][Os]::SetWindowPos($hwnd, $TOPMOST, 0, 0, 0, 0, $NOSIZE + $NOMOVE); [Console]::Out.WriteLine('OK') }
      'release' { [void][Os]::SetWindowPos($hwnd, $NOTOPMOST, 0, 0, 0, 0, $NOSIZE + $NOMOVE); [Console]::Out.WriteLine('OK') }
      'size' { [void][Os]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, [int]$a[1], [int]$a[2], $NOMOVE + 4); [Console]::Out.WriteLine('OK') }
      'move' {
        if (Moved-Outside) {
          if ($pressed) { [Os]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); $pressed = $false }
          [Console]::Out.WriteLine('ABORT cursor-moved-outside')
          break
        }
        if (-not [Os]::SetCursorPos([int]$a[1], [int]$a[2])) { [Console]::Out.WriteLine('ABORT set-cursor-failed'); break }
        [void][Os]::GetCursorPos([ref]$last)
        [Console]::Out.WriteLine('OK')
      }
      'down' {
        if (-not (Over-App)) { [Console]::Out.WriteLine('ABORT not-over-app'); break }
        [Os]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); $pressed = $true
        [Console]::Out.WriteLine('OK')
      }
      'up' { [Os]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); $pressed = $false; [Console]::Out.WriteLine('OK') }
      'wheel' {
        if (-not (Over-App)) { [Console]::Out.WriteLine('ABORT not-over-app'); break }
        [Os]::mouse_event(0x0800, 0, 0, [int]$a[1], [UIntPtr]::Zero); [Console]::Out.WriteLine('OK')
      }
      'esc' { if ([Os]::GetAncestor([Os]::GetForegroundWindow(), 2) -ne $hwnd) { [Console]::Out.WriteLine('ABORT not-foreground'); break }
        # 스캔 코드(0x01)까지 보낸다 — 실제 키보드와 같게(event.code = 'Escape').
        [Os]::keybd_event(0x1B, 0x01, 0, [UIntPtr]::Zero); [Os]::keybd_event(0x1B, 0x01, 2, [UIntPtr]::Zero); [Console]::Out.WriteLine('OK') }
      default { [Console]::Out.WriteLine('ERROR unknown') }
    }
  }
} finally {
  if ($pressed) { [Os]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
  [void][Os]::SetCursorPos($start.X, $start.Y)
  if (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) { [void][Os]::SetWindowPos($hwnd, $NOTOPMOST, 0, 0, 0, 0, $NOSIZE + $NOMOVE) }
}
