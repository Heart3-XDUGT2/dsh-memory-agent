// Run the actual new adapter's real core/host/journal/HTTP/WS integration suite
// without changing its source or substituting any core binding implementation.
import { mkdirSync } from 'node:fs'

// The QQ runner prepares this declared evidence directory in its preload.
// This memory-owned entry also needs it before evaluating the frozen suite.
mkdirSync(new URL('../../dsh-qq-bridge/.scratch/test-traces/', import.meta.url), { recursive: true })
await import('../../dsh-qq-bridge/official/tests/echo025-roundtrip.test.mjs')
