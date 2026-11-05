/**
 * 冒烟共享库:活库一致性快照到临时副本。
 * node:sqlite 没有 backup API,用 serialize()(整库快照 Buffer,对
 * WAL 库也是一致性读)—— 绝不裸拷贝 WAL 库(家规:活库只读)。
 */
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 把活库(~/.dsh/echo/echo.db)快照到 dstPath,返回 dstPath。 */
export function backupLiveDb (dstPath) {
  const src = join(homedir(), '.dsh', 'echo', 'echo.db')
  const db = new DatabaseSync(src, { readOnly: true })
  try {
    const buf = db.serialize()
    writeFileSync(dstPath, buf)
  } finally {
    db.close()
  }
  return dstPath
}
