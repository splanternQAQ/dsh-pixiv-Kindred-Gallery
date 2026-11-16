/**
 * 视觉调度枢纽（VisionHub）
 *
 * 画廊需要「能看图的模型」，但每台机器上能用的通路不一样。枢纽把这件事收成三条渠道：
 *   1) custom  —— 主人自己填的 OpenAI 兼容端点（第三方中转 / 本地 vLLM / 别的网关），跨机器最稳；
 *   2) gateway —— dsh-providers-hub 起的本机网关（默认 127.0.0.1:8326），凭证在 ~/.dsh/openai-gateway/api-key；
 *   3) host    —— DSH 宿主 llm 服务里支持图片输入的模型，最后底牌，不需要任何网关。
 *
 * 三条渠道各自记健康：某条失败就冷却一段时间，接着试下一条，而不是整轮判死。
 * 两条 lane（pick 精挑 / profile 画风）各自排队：精挑优先拿并发槽，画风不会把精挑堵死。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8326
const DEFAULT_GATEWAY_MODEL = 'deepseek-official/deepseek-flash'
const PROBE_TTL = 60 * 1000
const COOLDOWN = 3 * 60 * 1000
const MAX_CONCURRENCY = 4

/* ── 并发闸：pick 插队，profile 让路 ───────────────────────────── */
class SlotGate {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.queue = []
  }
  run(lane, fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ lane: lane === 'pick' ? 'pick' : 'profile', resolve, reject, fn })
      this._pump()
    })
  }
  _pump() {
    while (this.active < this.limit && this.queue.length) {
      let idx = this.queue.findIndex((x) => x.lane === 'pick')
      if (idx < 0) idx = 0
      const [item] = this.queue.splice(idx, 1)
      this.active += 1
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => { this.active -= 1; this._pump() })
    }
  }
}
const gate = new SlotGate(MAX_CONCURRENCY)

/* ── 健康状态 ─────────────────────────────────────────────────── */
const health = new Map() // key -> { until, error }
export function visionHealth() {
  const out = []
  for (const [key, v] of health) out.push({ key, cooling: v.until > Date.now(), error: v.error })
  return out
}
function markBad(key, err) {
  health.set(key, { until: Date.now() + COOLDOWN, error: String(err?.message ?? err).slice(0, 200) })
}
function cooling(key) {
  const v = health.get(key)
  return Boolean(v && v.until > Date.now())
}
const chanKey = (ch) => `${ch.kind}:${ch.model || ''}`

/* ── 网关探测 ─────────────────────────────────────────────────── */
let gwCache = { at: 0, info: null }

function gatewayKey() {
  const roots = []
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  roots.push(join(homedir(), '.dsh'))
  for (const r of roots) {
    const file = join(r, 'openai-gateway', 'api-key')
    try {
      if (existsSync(file)) {
        const key = readFileSync(file, 'utf8').trim()
        if (key) return key
      }
    } catch { /* 试下一个 */ }
  }
  return String(process.env.DSH_OPENAI_GATEWAY_KEY || '').trim()
}

function gatewayBase() {
  const env = String(process.env.DSH_OPENAI_GATEWAY_URL || '').trim()
  if (env) return env.replace(/\/+$/, '')
  const host = String(process.env.DSH_OPENAI_GATEWAY_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST
  const port = Number(process.env.DSH_OPENAI_GATEWAY_PORT || DEFAULT_PORT) || DEFAULT_PORT
  return `http://${host}:${port}`
}

function normalizeBase(raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base
  if (!/\/v\d+$/.test(base)) base += '/v1'
  return base
}

async function fetchJson(url, { headers = {}, timeoutMs = 2500, method = 'GET', body } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    const raw = await res.text()
    let json = null
    try { json = raw ? JSON.parse(raw) : null } catch { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, raw, json }
  } finally { clearTimeout(timer) }
}

function modelIds(json) {
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  return list.map((m) => String(m?.id || m?.model || m?.name || '')).filter(Boolean)
}

