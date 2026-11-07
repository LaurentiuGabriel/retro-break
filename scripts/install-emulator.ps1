# Prints the path of the emulator for -System, downloading it the first time.
#
# Downloads one pinned, official release from GitHub over HTTPS and unpacks it
# with Windows' built-in tar.exe into %LOCALAPPDATA%\retro-break\emulators.
# Nothing else is downloaded, and nothing is sent anywhere.
param(
  [Parameter(Mandatory)][ValidateSet('snes', 'gba')][string]$System
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$emulators = @{
  snes = @{ Exe = 'snes9x-x64.exe'; Url = 'https://github.com/snes9xgit/snes9x/releases/download/1.63/snes9x-1.63-win32-x64.zip' }
  gba  = @{ Exe = 'mGBA.exe'; Url = 'https://github.com/mgba-emu/mgba/releases/download/0.10.5/mGBA-0.10.5-win64.7z' }
}
$emu = $emulators[$System]
$dir = Join-Path $env:LOCALAPPDATA "retro-break\emulators\$System"

function Find-Exe {
  if (Test-Path -LiteralPath $dir) {
    Get-ChildItem -LiteralPath $dir -Recurse -Filter $emu.Exe | Select-Object -First 1 -ExpandProperty FullName
  }
}

$exe = Find-Exe
if (-not $exe) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $archive = Join-Path $dir 'download.tmp'
  Invoke-WebRequest -UseBasicParsing -Uri $emu.Url -OutFile $archive
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $archive -C $dir
  if ($LASTEXITCODE) { throw 'could not unpack the emulator download' }
  Remove-Item -LiteralPath $archive
  $exe = Find-Exe
  if (-not $exe) { throw "no $($emu.Exe) in the download" }
  if ($System -eq 'gba') {
    # An empty portable.ini makes mGBA keep its settings and saves beside itself.
    New-Item -ItemType File -Force -Path (Join-Path (Split-Path $exe) 'portable.ini') | Out-Null
  }
}
Write-Output $exe
