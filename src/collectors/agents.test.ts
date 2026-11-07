import type { SessionInfo } from '../types/state.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlTail } from '../codex/jsonl-tail.js'
import { collectAgentEntries } from './agents.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('subagent collector', () => {
  it('tracks sibling and nested thread IDs without reading unrelated rollouts', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-agents-'))
    temporaryDirectories.push(codexHome)
    const directory = path.join(codexHome, 'sessions')
    fs.mkdirSync(directory)
    for (const [id, parentThreadId] of [['a-grandchild', 'child'], ['child', 'root'], ['sibling', 'root'], ['unrelated', 'other-root']]) {
      const filePath = path.join(directory, `rollout-${id}.jsonl`)
      fs.writeFileSync(filePath, [
        JSON.stringify({
          timestamp: '2026-07-16T08:00:00Z',
          type: 'session_meta',
          payload: {
            id,
            session_id: id === 'unrelated' ? 'other-root' : 'root',
            timestamp: '2026-07-16T08:00:00Z',
            cwd: '/work/demo',
            parent_thread_id: parentThreadId,
            thread_source: 'subagent',
            source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId } } },
          },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } }),
        '',
      ].join('\n'))
      fs.utimesSync(filePath, new Date('2026-07-16T08:00:01Z'), new Date('2026-07-16T08:00:01Z'))
    }
    const session: SessionInfo = {
      id: 'root',
      rolloutPath: '/tmp/root.jsonl',
      startTime: new Date('2026-07-16T08:00:00Z'),
      cwd: '/work/demo',
    }
    const read = vi.spyOn(JsonlTail.prototype, 'read')
    const env = { CODEX_HOME: codexHome }
    expect(collectAgentEntries(session, env, new Date('2026-07-16T08:00:02Z'))).toEqual([
      expect.objectContaining({ id: 'child', status: 'running', activeDescendantCount: 1 }),
      expect.objectContaining({ id: 'sibling', status: 'running', activeDescendantCount: 0 }),
    ])
    expect(read.mock.calls.map(([filePath]) => path.basename(filePath)).sort()).toEqual([
      'rollout-a-grandchild.jsonl',
      'rollout-child.jsonl',
      'rollout-sibling.jsonl',
    ])
    const grandchildPath = path.join(directory, 'rollout-a-grandchild.jsonl')
    for (const [type, timestamp, expectedCount] of [
      ['task_complete', '2026-07-16T08:00:04Z', 0],
      ['task_started', '2026-07-16T08:00:06Z', 1],
    ] as const) {
      read.mockClear()
      fs.appendFileSync(grandchildPath, `${JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: { type, turn_id: 'a-grandchild' },
      })}\n`)
      fs.utimesSync(grandchildPath, new Date(timestamp), new Date(timestamp))
      expect(collectAgentEntries(session, env, new Date(timestamp))).toEqual([
        expect.objectContaining({ id: 'child', status: 'running', activeDescendantCount: expectedCount }),
        expect.objectContaining({ id: 'sibling', status: 'running', activeDescendantCount: 0 }),
      ])
      expect(read.mock.calls.map(([filePath]) => filePath)).toEqual([grandchildPath])
    }
  })

  it('finds a running canonical thread-spawn child', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-agents-'))
    temporaryDirectories.push(codexHome)
    const directory = path.join(codexHome, 'sessions', '2026', '07', '16')
    fs.mkdirSync(directory, { recursive: true })
    const childPath = path.join(directory, 'rollout-child.jsonl')
    fs.writeFileSync(childPath, [
      JSON.stringify({
        timestamp: '2026-07-16T08:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'child',
          timestamp: '2026-07-16T08:00:00Z',
          cwd: '/work/demo',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'root',
                agent_path: '/root/explorer',
                agent_role: 'Inspect protocol',
              },
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:00:01Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5-mini' },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:00:02Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-child', started_at: '2026-07-16T08:00:02Z' },
      }),
      '',
    ].join('\n'))
    fs.utimesSync(childPath, new Date('2026-07-16T08:00:02Z'), new Date('2026-07-16T08:00:02Z'))
    const session: SessionInfo = {
      id: 'root',
      rolloutPath: '/tmp/root.jsonl',
      startTime: new Date('2026-07-16T08:00:00Z'),
      cwd: '/work/demo',
    }
    expect(collectAgentEntries(session, { CODEX_HOME: codexHome }, new Date('2026-07-16T08:00:03Z'))).toEqual([
      expect.objectContaining({
        id: 'child',
        type: 'explorer',
        model: 'gpt-5.5-mini',
        description: 'Inspect protocol',
        status: 'running',
      }),
    ])
  })

  it('incrementally applies appended completion events', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-agents-'))
    temporaryDirectories.push(codexHome)
    const directory = path.join(codexHome, 'sessions', '2026', '07', '16')
    fs.mkdirSync(directory, { recursive: true })
    const childPath = path.join(directory, 'rollout-child-incremental.jsonl')
    fs.writeFileSync(childPath, [
      JSON.stringify({
        timestamp: '2026-07-16T08:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'child-incremental',
          timestamp: '2026-07-16T08:00:00Z',
          cwd: '/work/demo',
          source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-child' },
      }),
      '',
    ].join('\n'))
    const session: SessionInfo = {
      id: 'root',
      rolloutPath: '/tmp/root.jsonl',
      startTime: new Date('2026-07-16T08:00:00Z'),
      cwd: '/work/demo',
    }
    expect(collectAgentEntries(session, { CODEX_HOME: codexHome }, new Date('2026-07-16T08:00:02Z'))[0]?.status).toBe('running')
    fs.appendFileSync(childPath, `${JSON.stringify({
      timestamp: '2026-07-16T08:00:03Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-child' },
    })}\n`)
    expect(collectAgentEntries(session, { CODEX_HOME: codexHome }, new Date('2026-07-16T08:00:04Z'))[0]?.status).toBe('completed')
  })
})