/** 拉一次某个 OpenAI 兼容端点的模型清单，给设置页挑具体模型用 */
export async function listVisionModels({ base = '', key = '', config = {} } = {}) {
  const raw = String(base || config.visionBaseUrl || '').trim()
  let useKey = String(key || config.visionApiKey || '').trim()
  if (!raw) return { ok: false, base: '', models: [], error: '还没填端点地址' }
  const b = normalizeBase(raw)
  // 填的就是本机网关、又没单独给密钥：借用网关自己的 api-key（设置页留空时本来就是这个语义）
  if (!useKey && b === normalizeBase(gatewayBase())) useKey = gatewayKey()
  try {
    const r = await fetchJson(`${b}/models`, {
      headers: useKey ? { authorization: `Bearer ${useKey}` } : {},
      timeoutMs: 8000,
    })
    const models = modelIds(r.json).sort()
    if (r.status === 401 || r.status === 403) {
      return { ok: false, base: b, models: [], error: '密钥无效，或者这家不给列模型' }
    }
    if (!models.length) {
      return { ok: false, base: b, models: [], error: `没拿到模型清单（HTTP ${r.status}）；有些服务商不开放 /models，手填也行` }
    }
    return { ok: true, base: b, models, count: models.length }
  } catch (e) {
    return { ok: false, base: b, models: [], error: `连不上：${String(e?.message ?? e).slice(0, 120)}` }
  }
}

/** 网关活着吗：能连上 /v1/models 就算活（key 缺失但端点开放也认） */
export async function probeGateway({ force = false } = {}) {
  if (!force && gwCache.at && Date.now() - gwCache.at < PROBE_TTL) return gwCache.info
  const base = normalizeBase(gatewayBase())
  const key = gatewayKey()
  let info = null
  try {
    const r = await fetchJson(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, timeoutMs: 1800 })
    const models = modelIds(r.json)
    if (r.ok || models.length || (r.status === 401 && key)) {
      info = { ok: true, base, key, models, status: r.status }
    } else {
      info = { ok: false, base, key, models: [], status: r.status, error: `HTTP ${r.status}` }
    }
  } catch (e) {
    info = { ok: false, base, key, models: [], error: String(e?.message ?? e).slice(0, 120) }
  }
  gwCache = { at: Date.now(), info }
  return info
}

/** 挑模型：先认主人指定的，再按「deepseek flash → 视觉模型 → 通用」排 */
export function pickModel(models, prefer = '') {
  const ids = (models || []).filter(Boolean)
  if (prefer) return prefer
  const rank = (m) => {
    if (/deepseek.*flash/i.test(m)) return 0
    if (/vision|nemotron.*vl|-vl[-_]|\bvl\b|omni|4\.6v|\b5v\b|glm-.*v[-_]/i.test(m)) return 1
    if (/gemini|claude|gpt-4o|gpt-5/i.test(m)) return 2
    if (/flash|turbo|mini/i.test(m)) return 3
    if (/pro/i.test(m)) return 4
    return 6
  }
  return ids.slice().sort((a, b) => rank(a) - rank(b))[0] || ''
}

/* ── 协议适配：Responses / Chat Completions ───────────────────── */
function toResponsesInput(messages) {
  return (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: Array.isArray(m.content)
      ? m.content.map((part) => {
        if (part.type === 'image') {
          return { type: 'input_image', image_url: `data:${part.source?.media_type || 'image/jpeg'};base64,${part.source?.data || ''}` }
        }
        if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url || String(part.image_url || '') }
        return { type: 'input_text', text: String(part.text || '') }
      })
      : [{ type: 'input_text', text: String(m.content || '') }],
  }))
}

function toChatMessages(system, messages) {
  const out = []
  if (system) out.push({ role: 'system', content: String(system) })
  for (const m of messages || []) {
    if (!Array.isArray(m.content)) { out.push({ role: m.role || 'user', content: String(m.content || '') }); continue }
    out.push({
      role: m.role || 'user',
      content: m.content.map((part) => {
        if (part.type === 'image') {
          return { type: 'image_url', image_url: { url: `data:${part.source?.media_type || 'image/jpeg'};base64,${part.source?.data || ''}` } }
        }
        if (part.type === 'image_url') return { type: 'image_url', image_url: typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url }
        return { type: 'text', text: String(part.text || '') }
      }),
    })
  }
  return out
}

function parseResponses(json) {
  const out = []
  for (const item of json?.output || []) for (const c of item?.content || []) if (c?.type === 'output_text' && c.text) out.push(c.text)
  if (!out.length && json?.output_text) out.push(json.output_text)
  return out.join('').trim()
}

