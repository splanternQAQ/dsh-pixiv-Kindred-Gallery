# Pixiv 知心画廊 一键安装（Windows / PowerShell）
#
# 先看一眼再执行（推荐）：
#   $s = irm https://github.com/splanternQAQ/dsh-pixiv-Kindred-Gallery/raw/main/install.ps1
#   $s                     # 只打印，不执行
#   $s | iex               # 确认内容没问题，再执行
#
# 默认装到 %USERPROFILE%\.dsh\plugins（C 盘，和画廊数据同一个 .dsh 下面）；想换位置：
#   $env:PG_INSTALL_DIR = 'C:\MyPlugins'
#   $s | iex
# （用 PowerShell 7 时也可以先存盘再传参：pwsh -File .\install.ps1 -InstallDir 'C:\MyPlugins'）
#
# 本脚本只做四件事，全部写在下面，可以逐行核对：
#   1) 从 codeload.github.com 下载仓库 zip（纯下载：不执行 zip 里的任何代码/脚本）
#   2) 解压到安装目录；旧版本改名成 .bak-时间 留着，不删
#   3) 往 profile 的 package.json 加一条 link: 依赖和一个 bundles 名字（改前先存 .bak 备份）
#   4) 在 profile 的 node_modules 里建一个 Junction（目录联接）指向安装目录
#
# 它不需要管理员权限，也不写注册表、不装服务、不设开机自启、不改系统环境变量。
# 数据目录（评分 / 偏好 / 缩略图 / 轮次记录）在 %USERPROFILE%\.dsh\dsh-pixiv-Kindred-Gallery，
# 本脚本只读不动；重装只覆盖插件代码目录。
param(
  [string]$InstallDir = '',
  [string]$Ref = 'main'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# PS 5.1 默认的 TLS 栈会在 codeload 上偶发 "unexpected EOF"，显式固定到 TLS 1.2 稳定得多
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Get-FileWithRetry {
  param([string]$Url, [string]$OutFile, [int]$Tries = 3)
  for ($i = 1; $i -le $Tries; $i++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 90
      return
    } catch {
      if ($i -eq $Tries) { throw "下载失败（已重试 $Tries 次）：$($_.Exception.Message)" }
      Write-Host "   下载失败（第 $i 次）：$($_.Exception.Message)，重试…" -ForegroundColor Yellow
      Start-Sleep -Seconds 2
    }
  }
}

function Resolve-DestRoot {
  param([string]$Preferred)
  if ($Preferred) { return [IO.Path]::GetFullPath($Preferred) }
  if ($env:PG_INSTALL_DIR) { return [IO.Path]::GetFullPath($env:PG_INSTALL_DIR) }
  return (Join-Path $env:USERPROFILE '.dsh\plugins')
}

$repo = 'splanternQAQ/dsh-pixiv-Kindred-Gallery'
$name = 'dsh-pixiv-kindred-gallery'
$zipPrefix = 'dsh-pixiv-Kindred-Gallery'
$zipUrl = "https://codeload.github.com/$repo/zip/refs/heads/$Ref"
$destRoot = Resolve-DestRoot $InstallDir
if (-not (Test-Path $destRoot)) { New-Item -ItemType Directory -Path $destRoot -Force | Out-Null }
$dest = Join-Path $destRoot 'dsh-pixiv-Kindred-Gallery'
$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
$profileDir = $null
if (Test-Path $profilesRoot) {
  $cands = Get-ChildItem $profilesRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
  $desk = $cands | Where-Object { $_.Name -eq 'desktop' } | Select-Object -First 1
  if ($desk) { $profileDir = $desk.FullName }
  elseif ($cands) { $profileDir = ($cands | Select-Object -First 1).FullName }
}
if (-not $profileDir) { throw '找不到 DSH profile 目录（请先启动一次 DSH）' }
$dataHome = Join-Path $env:USERPROFILE '.dsh\dsh-pixiv-Kindred-Gallery'

