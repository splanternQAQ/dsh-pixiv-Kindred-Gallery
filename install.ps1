# Pixiv 知心画廊 一键安装（Windows / PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -c "irm https://github.com/splanternQAQ/dsh-pixiv-Kindred-Gallery/raw/main/install.ps1 | iex"
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

$repo = 'splanternQAQ/dsh-pixiv-Kindred-Gallery'
$name = 'dsh-pixiv-kindred-gallery'
$zipPrefix = 'dsh-pixiv-Kindred-Gallery'
$destRoot = 'D:\Deepseek_Plugins'
if (-not (Test-Path 'D:\')) { $destRoot = Join-Path $env:USERPROFILE '.dsh\plugins' }
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

Write-Host "==> 下载 $repo" -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP ('pg-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'src.zip'
Get-FileWithRetry -Url "https://codeload.github.com/$repo/zip/refs/heads/main" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$srcDir = (Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like "$zipPrefix-*" } | Select-Object -First 1).FullName
if (-not $srcDir) { throw '解压后找不到源码目录' }

Write-Host "==> 安装到 $dest" -ForegroundColor Cyan
$bak = $null
if (Test-Path $dest) {
  $bak = $dest + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
  Move-Item $dest $bak
  Write-Host "   旧版本已备份到 $bak"
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
$dataHome = Join-Path $env:USERPROFILE '.dsh\dsh-pixiv-Kindred-Gallery'
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

Write-Host ''
Write-Host '装好了。' -ForegroundColor Green
Write-Host '下一步：重启 DSH → 打开「知心画廊」→ 设置 → 点「一键安装」装刷Pixiv → 再重启一次 → 登录 pixiv 账号（token 或账号密码）。'
Write-Host '卸载：删掉 profile package.json 里的依赖与 bundles 条目，再删目录即可。'
