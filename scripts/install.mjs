#!/usr/bin/env node
/**
 * dsh-echo — 一键安装器
 * ============================================================
 * 用法:
 *   node scripts/install.mjs            # 复制装机(默认,与 afaccess 同构)
 *   node scripts/install.mjs --check    # 校验装机状态(不修改)
 *   node scripts/install.mjs --doctor   # 诊断:列出会让她/DSH 起不来的状态
 *   node scripts/install.mjs --remove   # 卸载(摘登记 + 删装机副本 + 摘依赖)
 *   node scripts/install.mjs --help
 *
 * 默认 DSH_HOME=~/.dsh。装机位:profiles/web/node_modules/dsh-echo(真实
 * 目录 —— 不用 junction:Node ESM 会把链接还原成真实路径,模块解析就
 * 从仓库目录往上找 @deepseek-ai/*,而依赖树在 profiles/node_modules,
 * v0.1.0 的 junction 因此打崩过 dsh web 启动)。
 * 同时把 "dsh-echo" 登记进 profiles/web/package.json 的
 * dsh.profile.bundles(bundle 的 cordis.patch.yml 自动应用,插件即挂载)。
 *
 * ---- 2026-09-26 现场(必须记住的一课)----
 * 只登记 bundles、不登记 dependency 会**打崩 DSH 启动**:
 *   他为了修另一个坏插件,`Remove-Item node_modules` + `dsh plugin install`
 *   —— 那一步按 dependencies 重装,pnpm 不知道 dsh-echo(它不在依赖表里),
 *   装机副本被清掉,而 `dsh.profile.bundles` 里的登记还在 ⇒ loader 抛
 *   「cannot resolve profile bundle "dsh-echo"」⇒ **整个 dsh web 起不来**。
 *   一个插件的安装方式,不该有本事拦住宿主启动。
 * 现在两道防线:
 *   ① 装完顺手 `npm pack` 出一个 tgz 放在 profiles/web/.dsh-echo-local/,
 *      并把 `"dsh-echo": "file:./.dsh-echo-local/dsh-echo-<版本>.tgz"` 写进
 *      profile 的 dependencies ⇒ 再被 pnpm install 时它会被**解包装回来**
 *      (tsg 一定解包成真目录,不是 symlink;两者都验证过)。
 *      pack 失败(没 npm / 断网)只警告不阻断 —— 复制装机本身已经完成。
 *   ② `--doctor` 把「登记在、文件没了」这种会拦启动的状态指名道姓报出来。
 *
 * 开发循环:改源码 → node scripts/install.mjs → 重启 dsh web
 * (插件代码变更本就需要重启;只有 cordis.patch.yml 是 live 重载)。
 */
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, rm, lstat, rename } from "node:fs/promises";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// P0(数据与程序分离):`--doctor` 顺手体检数据目录(只读;见 lib/data-dir.js 文件头)。
import { KNOWN_MIGRATIONS, dataDirStatus } from "../lib/data-dir.js";
import { PROGRAM_DATA_REV } from "../lib/data-schema.js";
// P3:一次性迁移的执行器。**默认路径是插件挂载时自动跑**(lib/index.js);
// 这里的 `--migrate` / `--dry-run` 只是运维口(看 / 重跑 / 干跑)。
import { migrateDataDir, planMigrations } from "../lib/data-migrate.js";
// patch 的形态按世代分(0.1.x 字符串 / 0.2.0 数组),preset 平面的文件名从这里取。
import { PRESET_PATCH_FILE } from "../lib/preset-patch.js";
import { createRequire } from "node:module";
import { runNpm } from "./npm-runner.mjs";
import { randomUUID } from "node:crypto";
import { assertHomePath, assertDisjoint } from "./install-boundary.mjs";

