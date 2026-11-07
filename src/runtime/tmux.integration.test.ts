import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { expect, it, vi } from 'vitest'
import { shellCommand } from './process.js'
import { createTmuxRunner, launchNewTmuxSession } from './tmux.js'

const canAttach = process.platform === 'linux'
  && spawnSync('tmux', ['-V']).status === 0
  && spawnSync('script', ['--version']).status === 0

it.skipIf(!canAttach)('keeps forwarding Codex titles while the HUD has focus', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-title-'))
  const socketPath = path.join(directory, 'tmux.sock')
  const env = { ...process.env, TERM: 'xterm-256color', TMUX: undefined, TMUX_PANE: undefined }
  const runner = createTmuxRunner(env, socketPath)
  let client: ChildProcess | undefined
  let clientClosed: Promise<unknown> | undefined
  try {
    const placeholder = path.join(directory, 'pane.mjs')
    fs.writeFileSync(placeholder, 'setInterval(() => {}, 1000)\n')
    const launched = launchNewTmuxSession({
      cwd: directory,
      cliPath: placeholder,
      renderCliPath: placeholder,
      codexArgs: [],
      height: 7,
      detached: true,
      launchedAfter: new Date(),
      bindingPath: path.join(directory, 'binding.json'),
      socketPath,
      env,
    }, runner)
    const codexPane = `${launched.sessionName}:0.0`
    runner.run(['select-pane', '-t', codexPane, '-T', 'Codex frame 1'])
    runner.run(['select-pane', '-t', launched.hudPaneId!, '-T', 'HUD hostname'])

    const command = shellCommand('tmux', ['-S', socketPath, 'attach-session', '-t', launched.sessionName!])
    client = spawn('script', ['--quiet', '--return', '--command', command, os.devNull], { env })
    clientClosed = once(client, 'close')
    let output = ''
    client.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    client.stderr!.resume()
    // eslint-disable-next-line no-control-regex -- Match terminal OSC title sequences.
    const titles = (): string[] => [...output.matchAll(/\x1B\]0;([^\x07]*)\x07/g)].map(match => match[1]!)
    await vi.waitFor(() => expect(titles().at(-1)).toBe('Codex frame 1'), { timeout: 3000 })

    runner.run(['select-pane', '-t', launched.hudPaneId!])
    runner.run(['select-pane', '-t', codexPane, '-T', 'Codex frame 2'])
    await vi.waitFor(() => expect(titles().at(-1)).toBe('Codex frame 2'), { timeout: 3000 })
    expect(runner.run(['display-message', '-p', '-t', launched.sessionName!, '#{pane_id}']).stdout.trim()).toBe(launched.hudPaneId)
    expect(titles()).not.toContain('HUD hostname')

    runner.run(['select-pane', '-t', codexPane])
    runner.run(['select-pane', '-t', codexPane, '-T', 'Codex frame 3'])
    await vi.waitFor(() => expect(titles().at(-1)).toBe('Codex frame 3'), { timeout: 3000 })
  }
  finally {
    runner.run(['kill-server'])
    client?.kill()
    await clientClosed
    fs.rmSync(directory, { recursive: true, force: true })
  }
}, 15_000)
