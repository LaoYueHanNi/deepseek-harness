/**
 * Cross-process writer lock for one JSONL session log. An OS advisory lock on
 * a lock-file sibling serializes physical mutations of the same log across
 * processes: POSIX `flock(2)` and Windows `LockFileEx` are both released by
 * the kernel when the owning process exits, so a crashed writer never leaves a
 * lock needing manual recovery.
 *
 * The lock file is created once and stays; session discovery reads only the
 * fixed `session.jsonl[.zstd]` names and ignores the `.lock` sibling.
 *
 * @module dsh-session-persistence-jsonl/writer-lock
 */

import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve, toNamespacedPath } from 'node:path'

/** Error thrown when another process currently holds the lock. */
export class SessionLogWriterLockHeldError extends Error {
  /**
   * Construct the busy error.
   * @param lockPath - the lock file another process holds.
   */
  constructor(readonly lockPath: string) {
    super(`session log writer lock is held by another process: ${lockPath}`)
    this.name = 'SessionLogWriterLockHeldError'
  }
}

/** The held kernel lock and how to release it. */
export interface SessionLogWriterLock {
  /** The lock file path (for diagnostics). */
  readonly lockPath: string
  /** Release the kernel lock. Idempotent. */
  release(): Promise<void>
}

/** POSIX `flock(2)` operation flags: exclusive, fail instead of blocking. */
const FLOCK_LOCK_EX = 2
const FLOCK_LOCK_NB = 4

/** POSIX errno value reported when a non-blocking lock finds contention. */
const EWOULDBLOCK = process.platform === 'darwin' ? 35 : 11

/** Win32 `LockFileEx` flags: exclusive, fail immediately instead of blocking. */
const LOCKFILE_EXCLUSIVE_LOCK = 0x00000002
const LOCKFILE_FAIL_IMMEDIATELY = 0x00000001

/** Win32 error code: the requested region is already locked. */
const ERROR_LOCK_VIOLATION = 33

/** Win32 open/lock constants for the native lock-file handle. */
const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_ALL = 0x7
const OPEN_ALWAYS = 4
const FILE_ATTRIBUTE_NORMAL = 0x80

/** Size of one Win32 `OVERLAPPED` structure on 64-bit hosts, zero-initialized. */
const OVERLAPPED_BYTES = 40

/** POSIX binding pair: `flock(2)` plus this platform's errno accessor. */
interface FlockBindings {
  /** Call `flock(fd, operation)`; nonzero return means failure. */
  flock: (fd: number, operation: number) => number
  /** Read the thread-local C `errno` after a failed call. */
  errno: () => number
}

/**
 * Load `flock(2)` and the platform errno accessor from the C library.
 * @returns the callable bindings.
 */
async function loadFlock(): Promise<FlockBindings> {
  const koffi = (await import('koffi')).default
  const library = process.platform === 'darwin' ? 'libSystem.dylib' : 'libc.so.6'
  const libc = koffi.load(library)
  const flock = libc.func('flock', 'int', ['int', 'int']) as (fd: number, operation: number) => number
  // glibc exposes errno through __errno_location(); macOS through __error().
  // Both return a pointer to the thread-local int koffi can decode in place.
  const errnoSymbol = process.platform === 'darwin' ? '__error' : '__errno_location'
  const errnoLocation = libc.func(errnoSymbol, koffi.pointer('int'), []) as () => unknown
  return { flock, errno: () => koffi.decode(errnoLocation(), 'int') as number }
}

/** Windows `CreateFileW`/`LockFileEx` binding set over one native HANDLE. */
interface Win32LockBindings {
  /** Open (or create) the lock file and return its native HANDLE; failures throw. */
  createFileW: (path: string) => number
  /** Attempt the exclusive immediate lock over the whole file; nonzero is success. */
  lockFileEx: (handle: number, flags: number, reserved: number, low: number, high: number, overlapped: Buffer) => number
  /** Close the HANDLE, releasing the lock derived from it. */
  closeHandle: (handle: number) => number
  /** Last-error code of the failed call. */
  getLastError: () => number
}

/**
 * Load the Windows lock bindings. The lock file HANDLE comes straight from
 * `CreateFileW` because Node file descriptors belong to the UCRT fd table,
 * which an `msvcrt.dll` `_get_osfhandle` cannot resolve.
 * @returns the bound Windows functions.
 */
