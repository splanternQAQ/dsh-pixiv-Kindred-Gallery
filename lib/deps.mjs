/**
 * lib/deps.mjs —— 运行时找「刷Pixiv」插件和浏览器，不写死任何本机绝对路径
 * ============================================================================
 * 画廊要做两件借用别的组件的事：
 *   1. 调 dsh-pixiv-scroll 的 lib/picks.mjs 重渲染预览页
 *   2. 起 Playwright（来自 dsh-pixiv-scroll 的 node_modules）+ 本机 Chrome/Edge
 * 新用户的机器上这些位置全都不确定，所以按下面顺序找：
 *   · 环境变量显式指定（PIXIV_SCROLL_DIR / PIXIV_GALLERY_PLAYWRIGHT / PIXIV_GALLERY_CHROME）
 *   · $DSH_HOME/profiles/<profile>/node_modules/<包>（DSH 用 link: 装插件的标准位置）
 *   · 与本插件并排的兄弟目录（开发时都在 <plugins 根>/ 下）
 *   · $DSH_HOME/plugins/<包>
 * 找不到就返回空串，调用方给出人话错误，不要崩。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { PLUGIN_DIR, dshHome } from './paths.mjs'

const envOf = (k) => String(process.env[k] || '').trim()
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

function realPathOf(p) {
  try { return realpathSync(p) } catch { return p }
}

/** $DSH_HOME/profiles 下的每个 profile 目录 */
function profileDirs() {
  const out = []
  const root = join(dshHome(), 'profiles')
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(join(root, e.name))
    }
  } catch { /* 没有 profiles 目录（老版本） */ }
  return out
}

/** 返回第一个「是目录且含有 marker」的候选；marker 为空则只看目录存在 */
function firstHit(cands, marker) {
  for (const raw of cands) {
    const c = String(raw || '').trim()
    if (!c) continue
    const p = realPathOf(c)
    if (!isDir(p)) continue
    if (marker && !existsSync(join(p, marker))) continue
    return p
  }
  return ''
}

/** 「刷Pixiv」插件代码目录；找不到回空串 */
export function pixivScrollDir() {
  const cands = [envOf('PIXIV_SCROLL_DIR')]
  for (const p of profileDirs()) cands.push(join(p, 'node_modules', 'dsh-pixiv-scroll'))
  cands.push(join(dirname(PLUGIN_DIR), 'dsh-pixiv-scroll'))
  cands.push(join(dshHome(), 'plugins', 'dsh-pixiv-scroll'))
  return firstHit(cands, join('lib', 'picks.mjs'))
}

/** playwright-core 包目录；找不到回空串 */
export function playwrightCoreDir() {
  const cands = [envOf('PIXIV_GALLERY_PLAYWRIGHT')]
  const scroll = pixivScrollDir()
  if (scroll) cands.push(join(scroll, 'node_modules', 'playwright-core'))
  for (const p of profileDirs()) cands.push(join(p, 'node_modules', 'playwright-core'))
  cands.push(join(PLUGIN_DIR, 'node_modules', 'playwright-core'))
  return firstHit(cands, join('package.json'))
}

/** 「刷Pixiv」自己的 node_modules 里那份 playwright-core（账号密码登录实际用它） */
export function scrollPlaywrightDir() {
  const scroll = pixivScrollDir()
  return scroll ? firstHit([join(scroll, 'node_modules', 'playwright-core')], join('package.json')) : ''
}

/** 登录是否可用：刷Pixiv 自带优先；没有刷Pixiv 时看任意能找到的那份 */
export function loginPlaywrightStatus() {
  const scroll = pixivScrollDir()
  const own = scrollPlaywrightDir()
  const any = playwrightCoreDir()
  /* 浏览器登录只认刷Pixiv 自带的那份：装到画廊目录里，login-pixiv.mjs 也 import 不到 */
  return { ok: Boolean(scroll && own), dir: own || any, scroll, own: Boolean(own) }
}

function npmCmdLine(args) {
  const q = (x) => (/[\s"&^|<>]/.test(String(x)) ? '"' + String(x).replace(/"/g, '') + '"' : String(x))
  const local = process.platform === 'win32' ? join(dirname(process.execPath), 'npm.cmd') : ''
  const bin = local && existsSync(local) ? local : 'npm'
  return { bin, line: [bin, ...args].map(q).join(' ') }
}

/**
 * 补装 playwright-core。
 * 装在「刷Pixiv」目录里，那个插件的 `import('playwright-core')` 才找得到；
 * 只装到画廊自己目录里，账号密码登录仍然会报「没装 playwright-core」。
 */
export function installPlaywrightCore({ log = () => {} } = {}) {
  return new Promise((resolve) => {
    const scroll = pixivScrollDir()
    if (!scroll) return resolve({ ok: false, error: '没装刷Pixiv 插件，先装它再补登录组件', cwd: '', log: '' })
    const cwd = scroll
    const args = ['install', 'playwright-core@^1.61.1', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com']
    const { bin, line } = npmCmdLine(args)
    log('安装登录组件：' + line + '（cwd=' + cwd + '）')
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(line, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, error: '启动 npm 失败：' + String(e?.message ?? e), log: '', cwd })
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 300_000)
    child.stdout?.on('data', (d) => { out += String(d); if (out.length > 20000) out = out.slice(-20000) })
    child.stderr?.on('data', (d) => { err += String(d); if (err.length > 20000) err = err.slice(-20000) })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: 'npm 启动失败：' + String(e?.message ?? e), log: (out + err).slice(-4000), cwd, bin })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const st = loginPlaywrightStatus()
      const tail = (out + '\n' + err).trim().slice(-4000)
      if (st.ok) log('登录组件已就绪：' + st.dir)
      else log('登录组件安装失败（code ' + code + '）：' + tail.slice(-600))
      resolve({ ok: st.ok, code, dir: st.dir, cwd, bin, error: st.ok ? '' : '安装后仍找不到 playwright-core', log: tail })
    })
  })
}

/** 本机能用的 Chromium 内核浏览器（Chrome 优先，退回 Edge；再退回常见 Unix 路径） */
export function chromeExe() {
  const env = envOf('PIXIV_GALLERY_CHROME')
  if (env && existsSync(env)) return env
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const cands = []
  if (local) cands.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  cands.push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  cands.push(join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  for (const c of cands) {
    try { if (c && existsSync(c)) return c } catch { /* ignore */ }
  }
  return ''
}

/** 一次性结果，给日志用 */
export function depsSnapshot() {
  const scroll = pixivScrollDir()
  return {
    pixivScroll: scroll,
    picks: scroll ? join(scroll, 'lib', 'picks.mjs') : '',
    playwright: playwrightCoreDir(),
    chrome: chromeExe(),
  }
}
