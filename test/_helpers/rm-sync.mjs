// Best-effort recursive rmSync with retry on ENOTEMPTY/EBUSY.
//
// `rmSync(dir, { recursive: true, force: true })` suppresses ENOENT but NOT
// ENOTEMPTY/EBUSY. When `dir` is a CCV_LOG_DIR for an imported/spawned server.js,
// the server's log file handles close asynchronously after stopViewer(); rmSync
// racing those writers throws ENOTEMPTY ("Directory not empty"). Retry a few times
// with a short backoff; if still contended, swallow (cleanup — a leftover tmpdir
// under os.tmpdir() is harmless and reaped by the OS). Test isolation is unaffected:
// each suite uses a unique mkdtempSync prefix, so a leftover dir never collides
// with another run.
import { rmSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rmRoulette(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = err && (err.code || err.errno);
      if (code === 'ENOTEMPTY' || code === 'EBUSY') { await sleep(50); continue; }
      throw err; // unexpected — surface it
    }
  }
  // give up silently; a leftover tmpdir is harmless
}
