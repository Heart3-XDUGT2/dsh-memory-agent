/** Synthetic test evidence belongs to this checkout, never a parent docs tree. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
const inside = value => value.startsWith(repository + path.sep)

export function writeTestTrace(prefix, label, value) {
  for (const part of [prefix, label]) {
    if (typeof part !== 'string' || !/^[a-z0-9-]{1,120}$/u.test(part)) throw Error('invalid_trace_label')
  }
  const scratch = path.join(repository, '.scratch')
  if (fs.existsSync(scratch) && fs.lstatSync(scratch).isSymbolicLink()) throw Error('linked_trace_directory')
  fs.mkdirSync(scratch, { recursive: true })
  const folder = path.join(scratch, 'test-traces')
  if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) throw Error('linked_trace_directory')
  fs.mkdirSync(folder, { recursive: true })
  const actualFolder = fs.realpathSync(folder)
  if (!inside(actualFolder)) throw Error('trace_directory_escaped_checkout')
  const target = path.join(actualFolder, prefix + '-' + label + '-' + process.pid + '.json')
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  return target
}