async function loadWin32Lock(): Promise<Win32LockBindings> {
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []) as () => number
  const createFileW = kernel32.func('__stdcall', 'CreateFileW', 'intptr', [
    'str16', 'uint', 'uint', 'void *', 'uint', 'uint', 'void *',
  ]) as unknown as (
    path: string, access: number, share: number, security: null,
    disposition: number, flags: number, template: null,
  ) => number
  return {
    createFileW: (path) => {
      const handle = createFileW(
        path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_ALL, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null,
      )
      if (handle < 0) throw new Error(`CreateFileW failed (Win32 ${getLastError()}): ${path}`)
      return handle
    },
    lockFileEx: kernel32.func(
      '__stdcall',
      'LockFileEx',
      'int',
      ['intptr', 'uint', 'uint', 'uint', 'uint', 'void *'],
    ) as unknown as (handle: number, flags: number, reserved: number, low: number, high: number, overlapped: Buffer) => number,
    closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as unknown as (handle: number) => number,
    getLastError,
  }
}

/** Whether this backend runs on Windows. */
const IS_WINDOWS = process.platform === 'win32'

/** Lock byte range [0, 2^32) — the whole lock file regardless of its size. */
const WHOLE_FILE_LOW = 0xFFFFFFFF
const WHOLE_FILE_HIGH = 0

/** Acquire the native Windows lock handle; the caller owns it after this returns. */
async function lockWindows(lockPath: string): Promise<() => Promise<void>> {
  const api = await loadWin32Lock()
  // See lockPosix: the lock file's directory may not exist before first materialization.
  await mkdir(dirname(lockPath), { recursive: true })
  // Long paths need the \\?\ namespace prefix the raw Win32 API will not add itself.
  const handle = api.createFileW(toNamespacedPath(resolve(lockPath)))
  try {
    // LockFileEx requires a valid OVERLAPPED; a zeroed one names offset 0.
    const overlapped = Buffer.alloc(OVERLAPPED_BYTES)
    const ok = api.lockFileEx(
      handle,
      LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
      0,
      WHOLE_FILE_LOW,
      WHOLE_FILE_HIGH,
      overlapped,
    )
    if (ok === 0) {
      const code = api.getLastError()
      throw code === ERROR_LOCK_VIOLATION
        ? new SessionLogWriterLockHeldError(lockPath)
        : new Error(`LockFileEx failed (Win32 ${code}): ${lockPath}`)
    }
  } catch (error) {
    api.closeHandle(handle)
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    // Closing the HANDLE releases the byte-range lock it derived.
    api.closeHandle(handle)
    await Promise.resolve()
  }
}

/** Acquire the POSIX flock over the lock file; the caller owns it after this returns. */
async function lockPosix(lockPath: string): Promise<() => Promise<void>> {
  const api = await loadFlock()
  // The lock precedes materialization, so its directory may not exist yet; a
  // fresh session's `.lock` sibling may legitimately be the directory's first entry.
  await mkdir(dirname(lockPath), { recursive: true })
  const handle = await open(lockPath, 'a+')
  try {
    if (api.flock(handle.fd, FLOCK_LOCK_EX | FLOCK_LOCK_NB) !== 0) {
      const code = api.errno()
      throw code === EWOULDBLOCK
        ? new SessionLogWriterLockHeldError(lockPath)
        : new Error(`flock failed (errno ${code}): ${lockPath}`)
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    // Closing the descriptor releases the flock range.
    await handle.close()
  }
}

/**
 * Acquire the exclusive cross-process writer lock for one session log. The
 * acquisition fails immediately — never blocks — while another process holds
 * it. Hold the lock across the complete read-validate-append (or repair) cycle.
 *
 * @param logPath - the session log whose writers this lock serializes; the
 *   lock file is its `${logPath}.lock` sibling.
 * @returns the held lock; call `release()` after the physical mutation commits.
 * @throws {@link SessionLogWriterLockHeldError} when another process holds the lock.
 */
export async function acquireSessionLogWriterLock(logPath: string): Promise<SessionLogWriterLock> {
  const lockPath = `${logPath}.lock`
  const release = await (IS_WINDOWS ? lockWindows(lockPath) : lockPosix(lockPath))
  return { lockPath, release }
}
