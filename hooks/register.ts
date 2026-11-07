import type { EngineInterface, Register } from 'claude-code'

type Engine = EngineInterface
type System = 'snes' | 'gba'
type Rom = { path: string; system: System }
type Config = { folders: string[]; delayMs: number }

const SYSTEM_BY_EXT: Record<string, System> = {
  sfc: 'snes',
  smc: 'snes',
  gba: 'gba',
  gb: 'gba',
  gbc: 'gba',
}

/** How deep under the ROM folder to look (a folder per game is common). */
const MAX_DEPTH = 4

/** How much of the screen's height the game window takes. */
const SCREEN_SHARE = '0.6'

/** The emulators the plugin starts, by process name. */
const EMULATOR_EXES = ['snes9x-x64.exe', 'mgba.exe']

// Module state; a hot reload starts it over.
const state: {
  pending: { cancel: () => void } | undefined
  roms: Rom[] | undefined
  hasWarnedNoFolder: boolean
  isLaunching: boolean
} = { pending: undefined, roms: undefined, hasWarnedNoFolder: false, isLaunching: false }

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}\\${name}`

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)

/** Runs one of the plugin's own scripts in scripts/ with the given arguments. */
async function runScript($: Engine, script: string, args: string[], timeoutMs: number) {
  const file = `${$.plugin.root}\\scripts\\${script}`
  return $.process.run(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
    { timeoutMs },
  )
}

async function findRoms($: Engine, config: Config) {
  if (state.roms) return state.roms
  const found: Rom[] = []
  const todo = config.folders.map(dir => ({ dir, depth: 0 }))
  while (todo.length > 0) {
    const next = todo.pop()
    if (!next) break
    const entries = await $.fs.list(next.dir).catch(() => [])
    for (const entry of entries) {
      const path = join(next.dir, entry.name)
      if (entry.kind === 'dir' && next.depth < MAX_DEPTH) todo.push({ dir: path, depth: next.depth + 1 })
      if (entry.kind !== 'file') continue
      const system = SYSTEM_BY_EXT[entry.name.split('.').pop()?.toLowerCase() ?? '']
      if (system) found.push({ path, system })
    }
  }
  state.roms = found
  return found
}

async function isEmulatorRunning($: Engine) {
  const result = await $.process.run(['tasklist.exe', '/FO', 'CSV', '/NH'])
  return result.stdout
    .toLowerCase()
    .split('\n')
    .some(line => EMULATOR_EXES.includes(line.split(',')[0]?.replaceAll('"', '').trim() ?? ''))
}

async function launchRandomGame($: Engine, config: Config) {
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
    const isRunning = await isEmulatorRunning($)
    if (isRunning) return // a game is already open: keep playing that one

    const roms = await findRoms($, config)
    const rom = roms[Math.floor(Math.random() * roms.length)]
    if (!rom) {
      $.ui.toast(`retro-break: no .sfc, .smc, .gba, .gb or .gbc files found in ${config.folders.join('; ')}`, { timeoutMs: 8000 })
      return
    }

    $.ui.status('retro-break: getting the emulator ready…')
    const installed = await runScript($, 'install-emulator.ps1', ['-System', rom.system], 600_000)
    $.ui.status(undefined)
    const exe = installed.stdout.trim().split('\n').pop()?.trim() ?? ''
    if (installed.exitCode !== 0 || !exe) throw new Error(installed.stderr.trim().slice(0, 200) || 'emulator setup failed')

    await runScript($, 'launch-game.ps1', ['-Exe', exe, '-Rom', rom.path, '-ScreenShare', SCREEN_SHARE], 30_000)
    $.ui.toast(`retro-break: Claude is still working. Enjoy ${baseName(rom.path).replace(/\.[^.]+$/, '')}!`)
  } catch (error) {
    $.ui.status(undefined)
    $.ui.toast(`retro-break: could not start a game (${String(error).slice(0, 160)})`, { timeoutMs: 8000 })
  } finally {
    state.isLaunching = false
  }
}

async function notifyDone($: Engine, seconds: number) {
  const title = 'Claude is done'
  const took = seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`
  const body = `Finished after ${took}. Come back when you reach a save point.`
  const shown = await runScript($, 'notify.ps1', ['-Title', title, '-Body', body], 30_000).catch(() => undefined)
  if (shown && shown.exitCode === 0) return
  await $.ui.notify(body, { title }).catch(() => undefined)
}

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
