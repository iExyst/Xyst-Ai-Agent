param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('wait', 'resize', 'wait-size', 'close')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$ProcessId,
  [ValidateRange(0, 10000)]
  [int]$Width = 0,
  [ValidateRange(0, 10000)]
  [int]$Height = 0,
  [ValidateRange(100, 120000)]
  [int]$TimeoutMs = 30000
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public struct XystSmokeRect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public static class XystSmokeNative
{
    [DllImport("user32.dll", EntryPoint = "GetWindowRect", SetLastError = true)]
    private static extern bool NativeGetWindowRect(IntPtr window, out XystSmokeRect rect);

    [DllImport("user32.dll", EntryPoint = "GetClientRect", SetLastError = true)]
    private static extern bool NativeGetClientRect(IntPtr window, out XystSmokeRect rect);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int NativeGetWindowText(IntPtr window, StringBuilder text, int capacity);

    [DllImport("user32.dll", EntryPoint = "SetWindowPos", SetLastError = true)]
    private static extern bool NativeSetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)]
    private static extern bool NativePostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "IsHungAppWindow")]
    public static extern bool IsHungAppWindow(IntPtr window);

    [DllImport("user32.dll", EntryPoint = "GetDpiForWindow")]
    public static extern uint GetDpiForWindow(IntPtr window);

    public static XystSmokeRect GetWindowRect(IntPtr window)
    {
        XystSmokeRect rect;
        if (!NativeGetWindowRect(window, out rect)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return rect;
    }

    public static XystSmokeRect GetClientRect(IntPtr window)
    {
        XystSmokeRect rect;
        if (!NativeGetClientRect(window, out rect)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return rect;
    }

    public static string GetWindowTitle(IntPtr window)
    {
        StringBuilder text = new StringBuilder(512);
        NativeGetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    public static void SetClientSize(IntPtr window, int width, int height)
    {
        XystSmokeRect frame = GetWindowRect(window);
        XystSmokeRect client = GetClientRect(window);
        int frameWidth = (frame.Right - frame.Left) - (client.Right - client.Left);
        int frameHeight = (frame.Bottom - frame.Top) - (client.Bottom - client.Top);
        if (!NativeSetWindowPos(window, IntPtr.Zero, 0, 0, width + frameWidth, height + frameHeight, 0x0016))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void PostClose(IntPtr window)
    {
        if (!NativePostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

function Get-XystWindow {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $handle = [IntPtr]$process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $window = [XystSmokeNative]::GetWindowRect($handle)
  $client = [XystSmokeNative]::GetClientRect($handle)
  return [pscustomobject]@{
    title = [XystSmokeNative]::GetWindowTitle($handle)
    handle = $handle.ToInt64()
    width = $client.Right - $client.Left
    height = $client.Bottom - $client.Top
    dpi = [XystSmokeNative]::GetDpiForWindow($handle)
    outer_width = $window.Right - $window.Left
    outer_height = $window.Bottom - $window.Top
    hung = [XystSmokeNative]::IsHungAppWindow($handle)
  }
}

function Write-Json($value) {
  $value | ConvertTo-Json -Compress -Depth 4
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
switch ($Action) {
  'wait' {
    do {
      $window = Get-XystWindow
      if ($window) {
        if ($window.title -eq 'Xyst AI Assistant') {
          Write-Json $window
          exit 0
        }
        if (-not [string]::IsNullOrWhiteSpace($window.title)) { throw "Unexpected desktop window title: $($window.title)" }
      }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Xyst AI Assistant did not create a main window for process $ProcessId within $TimeoutMs ms."
  }
  'resize' {
    if ($Width -lt 760 -or $Height -lt 540) { throw 'Resize target is below the supported 760x540 client area.' }
    $window = Get-XystWindow
    if (-not $window) { throw "Xyst AI Assistant process $ProcessId has no main window." }
    $dpi = if ($window.dpi -gt 0) { $window.dpi } else { 96 }
    $scale = $dpi / 96.0
    $physicalWidth = [int][Math]::Round($Width * $scale)
    $physicalHeight = [int][Math]::Round($Height * $scale)
    [XystSmokeNative]::SetClientSize([IntPtr]$window.handle, $physicalWidth, $physicalHeight)
    do {
      $window = Get-XystWindow
      if ($window) {
        $dpi = if ($window.dpi -gt 0) { $window.dpi } else { 96 }
        $logicalWidth = [Math]::Round($window.width * 96.0 / $dpi)
        $logicalHeight = [Math]::Round($window.height * 96.0 / $dpi)
      }
      if ($window -and [Math]::Abs($logicalWidth - $Width) -le 4 -and [Math]::Abs($logicalHeight - $Height) -le 4) {
        if ($window.hung) { throw 'The Xyst AI Assistant window stopped responding after resize.' }
        $window | Add-Member -NotePropertyName logical_width -NotePropertyValue $logicalWidth
        $window | Add-Member -NotePropertyName logical_height -NotePropertyValue $logicalHeight
        Write-Json $window
        exit 0
      }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Xyst AI Assistant did not resize to ${Width}x${Height}; observed $($window.width)x$($window.height)."
  }
  'wait-size' {
    do {
      $window = Get-XystWindow
      if ($window) {
        $dpi = if ($window.dpi -gt 0) { $window.dpi } else { 96 }
        $logicalWidth = [Math]::Round($window.width * 96.0 / $dpi)
        $logicalHeight = [Math]::Round($window.height * 96.0 / $dpi)
      }
      if ($window -and [Math]::Abs($logicalWidth - $Width) -le 4 -and [Math]::Abs($logicalHeight - $Height) -le 4) {
        if ($window.hung) { throw 'The restored Xyst AI Assistant window is not responding.' }
        $window | Add-Member -NotePropertyName logical_width -NotePropertyValue $logicalWidth
        $window | Add-Member -NotePropertyName logical_height -NotePropertyValue $logicalHeight
        Write-Json $window
        exit 0
      }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Xyst AI Assistant did not restore ${Width}x${Height}; observed $($window.width)x$($window.height)."
  }
  'close' {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { Write-Json @{ closed = $true }; exit 0 }
    $window = Get-XystWindow
    if (-not $window) { throw "Xyst AI Assistant process $ProcessId has no main window to close." }
    if (-not $process.CloseMainWindow()) { [XystSmokeNative]::PostClose([IntPtr]$window.handle) }
    if ($process.WaitForExit($TimeoutMs)) { Write-Json @{ closed = $true }; exit 0 }
    throw "Xyst AI Assistant process $ProcessId did not close within $TimeoutMs ms."
  }
}
