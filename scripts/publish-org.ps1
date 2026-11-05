<#
  publish-org.ps1 —— 把《GitHub上传策略-2026-10-05.md》§3.2 的发布流程脚本化(默认 dry-run)

  它做四件事:
    1) 从当前工作树导出一份发布树(被跟踪文件按**工作树版本**复制 = "HEAD + 未提交改动"
       的实况,外加未跟踪的新文件);
    2) 筛选(§5:archive/、CHANGELOG.md、.scratch/、data/、*.db、node_modules/、
       __pycache__/、*.log、*.bak、*.tmp、backup/ 一律不进包);
    3) 脱敏(§4:本机绝对路径 -> ~/.dsh/... 或 $env:USERPROFILE\...,真账号 id -> 占位符);
    4) 硬闸(命中即退出,不继续) + 临时目录 git init -> 单提交 -> 只**打印** push 命令。

  默认 **不 add remote、不 push**;只有显式 -Push 才推,而且推之前硬闸会再判一次。

  自净纪律(本文件自己也会被导出、也要过同一套硬闸):
  所以本文件里**不写死**任何会被硬闸命中的整段字面量 ——
    用户名从 $env:USERNAME / -UserName 动态取;
    盘符绝对前缀拆成 P @('C:','\Users','\');
    数据目录后缀拆成 P @('.dsh','\','echo');
    token 前缀拆成 P @('gh','o_') / P @('s','k-') / P @('github_','pat_')。
  这样脚本自己不会成为硬闸的假阳性来源(否则一个发布脚本会自己把自己闸死)。

  用法:
    powershell -NoProfile -File scripts/publish-org.ps1                      # 预演(默认)
    powershell -NoProfile -File scripts/publish-org.ps1 -StrictLiteralGates  # 严格字面量硬闸
    powershell -NoProfile -File scripts/publish-org.ps1 -Push                # 正式发布(勿轻用)
    powershell -NoProfile -File scripts/publish-org.ps1 -Push -AllowRemoteMismatch
                                                                             # 明知远端有别人的提交还要推
                                                                             # (2026-10-07 安全阀;默认拒)
#>
[CmdletBinding()]
param(
  [string] $RepoRoot      = '',
  [string] $UserName      = '',
  [string] $QqId          = '',
  [string] $QqPlaceholder = '1000000000',
  [string] $TempRoot      = '',
  [string] $RemoteUrl     = 'https://github.com/Heart3-XDUGT2/dsh-memory-agent.git',
  [string] $Branch        = 'main',
  [string] $AuthorName    = 'Yotao',
  [string] $AuthorEmail   = '241458159+Yotaoer@users.noreply.github.com',
  [string] $CommitMessage = 'Initial commit: Echo source code (desensitized) 2026-10-05',
  [switch] $Push,
  [switch] $AllowRemoteMismatch,
  [switch] $StrictLiteralGates
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------- 常量(拆开写,见文件头自净纪律)
function P { param([string[]] $Parts) return ($Parts -join '') }

$BS        = '\'
$ABS_USERS = P @('C:', '\Users', '\')          # 本机用户目录的绝对前缀
$FWD_USERS = P @('C:', '/', 'Users', '/')
$DSH_ECHO  = P @('.dsh', '\', 'echo')          # 数据目录后缀(反斜杠写法)
$TOK_LIT   = @((P @('gh', 'o_')), (P @('s', 'k-')), (P @('github_', 'pat_')))
$TOK_SHAPE = @(
  ((P @('gh', 'o_')) + '[A-Za-z0-9]{20,}'),
  ((P @('s', 'k-')) + '[A-Za-z0-9]{20,}'),
  ((P @('github_', 'pat_')) + '[A-Za-z0-9_]{20,}')
)

$EXCLUDE_RES = @(
  '\.bak',            # 2026-10-08:备份文件绝不进发布树(style.css.bak 那次的教训)
  '(^|/)archive/',
  # 源里的 CHANGELOG.md 已是**切片版**(全量档在 archive/CHANGELOG_FULL.md,按目录排除)
  # => 不再排除 CHANGELOG.md;切片由交接档 slice-changelog.mjs 生成、可重跑
  '(^|/)\.scratch/',
  '(^|/)data/',
  '\.db$',
  '(^|/)node_modules/',
  '__pycache__',
  '\.log$',
  '\.bak$',
  '\.tmp$',
  '(^|/)backup/'
)

$BINARY_EXT = @('.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.db', '.ico', '.zip', '.gz')

# ---------------------------------------------------------------- 小工具
# 原生命令统一走这里:$ErrorActionPreference='Stop' 时,git 的 stderr 在 PS 5.1 里会被
# 当成 terminating error;所以临时降级到 Continue,拿到输出与退出码自行判定。
function Invoke-Git {
  param([string[]] $GitArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& git @GitArgs 2>&1 | Out-String)
  } finally {
    $ErrorActionPreference = $prev
  }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}

function Split-GitLines {
  param([string] $Text)
  return @($Text -split "`r?`n" | Where-Object { $_ -ne '' })
}

function Count-Literal {
  param([string] $Text, [string] $Needle)
  if ([string]::IsNullOrEmpty($Needle) -or [string]::IsNullOrEmpty($Text)) { return 0 }
  $i = 0; $n = 0
  while (($i = $Text.IndexOf($Needle, $i, [System.StringComparison]::Ordinal)) -ge 0) {
    $n++; $i += $Needle.Length
  }
  return $n
}

function Get-PublishFiles {
  param([string] $Root)
  if (-not (Test-Path -LiteralPath $Root)) { return @() }
  return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' })
}

function Test-TextFile {
  param([System.IO.FileInfo] $File)
  if ($BINARY_EXT -contains $File.Extension.ToLowerInvariant()) { return $false }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($File.FullName)
    return ([System.Array]::IndexOf($bytes, [byte]0) -lt 0)
  } catch { return $false }
}

# ---------------------------------------------------------------- 参数兜底
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

if (-not $UserName) {
  $UserName = if ($env:USERNAME) { $env:USERNAME } else { Split-Path -Leaf $env:USERPROFILE }
}

# 真实账号 id:默认从本仓 git user.email 的 local-part 取(本仓 commit 邮箱就是 <id>@qq.com)。
# 不写死在文件里,是为了让本文件自己也能过硬闸。
if (-not $QqId) {
  $r = Invoke-Git @('-C', $RepoRoot, 'config', 'user.email')
  if ($r.Code -eq 0 -and $r.Out.Trim()) {
    $local = ($r.Out.Trim() -split '@')[0]
    if ($local -match '^\d{5,}$') { $QqId = $local }
  }
}

# ---------------------------------------------------------------- 删除闸:任何删除只能发生在发布临时目录内
if (-not $TempRoot) { $TempRoot = [System.IO.Path]::GetTempPath() }
$TempRoot = [System.IO.Path]::GetFullPath($TempRoot)
$PublishPrefix = Join-Path $TempRoot 'publish-echo-'
$PublishRoot = Join-Path $TempRoot ('publish-echo-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

# 发布目录/删除闸的前缀绝不许落在仓库里(否则"只准删发布目录"就成了"可以删仓库")
$repoTrim = $RepoRoot.TrimEnd([char[]]@('\', '/'))
if ($PublishPrefix.StartsWith($repoTrim + $BS, [System.StringComparison]::OrdinalIgnoreCase) -or
    $PublishPrefix.TrimEnd([char[]]@('\', '/')) -eq $repoTrim) {
  throw "拒绝:发布临时根落在仓库内 => $PublishPrefix(仓库:$repoTrim)"
}

function Assert-Deletable {
  param([string] $Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($PublishPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝删除:目标不在发布临时目录之下 => $full"
  }
  $a = $full.TrimEnd([char[]]@('\', '/'))
  $b = $RepoRoot.TrimEnd([char[]]@('\', '/'))
  if ($a -eq $b) { throw "拒绝删除:目标是仓库根 => $full" }
  return $full
}

function Remove-InPublish {
  param([string] $Path)
  $full = Assert-Deletable $Path
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}

# ---------------------------------------------------------------- 硬闸 / 字面量体检
function Measure-PublishGates {
  param([string] $Root, [string] $User, [string] $AbsUsers, [string] $FwdUsers,
        [string] $DshEcho, [string[]] $TokLit, [string[]] $TokShape)

  $m = [ordered]@{
    files           = 0
    rawUser         = 0   # 字面量:用户名子串(含出现在更长数字里的)
    bareUser        = 0   # 边界判定:用户名独立成词  <- 硬闸
    absUsers        = 0   # 盘符绝对用户目录前缀    <- 硬闸
    absUsersFwd     = 0   # 正斜杠形式的用户目录(仅体检)
    dshEcho         = 0   # 数据目录后缀字面量(仅体检)
    dshEchoAbs      = 0   # 盘符绝对的数据目录路径 <- 硬闸
    tokShape        = 0   # 真 token 形态          <- 硬闸
    tokLiteral      = 0   # token 前缀字面量(仅体检)
    bareUserFiles   = @()
    absUsersFiles   = @()
    dshEchoAbsFiles = @()
    tokShapeFiles   = @()
    dshEchoFiles    = @()
    tokLiteralFiles = @()
    absUsersFwdFiles = @()
  }

  $bareRe = '(?<!\d)' + [regex]::Escape($User) + '(?!\d)'
  $dshEchoAbsRe = '[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]\.dsh[\\/]echo'

  foreach ($f in (Get-PublishFiles -Root $Root)) {
    if (-not (Test-TextFile $f)) { continue }
    $rel = $f.FullName.Substring($Root.Length).TrimStart([char[]]@('\', '/'))
    $t = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    $m.files = $m.files + 1

    $m.rawUser = $m.rawUser + (Count-Literal $t $User)

    $c = ([regex]::Matches($t, $bareRe)).Count
    if ($c -gt 0) { $m.bareUser = $m.bareUser + $c; $m.bareUserFiles += "$rel ($c)" }

    $c = (Count-Literal $t $AbsUsers)
    if ($c -gt 0) { $m.absUsers = $m.absUsers + $c; $m.absUsersFiles += "$rel ($c)" }

    $c = (Count-Literal $t $FwdUsers)
    if ($c -gt 0) { $m.absUsersFwd = $m.absUsersFwd + $c; $m.absUsersFwdFiles += "$rel ($c)" }

    $c = (Count-Literal $t $DshEcho)
    if ($c -gt 0) { $m.dshEcho = $m.dshEcho + $c; $m.dshEchoFiles += "$rel ($c)" }

    $c = ([regex]::Matches($t, $dshEchoAbsRe)).Count
    if ($c -gt 0) { $m.dshEchoAbs = $m.dshEchoAbs + $c; $m.dshEchoAbsFiles += "$rel ($c)" }

    foreach ($sh in $TokShape) {
      $c = ([regex]::Matches($t, $sh)).Count
      if ($c -gt 0) { $m.tokShape = $m.tokShape + $c; $m.tokShapeFiles += "$rel ($c)" }
    }
    foreach ($lit in $TokLit) {
      $c = (Count-Literal $t $lit)
      if ($c -gt 0) { $m.tokLiteral = $m.tokLiteral + $c; $m.tokLiteralFiles += "$rel ($c)" }
    }
  }
  return $m
}

function Show-Gates {
  param($M, [string] $User, [string] $AbsUsers, [string] $DshEcho)

  Write-Output ''
  Write-Output '---------- 硬闸(命中 != 0 就退出) ----------'
  Write-Output ("  [硬] 用户名边界判定 {0} 命中 = {1}" -f $User, $M.bareUser)
  Write-Output ("  [硬] 盘符绝对用户目录前缀 {0} 命中 = {1}" -f $AbsUsers, $M.absUsers)
  Write-Output ("  [硬] 真 token 形态(前缀 + 20 位以上) 命中 = {0}" -f $M.tokShape)
  Write-Output ("  [硬] 盘符绝对的数据目录路径 命中 = {0}" -f $M.dshEchoAbs)
  Write-Output '---------- 字面量体检(不单独拦,除非 -StrictLiteralGates) ----------'
  Write-Output ("  [体检] 用户名子串(含出现在更长数字里,如真账号 id) 命中 = {0}" -f $M.rawUser)
  Write-Output ("  [体检] 正斜杠形式用户目录 命中 = {0}" -f $M.absUsersFwd)
  Write-Output ("  [体检] 数据目录后缀 {0} 字面量 命中 = {1}" -f $DshEcho, $M.dshEcho)
  Write-Output ("  [体检] token 前缀字面量(见文件头自净纪律) 命中 = {0}" -f $M.tokLiteral)

  $detailLabels = [ordered]@{
    bareUserFiles    = '用户名边界判定'
    absUsersFiles    = '盘符绝对用户目录前缀'
    dshEchoAbsFiles  = '绝对数据目录'
    tokShapeFiles    = '真 token 形态'
    dshEchoFiles     = '数据目录后缀字面量'
    tokLiteralFiles  = 'token 前缀字面量'
    absUsersFwdFiles = '正斜杠用户目录'
  }
  foreach ($k in $detailLabels.Keys) {
    $list = @($M[$k])
    if ($list.Count -gt 0) {
      Write-Output ("  明细 - {0}:" -f $detailLabels[$k])
      $list | Select-Object -First 20 | ForEach-Object { Write-Output ("      " + $_) }
    }
  }

}

# 只返回"没过"的项(和显示分开,免得显示文本被当成返回值)
function Get-GateFailures {
  param($M, [switch] $Strict)
  $fail = @()
  if ($M.bareUser   -ne 0) { $fail += '用户名边界判定' }
  if ($M.absUsers   -ne 0) { $fail += '盘符绝对用户目录前缀' }
  if ($M.tokShape   -ne 0) { $fail += '真 token 形态' }
  if ($M.dshEchoAbs -ne 0) { $fail += '绝对数据目录' }
  if ($Strict) {
    if ($M.rawUser    -ne 0) { $fail += '用户名子串(严格)' }
    if ($M.dshEcho    -ne 0) { $fail += '数据目录后缀字面量(严格)' }
    if ($M.tokLiteral -ne 0) { $fail += 'token 前缀字面量(严格)' }
  }
  return $fail
}

# ================================================================ 开始
Write-Output '=== publish-org.ps1 (默认 dry-run,绝不 push) ==='
Write-Output ("仓库        : {0}" -f $RepoRoot)
Write-Output ("本机用户名  : {0}" -f $UserName)
Write-Output ("账号 id     : {0}  ->  占位 {1}" -f ($(if ($QqId) { $QqId } else { '(未取到)' })), $QqPlaceholder)
$mode = if ($Push) { 'PUSH(真的会推!)' } else { 'dry-run' }
if ($StrictLiteralGates) { $mode = $mode + ' + StrictLiteralGates' }
Write-Output ("模式        : {0}" -f $mode)

# --- 0. 白名单护栏
$whitelistRe = '^https://github\.com/Heart3-XDUGT2/(dsh-memory-agent|dsh-qq-bridge)(\.git)?$'
if ($RemoteUrl -notmatch $whitelistRe) { throw "remote 不在白名单(只允许 Heart3-XDUGT2/dsh-memory-agent 与 dsh-qq-bridge): $RemoteUrl" }
if ($Branch -ne 'main') { throw "只允许推 main,收到: $Branch" }

# --- 1. 建发布目录
Remove-InPublish $PublishRoot
New-Item -ItemType Directory -Path $PublishRoot -Force | Out-Null
Write-Output ("发布临时目录: {0}" -f $PublishRoot)

# --- 2. 列文件 + 3. 筛选
$r1 = Invoke-Git @('-C', $RepoRoot, '-c', 'core.quotepath=false', 'ls-files')
if ($r1.Code -ne 0) { throw "git ls-files 失败: $($r1.Out)" }
$r2 = Invoke-Git @('-C', $RepoRoot, '-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard')
if ($r2.Code -ne 0) { throw "git ls-files --others 失败: $($r2.Out)" }

$tracked = Split-GitLines $r1.Out
$others = Split-GitLines $r2.Out
$all = @($tracked + $others | Select-Object -Unique)

$kept = @(); $dropped = @()
foreach ($rel in $all) {
  $skip = $false
  foreach ($re in $EXCLUDE_RES) { if ($rel -match $re) { $skip = $true; break } }
  if ($skip) { $dropped += $rel } else { $kept += $rel }
}
Write-Output ("源:被跟踪 {0} + 未跟踪 {1} = {2};筛选掉 {3};进包 {4}" -f $tracked.Count, $others.Count, $all.Count, $dropped.Count, $kept.Count)
foreach ($d in $dropped) { Write-Output ("  筛掉: " + $d) }

# --- 4. 复制(工作树版本 = HEAD + 未提交改动的实况)
$copied = 0; $missing = @()
foreach ($rel in $kept) {
  $src = Join-Path $RepoRoot ($rel -replace '/', '\')
  $dst = Join-Path $PublishRoot ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { $missing += $rel; continue }
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item -LiteralPath $src -Destination $dst -Force
  $copied = $copied + 1
}
Write-Output ("复制进发布树: {0} 个文件" -f $copied)
if ($missing.Count -gt 0) { Write-Output ("  警告:工作树里缺 {0} 个被索引文件:{1}" -f $missing.Count, ($missing -join ', ')) }

# --- 5. 脱敏(只改文本里的路径 / 账号 id,不动逻辑、不动缩进)
$U = $UserName
$absUser   = $ABS_USERS + $U
$fwdUser   = $FWD_USERS + $U
$dshBs     = P @('\', '.dsh', '\')
$pluginBs  = $absUser + $dshBs + 'plugins' + $BS
$echoBs    = $absUser + $dshBs + 'echo'
$pluginFwd = $fwdUser + '/.dsh/plugins'
$echoFwd   = $fwdUser + '/.dsh/echo'

$rules = @(
  @(($pluginBs + 'dsh-echo-qq'), '~/.dsh/plugins/dsh-echo-qq'),
  @(($pluginBs + 'dsh-echo'), '~/.dsh/plugins/dsh-echo'),
  @(($echoBs + '-qq'), '~/.dsh/echo-qq'),
  @($echoBs, '~/.dsh/echo'),
  @(($pluginFwd + '/dsh-echo-qq'), '~/.dsh/plugins/dsh-echo-qq'),
  @(($pluginFwd + '/dsh-echo'), '~/.dsh/plugins/dsh-echo'),
  @(($echoFwd + '-qq'), '~/.dsh/echo-qq'),
  @($echoFwd, '~/.dsh/echo'),
  @($absUser, '$env:USERPROFILE'),
  @($fwdUser, '~')
)
if ($QqId) { $rules += , @($QqId, $QqPlaceholder) }
# 私有真称呼:发布副本里一律换成占位符(本地仓库、本地测试**不动**)
$PRIV_LIT = P @('哥', '哥')
$rules += , @($PRIV_LIT, '<称呼>')
# 2026-10-22:她自己的 QQ 号(与他的号分开占位,便于夹具里分辨谁是谁)。
# 同样拆字面量 —— 本文件也在发布树里,写整段等于自己漏出去(见文件头自净纪律)。
$HER_QQ    = P @('3783', '207594')
$HER_QQ_PH = '1000000001'
if ($HER_QQ) { $rules += , @($HER_QQ, $HER_QQ_PH) }

$edited = 0
foreach ($f in (Get-PublishFiles -Root $PublishRoot)) {
  if (-not (Test-TextFile $f)) { continue }
  $t = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
  $o = $t
  foreach ($r in $rules) { if ($r[0]) { $o = $o.Replace($r[0], $r[1]) } }
  if ($U) { $o = [regex]::Replace($o, ('(?<!\d)' + [regex]::Escape($U) + '(?!\d)'), '<user>') }
  if ($o -ne $t) {
    [System.IO.File]::WriteAllText($f.FullName, $o, (New-Object System.Text.UTF8Encoding($false)))
    $edited = $edited + 1
  }
}
Write-Output ("脱敏:改动 {0} 个文件" -f $edited)

# --- 5b. 私有值复扫(真称呼不得出现在发布副本里)
$privHit = 0
foreach ($f in (Get-PublishFiles -Root $PublishRoot)) {
  if (-not (Test-TextFile $f)) { continue }
  $t2 = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
  $privHit += (Count-Literal $t2 $PRIV_LIT)
  $privHit += (Count-Literal $t2 $HER_QQ)
}
Write-Output ("私有值复扫:真称呼+她的号 命中 = {0}(应为 0)" -f $privHit)
if ($privHit -ne 0) {
  Write-Output '  真称呼仍在发布副本里 ⇒ 退出,不继续。'
  Write-Output ("发布树仍在(便于复查): {0}" -f $PublishRoot)
  exit 2
}

# --- 6. 硬闸
$M = Measure-PublishGates -Root $PublishRoot -User $U -AbsUsers $ABS_USERS -FwdUsers $FWD_USERS `
  -DshEcho $DSH_ECHO -TokLit $TOK_LIT -TokShape $TOK_SHAPE
Show-Gates -M $M -User $U -AbsUsers $ABS_USERS -DshEcho $DSH_ECHO
$fail = Get-GateFailures -M $M -Strict:$StrictLiteralGates
if ($fail.Count -gt 0) {
  Write-Output ''
  Write-Output ("硬闸未过:{0} —— 退出,不继续。" -f ($fail -join ' / '))
  Write-Output ("发布树仍在(便于复查): {0}" -f $PublishRoot)
  exit 2
}
Write-Output ''
Write-Output '硬闸:过。'

# --- 7. 临时目录 git init + 单提交(不 add remote、不 push)
$ri = Invoke-Git @('-C', $PublishRoot, 'init', '-b', $Branch)
if ($ri.Code -ne 0) { throw "git init 失败: $($ri.Out)" }

$gaDst = Join-Path $PublishRoot '.gitattributes'
if (-not (Test-Path -LiteralPath $gaDst)) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot '.gitattributes') -Destination $gaDst
}

$fileCount = (Get-PublishFiles -Root $PublishRoot).Count
$ra = Invoke-Git @('-C', $PublishRoot, 'add', '-A')
if ($ra.Code -ne 0) { throw "git add 失败: $($ra.Out)" }
# P3-e 追加(2026-10-05):钉死作者/提交时间 ⇒ 同一份内容每次都得到同一个 sha
# (干跑与正式推、今天与下次,sha 都不再漂;要改内容必须改内容本身)。
$env:GIT_AUTHOR_DATE = '2026-10-05T00:00:00Z'
$env:GIT_COMMITTER_DATE = '2026-10-05T00:00:00Z'
$rc = Invoke-Git @('-C', $PublishRoot, '-c', "user.name=$AuthorName", '-c', "user.email=$AuthorEmail", 'commit', '-q', '-m', $CommitMessage)
if ($rc.Code -ne 0) { throw "git commit 失败: $($rc.Out)" }

$sha = (Invoke-Git @('-C', $PublishRoot, 'rev-parse', 'HEAD')).Out.Trim()
$shortSha = (Invoke-Git @('-C', $PublishRoot, 'rev-parse', '--short', 'HEAD')).Out.Trim()
Remove-Item Env:GIT_AUTHOR_DATE, Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue
$commits = (Invoke-Git @('-C', $PublishRoot, 'rev-list', '--count', 'HEAD')).Out.Trim()
$trackedInPublish = (Split-GitLines (Invoke-Git @('-C', $PublishRoot, 'ls-files')).Out).Count
$statusLines = Split-GitLines (Invoke-Git @('-C', $PublishRoot, 'status', '--porcelain')).Out
$pushCmd = 'git -C "' + $PublishRoot + '" remote add origin ' + $RemoteUrl
$pushCmd2 = 'git -C "' + $PublishRoot + '" push --force origin ' + $Branch

Write-Output ''
Write-Output '---------- 发布树(临时目录) ----------'
Write-Output ("临时目录完整路径 : {0}" -f $PublishRoot)
Write-Output ("发布树文件数     : {0}(git 纳入 {1})" -f $fileCount, $trackedInPublish)
Write-Output ("git 提交数       : {0}(应为 1)" -f $commits)
Write-Output ("单提交 sha       : {0}   ({1})" -f $sha, $shortSha)
Write-Output ("提交信息         : {0}" -f $CommitMessage)
Write-Output ("提交身份         : {0} <{1}>" -f $AuthorName, $AuthorEmail)
if ($statusLines.Count -eq 0) {
  Write-Output 'git status       : 干净(0 行)'
} else {
  Write-Output ("git status       : 不干净:" + ($statusLines -join ' | '))
}
Write-Output ("将要 push 的 remote : {0}" -f $RemoteUrl)
Write-Output ("将要 push 的 branch : {0}" -f $Branch)
Write-Output '白名单             : Heart3-XDUGT2/dsh-memory-agent, Heart3-XDUGT2/dsh-qq-bridge(都只推 main)'

Write-Output ''
Write-Output '---------- 若正式发布,会执行的两条命令(本次未执行) ----------'
Write-Output ("  " + $pushCmd)
Write-Output ("  " + $pushCmd2)

if (-not $Push) {
  Write-Output ''
  Write-Output 'dry-run 结束:没有 add remote、没有 push。正式发布请显式加 -Push(那时硬闸会再判一次)。'
  exit 0
}

# --- 8. -Push:硬闸再判一次,然后才推
Write-Output ''
Write-Output '--- -Push:硬闸复判 ---'
$M2 = Measure-PublishGates -Root $PublishRoot -User $U -AbsUsers $ABS_USERS -FwdUsers $FWD_USERS `
  -DshEcho $DSH_ECHO -TokLit $TOK_LIT -TokShape $TOK_SHAPE
Show-Gates -M $M2 -User $U -AbsUsers $ABS_USERS -DshEcho $DSH_ECHO
$fail2 = Get-GateFailures -M $M2 -Strict:$StrictLiteralGates
if ($fail2.Count -gt 0) { throw ("复判未过,拒绝 push:{0}" -f ($fail2 -join ' / ')) }

# --- 8b. 安全阀(2026-10-07 事故后加):force push 之前先**看远端**,防手滑覆盖别人的提交
#
# 为什么加:2026-10-07 队友(Terabinaryte)在**我们那次 force push 出来的单提交之上**
# 又提交了一条 `feat(sidecar): 记忆引擎可取消`(`89d88cb`)。我们下一次 `--force` 会把它
# 整条推掉,而且不可逆。所以推之前先问一句:远端现在那个 HEAD,还是我们上次推的那个吗?
#
# 判据(默认保守,宁可不推):
#   · 远端 `refs/heads/<Branch>` **不存在** ⇒ 允许(首次发布,没有别人的东西可覆盖)
#   · 远端 HEAD == **台账里记的"我们上次推的 sha"** ⇒ 允许(照常 force push)
#   · 其余(远端动过、或本地没有台账)一律**拒绝**:打印远端那个提交的 sha / 作者 /
#     日期 / 首行,并说明"要先处理"。
#   · 逃生门:`-AllowRemoteMismatch`(显式写出来,审计里看得见你明知故推)。
#
# 台账:$env:USERPROFILE\.dsh\publish-state.json(**不进仓库**,不会被发出去)
# —— 每次推成功后把 sha 记进去,下次就靠它认"是不是我们自己的"。
$StatePath = Join-Path $env:USERPROFILE '.dsh\publish-state.json'

function Read-PublishState {
  try {
    if (Test-Path -LiteralPath $StatePath) {
      return (Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
  } catch { }
  return $null
}

function Write-PublishState {
  param([string] $Url, [string] $Sha)
  $st = Read-PublishState
  $obj = @{}
  if ($st -ne $null) { foreach ($p in $st.PSObject.Properties) { $obj[$p.Name] = $p.Value } }
  $obj[$Url] = $Sha
  $dir = Split-Path -Parent $StatePath
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  ($obj | ConvertTo-Json) | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

Write-Output ''
Write-Output '--- -Push:安全阀(先看远端,再决定能不能 force) ---'
$remoteRef = 'refs/heads/' + $Branch
$ls = Invoke-Git @('ls-remote', $RemoteUrl, $remoteRef)
if ($ls.Code -ne 0) { throw ('安全阀:ls-remote 失败(网络/权限?):' + $ls.Out) }
$remoteSha = ''
$firstLine = ($ls.Out -split "`n") | Where-Object { $_ -match '\S' } | Select-Object -First 1
if ($firstLine) { $remoteSha = ($firstLine -split '\s+')[0].Trim() }
$localSha = (Invoke-Git @('-C', $PublishRoot, 'rev-parse', 'HEAD')).Out.Trim()
$st = Read-PublishState
$lastSha = ''
if ($st -ne $null -and (@($st.PSObject.Properties.Name) -contains $RemoteUrl)) {
  $lastSha = [string]$st.$RemoteUrl
}
Write-Output ('  远端 ' + $Branch + '   = ' + $(if ($remoteSha -eq '') { '(空仓 —— 首次发布)' } else { $remoteSha }))
Write-Output ('  本地待推      = ' + $localSha)
Write-Output ('  台账上次推的  = ' + $(if ($lastSha -eq '') { '(没有台账记录)' } else { $lastSha }))

if ($remoteSha -ne '' -and $remoteSha -ne $lastSha) {
  # 远端有"不是我们上次推的那版" ⇒ 先把它 fetch 下来,打印清楚,再拒绝
  $guardRef = 'refs/remotes/guarded/' + $Branch
  $fr = Invoke-Git @('-C', $PublishRoot, 'fetch', '--no-tags', $RemoteUrl, ($remoteRef + ':' + $guardRef))
  Write-Output ''
  Write-Output '  ⚠️ 远端动过 —— 不是我们上次推的那版。远端那个提交是:' -ForegroundColor Yellow
  if ($fr.Code -eq 0) {
    $show = Invoke-Git @('-C', $PublishRoot, 'log', '-1', '--format=%H%n作者 %an <%ae>%n日期 %ad%n标题 %s', $guardRef)
    foreach ($l in (($show.Out -split "`n") | Where-Object { $_ -match '\S' })) {
      Write-Output ('    ' + $l.Trim())
    }
  } else {
    Write-Output ('    (fetch 失败,只能给 sha:' + $remoteSha + ')')
  }
  if (-not $AllowRemoteMismatch) {
    # 消息拼进变量再 throw(多行拼接里嵌 $(if) 会让 PS 5.1 解析器咬人)
    $why = if ($lastSha -eq '') { '(且本地没有台账)' } else { '(台账里记的是 ' + $lastSha + ')' }
    $msg = '安全阀:拒绝 force push —— 远端 HEAD ' + $remoteSha + ' 不是我们上次推的那版' + $why
    $msg = $msg + '。先把远端那版处理掉(合并/让人 rebase),或明知故推加 -AllowRemoteMismatch。'
    throw $msg
  }
  Write-Output '  (-AllowRemoteMismatch:明知故推,继续)' -ForegroundColor Yellow
}

$rr = Invoke-Git @('-C', $PublishRoot, 'remote', 'add', 'origin', $RemoteUrl)
if ($rr.Code -ne 0) { throw "git remote add 失败: $($rr.Out)" }
$rp = Invoke-Git @('-C', $PublishRoot, 'push', '--force', 'origin', $Branch)
if ($rp.Code -ne 0) { throw "git push 失败: $($rp.Out)" }
Write-Output '已 push(--force)。'
# 记台账:下次就认得出"远端还是我们上次推的那版"
Write-PublishState -Url $RemoteUrl -Sha $localSha
Write-Output ('台账已记:' + $RemoteUrl + ' → ' + $localSha)
