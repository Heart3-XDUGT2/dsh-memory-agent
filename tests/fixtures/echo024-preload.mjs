// Before imports: retain the old suite's per-test-home semantics. An inherited
// ECHO_DATA_DIR must not override its explicit DSH_HOME fixtures.
import '../_isolate.mjs'
import { allowLoopback } from './echo024-network.mjs'
delete process.env.ECHO_DATA_DIR
delete process.env.ECHO_QQ_DATA_DIR
allowLoopback()