const knownFlags = new Set(["--check", "--remove", "--doctor", "--migrate", "--dry-run", "--help"]);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!knownFlags.has(arg)) {
    console.error("Unknown option: " + arg);
    process.exit(2);
  }
}
if (args.has("--dry-run") && !args.has("--migrate")) {
  console.error("--dry-run 只跟 --migrate 一起用:node scripts/install.mjs --migrate --dry-run(只看计划,不写盘)");
  process.exit(2);
}
if (args.has("--help")) {
  console.log(`dsh-echo installer

Usage:
  node scripts/install.mjs            Install into the web profile — link 装机只校验,copy 装机才复制
  node scripts/install.mjs --check    Verify installation without changing it
  node scripts/install.mjs --doctor   Diagnose states that stop dsh web from booting
  node scripts/install.mjs --migrate  Apply pending P3 one-shot migrations to the data dir
  node scripts/install.mjs --migrate --dry-run   Show what --migrate would do (writes nothing)
  node scripts/install.mjs --remove   Uninstall: drop bundles entry + delete installed copy/junction

迁移平时**不用手动跑**:插件挂载时会自己跑一遍(lib/index.js → lib/data-migrate.js),
新装用户也跑得到。这两个旗子是运维口:看看到底做了什么、或把某批重跑一次。

形态(2026-09-27 搬家起):源码在 ~/.dsh/plugins/dsh-echo,装机位是指向它的 link。
要改回"复制装机":先 --remove,再跑本脚本。

Note: never run 'dsh plugin add dsh-echo' (bare name) — npm has an unrelated
dsh-echo@0.0.1 placeholder, and the CLI would install that instead. Install from
this directory, or run this script.

Set DSH_HOME to override the default ~/.dsh location.`);
  process.exit(0);
}

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePackage = parseJsonOrThrow(
  await readFile(join(sourceRoot, "package.json"), "utf8"),
  join(sourceRoot, "package.json"),
  "插件自己的 package.json"
);
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", "web");
const target = join(profileDir, "node_modules", sourcePackage.name);
const profilePkgPath = join(profileDir, "package.json");
/** 本地分发包落点:profile 自己的目录里,不依赖仓库还在不在。 */
const localDistDir = join(profileDir, ".dsh-echo-local");
const localTarballName = sourcePackage.name + "-" + sourcePackage.version + ".tgz";
const localTarball = join(localDistDir, localTarballName);
const localSpec = "file:./.dsh-echo-local/" + localTarballName;
// The slot itself may be a legacy source link. Ancestor links are never allowed.
assertHomePath(dshHome, target, { allowLeafLink: true });
assertHomePath(dshHome, profilePkgPath);
assertHomePath(dshHome, localDistDir);

async function readOptional(path) {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 读 JSON:要么给出人话的错误,要么别动(v0.42.0 审计修复 P1)。
 * 原来直接 `JSON.parse`,profile package.json 是空文件(或手改坏了)时,
 * 装机只留下一句 `Unexpected end of JSON input` —— 看不出是哪个文件、该怎么办。
 */
function parseJsonOrThrow(text, path, what) {
  // 前导 BOM 先剥掉:PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM,
  // 而 `JSON.parse` 不认它 —— 一份手改过的 profile package.json 就足以让装机
  // 在这里硬失败(本仓另有 scripts/check-bom.mjs,说明这坑踩过)。
  const clean = String(text ?? "").replace(/^\uFEFF/, "");
  try { return JSON.parse(clean); } catch (error) {
    throw new Error("读不了 " + what + "(" + path + "):" + String(error?.message ?? error)
      + "\n  修法:确认它是合法 JSON(空文件也算坏 —— 至少要有 {} 或 []）。");
  }
}

/**
 * 装机位守卫(v0.42.0 审计修复 P1:装机脚本原来没有"源==目标"守卫)。
 *
 * 为什么必须有:下面要 `rm -rf <target>` 再复制,而 target 是拿 `DSH_HOME`
 * 拼出来的。DSH_HOME 一旦指错(指到插件源码区所在那一层、或指到仓库里),
 * target 就可能**正好是源码区本身**、或源码区的父子目录 —— 一次例行的
 * "装个机"就把整个仓库递归删掉,还是静默的。已提交的东西 git 里还在,
 * 没提交的(比如刚写完的 lib/*.js)就真没了。
 * 判据走 realpath(链接/大小写都要认出来),宁可拒装,不可删错。
 */
function assertInstallTargetSafe(sourceRoot, target) {
  assertHomePath(dshHome, target);
  assertDisjoint(sourceRoot, target);
}
function verifyRuntimeDependencies(directory) {
  const req = createRequire(join(directory, "package.json"));
  for (const name of [...Object.keys(sourcePackage.dependencies || {}),
    "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-compaction-basic"]) req.resolve(name);
}
async function removeDirectory(directory) {
  assertInstallTargetSafe(sourceRoot, directory);
  await rm(directory, { recursive: true, force: true });
}
async function writeProfile(text, nonce) {
  const temporary = profilePkgPath + ".echo-" + nonce;
  assertHomePath(dshHome, temporary); assertHomePath(dshHome, profilePkgPath);
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, profilePkgPath);
  } finally {
    assertHomePath(dshHome, temporary);
    await rm(temporary, { force: true });
  }
}