function parseChat(json) {
  const msg = json?.choices?.[0]?.message
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content.trim()
  if (Array.isArray(msg.content)) return msg.content.map((c) => String(c?.text || '')).join('').trim()
  return ''
}

/** 先 Responses（providers-hub / 部分中转支持），不行再 Chat Completions（第三方更普适） */
async function callEndpoint({ base, key, model, system, messages, maxTokens, timeoutMs }) {
  const headers = key ? { authorization: `Bearer ${key}` } : {}
  const errs = []
  try {
    const body = { model, input: toResponsesInput(messages), max_output_tokens: maxTokens || 1600 }
    if (system) body.instructions = String(system)
    const r = await fetchJson(`${base}/responses`, { method: 'POST', headers, body, timeoutMs })
    if (r.ok) {
      const text = parseResponses(r.json || {})
      if (text) return text
      errs.push('Responses 返回空文本')
    } else {
      errs.push(`Responses HTTP ${r.status}：${String(r.raw || '').slice(0, 120)}`)
    }
  } catch (e) { errs.push('Responses ' + String(e?.message ?? e).slice(0, 100)) }
  try {
    const body = {
      model,
      messages: toChatMessages(system, messages),
      max_tokens: maxTokens || 1600,
      temperature: 0.2,
    }
    const r = await fetchJson(`${base}/chat/completions`, { method: 'POST', headers, body, timeoutMs })
    if (r.ok) {
      const text = parseChat(r.json || {})
      if (text) return text
      errs.push('Chat 返回空文本')
    } else {
      errs.push(`Chat HTTP ${r.status}：${String(r.raw || '').slice(0, 120)}`)
    }
  } catch (e) { errs.push('Chat ' + String(e?.message ?? e).slice(0, 100)) }
  throw new Error(errs.join('；'))
}

/** 宿主 llm 只认附件引用（{type:'image', attachment:{attachmentId,…}}），不认 base64 source。
 *  这里先把图登记成附件，再交给 stream——否则整条宿主通路一调就是 finish.reason.kind='error'。 */
async function toHostMessages(messages, attachments) {
  const need = (messages || []).some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image'))
  if (!need) return messages
  if (!attachments?.saveImages) {
    throw new Error('宿主通道要把图片登记成附件，但当前拿不到 ctx.attachments（DSH 版本不带附件服务）')
  }
  return Promise.all((messages || []).map(async (m) => {
    if (!Array.isArray(m?.content)) return m
    const content = await Promise.all(m.content.map(async (p) => {
      if (p?.type !== 'image') return p
      const src = p.source?.type === 'base64' ? p.source : null
      if (!src?.data) return p
      const mediaType = String(src.media_type || src.mediaType || 'image/jpeg')
      const ref = (await attachments.saveImages([{ data: Buffer.from(src.data, 'base64'), mediaType }]))[0]
      if (!ref) throw new Error('图片登记失败（附件服务没有返回 id）')
      return { type: 'image', attachment: ref }
    }))
    return { ...m, content }
  }))
}

