/* 让路器（load governor）
 *
 * 主人 2026-11-15：他在 DSH 里做别的项目时，画廊跑一轮要主动让出一点机器和额度 ——
 * 最多降 30% 的调用速率，不许打断正在跑的轮次，也不许把「让路」变成常驻慢速。
 *
 * 判定只靠一件能真实观测到的事：$DSH_HOME/sessions 下**别的会话**最近还有没有在长。
 * 会话文件是 zstd 压缩的 JSONL，拿字节增长速率当 token 消耗的代理量（约 6 字节/token）。
 *
 * 规则（与主人定的口径一致）：
 *   - 有 ≥2 个别的会话在活跃 → 立刻 0.7（削 30%），不打断当前这一轮；
 *   - 只有 1 个别的会话 → 看它的速率：< 160 token/分 不动，超过就从 1.0 线性降到 0.7；
 *   - 谁都不在 → 1.0，全速。
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SESSION_ROOT = () => {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'sessions')
}
/* 多久没长过就算「不在跑」：DSH 里人打字/等模型时，会话文件不是每秒钟都在写 */
const ACTIVE_MS = 150_000
const BYTES_PER_TOKEN = 6
const FLOOR = 0.7
const MEMO_MS = 15_000

let memo = { at: 0, value: null }
let lastSnap = null // Map(path -> { size, at })

const walkSessions = (root) => {
  const out = []
  let level1 = []
  try { level1 = readdirSync(root) } catch { return out }
  for (const ws of level1) {
    const p1 = join(root, ws)
    let level2 = []
    try { level2 = readdirSync(p1) } catch { continue }
    for (const id of level2) {
      const dir = join(p1, id)
      for (const f of ['session.jsonl.zstd', 'session.jsonl']) {
        const file = join(dir, f)
        try {
          const s = statSync(file)
          out.push({ key: `${ws}/${id}`, file, size: s.size, mtime: s.mtimeMs })
          break
        } catch { /* 没有这个文件 */ }
      }
    }
  }
  return out
}

/** 采样一次：返回 { factor, others, burnPerMin, note, at } */
export function sampleLoad({ now = Date.now() } = {}) {
  if (memo.value && now - memo.at < MEMO_MS) return memo.value
  const files = walkSessions(SESSION_ROOT())
  const prev = lastSnap
  lastSnap = new Map(files.map((f) => [f.key, { size: f.size, at: now }]))
  if (!prev) {
    const idle = { factor: 1, others: 0, burnPerMin: 0, note: '第一次采样，按全速跑', at: now }
    memo = { at: now, value: idle }
    return idle
  }
  const busy = []
  const selfId = String(process.env.DSH_SESSION_ID || '')
  for (const f of files) {
    if (selfId && f.key.includes(selfId)) continue // 自己这一轮的写入不算「别人在忙」
    const before = prev.get(f.key)
    const grew = before ? Math.max(0, f.size - before.size) : 0
    const dtMin = before ? Math.max(0.05, (now - before.at) / 60_000) : 1
    if (now - f.mtime < ACTIVE_MS) busy.push({ key: f.key, burn: Math.round(grew / BYTES_PER_TOKEN / dtMin) })
  }
  /* 正在跑这一轮的那个会话自己也可能在长，但它不算「别人」——
     画廊自己的会话在跑一轮时也会写日志，所以把 burn 最高、且明显是本人的那份去掉。
     保守做法：只按「有几个在做别的事」计数，速率取其余中最高的。 */
  const others = busy.length
  const burnPerMin = busy.reduce((a, b) => Math.max(a, b.burn), 0)
  let factor = 1
  let note = '没有别的会话在跑，全速'
  if (others >= 2) {
    factor = FLOOR
    note = `有 ${others} 个会话同时在跑 → 削 30%`
  } else if (others === 1) {
    if (burnPerMin >= 160) {
      /* 160 token/分往上：越忙让得越多，最多到 0.7 */
      const k = Math.min(1, (burnPerMin - 160) / 1440)
      factor = Math.round((1 - (1 - FLOOR) * k) * 100) / 100
      note = `另一个会话在吃 ${burnPerMin} token/分 → 削 ${Math.round((1 - factor) * 100)}%`
    } else {
      note = `另一个会话很轻（${burnPerMin} token/分），不动`
    }
  }
  const value = { factor, others, burnPerMin, note, at: now }
  memo = { at: now, value }
  return value
}

/** 把一个基准并发按让路系数缩到整数（至少 3，别把一轮拖成一条线） */
export const applyFactor = (base, factor) => Math.max(3, Math.round(base * (Number(factor) || 1)))

/** 每次请求之间该多等多久（毫秒）：因子越低等得越久，但最多 +300ms */
export const paceDelay = (factor) => Math.round((1 / Math.max(FLOOR, Number(factor) || 1) - 1) * 700)