async function verify() {
  const installedRaw = await readOptional(join(target, "package.json"));
  if (installedRaw === null) throw new Error("package is not installed at " + target);
  const installed = JSON.parse(installedRaw);
  if (installed.name !== sourcePackage.name) throw new Error("installed package name mismatch: " + installed.name);
  if (installed.version !== sourcePackage.version) {
    throw new Error("installed " + installed.version + " != source " + sourcePackage.version
      + " — re-run install。注意:npm 上有一个同名的 dsh-echo@0.0.1 占位包,"
      + "`dsh plugin add dsh-echo`(裸名)装的是它,不是本插件 —— 装本插件请用本目录路径或这个脚本");
  }
  const patches = Array.isArray(installed.dsh?.bundle?.patch) ? installed.dsh.bundle.patch : [installed.dsh?.bundle?.patch];
  if (!patches.length || patches.some(rel => typeof rel !== "string" || !existsSync(join(target, rel)))) {
    throw new Error("Installed manifest patch asset is missing");
  }
  verifyRuntimeDependencies(target);
  const profileRaw = await readOptional(profilePkgPath);
  if (profileRaw === null) throw new Error("profile package.json not found: " + profilePkgPath);
  const profile = JSON.parse(profileRaw);
  const bundles = profile?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes(sourcePackage.name)) {
    throw new Error(sourcePackage.name + " is not in dsh.profile.bundles of " + profilePkgPath);
  }
  // 2026-09-26 现场:登记在 bundles 里、文件却没了 ⇒ loader 直接抛错、
  // **整个 dsh web 起不来**(他 wipe node_modules 后遇到的就是这个)。
  // 所以依赖表里也必须有一份 —— pnpm install 才有办法把它装回来。
  const deps = profile?.dependencies ?? {};
  if (typeof deps[sourcePackage.name] !== "string") {
    throw new Error(sourcePackage.name + " 不在 " + profilePkgPath + " 的 dependencies 里 ——"
      + " 只登记 bundles 的话,别人（或你自己）wipe node_modules 后 `dsh plugin install`"
      + " 不会把它装回来,而 bundles 登记还在 ⇒ dsh web 直接起不来");
  }
  // v0.11.1:装机位审查台接线自检 —— 用装机副本自己的 webRootOf
  // (与 lib/index.js 同源公式)对装机位 lib/index.js 算 webRoot,
  // 断言首页真在那儿。M6-a 的雷(公式错成 lib/web,/echo/ 404
  // 半个月,smoke 只测显式传 rootDir 的纯函数)就此堵死:装完
  // 即验,不等用户点开页面才炸。
  {
    const { webRootOf } = await import(pathToFileURL(join(target, "lib", "webpage.js")).href);
    const webIndex = join(webRootOf(pathToFileURL(join(target, "lib", "index.js")).href), "index.html");
    if (!existsSync(webIndex)) {
      throw new Error("webpage wiring broken: " + webIndex + " missing — /echo/ would 404");
    }
    console.log("  webpage: " + webIndex);
  }
  // 2026-09-27 搬家:link 装机时装机位是指向源码区的 junction,而 Node 会**先把
  // junction 解析成真实路径**,裸 import(`@deepseek-ai/dsh-tools` 这类宿主包)的解析
  // 起点因此挪到源码区 —— 那里必须有一条通到 profiles/node_modules 的路(插件源码区
  // 自己的 `node_modules` junction),否则直接 ERR_MODULE_NOT_FOUND、她起不来,
  // 而"六项一致"照样全绿(假绿)。v0.1.0 就是 symlink 装法打崩过 dsh web 启动。
  {
    let installedIsLink = false;
    try { installedIsLink = lstatSync(target).isSymbolicLink(); } catch { /* 装机位不在:上面已拦 */ }
    if (String(deps[sourcePackage.name] ?? "").startsWith("link:") || installedIsLink) {
      const real = realpathSync(target);
      let dir = real;
      let found = null;
      for (let hop = 0; hop < 8; hop += 1) {
        const nm = join(dir, "node_modules");
        if (existsSync(join(nm, "@deepseek-ai", "dsh-tools"))) { found = nm; break; }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      if (found === null) {
        throw new Error("link 装机,但宿主包解析不着(插件会以 ERR_MODULE_NOT_FOUND 起不来):"
          + real + " 往上 8 级都没有含 @deepseek-ai/dsh-tools 的 node_modules。"
          + "修法:给插件源码区补一条 junction —— New-Item -ItemType Junction -Path \""
          + dirname(real) + "\\node_modules\" -Target \"" + join(dshHome, "profiles", "node_modules") + "\"");
      }
      console.log("  host packages: " + found + "  (link 装机,源码区 " + real + ")");
    }
  }
  console.log("Verified " + sourcePackage.name + "@" + sourcePackage.version);
  console.log("  package: " + target);
  console.log("  bundles: " + profilePkgPath);
  console.log("  dependency: " + deps[sourcePackage.name]);
}

/**
 * 数据目录体检(P0 起,只读):目录在不在 / 可写、8 个文件的 schemaRev 与程序期望
 * 是否一致、有没有 `.bad-*` 残留、记账文件(data-rev.json)是否落后。
 *
 * 与上面 notes 的分工:这里的问题**不参与退出码** —— 数据目录建不出来时插件照样挂载
 * (只是面板没底稿),所以它们是「警告/信息」,不是「致命」。输出人话,不打印内部结构。
 */