/** 宿主 llm 流式兜底：不需要任何网关 */
async function callHost({ llm, provider, model, system, messages, maxTokens, timeoutMs, attachments = null }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const brief = (x) => {
    if (!x) return ''
    if (typeof x === 'string') return x.slice(0, 200)
    /* 宿主 stream 的真正原因藏在 reason.failure 里（{message, code, status}）；
       只看 message/error/kind 会永远得到一个字面上的 "error"。 */
    const f = x.failure || x.reason?.failure
    if (f && typeof f === 'object') {
      const bits = [String(f.message || '').trim()]
      if (f.code) bits.push(`[${f.code}]`)
      if (f.status) bits.push(`HTTP ${f.status}`)
      const t = bits.filter(Boolean).join(' ').trim()
      if (t) return t.slice(0, 240)
    }
    const t = String(x.message || x.error || x.kind || '')
    if (t) return t.slice(0, 200)
    try { return JSON.stringify(x).slice(0, 240) } catch { return String(x).slice(0, 200) }
  }
  const runOnce = async (budget, slim = false) => {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    let text = ''
    let finish = ''
    try {
      /* slim：有些宿主的 stream 不接受 temperature / maxTokens / signal，带上就整个报 error。
         第一次按完整参数试，报错就换精简参数再来一遍。 */
      const req = slim
        ? { provider, model, system, messages: msgs }
        : { provider, model, system, messages: msgs, temperature: 0.2, maxTokens: budget, signal: ac.signal }
      const stream = llm.stream(req)
      for await (const ch of stream) {
        if (!ch) continue
        if (ch.type === 'text-delta' && ch.text) text += ch.text
        else if (ch.type === 'block-end' && ch.block?.type === 'text' && ch.block.text) text += ch.block.text
        else if (ch.type === 'error') throw new Error('宿主模型报错：' + (brief(ch.error) || brief(ch.message) || '无说明'))
        else if (ch.type === 'finish') {
          finish = String(ch.reason?.kind || '')
          if (ch.reason?.kind === 'error') throw new Error('宿主模型结束于错误：' + (brief(ch.reason) || '无说明'))
        }
      }
    } finally { clearTimeout(t) }
    return { text: text.trim(), finish }
  }
  clearTimeout(timer)
  const msgs = await toHostMessages(messages, attachments)
  let first
  try {
    first = await runOnce(maxTokens)
  } catch (e) {
    const msg = String(e?.message ?? e)
    // 带参数的请求整个失败：换精简参数再试一次，成功了就当这条通路其实没问题
    const slim = await runOnce(maxTokens, true)
    if (slim.text) return slim.text
    throw new Error(`${msg}（精简参数重试后仍是空：${slim.finish || '未知'}）`)
  }
  if (first.text) return first.text
  // 空手 = 这一趟白跑。多半是思考把预算吃光了（宿主模型的 reasoning 也算进 max tokens），加倍再来一次。
  const bigger = Math.max(Math.round(maxTokens * 2), 4096)
  const second = await runOnce(bigger)
  if (second.text) return second.text
  throw new Error(`宿主模型空手返回（结束原因 ${first.finish || '未知'}；预算 ${maxTokens}→${bigger} token，正文仍是空的）`)
}

/* ── 渠道解析 ─────────────────────────────────────────────────── */
/** 宿主清单的排序：先 DeepSeek 的 flash，再明确是视觉模型的，再其它，pro 垫底 */
const hostRank = (x) => {
  const m = String(x?.model || '')
  const deep = /^(deepseek-official|deepseek-account|deepseek-api-key)$/.test(String(x?.provider || ''))
  if (deep && /deepseek-flash/i.test(m)) return 0
  if (/vision|nemotron.*vl|-vl[-_]|\bvl\b|omni|4\.6v|\b5v\b|glm-.*v[-_]/i.test(m)) return 1
  if (deep) return 2
  if (/flash|turbo|mini/i.test(m)) return 3
  if (/pro/i.test(m)) return 5
  return 4
}

/**
 * 把宿主那一个「排名第一的模型」摊成整张订阅清单。
 * 当前选中的那个永远排最前（主人要的「落到当前模型」），后面按能力排序，最多 7 个。
 */
