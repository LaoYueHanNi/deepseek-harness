/**
 * Child-process fixture for the writer-lock tests: acquire the lock named by
 * argv[2], signal readiness on stdout, then hold the lock until stdin closes
 * so the parent can observe contention and release.
 */

import { acquireSessionLogWriterLock } from '../../src/writer-lock.ts'

const lock = await acquireSessionLogWriterLock(process.argv[2]!)
process.stdout.write('held\n')
process.stdin.resume()
await new Promise<void>((resolve) => { process.stdin.on('end', resolve) })
await lock.release()
