/**
 * Unit tests for the cross-process session-log writer lock. The same-process
 * contention, release, and re-acquire semantics run on every host; a real
 * child process proves the kernel-level exclusivity and crash-release behavior
 * the lock exists for.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireSessionLogWriterLock, SessionLogWriterLockHeldError,
} from '../src/writer-lock.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-lock-'))
  roots.push(dir)
  return dir
}

/** Spawn a child that acquires the lock, signals readiness, and holds it until stdin closes. */
function spawnLockHolder(logPath: string) {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lock-holder.ts')
  return spawn(process.execPath, ['--import', 'tsx/esm', fixture, logPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
}

/** Resolve once the child signals it holds the lock. */
function held(child: ReturnType<typeof spawnLockHolder>): Promise<void> {
  return new Promise((resolve) => {
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
      if (out.includes('held')) resolve()
    })
  })
}

/** Await the child's exit event. */
function exited(child: ReturnType<typeof spawnLockHolder>): Promise<void> {
  return new Promise((resolve) => { child.on('exit', () => { resolve() }) })
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('session log writer lock', () => {
  it('rejects a same-process re-entry while held and re-acquires after release', async () => {
    const root = await tempRoot()
    const logPath = join(root, 'session.jsonl.zstd')

    const first = await acquireSessionLogWriterLock(logPath)
    await expect(acquireSessionLogWriterLock(logPath)).rejects.toBeInstanceOf(SessionLogWriterLockHeldError)
    await first.release()

    const second = await acquireSessionLogWriterLock(logPath)
    await second.release()
    // Idempotent release must not throw or affect a later holder.
    await second.release()
    const third = await acquireSessionLogWriterLock(logPath)
    await third.release()
  })

  it('creates the lock file beside the log and leaves it after release', async () => {
    const root = await tempRoot()
    const logPath = join(root, 'nested', 'dir', 'session.jsonl')
    await mkdir(join(root, 'nested', 'dir'), { recursive: true })

    const lock = await acquireSessionLogWriterLock(logPath)
    const info = await stat(lock.lockPath)
    expect(info.isFile()).toBe(true)
    expect(lock.lockPath).toBe(`${logPath}.lock`)
    await lock.release()
    // The file stays: discovery must ignore it, not require its removal.
    await expect(stat(lock.lockPath)).resolves.toBeTruthy()
  })

  it('rejects another process while that process holds the lock', async () => {
    const root = await tempRoot()
    const logPath = join(root, 'session.jsonl.zstd')

    const child = spawnLockHolder(logPath)
    try {
      await held(child)
      await expect(acquireSessionLogWriterLock(logPath)).rejects.toBeInstanceOf(SessionLogWriterLockHeldError)
    } finally {
      child.stdin?.end()
      await exited(child)
    }

    // The exited process released the kernel lock; re-acquire must succeed.
    const reclaimed = await acquireSessionLogWriterLock(logPath)
    await reclaimed.release()
  })

  it('releases the kernel lock after a crashed holder process dies', async () => {
    const root = await tempRoot()
    const logPath = join(root, 'session.jsonl.zstd')

    const child = spawnLockHolder(logPath)
    await held(child)

    // Kill the holder without letting it release: only the kernel can free the lock now.
    child.kill('SIGKILL')
    await exited(child)

    const reclaimed = await acquireSessionLogWriterLock(logPath)
    await reclaimed.release()
  })
})