export function hostModels(host) {
  if (!host?.llm) return []
  const out = []
  const seen = new Set()
  const push = (provider, model, label) => {
    const p = String(provider || '')
    const m = String(model || '')
    if (!p || !m) return
    const key = `${p}/${m}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ provider: p, model: m, label })
  }
  push(host.provider, host.model, 'DSH 宿主（当前模型）')
  const all = Array.isArray(host.all) ? [...host.all] : []
  all.sort((a, b) => hostRank(a) - hostRank(b))
  for (const x of all.slice(0, 6)) push(x.provider, x.model, 'DSH 宿主')
  return out
}

/**
 * 按优先级排出这次可用的视觉渠道。host 传 { llm, provider, model, all?, attachments? } 或 null。
 * 返回 { ok, channels:[{kind,label,base?,key?,model,llm?,provider?}], error? }
 */
export async function resolveVision({ config = {}, host = null, force = false, only = '' } = {}) {
  const chain = []
  const customRaw = String(config.visionBaseUrl || '').trim()
  if (customRaw) {
    const base = normalizeBase(customRaw)
    const key = String(config.visionApiKey || '').trim()
    let models = []
    try {
      const r = await fetchJson(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, timeoutMs: 2000 })
      if (r.json) models = modelIds(r.json)
    } catch { /* 端点不一定实现 /models，照试 */ }
    chain.push({
      kind: 'custom',
      label: '自定义端点',
      base,
      key,
      model: pickModel(models, String(config.visionModel || '').trim()) || String(config.visionModel || '').trim(),
    })
  }
  const gw = only && only !== 'gateway' ? null : await probeGateway({ force })
  if (gw?.ok) {
    const prefer = /^[\w.-]+\/[\w.:-]+$/.test(String(config.visionModel || '').trim()) ? String(config.visionModel).trim() : ''
    chain.push({ kind: 'gateway', label: '本机网关', base: normalizeBase(gw.base), key: gw.key, model: pickModel(gw.models, prefer) || DEFAULT_GATEWAY_MODEL })
  }
  if (!only || only === 'host') {
    /* 宿主不是「一个模型」，而是用户在 DSH 里登录的整张订阅清单。
       直接拿排名第一的去试，等于把运气押在一次调用上：那个模型可能声称支持图片、
       实际只回一句「未知」（deepseek-v4-pro 就是这样）。这里把清单按能力排好顺序
       全部挂上去，一条失败就换下一个，最后才轮到名字里带 pro 的那类。 */
    for (const h of hostModels(host)) {
      chain.push({
        kind: 'host',
        label: h.label || 'DSH 宿主',
        llm: host.llm,
        provider: h.provider,
        model: h.model,
        attachments: host.attachments || null,
      })
    }
  }
  if (only) {
    const keep = chain.filter((c) => c.kind === only)
    if (keep.length) return { ok: true, channels: keep }
  }
  if (!chain.length) {
    return {
      ok: false,
      channels: [],
      error: '没有任何可用的视觉通路：没有填自定义端点、本机网关没起来、宿主也没有支持图片的模型',
    }
  }
  // 冷却中的渠道排到后面，而不是丢掉 —— 三条都冷却时仍然按顺序尝试一次
  const fresh = chain.filter((c) => !cooling(chanKey(c)))
  const coolingOnes = chain.filter((c) => cooling(chanKey(c)))
  return { ok: true, channels: [...fresh, ...coolingOnes] }
}

/**
 * 真正干活：按渠道顺序试，成功即返回。
 * 返回 { text, channel, model, label }；全失败抛错。
 */
export async function visionCall({ config = {}, host = null, lane = 'pick', system, messages, maxTokens = 1600, timeoutMs = 100000, log = () => {}, force = false, only = '' } = {}) {
  const plan = await resolveVision({ config, host, force, only })
  if (!plan.ok) throw new Error(plan.error)
  // 设置页的「强度」只调预算：快速省额度、仔细给模型更多余量写完长结论
  const EFFORT = { fast: 0.6, normal: 1, deep: 1.7 }
  const budget = Math.max(400, Math.round(maxTokens * (EFFORT[String(config.visionEffort || 'normal')] || 1)))
  const errs = []
  for (const ch of plan.channels) {
    try {
      const text = await gate.run(lane, () => (ch.kind === 'host'
        ? callHost({ ...ch, system, messages, maxTokens: budget, timeoutMs })
        : callEndpoint({ ...ch, system, messages, maxTokens: budget, timeoutMs })))
      if (!text) throw new Error('返回空文本')
      return { text, channel: ch.kind, model: String(ch.model || ''), label: ch.label }
    } catch (e) {
      const msg = String(e?.message ?? e)
      // 4xx 多半是这张图或这条请求本身不合规（声明的类型对不上字节、尺寸超限、参数错），
      // 不该把整条渠道打进 3 分钟冷却——否则一张坏图就会让后面的精挑全部降级。
      if (!/HTTP 4\d\d/.test(msg)) markBad(chanKey(ch), e)
      errs.push(`${ch.label}（${ch.model || '默认模型'}）：${String(e?.message ?? e).slice(0, 160)}`)
      log(`画廊视觉：${ch.label}不可用，换下一条通路`)
    }
  }
  throw new Error('所有视觉通路都失败：' + errs.join(' / '))
}

/** 给设置页看的自检信息 */
/* ── 本机网关的「装没装」检测：只是推荐项，不是依赖 ─────────────── */
export function hubInfo() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dirs = []
  try {
    for (const prof of readdirSync(join(home, 'profiles'))) dirs.push(join(home, 'profiles', prof, 'node_modules', 'dsh-providers-hub'))
  } catch { /* 没有 profiles 目录 */ }
  dirs.push(join(home, 'node_modules', 'dsh-providers-hub'))
  for (const dir of dirs) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (!String(pkg?.name || '').includes('providers-hub')) continue
      return { installed: true, version: String(pkg.version || ''), dir, name: String(pkg.name || '') }
    } catch { /* 这一处没有 */ }
  }
  return { installed: false, version: '', dir: '', name: '' }
}

/* 一张 64×64 纯红 PNG：只问「什么颜色」，用来验一个模型到底看不看得见图。
   实测 deepseek-flash 会答「红色」，deepseek-v4-pro 会答「未知」——后者收图但不识图。 */
const PROBE_IMG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAnklEQVRoge2SUQkAQBSDFsL+yRbmQtyHPBgYwMlSOE10g24AesXuQtwlukE3AL1idyHuEt2gG4BesbsQd4lu0A1Ar9hdiLtEN+gGoFfsLsRdoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX/OEBqsVA8fklJaUAAAAASUVORK5CYII='
const CAP_TTL = 5 * 60 * 1000
const capCache = new Map()

/** 拿纯色图问一次颜色：答对＝真识图；答「未知/无法」或空手＝不识图 */
async function askProbeColor({ config, host, kind, timeoutMs = 25000 }) {
  const t0 = Date.now()
  const got = await visionCall({
    config,
    host,
    only: kind,
    lane: 'profile',
    force: true,
    maxTokens: 400,
    timeoutMs,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PROBE_IMG_B64 } },
        { type: 'text', text: '这张图整体是什么颜色？只回一个颜色名，不要解释。' },
      ],
    }],
  })
  const answer = String(got.text || '').trim()
  const sees = /红|red|crimson|scarlet/i.test(answer) && !/未知|unknown|无法|不能|看不清/.test(answer)
  return { kind, model: got.model, ok: sees, ms: Date.now() - t0, answer: answer.slice(0, 40) }
}

/**
 * 跑轮前的能力体检：这条链上到底有没有一个真能看图的模型。
 * 三个渠道各试一次（自定义端点 → 本机网关 → 宿主），第一个答对颜色就算 ready。
 * 结果缓存 5 分钟，`force` 破缓存。
 */
export async function probeVision({ config = {}, host = null, force = false } = {}) {
  const key = [String(config.visionBaseUrl || ''), String(config.visionModel || ''), String(host?.provider || ''), String(host?.model || '')].join('|')
  const hit = capCache.get(key)
  if (!force && hit && Date.now() - hit.at < CAP_TTL) return hit.value
  const plan = await resolveVision({ config, host, force })
  if (!plan.ok) {
    const value = { ready: false, reason: plan.error || '没有可用的视觉通路', checks: [] }
    capCache.set(key, { at: Date.now(), value })
    return value
  }
  const kinds = [...new Set(plan.channels.map((c) => c.kind))]
  const checks = []
  for (const kind of kinds) {
    try {
      const r = await askProbeColor({ config, host, kind })
      checks.push(r)
      if (r.ok) {
        const value = { ready: true, via: kind, model: r.model, checks }
        capCache.set(key, { at: Date.now(), value })
        return value
      }
    } catch (e) {
      checks.push({ kind, model: (plan.channels.find((c) => c.kind === kind) || {}).model || '', ok: false, error: String(e?.message ?? e).slice(0, 160) })
    }
  }
  const value = { ready: false, reason: '所有通路都试过了，没有一个能看图', checks }
  capCache.set(key, { at: Date.now(), value })
  return value
}

export async function visionStatus({ config = {}, host = null } = {}) {  const gw = await probeGateway({ force: true })
  const plan = await resolveVision({ config, host })
  return {
    gateway: gw ? { ok: Boolean(gw.ok), base: gw.base, hasKey: Boolean(gw.key), models: (gw.models || []).length, error: gw.error || '' } : null,
    hub: hubInfo(),
    custom: String(config.visionBaseUrl || '').trim() ? { base: normalizeBase(config.visionBaseUrl), model: String(config.visionModel || '') } : null,
    host: host?.model ? `${host.provider}/${host.model}` : '',
    channels: (plan.channels || []).map((c) => ({ kind: c.kind, label: c.label, model: c.model, cooling: cooling(chanKey(c)) })),
    error: plan.ok ? '' : plan.error,
    health: visionHealth(),
  }
}
