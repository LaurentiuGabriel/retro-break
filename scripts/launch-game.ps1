# Opens -Rom in the emulator at -Exe, then resizes its window to -ScreenShare
# of the screen's height (keeping its shape) and centers it.
param(
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$Rom,
  [double]$ScreenShare = 0.6
)
$ErrorActionPreference = 'Stop'

$p = Start-Process -PassThru -FilePath $Exe -WorkingDirectory (Split-Path $Exe) -ArgumentList ('"' + $Rom + '"')

# Best effort from here: a window that doesn't show up in ~10 s is left as it is.
try {
  Add-Type -Namespace RetroBreak -Name Win -MemberDefinition @'
public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
  # Without this, on a scaled display Windows hands us scaled coordinates
  # and the window lands off-center.
  [RetroBreak.Win]::SetProcessDPIAware() | Out-Null
  Add-Type -AssemblyName System.Windows.Forms

  for ($i = 0; $i -lt 40 -and $p.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 250; $p.Refresh() }
  if ($p.MainWindowHandle -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 700  # let the emulator size the window for the game first

  $h = $p.MainWindowHandle
  $r = New-Object RetroBreak.Win+RECT
  [RetroBreak.Win]::GetWindowRect($h, [ref]$r) | Out-Null
  $area = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
  $height = [int]($area.Height * $ScreenShare)
  $width = [int]($height * ($r.Right - $r.Left) / [Math]::Max(1, $r.Bottom - $r.Top))
  if ($width -gt $area.Width) { $height = [int]($height * $area.Width / $width); $width = $area.Width }
  $x = [int]($area.Left + ($area.Width - $width) / 2)
  $y = [int]($area.Top + ($area.Height - $height) / 2)
  [RetroBreak.Win]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $width, $height, 0x14) | Out-Null  # NOZORDER | NOACTIVATE
} catch {
  exit 0
}