Write-Host ''
Write-Host '本脚本将做这些事：' -ForegroundColor Cyan
Write-Host "   下载源码   $zipUrl"
Write-Host "   安装到     $dest"
Write-Host "   注册到     $(Join-Path $profileDir 'package.json')（改前备份 .bak）"
Write-Host "   数据目录   $dataHome（只读不动）"
Write-Host ''

Write-Host "==> 下载 $repo（$Ref）" -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP ('pg-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'src.zip'
Get-FileWithRetry -Url $zipUrl -OutFile $zip
$zipBytes = (Get-Item $zip).Length
$zipSha = ''
try { $zipSha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() } catch { }
Write-Host ("   已下载 {0:N0} 字节" -f $zipBytes)
if ($zipSha) { Write-Host "   sha256 $zipSha" -ForegroundColor DarkGray }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$srcDir = (Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like "$zipPrefix-*" } | Select-Object -First 1).FullName
if (-not $srcDir) { throw '解压后找不到源码目录' }

Write-Host "==> 安装到 $dest" -ForegroundColor Cyan
$bak = $null
if (Test-Path $dest) {
  $bak = $dest + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
  Move-Item $dest $bak
  Write-Host "   旧版本已备份到 $bak（要回滚就把它改回原名）"
}
Move-Item $srcDir $dest

# 数据保险：画廊的数据本来就在 profile 家目录里（下面那行会打印路径），重装不碰它；
# 但早期版本如果把数据放在插件目录里，这里把数据文件原样搬回新目录，免得看起来“数据丢了”。
if ($bak -and (Test-Path $bak)) {
  foreach ($n in @('gallery.json', 'preferences.json', 'prefs-auto.json', 'gallery.log')) {
    $from = Join-Path $bak $n
    if (Test-Path $from) { Copy-Item $from (Join-Path $dest $n) -Force; Write-Host "   已带回过数据文件：$n" }
  }
  foreach ($d in @('picks', 'thumbs', 'backups')) {
    $fromDir = Join-Path $bak $d
    if (Test-Path $fromDir) { Copy-Item $fromDir (Join-Path $dest $d) -Recurse -Force; Write-Host "   已带回过数据目录：$d" }
  }
}
Write-Host "   您的画廊数据（评分 / 偏好 / 缩略图 / 轮次）在：$dataHome" -ForegroundColor DarkGray
Write-Host "   重装只覆盖插件代码目录，不会删改上面这个目录。" -ForegroundColor DarkGray

Write-Host '==> 注册到 profile' -ForegroundColor Cyan
$pkgPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgPath)) { throw "找不到 $pkgPath（请先启动一次 DSH）" }
Copy-Item $pkgPath ($pkgPath + '.bak-' + $name) -Force
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
$link = 'link:' + ($dest -replace '\\', '/')
$pkg.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $link -Force
if (-not $pkg.dsh) { throw 'profile 的 package.json 没有 dsh 字段' }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains $name) { $pkg.dsh.profile.bundles = @($bundles + $name) }

$json = $pkg | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding $false))

$nm = Join-Path $profileDir 'node_modules'
$target = Join-Path $nm $name
if (Test-Path $target) { [IO.Directory]::Delete($target, $true) }
New-Item -ItemType Junction -Path $target -Target $dest | Out-Null

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '装好了。' -ForegroundColor Green
Write-Host '下一步：重启 DSH → 打开「知心画廊」→ 设置 → 点「一键安装」装刷Pixiv → 再重启一次 → 登录 pixiv 账号（token 或账号密码）。'
Write-Host '卸载：删掉 profile package.json 里的依赖与 bundles 条目，再删掉上面那个安装目录即可（数据目录可以留着）。'
Write-Host '改动清单（可核对）：profile/package.json（改前已备份）+ node_modules 里的一条目录联接 + 安装目录本身。' -ForegroundColor DarkGray
