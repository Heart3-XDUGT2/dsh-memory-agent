/** Filesystem guards for installer mutations; no live data is opened here. */
import fs from 'node:fs'
import path from 'node:path'
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value
const inside = (base, candidate) => fold(candidate) === fold(base)
  || fold(candidate).startsWith(fold(base) + path.sep)

export function nearestRealPath(candidate) {
  let cursor = path.resolve(candidate)
  const suffix = []
  for (;;) {
    try { return path.resolve(fs.realpathSync(cursor), ...suffix) } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      // A dangling link must never become a lexical fallback.
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('unsafe_dangling_install_link') } catch (statError) {
        if (statError.code !== 'ENOENT' && statError.code !== 'ENOTDIR') throw statError
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) throw Error('install_ancestor_not_resolvable')
      suffix.unshift(path.basename(cursor)); cursor = parent
    }
  }
}

export function assertHomePath(home, candidate, { allowLeafLink = false } = {}) {
  const base = path.resolve(home), destination = path.resolve(candidate)
  if (!inside(base, destination) || fold(base) === fold(destination)) throw Error('install_path_outside_home')
  const realBase = nearestRealPath(base)
  const pieces = path.relative(base, destination).split(path.sep)
  let cursor = base
  for (let i = 0; i < pieces.length; i++) {
    cursor = path.join(cursor, pieces[i])
    let stat
    try { stat = fs.lstatSync(cursor) } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
    }
    if (stat?.isSymbolicLink()) {
      if (allowLeafLink && i === pieces.length - 1) return { leafLink: true, path: destination }
      throw Error('linked_install_ancestor')
    }
    if (!inside(realBase, nearestRealPath(cursor))) throw Error('install_realpath_outside_home')
  }
  return { leafLink: false, path: destination }
}

export function assertDisjoint(source, candidate) {
  const a = nearestRealPath(source), b = nearestRealPath(candidate)
  if (inside(a, b) || inside(b, a)) throw Error('install_source_target_overlap')
}
