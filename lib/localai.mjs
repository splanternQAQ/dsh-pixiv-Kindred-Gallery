/* 本地小模型润色：只做「文本 -> 文本」，不假装能看图。
   视觉模型先给出 style/highlight，这里再让本地模型把它们改写成更贴切的中文描述。
   默认不启用；端点/模型由设置里的「优化算法提升」弹窗配置。失败一律静默回退原文。 */

function cleanBase(u) {
  return String(u || '').trim().replace(/\/+$/, '')
}

export async function polishCaptions(items = [], { endpoint = '', model = '', timeoutMs = 45000, log = () => {} } = {}) {
  /* 一次最多润色 8 件：本机 qwen3-4b 实测 8 件约 30 秒，再多会明显拖慢本轮出图 */
  const list = (Array.isArray(items) ? items : []).filter((x) => x && x.id && (x.style || x.highlight)).slice(0, 8)
  const base = cleanBase(endpoint)
  if (!list.length || !base) return items
  const prompt = [
    '你是中文画作描述润色助手。输入是若干条作品解读，输出只保留更准确、更有画面感的中文描述。',
    '要求：style 8~24 字，写画风/笔触/上色/构图/光影；highlight 一句 20~45 字，只写画面里具体看得到的东西（人物、动作、服饰、场景、镜头），不要复述标签，不要编造原文没有的设定。',
    '保留原文已明确的人物关系、体型与服饰取向，不擅自净化、不说教、不加码；拿不准就写得更笼统。',
    '不改变 id，不增删条目，不输出解释或 Markdown。只返回 JSON 数组：[{"id":"...","style":"...","highlight":"..."}]',
    JSON.stringify(list.map((x) => ({ id: String(x.id), style: String(x.style || ''), highlight: String(x.highlight || '') }))),
  ].join('\n')
  let timer = null
  try {
    const ctl = new AbortController()
    timer = setTimeout(() => { try { ctl.abort() } catch { /* ignore */ } }, Math.max(3000, timeoutMs))
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ollama' },
      body: JSON.stringify({
        model: model || 'qwen3-4b-agent:latest',
        stream: false,
        temperature: 0.35,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctl.signal,
    })
    if (!r.ok) { log('本地润色：HTTP ' + r.status + '，保留原文'); return items }
    const j = await r.json().catch(() => null)
    const text = String(j?.choices?.[0]?.message?.content || '')
    const m = text.match(/\[[\s\S]*\]/)
    if (!m) { log('本地润色：返回里没有 JSON，保留原文'); return items }
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr)) return items
    const by = new Map(arr.map((x) => [String(x?.id || ''), x]))
    return items.map((x) => {
      const p = by.get(String(x.id))
      if (!p) return x
      const style = String(p.style || '').trim()
      const highlight = String(p.highlight || '').trim()
      return {
        ...x,
        style: style ? style.slice(0, 80) : x.style,
        highlight: highlight ? highlight.slice(0, 120) : x.highlight,
      }
    })
  } catch (e) {
    log('本地润色失败：' + String(e?.message ?? e).slice(0, 120) + '，保留原文')
    return items
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function localAiStatus({ endpoint = '', model = '' } = {}) {
  const base = cleanBase(endpoint) || 'http://127.0.0.1:11434/v1'
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => { try { ctl.abort() } catch { /* ignore */ } }, 3500)
    const r = await fetch(base + '/models', { signal: ctl.signal, headers: { authorization: 'Bearer ollama' } })
    clearTimeout(t)
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status }
    const j = await r.json().catch(() => null)
    const models = (j?.data || []).map((x) => String(x?.id || '')).filter(Boolean)
    return { ok: true, models, model: model || models[0] || '' }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}