function dataDirDoctor() {
  const st = dataDirStatus();
  if (!st.exists) {
    console.log("[信息] 数据目录 " + st.dir + " 还不存在 —— 插件首次启动会自动建出 8 个空模板");
    return;
  }
  const missing = st.files.filter((f) => !f.exists).map((f) => f.file);
  const broken = st.files.filter((f) => f.exists && f.errors.length > 0);
  const revOff = st.files
    .filter((f) => f.exists && f.ok && f.rev !== null && f.rev !== PROGRAM_DATA_REV)
    .map((f) => f.file + "(rev" + f.rev + ")");
  const noRev = st.files.filter((f) => f.exists && f.ok && f.rev === null).map((f) => f.file);
  if (st.problems.length === 0) {
    console.log("  数据目录:" + st.dir + " —— 就绪(8/8 文件齐、无版本冲突、无 .bad 残留、dataRev="
      + PROGRAM_DATA_REV + ")");
    if (noRev.length > 0) {
      console.log("[信息] " + noRev.length + " 个 P0 之前写的文件还没 schemaRev(合法,不用管):" + noRev.join(", "));
    }
    return;
  }
  console.log("  数据目录:" + st.dir);
  if (!st.writable) console.log("[警告] 数据目录不可写 —— 面板存不下去,备份也落不了");
  if (!st.backupExists) console.log("[信息] 没有 backup/ 子目录(首次写入前会自动建)");
  if (missing.length > 0) {
    console.log("[信息] 缺 " + missing.length + " 个文件(scaffold 会自动补):" + missing.join(", "));
  }
  for (const f of broken) console.log("[警告] " + f.file + " 有问题:" + f.errors.join("; "));
  if (revOff.length > 0) {
    console.log("[警告] schemaRev 与程序期望(" + PROGRAM_DATA_REV + ")不一致:" + revOff.join(", "));
  }
  if (noRev.length > 0) console.log("[信息] 还没有 schemaRev(P0 之前写的文件,合法):" + noRev.join(", "));
  if (st.badResidue.length > 0) {
    console.log("[警告] 有 .bad-* 残留(坏文件的留档,确认后可删):" + st.badResidue.join(", "));
  }
  if (st.dataRev === null) console.log("[信息] 记账文件 " + "data-rev.json" + " 缺(还没跑过 scaffold)");
  else if (st.dataRevStale) {
    console.log("[警告] 记账 dataRev=" + st.dataRev.dataRev + " != 程序期望 " + PROGRAM_DATA_REV);
  }
  if (st.pendingMigrations.length > 0) {
    console.log("[警告] " + st.pendingMigrations.length + " 项一次性迁移没应用:" + st.pendingMigrations.join(", "));
  }
  // 记账口径(2026-10-05 P3):体检只在 dataRev 落后时报 pending,所以平时这里
  // 只给一行**信息** —— 想知道"到底还剩哪几项",用 `--migrate --dry-run`(它逐条列)。
  const applied = Array.isArray(st.dataRev?.appliedMigrations) ? st.dataRev.appliedMigrations : [];
  const left = KNOWN_MIGRATIONS.filter((m) => !applied.includes(m));
  if (left.length > 0) {
    console.log("[信息] 一次性迁移记账:" + (KNOWN_MIGRATIONS.length - left.length) + "/" + KNOWN_MIGRATIONS.length
      + " 已登记,还有 " + left.length + " 项没登记(挂载时会自动跑一次;`--migrate` 手动跑,`--migrate --dry-run` 先看计划)");
  }
}

/**
 * `--migrate` / `--migrate --dry-run`:手动运维口(P3 设计 §3.1 的 T3)。
 *
 * 平时不用手动跑 —— 插件挂载时自动跑(lib/index.js);这里给"看 / 重跑 / 干跑"。
 * 退出码:全部跑成(含"没东西可跑")⇒ 0;有失败项 ⇒ 1(与 `--doctor` 的致命项同规矩)。
 */
function migrate() {
  const dryRun = args.has("--dry-run");
  const plan = planMigrations();
  console.log("  数据目录:" + plan.dir);
  if (plan.firstInstall) {
    console.log("[信息] 首次安装(8 个文件都还是空模板)⇒ 一次性迁移会**全部跳过并登记**"
      + "(新装用户不该继承别人的词表/名单;设计 §3.3)");
  } else {
    console.log("[信息] 已有用户数据(非空字段 " + plan.filled.length + " 处,例如 "
      + plan.filled.slice(0, 3).join(", ") + ")⇒ 逐条过门 + 记账");
  }
  const log = { info: (m) => console.log("  " + m), warn: (m) => console.log("[警告] " + m) };
  if (dryRun) {
    const r = migrateDataDir({ dryRun: true, logger: log });
    console.log("[干跑] 将要跑 " + r.planned.length + " 项(**一个字节都不写**):");
    for (const line of r.notes) console.log("  " + line);
    console.log("[干跑] 已登记 " + plan.done.length + "/" + KNOWN_MIGRATIONS.length + " 项");
    return 0;
  }
  const r = migrateDataDir({ logger: log });
  if (!r.ok) {
    for (const f of r.failed) console.log("[警告] 没跑成(不记账,下次开机重试):" + f.key + " —— " + f.reason);
    return 1;
  }
  console.log("迁移完成:新登记 " + r.registered.length + " 项,已登记跳过 " + r.skipped.length + " 项,写盘 "
    + r.wrote.length + " 个文件"
    + (r.firstInstall ? "(首次安装 ⇒ 全部跳过并登记)" : ""));
  return 0;
}

