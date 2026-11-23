/* 标签权重排序：BM25 风格（IDF + 词频饱和）+ 时间衰减 + 作者亲和 + 负反馈。
   参考并致谢：implicit（BPR/ALS 隐式反馈）、LightFM（元数据混合嵌入）、
   TagRec（标签推荐框架，含 FolkRank / 用户-物品 CF）。这里不引入依赖，只取可解释的轻量部分，
   默认关闭，由设置里的「优化算法提升」开关决定是否走这条路。 */

const norm = (x) => String(x == null ? '' : x).trim().toLowerCase()

export function namesOf(it) {
  const out = []
  const push = (t) => { const s = norm(t); if (s) out.push(s) }
  for (const t of (Array.isArray(it?.tags) ? it.tags : [])) {
    if (typeof t === 'string') push(t)
    else if (t && typeof t === 'object') { push(t.name); push(t.translation); push(t.translated) }
  }
  return Array.from(new Set(out))
}

/* 从作品库评分反推标签权重：均分 5.5 为中性，10 分约 +1，0 分约 -1。
   只统计有评分的作品，样本少的标签向 0 收缩，避免一张 10 分就把标签捧上天。 */
export function tagWeightsFromWorks(works = []) {
  const agg = new Map()
  for (const w of (Array.isArray(works) ? works : [])) {
    const score = Number(w?.userScore)
    if (!Number.isFinite(score)) continue
    for (const t of namesOf(w)) {
      const a = agg.get(t) || { sum: 0, n: 0 }
      a.sum += score; a.n += 1
      agg.set(t, a)
    }
  }
  const out = {}
  for (const [t, a] of agg) {
    const avg = a.sum / a.n
    const confidence = a.n / (a.n + 4)
    out[t] = Math.max(-1, Math.min(1, (avg - 5.5) / 4.5)) * confidence
  }
  return out
}

export function authorAffinityFromWorks(works = []) {
  const agg = new Map()
  for (const w of (Array.isArray(works) ? works : [])) {
    const score = Number(w?.userScore)
    const artist = norm(w?.artist || w?.artistName)
    if (!artist || !Number.isFinite(score)) continue
    const a = agg.get(artist) || { sum: 0, n: 0 }
    a.sum += score; a.n += 1
    agg.set(artist, a)
  }
  const out = {}
  for (const [k, a] of agg) out[k] = { avg: a.sum / a.n, n: a.n }
  return out
}

export function createRanker({
  candidates = [],
  tagWeights = {},
  blockTags = [],
  boostTags = [],
  targetTags = [],
  targetMode = 'and',
  mustTags = [],
  authorAffinity = {},
  halfLifeDays = 365,
} = {}) {
  const df = new Map()
  for (const it of candidates) for (const t of namesOf(it)) df.set(t, (df.get(t) || 0) + 1)
  const N = Math.max(1, candidates.length)
  const block = new Set((blockTags || []).map(norm).filter(Boolean))
  const boost = new Set((boostTags || []).map(norm).filter(Boolean))
  const target = [...new Set((targetTags || []).map(norm).filter(Boolean))]
  const must = [...new Set((mustTags || []).map(norm).filter(Boolean))]
  const idf = (t) => {
    const d = df.get(t) || 0
    return Math.log(1 + (N - d + 0.5) / (d + 0.5))
  }
  const hl = Math.max(7, Number(halfLifeDays) || 365)

  return function rank(it) {
    const names = namesOf(it)
    const set = new Set(names)
    let s = 0
    /* 词频饱和：同一标签重复出现不叠加；IDF 让稀有标签更有分量 */
    for (const t of names) {
      const w = Number(tagWeights[t]) || 0
      if (!w) continue
      const tf = 1
      s += w * (tf * (1.2 + 0.75)) / (tf + 0.75) * idf(t) * 9
    }
    for (const t of names) {
      if (boost.has(t)) s += 6 * (1 + idf(t))
      if (block.has(t)) s -= 34
    }
    if (target.length) {
      let hit = 0
      for (const t of target) if (set.has(t)) hit += 1
      s += targetMode === 'or' ? (hit > 0 ? 52 : -18) : (hit === target.length ? 52 : -18 - (target.length - hit) * 10)
    }
    if (must.length) s += must.some((t) => set.has(t)) ? 16 : -22
    const author = authorAffinity[norm(it.artist || it.artistName || it.author || '')]
    if (author) s += Math.min(26, Math.max(-18, (author.avg - 5.5) * 7)) * (author.n / (author.n + 2))
    const created = Date.parse(it.createDate || it.create_at || '')
    if (Number.isFinite(created)) {
      const days = Math.max(0, (Date.now() - created) / 86400000)
      s += 22 * Math.pow(0.5, days / hl)
    }
    // 热度只做轻微修正，避免高收藏老图把新鲜候选全压死
    s += Math.log10((Number(it.bookmarkCount) || 0) + 1) * 4
    return s
  }
}