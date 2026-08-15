/**
 * Cross-process write-race regressions for the JSONL backend. These exercise
 * the physical backend seam directly 鈥?`appendBatch`/`commitRepair` behind the
 * coordinator's per-id chain 鈥?because the damaging interleavings come from a
 * second backend instance or process holding a stale in-memory cursor, which a
 * same-process coordinator cannot reproduce.
 */

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '../src/index.ts'
import { eventLines, logPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { acquireSessionLogWriterLock } from '../src/writer-lock.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const roots: string[] = []
const fibers: Array<{ dispose: () => Promise<void> }> = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-race-'))
  roots.push(root)
  return root
}

async function mount(root: string): Promise<{ ctx: Context; backend: JsonlSessionPersistence }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  fibers.push(fiber)
  return { ctx, backend: ctx.sessionPersistence as JsonlSessionPersistence }
}

/** A closed second turn continuing `oneTurnLog` at seq 6. */
function secondTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
    { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

afterEach(async () => {
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('JSONL cross-process write races', () => {
  it('rejects a stale-cursor appendBatch instead of writing a seq fork', async () => {
    const root = await freshRoot()
    const { ctx, backend } = await mount(root)
    const header = meta('stale-cursor', '/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())

    // Simulate the OTHER writer: it appends the real continuation first...
    await backend.appendBatch(header, secondTurn(), true)

    // ...then a writer holding the pre-append cursor tries the same seqs with
    // different content (the exact incident shape: interrupted vs completed).
    const original = secondTurn()
    const forked: SessionEvent[] = [
      original[0]!,
      { ...original[1]!, data: { turn: 2, reason: { kind: 'interrupted' } } } as SessionEvent,
    ]
    await expect(backend.appendBatch(header, forked, true)).rejects.toThrow(
      /advanced under this writer.*expected the durable tail at seq 6, found seq 8/,
    )

    // The durable log stays contiguous and single-voiced: reload succeeds.
    const loaded = await ctx.sessionPersistence.load(header.id)
    expect(loaded.events).toEqual([...oneTurnLog(), ...secondTurn()])
  })

  it('rejects closers-only commitRepair when the real outcome already landed', async () => {
    const root = await freshRoot()
    const { ctx, backend } = await mount(root)
    const header = meta('closers-race', '/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())

    // An open tool call the crash-repair path wants to close synthetically...
    const openCall = [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
      { type: 'step/start', seq: 7, time: 8, data: { turn: 2, step: 1 } },
      { type: 'tool/call', seq: 8, time: 9, data: { turn: 2, step: 1, callId: CallId('call-race'), name: 'bash', arguments: '{}' } },
    ] as SessionEvent[]
    await backend.appendBatch(header, openCall, true)

    // ...but the live writer records the REAL result before repair commits.
    const realResult = [
      {
        type: 'tool/result',
        seq: 9,
        time: 10,
        surfaceOp: 'append',
        sourceEventSeqs: [8],
        data: {
          turn: 2,
          step: 1,
          message: freezeMessage({
            id: MessageId('real-tool-result'),
            role: 'user',
            source: { kind: 'tool', callId: CallId('call-race') },
            content: [{ type: 'tool-result', toolCallId: CallId('call-race'), content: [], isError: false }],
          }),
        },
      },      { type: 'step/end', seq: 10, time: 11, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 11, time: 12, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    await backend.appendBatch(header, realResult, true)

    // The synthetic closers minted at seq 9 must now refuse to write.
    const closers = [
      {
        type: 'tool/result',
        seq: 9,
        time: 9,
        data: {
          turn: 2,
          step: 1,
          message: freezeMessage({
            id: MessageId('interrupted-tool-result-call-race-9'),
            role: 'user',
            source: { kind: 'tool', callId: CallId('call-race') },
            content: [{
              type: 'tool-result',
              toolCallId: CallId('call-race'),
              content: [{ type: 'text', text: 'interrupted' }],
              isError: true,
            }],
          }),
          error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
        },
        surfaceOp: 'append',
        sourceEventSeqs: [8],
      },
      { type: 'step/end', seq: 10, time: 9, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 11, time: 9, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ] as SessionEvent[]
    await expect(backend.commitRepair(header, undefined, closers)).rejects.toThrow(
      /advanced under this writer.*expected the durable tail at seq 9, found seq 12/,
    )
    expect((await ctx.sessionPersistence.load(header.id)).events).toHaveLength(12)
  })

  it('refuses a torn-tail repair whose revision no longer matches the log', async () => {
    const root = await freshRoot()
    const { ctx, backend } = await mount(root)
    const header = meta('torn-race', '/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')

    // A structurally incomplete final frame: complete prefix + torn tail.
    const complete = await compressZstdFrame(`${eventLines(secondTurn(), true)}\n`)
    await appendFile(path, complete.subarray(0, Math.floor(complete.length / 2)))
    const stored = await backend.loadStored(header.id)
    expect(stored?.tornMarker).toBeDefined()

    // Another writer repairs the same tail first (truncate + rewrite).
    await backend.commitRepair(header, stored!.tornMarker, [])

    // The stale marker must not truncate the now-repaired log again.
    const before = await readFile(path)
    await expect(backend.commitRepair(header, stored!.tornMarker, [])).rejects.toThrow(/advanced under this writer/)
    expect(await readFile(path)).toEqual(before)
    // The log stays readable and contiguous; crash recovery closes whatever
    // partial turn the torn frame's recovered events left open.
    const loaded = await ctx.sessionPersistence.load(header.id)
    expect(loaded.events.slice(0, oneTurnLog().length)).toEqual(oneTurnLog())
    expect(loaded.events.every((event, index) => event.seq === index)).toBe(true)
  })

  it('fails an append while another process holds the writer lock, leaving bytes unchanged', async () => {
    const root = await freshRoot()
    const { ctx, backend } = await mount(root)
    const header = meta('locked', '/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const before = await readFile(path)

    const lock = await acquireSessionLogWriterLock(path)
    try {
      await expect(backend.appendBatch(header, secondTurn(), true)).rejects.toThrow(
        /writer lock is held by another process/,
      )
    } finally {
      await lock.release()
    }
    expect(await readFile(path)).toEqual(before)
  })

  it('revalidates the cached tail when an external writer advanced the log', async () => {
    const root = await freshRoot()
    const { ctx, backend } = await mount(root)
    const header = meta('cache-invalidate', '/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')

    // An external writer appends a full frame the backend never saw.
    await appendFile(path, await compressZstdFrame(`${eventLines(secondTurn(), true)}\n`))

    // The backend's tail cache is now stale; the next append must re-read,
    // observe nextSeq 8, and accept the seq-8 continuation.
    const thirdTurn = [
      { type: 'turn/start', seq: 8, time: 9, data: { turn: 3 } },
      { type: 'turn/end', seq: 9, time: 10, data: { turn: 3, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    await backend.appendBatch(header, thirdTurn, true)
    const loaded = await ctx.sessionPersistence.load(header.id)
    expect(loaded.events).toEqual([...oneTurnLog(), ...secondTurn(), ...thirdTurn])
  })

  it('a second backend instance continues the same log legitimately (lock relays, not deadlocks)', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    const header = meta('relay', '/work')
    await first.ctx.sessionPersistence.create(header)
    await first.ctx.sessionPersistence.append(header.id, oneTurnLog())

    const second = await mount(root)
    await second.ctx.sessionPersistence.append(header.id, secondTurn())
    const loaded = await second.ctx.sessionPersistence.load(header.id)
    expect(loaded.events).toEqual([...oneTurnLog(), ...secondTurn()])
  })
})