/**
 * `--doctor`:把「会让她起不来 / 让 DSH 起不来」的状态逐条查出来。
 * 只读,不改任何东西 —— 出问题时先跑这个,别先猜。
 */
async function doctor() {
  const notes = [];
  const installedRaw = await readOptional(join(target, "package.json"));
  const profileRaw = await readOptional(profilePkgPath);
  const profile = profileRaw === null ? null : JSON.parse(profileRaw);
  const bundles = profile?.dsh?.profile?.bundles;
  const listed = Array.isArray(bundles) && bundles.includes(sourcePackage.name);
  const deps = profile?.dependencies ?? {};
  const declared = typeof deps[sourcePackage.name] === "string";

  if (!listed && installedRaw === null) {
    notes.push(["信息", "未装机(既不在 bundles 登记里,也没有装机副本)—— 插件不会被加载"]);
  }
  if (listed && installedRaw === null) {
    notes.push(["致命", "bundles 登记在、装机副本不在:" + target
      + "\n         ⇒ loader 会抛 cannot resolve profile bundle, **dsh web 起不来**"
      + "\n         ⇒ 修法:`node scripts/install.mjs`(或 dsh plugin install,依赖表里有 tgz 时会自动装回)"]);
  }
  if (!listed && installedRaw !== null) {
    notes.push(["警告", "装机副本在、bundles 登记没了:DSH 能起,但**她不会被挂载**"
      + "\n         ⇒ 修法:`node scripts/install.mjs`"]);
  }
  if (installedRaw !== null) {
    const installed = JSON.parse(installedRaw);
    if (installed.version !== sourcePackage.version) {
      notes.push(["警告", "装机位版本 " + installed.version + " != 仓库版本 " + sourcePackage.version
        + " —— 重启后跑的仍是旧代码"]);
    }
    if (installed.dsh?.bundle?.patch === undefined) {
      notes.push(["致命", "装机位的 package.json 没有 dsh.bundle.patch"
        + "(很像 npm 上那个 dsh-echo@0.0.1 占位包)⇒ loader 会抛 declares no dsh.bundle"
        + "\n         ⇒ 修法:`node scripts/install.mjs --remove` 后重装"]);
    } else {
      // 2026-10-05 修(既有事故,不是 P0 引入):这里原来直接 `join(target, patch)`,
      // 而 0.2.0 世代的 `dsh.bundle.patch` 是**数组** ⇒ path.join 当场抛
      // ERR_INVALID_ARG_TYPE,**整个 `--doctor` 跑不起来**。现在按形态摊平:
      //   0.1.x = 字符串(只点名 cordis.patch.yml);0.2.0 = 数组(多一个 preset.patch.yml)。
      const patchRels = Array.isArray(installed.dsh.bundle.patch)
        ? installed.dsh.bundle.patch
        : [installed.dsh.bundle.patch];
      const missingPatch = patchRels.filter((rel) => typeof rel !== "string" || !existsSync(join(target, rel)));
      if (missingPatch.length > 0) {
        notes.push(["致命", "装机位 bundle patch 文件缺失:"
          + missingPatch.map((rel) => join(target, String(rel))).join("、") + "(复制不完整)"]);
      } else {
        // loader entry 只写在**主 patch**(cordis.patch.yml)里;preset.patch.yml 是
        // preset 平面的声明(声明行 preset-echo,由 check-preset-patch.mjs 看住),
        // 对它也查 `name: dsh-echo` 会假报警 —— 所以只查不带 preset 名的那一个。
        const loaderRel = patchRels.find((rel) => typeof rel === "string" && !rel.includes(PRESET_PATCH_FILE));
        if (loaderRel !== undefined) {
          const patchText = await readFile(join(target, loaderRel), "utf8");
          if (!patchText.includes("name: " + sourcePackage.name)) {
            notes.push(["致命", "bundle patch(" + loaderRel + ")里的 loader entry 名字不是 " + sourcePackage.name
              + " ⇒ 会抛 failed to import loader entry(D 侧的真实事故:dafeiyu 的 patch 用了不带 scope 的短名)"]);
          }
        }
      }
    }
    // 客户端模块协议:图里的行 id 就是包名,bundle 必须用同一个 id 注册自己。
    const clientRel = sourcePackage.exports?.["./client"];
    if (typeof clientRel === "string") {
      const clientPath = join(target, clientRel);
      if (!existsSync(clientPath)) {
        notes.push(["致命", "客户端 bundle 缺失:" + clientPath + "(面板不会有 Echo 设置区)"]);
      } else {
        const clientText = await readFile(clientPath, "utf8");
        if (!clientText.includes('__ModuleLoader__.load')) {
          notes.push(["致命", "客户端 bundle 没有调用 __ModuleLoader__.load:" + clientPath]);
        } else if (!clientText.includes('"id": "' + sourcePackage.name + '"')
          && !clientText.includes("id: \"" + sourcePackage.name + "\"")) {
          notes.push(["致命", "客户端 bundle 注册的 id 不是 " + sourcePackage.name
            + " ⇒ 浏览器侧会抛 loaded without registering(这是社区插件真踩过的坑)"]);
        }
      }
    }
  }
  if (!declared && listed) {
    notes.push(["警告", "profile 依赖表里没有 " + sourcePackage.name
      + " ⇒ 下次 `dsh plugin install` 会把它清掉,清完 bundles 登记变成悬空"
      + "\n         ⇒ 修法:`node scripts/install.mjs`(会生成 .dsh-echo-local/*.tgz 并登记依赖)"]);
  }
  // 2026-09-28 实测:link 装机(deps 写的是 link:…)根本不需要 tgz,而这条只按下标
  // 判断"有登记 + 没有 tgz"就报警 ⇒ **假警告**。只对真用 tgz 的 file: 装机才算。
  if (declared && String(deps[sourcePackage.name] ?? "").startsWith("file:") && !existsSync(localTarball)) {
    notes.push(["警告", "依赖表指向 " + localSpec + ",但分发包不在 ——"
      + " `dsh plugin install` 会失败。修法:重跑 `node scripts/install.mjs`"]);
  }
  dataDirDoctor();
  // 第七项(v0.20.0 D1):压缩后端住在 **preset 平面** —— 插件本身装好了,
  // 但没人选「Echo 陪伴模式」预设 ⇒ 策展后端根本不会被挂载。这不是致命
  // 问题(不选就一切照旧),所以只报"信息/警告",不拦退出码。
  const installedManifest = installedRaw ? JSON.parse(installedRaw) : null;
  const modernPreset = Array.isArray(installedManifest?.dsh?.bundle?.patch)
    && installedManifest.dsh.bundle.patch.some(rel => String(rel).includes(PRESET_PATCH_FILE));
  const presetPath = modernPreset ? join(target, PRESET_PATCH_FILE)
    : join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".agent-presets", "echo", "agent.cordis.yml");
  if (!existsSync(presetPath)) {
    notes.push(["信息", "没有生成「Echo 陪伴模式」预设 ⇒ 压缩仍走 stock(英文工程检查点)。"
      + "\n         ⇒ 想要 D1 的策展压缩:`node scripts/install-preset.mjs`,再在会话里选这份预设"]);
  } else {
    const presetText = await readOptional(presetPath) ?? "";
    if (!presetText.includes("dsh-echo/compaction")) {
      notes.push(["警告", "预设存在但没指向 dsh-echo/compaction:" + presetPath
        + "\n         ⇒ 重跑 `node scripts/install-preset.mjs`(它现读出厂预设再换那一行)"]);
    } else if (notes.length === 0) {
      console.log("没问题:登记、装机副本、bundle patch、客户端 id、依赖表、分发包六项一致;"
        + "「Echo 陪伴模式」预设也在。");
      return;
    }
  }
  if (notes.length === 0) {
    console.log("没问题:登记、装机副本、bundle patch、客户端 id、依赖表、分发包六项一致。");
    return;
  }
  for (const [level, text] of notes) console.log("[" + level + "] " + text);
  if (notes.some(([level]) => level === "致命")) process.exitCode = 1;
}

