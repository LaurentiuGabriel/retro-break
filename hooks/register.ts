import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

// Portable Windows builds, pinned so every install gets the same thing.
// Each is downloaded the first time a game for that system is picked.
const EMULATORS = {
  gba: {
    name: 'mGBA',
    exe: 'mGBA.exe',
    url: 'https://github.com/mgba-emu/mgba/releases/download/0.10.5/mGBA-0.10.5-win64.7z',
    // An empty portable.ini makes mGBA keep its settings and saves beside itself.
    portableFile: 'portable.ini',
  },
  snes: {
    name: 'Snes9x',
    exe: 'snes9x-x64.exe',
    url: 'https://github.com/snes9xgit/snes9x/releases/download/1.63/snes9x-1.63-win32-x64.zip',
    portableFile: undefined,
  },
} as const

type System = keyof typeof EMULATORS

const SYSTEM_BY_EXT: Record<string, System> = {
  sfc: 'snes',
  smc: 'snes',
  gba: 'gba',
  gb: 'gba',
  gbc: 'gba',
}

const MAX_DEPTH = 4
const EMULATOR_EXES = Object.values(EMULATORS).map(e => e.exe.toLowerCase())

// --- small helpers ---------------------------------------------------------

/** A PowerShell single-quoted literal. */
const psq = (s: string) => `'${s.replaceAll("'", "''")}'`

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** UTF-16LE base64, the form `powershell -EncodedCommand` takes. */
function encodeCommand(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bytes.push(c & 0xff, c >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}

function powershell($: $, script: string, timeoutMs = 30_000) {
  return $.process.run(
    [
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodeCommand(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`),
    ],
    { timeoutMs },
  )
}

const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join('\\')

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')))

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)

// --- state (module-level; a hot reload starts it over) ------------------

type Config = { folders: string[]; delayMs: number }

const state: {
  pending: { cancel: () => void } | undefined
  romCache: { path: string; system: System }[] | undefined
  hasWarnedNoFolder: boolean
  isLaunching: boolean
} = { pending: undefined, romCache: undefined, hasWarnedNoFolder: false, isLaunching: false }

// --- work ------------------------------------------------------------------

async function findRoms($: $, config: Config) {
  if (state.romCache) return state.romCache
  const found: { path: string; system: System }[] = []
  const pending = config.folders.map(folder => ({ dir: folder, depth: 0 }))
  while (pending.length > 0) {
    const { dir, depth } = pending.pop()!
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.kind === 'dir' && depth < MAX_DEPTH) pending.push({ dir: path, depth: depth + 1 })
      else if (entry.kind === 'file') {
        const system = SYSTEM_BY_EXT[entry.name.split('.').pop()?.toLowerCase() ?? '']
        if (system) found.push({ path, system })
      }
    }
  }
  state.romCache = found
  return found
}

async function isEmulatorRunning($: $) {
  const { stdout } = await $.process.run(['tasklist.exe', '/FO', 'CSV', '/NH'])
  return stdout
    .toLowerCase()
    .split('\n')
    .some(line => EMULATOR_EXES.includes(line.split(',')[0]?.replaceAll('"', '').trim() ?? ''))
}

/** The emulator's exe path, downloading and unpacking it the first time. */
async function ensureEmulator($: $, system: System) {
  const emu = EMULATORS[system]
  const localAppData = (await $.env.get('LOCALAPPDATA')) ?? ''
  const dir = join(localAppData, 'retro-break', 'emulators', system)
  const find = `Get-ChildItem -LiteralPath ${psq(dir)} -Recurse -Filter ${psq(emu.exe)} | Select-Object -First 1 -ExpandProperty FullName`

  const existing = (await $.fs.exists(dir)) ? (await powershell($, find)).stdout.trim() : ''
  if (existing) return existing

  $.ui.status(`retro-break: downloading ${emu.name} (one time)…`)
  try {
    const archive = join(dir, 'download.tmp')
    const result = await powershell(
      $,
      [
        `New-Item -ItemType Directory -Force -Path ${psq(dir)} | Out-Null`,
        `Invoke-WebRequest -UseBasicParsing -Uri ${psq(emu.url)} -OutFile ${psq(archive)}`,
        `& (Join-Path $env:SystemRoot 'System32\\tar.exe') -xf ${psq(archive)} -C ${psq(dir)}`,
        `if ($LASTEXITCODE) { throw 'could not unpack the download' }`,
        `Remove-Item -LiteralPath ${psq(archive)}`,
        find,
      ].join('; '),
      600_000,
    )
    const exe = result.stdout.trim().split('\n').pop()?.trim() ?? ''
    if (result.exitCode !== 0 || !exe) throw new Error(result.stderr.trim().slice(0, 200) || 'download failed')
    if (emu.portableFile) await $.fs.write(join(dirOf(exe), emu.portableFile), '')
    return exe
  } finally {
    $.ui.status(undefined)
  }
}

async function launchRandomGame($: $, config: Config) {
  if (state.isLaunching) return
  state.isLaunching = true
  try {
    if (config.folders.length === 0) {
      if (!state.hasWarnedNoFolder) {
        state.hasWarnedNoFolder = true
        $.ui.toast('retro-break: set your ROM folder in /config to get a game during long tasks', { timeoutMs: 8000 })
      }
      return
    }
    if (await isEmulatorRunning($)) return // a game is already open: keep playing that one

    const roms = await findRoms($, config)
    if (roms.length === 0) {
      $.ui.toast(`retro-break: no .sfc, .smc, .gba, .gb or .gbc files found in ${config.folders.join('; ')}`, { timeoutMs: 8000 })
      return
    }
    const rom = roms[Math.floor(Math.random() * roms.length)]!
    const exe = await ensureEmulator($, rom.system)

    await powershell(
      $,
      `Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(dirOf(exe))} -ArgumentList ('"' + ${psq(rom.path)} + '"')`,
    )
    $.ui.toast(`retro-break: Claude is still working. Enjoy ${baseName(rom.path).replace(/\.[^.]+$/, '')}!`)
  } catch (error) {
    $.ui.toast(`retro-break: could not start a game (${String(error).slice(0, 160)})`, { timeoutMs: 8000 })
  } finally {
    state.isLaunching = false
  }
}

async function notifyDone($: $, seconds: number) {
  const title = 'Claude is done'
  const body = `Finished after ${seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`}. Come back when you reach a save point.`
  // A native Windows toast, shown over the game; PowerShell is the sender app.
  const toast = [
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
    `$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
    `$text = $xml.GetElementsByTagName('text')`,
    `$text.Item(0).AppendChild($xml.CreateTextNode(${psq(title)})) | Out-Null`,
    `$text.Item(1).AppendChild($xml.CreateTextNode(${psq(body)})) | Out-Null`,
    `$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
  ].join('; ')
  const shown = await powershell($, toast).catch(() => undefined)
  if (shown?.exitCode !== 0) await $.ui.notify(body, { title }).catch(() => undefined)
}

// --- hooks -----------------------------------------------------------------

export const register: Register = (on, options) => {
  const config: Config = {
    folders: String(options.romFolder ?? '')
      .split(';')
      .map(f => f.trim().replace(/^"|"$/g, ''))
      .filter(Boolean),
    delayMs: Math.max(5, Number(options.delaySeconds) || 60) * 1000,
  }

  // Each main-loop turn: start the countdown to a game.
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      state.pending?.cancel()
      state.pending = $.clock.after(config.delayMs, () => {
        state.pending = undefined
        void launchRandomGame($, config)
      })
    }
    return next(e)
  })

  // The turn ended: no game if it was quick; a notification if it was long.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      state.pending?.cancel()
      state.pending = undefined
      if (!e.isAborted && e.durationMs >= config.delayMs && config.folders.length > 0) {
        void notifyDone($, Math.round(e.durationMs / 1000))
      }
    }
    return result
  })

  on('session.end', ($, e, next) => {
    state.pending?.cancel()
    state.pending = undefined
    return next(e)
  })
}