if (args.has("--check")) {
  await verify();
  process.exit(0);
}
if (args.has("--doctor")) {
  await doctor();
  process.exit(process.exitCode ?? 0);
}
if (args.has("--migrate")) {
  process.exit(migrate());
}

// ---- 卸载:摘 bundles 登记 + 删装机副本(链接只删本身) ----
// dsh plugin remove 走 pnpm 依赖表,管不了手工装机包 —— 这是官方 CLI
// 之外唯一受支持的卸载路径。
if (args.has("--remove")) {
  // Validate registration before touching code; malformed JSON must preserve it.
  const profileRaw = await readOptional(profilePkgPath);
  const profile = profileRaw === null ? null : parseJsonOrThrow(profileRaw, profilePkgPath, "Web profile package.json");
  const nonce = randomUUID();
  const previous = target + ".remove-" + nonce, previousDist = localDistDir + ".remove-" + nonce;
  assertHomePath(dshHome, previous); assertHomePath(dshHome, previousDist);
  let targetStat = null, distStat = null;
  try { targetStat = await lstat(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { distStat = await lstat(localDistDir); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (targetStat && !targetStat.isSymbolicLink()) assertInstallTargetSafe(sourceRoot, target);
  if (distStat) assertInstallTargetSafe(sourceRoot, localDistDir);
  let dirty = false;
  if (Array.isArray(profile?.dsh?.profile?.bundles)) {
    const index = profile.dsh.profile.bundles.indexOf(sourcePackage.name);
    if (index >= 0) { profile.dsh.profile.bundles.splice(index, 1); dirty = true; }
  }
  if (profile?.dependencies && typeof profile.dependencies[sourcePackage.name] === "string") {
    delete profile.dependencies[sourcePackage.name]; dirty = true;
  }
  let moved = false, movedDist = false;
  try {
    if (targetStat) { await rename(target, previous); moved = true; }
    if (distStat) { await rename(localDistDir, previousDist); movedDist = true; }
    if (dirty) await writeProfile(JSON.stringify(profile, null, 2) + "\n", nonce);
  } catch (error) {
    if (movedDist) { assertHomePath(dshHome, localDistDir); await rename(previousDist, localDistDir); }
    if (moved) { assertHomePath(dshHome, target); await rename(previous, target); }
    throw error;
  }
  // Registration committed. Clean only the owned backups; never traverse a slot link.
  if (moved) {
    if (targetStat.isSymbolicLink()) {
      assertHomePath(dshHome, previous, { allowLeafLink: true }); await rm(previous, { force: true });
    } else await removeDirectory(previous);
  }
  if (movedDist) await removeDirectory(previousDist);
  console.log("Uninstall complete. Personal data retained. Restart dsh web.");
  process.exit(0);
}

if (!existsSync(join(dshHome, "profiles", "web"))) {
  console.warn("⚠️  未检测到 DSH Web 配置目录:" + join(dshHome, "profiles", "web"));
  console.warn("   请确认这台电脑已安装 DeepSeek Harness(Web 版)且 DSH_HOME 指向正确。");
}

// ---- 1a. link 装机:默认运行本脚本**不再复制** ----
// 2026-09-27 搬家起装机形态是 link(源码区即装机位)。不特判的话,一次习惯性的
// `node scripts/install.mjs` 会先把 junction 摘掉、再复制一份进去 —— 等于把搬家悄悄回退。
// 所以 link 形态下本脚本退化成"只校验"(改完源码直接重启 dsh web)。
{
  let isLink = false;
  try { isLink = (await lstat(target)).isSymbolicLink(); } catch { /* 没装过:走下面的复制装机 */ }
  if (isLink) {
    console.log("装机形态 = link(" + target + " → " + realpathSync(target) + "),跳过复制");
    await verify();
    console.log("link 装机无需复制:改完源码重启 dsh web 即可(只有 web/ 刷新页面就够)。");
    process.exit(0);
  }
}

// ---- 1. 装机位守卫(先说清楚,再动旧装机位) ----
assertInstallTargetSafe(sourceRoot, target);
const profileBeforeText = await readOptional(profilePkgPath) ?? "";
const profileBefore = parseJsonOrThrow(profileBeforeText, profilePkgPath, "Web profile package.json");
if (!Array.isArray(profileBefore?.dsh?.profile?.bundles)) {
  throw new Error("Initialize the DSH Web profile before installing; dsh.profile.bundles is missing");
}

// ---- 2. 先复制到**临时位**,自检过了才换名上任 ----
// v0.42.0 审计修复(P1):原来是「先 rm -rf 装机位 → 再往装机位里复制」。
// 2026-09-26 那次 PowerShell 管道被掐断(见下面 2b)恰好证明了这条顺序的代价:
// 复制半路死掉,而装机位**已经被删空** —— 面板一 reload 她就起不来,还回不去。
// 现在旧装机位在换名前一直不动:复制/自检失败就删掉临时位走人,现场和装之前
// 一模一样。换名(rename)同盘是原子的。
assertHomePath(dshHome, dirname(target));
await mkdir(dirname(target), { recursive: true });
const staging = await mkdtemp(target + ".incoming-");
const preparedDist = await mkdtemp(join(profileDir, ".dsh-echo-dist-incoming-"));
assertInstallTargetSafe(sourceRoot, staging);
assertInstallTargetSafe(sourceRoot, preparedDist);
try {
  // 2026-09-26 全仓审查抓到:整目录 cp 会把**测试与本机缓存**一起搬进宿主的
  // node_modules —— 实测装机副本里有 `python/tests`(12 个文件)与 24 个 `.pyc`。
  // 它们不影响运行,但会污染宿主目录、让「装机副本 vs 仓库」的字节比对失去意义
  // (那几个文件本来就该不一样),还可能把测试用例里的假数据/钥匙带进宿主的包。
  const COPY_SKIP = /(^|[\\/])(tests|__pycache__)([\\/]|$)|\.pyc$/;
  await cp(join(sourceRoot, "python"), join(staging, "python"), {
    recursive: true, force: true,
    filter: (src) => !COPY_SKIP.test(src)
  });
  const patchAssets = Array.isArray(sourcePackage.dsh?.bundle?.patch)
    ? sourcePackage.dsh.bundle.patch : [sourcePackage.dsh?.bundle?.patch];
  for (const entry of new Set(["lib", "web", "scripts", "docs", "LICENSE", "LICENSES", "THIRD_PARTY.md",
    "PRIVACY.md", "SECURITY.md", "CONTRIBUTING.md", ".preset-patch-generated.json",
    "package.json", "npm-shrinkwrap.json", "README.md", "CHANGELOG.md", ...patchAssets])) {
    if (typeof entry !== "string" || resolve(sourceRoot, entry).startsWith(resolve(sourceRoot) + sep) === false) {
      throw new Error("Invalid package asset");
    }
    await cp(join(sourceRoot, entry), join(staging, entry), { recursive: true, force: true });
  }
  // 上一次装机可能留下的旧残渣(过滤规则变了之后要清干净)
  for (const stale of ["python/tests", "python/engine/__pycache__", "python/__pycache__", "tests"]) {
    await rm(join(staging, stale), { recursive: true, force: true });
  }
  console.log("Staged " + sourcePackage.name + "@" + sourcePackage.version + " -> " + staging);
  runNpm(["ci", "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund"],
    { cwd: staging, env: process.env });
  verifyRuntimeDependencies(staging);

  // ---- 2b. 装漏了 / 拷到一半就死:装机位必须能解析自己的相对 import ----
  // 2026-09-26 现场:我一条命令里 `npm run install-plugin | Select-Object -First 1`
  // —— PowerShell 的 Select-Object -First N 拿到第一行就**掐掉上游管道**,复制被
  // 拦腰截断:新模块 lib/turn-query.js 没进装机位,而 lib/index.js 已经在 import 它。
  // 那一刻只要面板 reload,她就直接起不来,而且**没有任何提示**。复制完立刻自检:
  {
    const missing = [];
    for (const f of await readdir(join(staging, "lib"))) {
      if (!f.endsWith(".js")) continue;
      const src = await readFile(join(staging, "lib", f), "utf8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g)) {
        if (!existsSync(join(staging, "lib", m[1]))) missing.push(f + " → " + m[1]);
      }
    }
    if (missing.length > 0) {
      throw new Error("装机位缺文件(复制不完整,reload 会起不来):" + missing.join("; "));
    }
    console.log("  imports: 装机位每个相对 import 都有着落");
  }
  // Isolated dist staging cannot overwrite a still-live same-version package.
  runNpm(["pack", "--pack-destination", preparedDist, "--silent"], { cwd: sourceRoot, env: process.env });
  if (!existsSync(join(preparedDist, localTarballName))) throw new Error("Prepared distribution package is missing");
} catch (error) {
  // 自检没过 / 拷到一半死了:撤掉临时位,旧装机位原样留着(她还能跑)
  await removeDirectory(staging);
  await removeDirectory(preparedDist);
  console.error("装机中止:临时位已撤,原装机位未动。原因:" + String(error?.message ?? error));
  throw error;
}

// ---- Commit prepared code, durable package and profile, with exception rollback. ----
const nonce = randomUUID();
const previous = target + ".previous-" + nonce;
const previousTar = join(preparedDist, "previous-package.tgz");
let movedOld = false, placedNew = false, movedTar = false, placedTar = false, profileCommitted = false;
try {
  for (const file of [target, previous, localDistDir, localTarball, previousTar]) assertHomePath(dshHome, file);
  if (await readOptional(profilePkgPath) !== profileBeforeText) throw new Error("Profile changed during preparation; previous installation retained");
  const nextProfile = structuredClone(profileBefore);
  if (!nextProfile.dsh.profile.bundles.includes(sourcePackage.name)) nextProfile.dsh.profile.bundles.push(sourcePackage.name);
  nextProfile.dependencies ||= {};
  nextProfile.dependencies[sourcePackage.name] = localSpec;
  assertInstallTargetSafe(sourceRoot, target);
  if (existsSync(target)) { await rename(target, previous); movedOld = true; }
  await rename(staging, target); placedNew = true;
  assertHomePath(dshHome, localDistDir);
  await mkdir(localDistDir, { recursive: true });
  if (existsSync(localTarball)) { await rename(localTarball, previousTar); movedTar = true; }
  await rename(join(preparedDist, localTarballName), localTarball); placedTar = true;
  await writeProfile(JSON.stringify(nextProfile, null, 2) + "\n", nonce); profileCommitted = true;
  await verify();
} catch (error) {
  const failures = [];
  const attempt = async work => { try { await work(); } catch (rollbackError) { failures.push(rollbackError); } };
  if (profileCommitted) await attempt(() => writeProfile(profileBeforeText, nonce + "-rollback"));
  if (placedTar) await attempt(async () => { assertHomePath(dshHome, localTarball); await rm(localTarball, { force: true }); });
  if (movedTar) await attempt(async () => { assertHomePath(dshHome, localTarball); await rename(previousTar, localTarball); });
  if (placedNew) await attempt(() => removeDirectory(target));
  if (movedOld) await attempt(async () => { assertHomePath(dshHome, previous); await rename(previous, target); });
  await attempt(() => removeDirectory(staging));
  if (!failures.length) await attempt(() => removeDirectory(preparedDist));
  if (failures.length) throw new AggregateError([error, ...failures], "Install failed; recovery backups retained");
  throw error;
}
if (movedOld) await removeDirectory(previous);
await removeDirectory(preparedDist);
// Prune only this package's older local tarballs after the new state is verified.
for (const file of await readdir(localDistDir)) {
  if (file.startsWith(sourcePackage.name + "-") && file.endsWith(".tgz") && file !== localTarballName) {
    const candidate = join(localDistDir, file); assertHomePath(dshHome, candidate); await rm(candidate, { force: true });
  }
}
console.log("Installation complete. Restart dsh web, then hard-refresh the browser.");
