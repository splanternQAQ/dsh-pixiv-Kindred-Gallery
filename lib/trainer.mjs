/**
 * lib/trainer.mjs —— 画廊数据 与 本机炼图（ComfyUI）之间的桥
 * ============================================================================
 * 目标：把作品库里评过分的作品，整理成三家 SDXL 系底模（Illustrious XL /
 * NoobAI-XL / Animagine XL）都能直接读的数据，并提供一条
 * 「丢进去 -> 画出来 -> 反图落回作品库」的通路。
 *
 * 三条通路：
 *   1 数据集导出：<gallery>/train-bridge/dataset/{images,captions,manifest.json}
 *     给 LoRA 训练 / 参考集 / 提示词对照表用。
 *   2 投递箱：<gallery>/train-bridge/inbox/<slug>.png + .txt + .json
 *     任何炼图脚本读它就能直接出图（含完整 prompt 与参数）。
 *   3 回收箱：outbox/ 与设置里的「炼图反图文件夹」
 *     读出图里的 prompt/seed/model，收进作品库（allwork），并回填标签。
 * ============================================================================
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'

import { allworkOf, libraryAdd, listLibrary } from './gallery.mjs'

export const TRAIN_PROTOCOL = 'dsh-pixiv-train-bridge/1'

/* ------------------------- 标签分组（姿势/动作/装饰…） ------------------------- */

const BUCKET_WORDS = {
  pose: ['立ち', '座り', '寝そべり', '立膝', '四つ這い', '正座', 'あぐら', '横座り', 'うつ伏せ', '仰向け',
    'sitting', 'standing', 'lying', 'kneeling', 'squatting', 'on back', 'on stomach', 'all fours', 'seiza',
    'wariza', 'crossed legs', 'legs together', 'legs apart', 'leaning forward', 'arched back', 'contrapposto',
    'cowboy shot', 'portrait', 'upper body', 'lower body', 'full body', 'from above', 'from below',
    'from behind', 'from side', 'dutch angle', 'foreshortening', 'profile', '背中', '俯瞰', '煽り'],
  action: ['走り', 'ジャンプ', '飛び', '抱き', 'キス', '飲み', '食べ', '踊り', '歌', '寝', '起き', '伸び',
    'walking', 'running', 'jumping', 'hugging', 'kiss', 'kissing', 'dancing', 'singing', 'sleeping',
    'stretching', 'holding', 'hand up', 'arms up', 'arms behind back', 'hands on hips', 'crossed arms',
    'covering mouth', 'covering face', 'pointing', 'waving', 'eating', 'drinking', 'smoking',
    'looking at viewer', 'looking away', 'looking back', 'looking down', 'looking up', 'eye contact'],
  decoration: ['リボン', '花', '蝶', '羽', 'ハート', '星', 'ステッカー', 'ヘッドホン', 'イヤリング',
    'ネックレス', 'チョーカー', '帽子', 'ベール', 'しっぽ', '角', '翼', 'halo', 'ribbon', 'bow', 'flower',
    'butterfly', 'feather', 'heart', 'star', 'sticker', 'headphones', 'earrings', 'necklace', 'choker',
    'hat', 'veil', 'tail', 'horn', 'wings', 'hair ornament', 'hairclip', 'bandaid', 'bandage', 'glasses',
    'hairband', 'crown', 'garter', 'frills', 'lace', 'jewelry'],
  clothing: ['白タイツ', '黒タイツ', 'ニーソ', '水着', '制服', 'セーラー服', '浴衣', '着物', 'ドレス',
    'メイド', 'ナース', 'チャイナ', '下着', 'パンツ', 'スカート', 'ワンピース', 'コート', '手袋',
    'thighhighs', 'pantyhose', 'swimsuit', 'bikini', 'school uniform', 'serafuku', 'yukata', 'kimono',
    'dress', 'maid', 'nurse', 'china dress', 'underwear', 'panties', 'skirt', 'one-piece', 'coat',
    'gloves', 'boots', 'high heels', 'socks', 'shirt', 'hoodie', 'apron', 'leotard', 'bodysuit'],
  expression: ['笑顔', '泣き', '照れ', '怒り', '悲しみ', '驚き', 'smile', 'crying', 'blush', 'angry',
    'sad', 'surprised', 'expressionless', 'open mouth', 'closed mouth', 'teeth', 'tongue out',
    'half-closed eyes', 'closed eyes', 'one eye closed', 'smug', 'embarrassed', 'pout', 'grin'],
  scene: ['屋外', '室内', '海', '空', '夜景', '風', '雨', '雪', '森', '街', '部屋', 'ベッド', 'お風呂',
    'outdoors', 'indoors', 'ocean', 'sky', 'night', 'wind', 'rain', 'snow', 'forest', 'city', 'bedroom',
    'bed', 'bath', 'onsen', 'beach', 'classroom', 'school', 'window', 'curtains', 'scenery', 'sunlight',
    'backlighting', 'cloud', 'water'],
  style: ['モノクロ', '水彩', '厚塗り', 'アニメ塗り', '線画', '劇画', 'ドット', 'レトロ', 'monochrome',
    'watercolor', 'thick painting', 'flat color', 'lineart', 'sketch', 'retro', 'pixel art',
    'greyscale', 'sepia', 'impasto', 'chibi', 'realistic'],
}

const NORMALIZED = new Map()
for (const [bucket, words] of Object.entries(BUCKET_WORDS)) {
  for (const w of words) {
    const k = String(w).toLowerCase().replace(/[_\s]+/g, '')
    if (!NORMALIZED.has(k)) NORMALIZED.set(k, bucket)
  }
}

export function bucketOf(tag) {
  const k = String(tag || '').toLowerCase().replace(/[_\s]+/g, '')
  if (!k) return 'other'
  if (NORMALIZED.has(k)) return NORMALIZED.get(k)
  for (const [word, bucket] of NORMALIZED) {
    if (word.length >= 4 && (k.includes(word) || word.includes(k))) return bucket
  }
  return 'other'
}

/** 把一串标签分桶；返回 {pose,action,decoration,clothing,expression,scene,style,other} */
export function groupTags(tags = []) {
  const out = { pose: [], action: [], decoration: [], clothing: [], expression: [], scene: [], style: [], other: [] }
  for (const raw of tags) {
    const t = String(typeof raw === 'string' ? raw : (raw?.name || raw?.translated || '')).trim()
    if (!t) continue
    const b = bucketOf(t)
    if (!out[b].includes(t)) out[b].push(t)
  }
  return out
}

/* ------------------------- 底模档案 ------------------------- */

export const MODEL_PROFILES = {
  illustrious: {
    label: 'Illustrious XL',
    family: 'SDXL',
    qualityPrefix: [],
    qualitySuffix: ['masterpiece', 'best quality', 'very aesthetic', 'absurdres'],
    negative: 'worst quality, comic, multiple views, bad quality, low quality, lowres, displeasing, very displeasing, bad anatomy, bad hands, scan artifacts, monochrome, greyscale, signature, twitter username, jpeg artifacts, 2koma, 4koma, guro, extra digits, fewer digits',
    size: [832, 1216],
    steps: 28, cfg: 6.5, sampler: 'Euler a', scheduler: 'normal', clipSkip: 1,
    artistFormat: 'plain',
    rating: 'danbooru',
    order: ['subject', 'character', 'series', 'artist', 'rating', 'appearance', 'clothing', 'pose', 'action', 'expression', 'decoration', 'scene', 'composition', 'style', 'nsfw'],
    notes: 'danbooru 原生标签，前 20 token 权重最高：主体和质量块靠前；画师写裸名；权重 (tag:1.2)。',
  },
  noobai: {
    label: 'NoobAI-XL',
    family: 'SDXL',
    qualityPrefix: ['masterpiece', 'best quality', 'newest', 'absurdres', 'highres'],
    qualitySuffix: [],
    negative: 'nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro',
    size: [832, 1216],
    steps: 28, cfg: 5.5, sampler: 'Euler a', scheduler: 'normal', clipSkip: 1,
    artistFormat: 'prefix',
    rating: 'danbooru',
    order: ['subject', 'character', 'series', 'artist', 'rating', 'style', 'appearance', 'clothing', 'pose', 'action', 'expression', 'decoration', 'scene', 'composition', 'nsfw'],
    notes: '质量词与年份词放最前，画师必须 artist:name 并且带下划线；v-pred 版改 Euler + cfg 4.5 + steps 30。',
  },
  animagine: {
    label: 'Animagine XL',
    family: 'SDXL',
    qualityPrefix: [],
    qualitySuffix: ['masterpiece', 'high score', 'great score', 'absurdres'],
    negative: 'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry',
    size: [1024, 1024],
    steps: 28, cfg: 5, sampler: 'Euler a', scheduler: 'normal', clipSkip: 1,
    artistFormat: 'plain',
    rating: 'animagine',
    order: ['subject', 'character', 'series', 'rating', 'artist', 'appearance', 'clothing', 'pose', 'action', 'expression', 'decoration', 'scene', 'composition', 'style', 'nsfw'],
    notes: '质量词必须放结尾、画师靠前，否则画师标签被压掉；分级只认 safe/sensitive/nsfw/explicit。',
  },
}

/* 常用标签归一：pixiv 的日文标签 -> danbooru 英文（够用的一批，不求全覆盖） */
const TAG_EN = {
  '女の子': '1girl', '女の子一人': 'solo', '白タイツ': 'white thighhighs', '黒タイツ': 'black pantyhose',
  'ニーソ': 'thighhighs', 'ニーハイ': 'thighhighs', '水着': 'swimsuit', 'スク水': 'school swimsuit',
  'ビキニ': 'bikini', '制服': 'school uniform', 'セーラー服': 'serafuku', '浴衣': 'yukata',
  '着物': 'kimono', 'ドレス': 'dress', 'メイド': 'maid', 'ナース': 'nurse', 'チャイナ': 'china dress',
  '下着': 'underwear', 'パンツ': 'panties', 'スカート': 'skirt', 'ワンピース': 'one-piece dress',
  '手袋': 'gloves', '笑顔': 'smile', '泣き': 'crying', '照れ': 'blush', '怒り': 'angry',
  '悲しみ': 'sad', '驚き': 'surprised', '屋外': 'outdoors', '室内': 'indoors', '海': 'ocean',
  '空': 'sky', '夜景': 'night', '雨': 'rain', '雪': 'snow', '森': 'forest', '街': 'city',
  '部屋': 'room', 'ベッド': 'bed', 'お風呂': 'bath', '立ち': 'standing', '座り': 'sitting',
  '寝そべり': 'lying', '立膝': 'knees up', '四つ這い': 'all fours', 'モノクロ': 'monochrome',
  '水彩': 'watercolor', '厚塗り': 'thick painting', '線画': 'lineart', 'リボン': 'ribbon',
  '花': 'flower', '羽': 'feather', 'ハート': 'heart', '星': 'star', 'ヘッドホン': 'headphones',
  'イヤリング': 'earrings', 'ネックレス': 'necklace', '帽子': 'hat', 'しっぽ': 'tail',
  '角': 'horn', '翼': 'wings', 'ロリ': 'loli', '足裏': 'feet', '足指': 'toes', '狐耳': 'fox ears',
  '猫耳': 'cat ears', 'ケモミミ': 'animal ears', 'オリジナル': 'original',
  'おへそ': 'navel', 'へそ': 'navel', '貧乳': 'flat chest', '巨乳': 'large breasts', '腋': 'armpit',
  '腋見せ': 'armpits', 'マイクロビキニ': 'micro bikini', 'メスガキ': 'mesugaki', '幼女': 'loli',
  'ツインテール': 'twintails', 'ポニーテール': 'ponytail', 'ショートヘア': 'short hair', '長髪': 'long hair',
  '黒髪': 'black hair', '白髪': 'white hair', '金髪': 'blonde hair', '銀髪': 'silver hair',
  '赤目': 'red eyes', '青目': 'blue eyes', '碧眼': 'blue eyes', '瞳': 'eyes', '涙': 'tears',
  '汗': 'sweat', '涎': 'saliva', '舌': 'tongue', 'キス': 'kiss', '抱擁': 'hug', '見つめ合い': 'eye contact',
  '見上げ': 'looking up', '見下ろし': 'looking down', '横顔': 'profile', '後ろ姿': 'from behind',
  '振り向き': 'looking back', '手を振る': 'waving', '歩き': 'walking', '走り': 'running',
  'ジャンプ': 'jumping', '飛び跳ね': 'jumping', 'しゃがみ': 'squatting', '正座': 'seiza', 'あぐら': 'indian style',
  'うつ伏せ': 'on stomach', '仰向け': 'on back', '片膝立ち': 'kneeling', '土下座': 'dogeza',
  'ニーソックス': 'thighhighs', 'ストッキング': 'stockings', 'ガーター': 'garter straps',
  'ブーツ': 'boots', 'ハイヒール': 'high heels', '裸足': 'barefoot', '足': 'feet', '脚': 'legs',
  '太もも': 'thighs', 'スカートめくり': 'skirt lift', '胸': 'breasts', '胸元': 'cleavage',
  'へそ出し': 'midriff', '背中': 'back', '鎖骨': 'collarbone', '首輪': 'collar', 'チョーカー': 'choker',
  'ピアス': 'earrings', '眼鏡': 'glasses', 'マスク': 'mask', 'リボン': 'ribbon', 'カチューシャ': 'headband',
  'ヘアピン': 'hairpin', '花冠': 'flower wreath', '髪飾り': 'hair ornament', '日傘': 'parasol',
  '剣': 'sword', '銃': 'gun', '本': 'book', '傘': 'umbrella', '花束': 'bouquet', 'ケーキ': 'cake',
  '桜': 'cherry blossoms', '紅葉': 'autumn leaves', '海辺': 'beach', '砂浜': 'beach', '夕日': 'sunset',
  '朝焼け': 'sunrise', '星空': 'starry sky', '月': 'moon', '雲': 'clouds', '虹': 'rainbow',
  '教室': 'classroom', '学校': 'school', '図書館': 'library', 'カフェ': 'cafe', '神社': 'shrine',
  '和室': 'japanese room', '縁側': 'engawa', '畳': 'tatami', '銭湯': 'bathhouse', 'プール': 'pool',
  '水': 'water', '泡': 'bubbles', '光': 'light', '影': 'shadow', '逆光': 'backlighting',
  'アニメ塗り': 'anime coloring', '水彩風': 'watercolor (medium)', '油絵': 'oil painting (medium)',
  '鉛筆': 'pencil (medium)', 'ドット絵': 'pixel art', '背景なし': 'simple background', '白背景': 'white background',
}

export const isAsciiTag = (t) => /^[\x20-\x7e]+$/.test(String(t || ''))

export function toDanbooru(tag) {
  const t = String(tag || '').trim()
  if (!t) return ''
  const hit = TAG_EN[t] || TAG_EN[t.toLowerCase()]
  const out = hit || t
  return out.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

/* ------------------------- 路径 ------------------------- */

export function bridgePaths(pixivHome) {
  const root = join(pixivHome, 'train-bridge')
  return {
    root,
    readme: join(root, 'README.md'),
    iface: join(root, 'interface.json'),
    models: join(root, 'models.json'),
    dataset: join(root, 'dataset'),
    images: join(root, 'dataset', 'images'),
    captions: join(root, 'dataset', 'captions'),
    manifest: join(root, 'dataset', 'manifest.json'),
    tags: join(root, 'dataset', 'tags.json'),
    inbox: join(root, 'inbox'),
    outbox: join(root, 'outbox'),
    script: join(root, 'comfy_bridge.py'),
  }
}

export function safeFile(s, max = 80) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max) || 'work'
}

/** 作品首图绝对路径（files 里存的是文件名，要拼上作品目录） */
function absOf(work) {
  const f = (work?.files && work.files[0]) || work?.cover || ''
  if (!f) return ''
  return isAbsolute(f) ? f : join(String(work?.dir || ''), String(f))
}

function readJsonSafe(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

/* ------------------------- PNG 文本块读写 ------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 读 PNG 的 tEXt / iTXt / zTXt（zTXt 只取压缩标记，不 inflate） */
export function readPngText(buf) {
  const out = {}
  if (!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return out
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const start = off + 8
    if (start + len > buf.length) break
    if (type === 'tEXt') {
      const chunk = buf.subarray(start, start + len)
      const z = chunk.indexOf(0)
      if (z > 0) out[chunk.toString('latin1', 0, z)] = chunk.toString('latin1', z + 1)
    } else if (type === 'iTXt') {
      const chunk = buf.subarray(start, start + len)
      const z = chunk.indexOf(0)
      if (z > 0) {
        const key = chunk.toString('latin1', 0, z)
        let p = z + 1
        const compressed = chunk[p] === 1
        p += 2
        const langEnd = chunk.indexOf(0, p)
        const transEnd = langEnd >= 0 ? chunk.indexOf(0, langEnd + 1) : -1
        if (transEnd >= 0 && !compressed) {
          try { out[key] = chunk.subarray(transEnd + 1).toString('utf8') } catch { /* ignore */ }
        }
      }
    } else if (type === 'IEND') break
    off = start + len + 4
  }
  return out
}

/** 往 PNG 里塞 tEXt（同名 key 先删掉；返回新 Buffer） */
export function writePngText(buf, entries) {
  if (!buf || buf.readUInt32BE(0) !== 0x89504e47) return buf
  const drop = new Set(Object.keys(entries || {}))
  const chunks = []
  let off = 8
  let iendAt = -1
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const total = 12 + len
    const slice = buf.subarray(off, off + total)
    if (type === 'IEND') { iendAt = off; break }
    if (type === 'tEXt') {
      const z = slice.subarray(8, 8 + len).indexOf(0)
      if (z > 0 && drop.has(slice.toString('latin1', 8, 8 + z))) { off += total; continue }
    }
    chunks.push(slice)
    off += total
  }
  if (iendAt < 0) return buf
  const extra = []
  for (const [key, value] of Object.entries(entries || {})) {
    const text = String(value)
    const latin1 = /^[\u0000-\u00ff]*$/.test(text)
    const type = latin1 ? 'tEXt' : 'iTXt'
    const payload = latin1
      ? Buffer.concat([Buffer.from(String(key), 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])
      : Buffer.concat([Buffer.from(String(key), 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, 'utf8')])
    const head = Buffer.alloc(8)
    head.writeUInt32BE(payload.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), payload])), 0)
    extra.push(Buffer.concat([head, payload, crc]))
  }
  return Buffer.concat([buf.subarray(0, 8), ...chunks, ...extra, buf.subarray(iendAt)])
}

/* ------------------------- 生成参数解析（反图用） ------------------------- */

const RE_PARAM = /\s*(\w[\w \-/]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)/g

function unquote(v) {
  const s = String(v || '').trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s) } catch { return s.slice(1, -1) }
  }
  return s
}

/** A1111 的 infotext -> 结构化（复刻官方四步：末行至少三个 K: v 才算参数行） */
export function parseA1111(raw) {
  const s = String(raw || '').replace(/\r\n?/g, '\n').trim()
  if (!s) return { prompt: '', negative: '', extra: {} }
  const lines = s.split('\n')
  let last = lines.length > 1 ? lines.pop() : ''
  if (last) {
    const hits = String(last).match(RE_PARAM) || []
    if (hits.length < 3) { lines.push(last); last = '' }
  }
  let prompt = ''
  let negative = ''
  let inNeg = false
  for (const line of lines) {
    if (!inNeg && line.trim().startsWith('Negative prompt:')) {
      inNeg = true
      negative += (negative ? '\n' : '') + line.trim().slice('Negative prompt:'.length).trim()
      continue
    }
    if (inNeg) negative += (negative ? '\n' : '') + line
    else prompt += (prompt ? '\n' : '') + line
  }
  const out = { prompt: prompt.trim(), negative: negative.trim(), extra: {} }
  if (last) {
    RE_PARAM.lastIndex = 0
    let m
    while ((m = RE_PARAM.exec(last))) {
      const k = m[1].trim().toLowerCase().replace(/\s+/g, '_')
      const v = unquote(m[2])
      if (!k) continue
      if (k === 'size') {
        const mm = String(v).match(/^(\d+)x(\d+)$/)
        if (mm) { out.width = Number(mm[1]); out.height = Number(mm[2]) }
        out.extra.size = String(v)
      } else out[k] = v
    }
  }
  if (out.steps) out.steps = Number(out.steps) || out.steps
  if (out.cfg_scale) out.cfg = Number(out.cfg_scale) || out.cfg_scale
  if (out.seed !== undefined) out.seed = String(out.seed)
  return out
}

const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string'

/** 从节点图里回溯一段文本（透传节点继续往上） */
function textOf(nodes, ref, depth = 0, seen = new Set()) {
  if (!isLink(ref) || depth > 64) return ''
  const id = String(ref[0])
  if (seen.has(id)) return ''
  seen.add(id)
  const n = nodes[id]
  if (!n) return ''
  const ins = n.inputs || {}
  for (const key of ['text', 'text_g', 'text_l', 'value', 'string', 'text_a', 'text_b']) {
    const v = ins[key]
    if (typeof v === 'string' && v.trim()) return v
    if (isLink(v)) {
      const up = textOf(nodes, v, depth + 1, seen)
      if (up) return up
    }
  }
  for (const key of ['conditioning', 'conditioning_1', 'conditioning_2', 'positive', 'negative']) {
    const v = ins[key]
    if (isLink(v)) {
      const up = textOf(nodes, v, depth + 1, seen)
      if (up) return up
    }
  }
  return ''
}

/** 顺着 SaveImage -> VAEDecode -> latent_image 找到真正生效的采样器 */
function findSampler(nodes) {
  const ids = Object.keys(nodes || {})
  const starts = ids.filter((id) => /^(SaveImage|PreviewImage|SaveImageWebp)$/.test(String(nodes[id]?.class_type || '')))
  const walk = (id, depth, seen) => {
    if (!id || depth > 40 || seen.has(id)) return null
    seen.add(id)
    const n = nodes[id]
    if (!n) return null
    const ct = String(n.class_type || '')
    if (/^KSampler|^SamplerCustom/.test(ct)) return n
    for (const v of Object.values(n.inputs || {})) {
      if (isLink(v)) {
        const hit = walk(String(v[0]), depth + 1, seen)
        if (hit) return hit
      }
    }
    return null
  }
  for (const s of starts) {
    const hit = walk(s, 0, new Set())
    if (hit) return hit
  }
  const any = ids.map((id) => nodes[id]).find((n) => /^KSampler|^SamplerCustom/.test(String(n?.class_type || '')))
  return any || null
}

/** ComfyUI 的 prompt（API 图）-> 生效的正负提示词与参数 */
export function fromComfyGraph(graph) {
  const nodes = graph && typeof graph === 'object' ? graph : {}
  const ks = findSampler(nodes)
  const ins = ks?.inputs || {}
  const positive = textOf(nodes, ins.positive) || textOf(nodes, ins.guider)
  const negative = textOf(nodes, ins.negative)
  let model = ''
  const modelRef = ins.model || ins.unet
  if (isLink(modelRef)) {
    let cur = String(modelRef[0])
    for (let d = 0; d < 24 && cur; d++) {
      const n = nodes[cur]
      if (!n) break
      const ni = n.inputs || {}
      const ck = String(ni.ckpt_name || ni.unet_name || '')
      if (ck) { model = ck.replace(/\.(safetensors|ckpt|gguf)$/i, ''); break }
      const up = ni.model || ni.unet
      cur = isLink(up) ? String(up[0]) : ''
    }
  }
  if (!model) {
    const ck = Object.values(nodes).map((n) => n?.inputs?.ckpt_name).find(Boolean)
    if (ck) model = String(ck).replace(/\.(safetensors|ckpt)$/i, '')
  }
  let width = 0
  let height = 0
  const lat = ins.latent_image
  if (isLink(lat)) {
    const n = nodes[String(lat[0])]
    width = Number(n?.inputs?.width) || 0
    height = Number(n?.inputs?.height) || 0
  }
  return {
    prompt: Array.isArray(positive) ? positive.join(', ') : String(positive || ''),
    negative: Array.isArray(negative) ? negative.join(', ') : String(negative || ''),
    seed: ins.seed !== undefined ? String(ins.seed) : (ins.noise_seed !== undefined ? String(ins.noise_seed) : undefined),
    steps: ins.steps === undefined ? undefined : Number(ins.steps),
    cfg: ins.cfg === undefined ? undefined : Number(ins.cfg),
    sampler: ins.sampler_name, scheduler: ins.scheduler, denoise: ins.denoise,
    model, width, height,
  }
}

/** 解析任意生成图的元数据；返回 {source, prompt, negative, ...} */
export function parseGenMeta(buf) {
  const txt = readPngText(buf)
  const out = { source: '', prompt: '', negative: '', extra: {}, raw: txt }
  const params = txt.parameters
  if (params) {
    const looksJson = /^\s*\{/.test(params)
    if (looksJson) {
      try {
        const g = JSON.parse(params)
        Object.assign(out, fromComfyGraph(g), { source: 'comfyui' })
        return out
      } catch { /* 落回 infotext */ }
    }
    Object.assign(out, parseA1111(params), { source: 'a1111' })
    return out
  }
  const graphRaw = txt.prompt || txt.workflow
  if (graphRaw) {
    try {
      const g = JSON.parse(graphRaw)
      if (g && g.nodes && g.links) out.workflowOnly = true
      Object.assign(out, fromComfyGraph(g), { source: 'comfyui' })
      return out
    } catch { /* 落到下面 */ }
  }
  if (txt.Comment) {
    try {
      const j = JSON.parse(txt.Comment)
      const v4 = j?.v4_prompt?.caption?.base_caption
      out.prompt = String(v4 || j.prompt || j.caption || '')
      out.negative = String(j?.v4_negative_prompt?.caption?.base_caption || j.uc || j.negative_prompt || '')
      out.seed = j.seed !== undefined ? String(j.seed) : undefined
      out.steps = j.steps; out.cfg = j.scale; out.sampler = j.sampler
      out.source = 'novelai'
      return out
    } catch { /* ignore */ }
  }
  if (txt.Description) { out.prompt = String(txt.Description); out.source = 'novelai' }
  else if (txt.Software) out.source = 'text'
  return out
}

/* ------------------------- 提示词组装 ------------------------- */

const COMPOSITION_WORDS = new Set(['upper body', 'cowboy shot', 'full body', 'close-up', 'from above', 'from below', 'from side', 'dutch angle', 'portrait', 'feet out of frame'])
const DROP_TAGS = new Set(['comic', 'multiple views', '2koma', '4koma', 'guro'])
const R18_TAG = /^(r-?18|r-?18g|adult|nsfw|explicit)$/i

const escapeParens = (t) => String(t).replace(/(^|[^\\])\(/g, '$1\\(').replace(/(^|[^\\])\)/g, '$1\\)')

const RATING_WORD = {
  danbooru: { all: 'general', r18: 'nsfw', r18g: 'explicit' },
  animagine: { all: 'safe', r18: 'nsfw', r18g: 'explicit', sensitive: 'sensitive', questionable: 'nsfw' },
}

const scoreWord = (score, profile) => {
  const s = Number(score) || 0
  if (profile?.rating === 'animagine') return s >= 10 ? 'very aesthetic, great score' : s >= 9 ? 'high score' : s >= 8 ? 'good score' : ''
  return s >= 9 ? 'very aesthetic' : s >= 8 ? 'aesthetic' : s >= 7 ? 'good composition' : ''
}

/**
 * 把一件作品整理成某家底模的 prompt。
 * 归一 → 去噪 → 分桶 → 按该底模的官方顺序拼装（质量词前置或结尾）。
 */
export function promptForWork(work, modelKey = 'illustrious', opts = {}) {
  const profile = opts.profile || MODEL_PROFILES[modelKey] || MODEL_PROFILES.illustrious
  const raw = [...new Set([...(work?.tagKeys || []), ...(work?.tags || [])].map(toDanbooru).filter(Boolean))]
  const restrict = String(work?.restrict || 'all')
  const ratingKey = restrict === 'r18g' ? 'r18g' : restrict === 'r18' ? 'r18' : 'all'
  const tags = raw.filter((t) => !R18_TAG.test(t) && !DROP_TAGS.has(t) && !/^\d+users入り$/.test(t) && isAsciiTag(t))
  const g = groupTags(tags)
  const subject = []
  if (!tags.some((t) => /^(1girl|1boy|2girls|multiple girls)$/.test(t))) subject.push('1girl')
  if (!tags.includes('solo')) subject.push('solo')
  const artistName = work?.artist ? String(work.artist).trim().toLowerCase() : ''
  const artist = artistName
    ? profile.artistFormat === 'prefix' ? 'artist:' + artistName.replace(/\s+/g, '_') : artistName
    : ''
  const composition = []
  const pose = []
  for (const t of g.pose) (COMPOSITION_WORDS.has(t) ? composition : pose).push(t)
  const scene = []
  for (const t of g.scene) if (COMPOSITION_WORDS.has(t)) { if (!composition.length) composition.push(t) } else scene.push(t)
  const appearance = g.other.filter((t) => !COMPOSITION_WORDS.has(t)).slice(0, 8)
  const table = RATING_WORD[profile.rating] || RATING_WORD.danbooru
  const fields = {
    subject,
    character: [],
    series: [],
    artist: artist ? [artist] : [],
    rating: [table[ratingKey] || table.all],
    appearance,
    clothing: g.clothing,
    pose,
    action: g.action,
    expression: g.expression,
    decoration: g.decoration,
    scene,
    composition: composition.slice(0, 1),
    style: g.style,
    nsfw: ratingKey === 'all' ? [] : [],
  }
  const seq = []
  const seen = new Set()
  for (const key of profile.order || []) for (const t of fields[key] || []) {
    if (!t || seen.has(t)) continue
    seen.add(t)
    seq.push(t)
  }
  const quality = [...(profile.qualityPrefix || []), ...(profile.qualitySuffix || [])]
  const head = profile.qualityPrefix || []
  const tail = profile.qualitySuffix || []
  const sw = scoreWord(work?.userScore, profile)
  const bits = [...head, ...seq, ...String(sw).split(',').map((x) => x.trim()), ...tail]
    .filter((x, i, arr) => x && arr.indexOf(x) === i)
  const positive = bits.map((x) => escapeParens(String(x || '').trim())).filter(Boolean).join(', ').replace(/\s*,\s*,+/g, ', ')
  const warnings = []
  if (!artist) warnings.push('作品没有画师名，画风不可复现')
  if (ratingKey !== 'all' && profile.rating === 'animagine' && !tags.includes('nsfw')) warnings.push('R-18 作品在 Animagine 上用 nsfw 代替 danbooru 分级词')
  return {
    model: modelKey,
    label: profile.label,
    positive,
    negative: profile.negative,
    rating: ratingKey,
    params: {
      width: profile.size[0], height: profile.size[1],
      steps: profile.steps, cfg: profile.cfg, sampler: profile.sampler,
      scheduler: profile.scheduler, clipSkip: profile.clipSkip,
    },
    grouped: g,
    quality,
    warnings,
  }
}

export const COMFY_BRIDGE_PY = String.raw`#!/usr/bin/env python3
"""画廊数据直连炼图 —— 最小桥脚本（纯标准库，无第三方依赖）。

用法：
  python comfy_bridge.py            # 扫一遍 inbox/，逐件提交给本机 ComfyUI
  python comfy_bridge.py --watch    # 长驻，每 2 秒扫一次
  python comfy_bridge.py --serve 8790   # 起个 HTTP 服务，POST / 收 job spec

约定：
  inbox/<slug>.json   job spec（唯一权威参数源）
  inbox/<slug>.png    img2img 的原图（可选；txt2img 只给 json 也行）
  outbox/             结果平铺落盘，画廊的「收批出图」会扫这里并自动入库
"""

import json, os, sys, time, uuid, random, shutil, mimetypes, urllib.request, urllib.parse
from pathlib import Path

HOME = Path(__file__).resolve().parent
IF = json.loads((HOME / "interface.json").read_text("utf-8"))
INBOX = Path(IF["paths"]["inbox"])
OUTBOX = Path(IF["paths"]["outbox"])
COMFY = IF["comfyui"]["base"].rstrip("/")
CLIENT = str(uuid.uuid4())

SAMPLER = {"euler a": "euler_ancestral", "euler": "euler", "dpm++ 2m": "dpmpp_2m",
           "dpm++ sde": "dpmpp_sde", "ddim": "ddim", "lcm": "lcm"}
SCHED = {"normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"}


def call(path, body=None, ctype=None, raw=False, timeout=60):
    req = urllib.request.Request(COMFY + path, data=body,
                                 headers={"Content-Type": ctype} if ctype else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except urllib.error.URLError as e:
        raise RuntimeError("连不上 ComfyUI（%s）：先启动 python main.py --listen 127.0.0.1 --port 8188" % e.reason)
    return data if raw else json.loads(data or b"{}")


def ckpt_for(want):
    info = call("/object_info/CheckpointLoaderSimple")
    lst = info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
    if want in lst:
        return want
    stem = Path(want).stem.lower()
    for n in lst:
        if Path(n).stem.lower() == stem or stem in n.lower():
            return n
    raise RuntimeError("checkpoint 不在 ComfyUI 的模型列表里：%s（现有 %s）" % (want, ", ".join(lst[:8])))


def upload(p):
    b = "----b" + uuid.uuid4().hex
    body = ('--%s\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
            '--%s\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n') % (b, b)
    body = body.encode()
    body += ('--%s\r\nContent-Disposition: form-data; name="image"; filename="%s"\r\n'
             'Content-Type: %s\r\n\r\n') % (b, p.name, mimetypes.guess_type(p.name)[0] or "image/png")
    body = body.encode() + p.read_bytes() + ('\r\n--%s--\r\n' % b).encode()
    r = call("/upload/image", body, "multipart/form-data; boundary=" + b)
    return (r["subfolder"] + "/" if r.get("subfolder") else "") + r["name"]


def graph(spec, ckpt, image=None, seed=None):
    p = spec.get("params") or {}
    seed = seed or random.randint(1, 2**31 - 1)
    g = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text": spec.get("positive", "")}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text": spec.get("negative", "")}},
        "3": {"class_type": "KSampler", "inputs": {
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0],
            "seed": seed, "steps": int(p.get("steps", 28)), "cfg": float(p.get("cfg", 5)),
            "sampler_name": SAMPLER.get(str(p.get("sampler", "")).lower(), "euler_ancestral"),
            "scheduler": p.get("scheduler") if p.get("scheduler") in SCHED else "normal",
            "denoise": float(spec.get("denoise", 1.0 if not image else 0.6))}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": spec["slug"], "images": ["8", 0]}},
    }
    if int(p.get("clipSkip") or 0) > 1:
        g["10"] = {"class_type": "CLIPSetLastLayer", "inputs": {"clip": ["4", 1], "stop_at_clip_layer": -int(p["clipSkip"])}}
        g["6"]["inputs"]["clip"] = g["7"]["inputs"]["clip"] = ["10", 0]
    if image:
        g["11"] = {"class_type": "LoadImage", "inputs": {"image": image}}
        g["12"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["4", 2]}}
        g["3"]["inputs"]["latent_image"] = ["12", 0]
    else:
        g["5"] = {"class_type": "EmptyLatentImage", "inputs": {
            "width": int(p.get("width", 832)), "height": int(p.get("height", 1216)), "batch_size": 1}}
    return g, seed


def run(spec, src=None, timeout=900):
    ck = ckpt_for(spec.get("model") or "illustrious.safetensors")
    g, seed = graph(spec, ck, upload(src) if src else None)
    body = json.dumps({"prompt": g, "client_id": CLIENT}).encode()
    try:
        pid = call("/prompt", body, "application/json")["prompt_id"]
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError("提交失败（多半是节点参数不合法）：%s" % e)
    t0 = time.time()
    hist = {}
    while time.time() - t0 < timeout:
        hist = call("/history/" + pid).get(pid)
        if hist and hist.get("status", {}).get("completed"):
            break
        time.sleep(1)
    else:
        raise TimeoutError("等待出图超时：" + pid)
    OUTBOX.mkdir(parents=True, exist_ok=True)
    out = []
    for o in (hist.get("outputs") or {}).values():
        for i in o.get("images", []):
            q = urllib.parse.urlencode({"filename": i["filename"], "subfolder": i.get("subfolder", ""),
                                        "type": i.get("type", "output")})
            dst = OUTBOX / ("%s_%s_%s" % (spec["slug"], seed, i["filename"]))
            dst.write_bytes(call("/view?" + q, raw=True))
            out.append(str(dst))
    (OUTBOX / ("%s_%s.json" % (spec["slug"], seed))).write_text(json.dumps({
        "protocol": IF["protocol"], "job": spec["slug"], "prompt_id": pid, "seed": seed,
        "checkpoint": ck, "images": out, "graph": g}, ensure_ascii=False, indent=2), "utf-8")
    return out


def do_file(js):
    try:
        spec = json.loads(js.read_text("utf-8"))
        src = next((js.with_suffix(e) for e in (".png", ".jpg", ".jpeg", ".webp") if js.with_suffix(e).exists()), None)
        print("ok", spec["slug"], run(spec, src))
        js.rename(js.with_name(js.stem + ".done.json"))
    except Exception as e:
        fail = INBOX / "failed"
        fail.mkdir(parents=True, exist_ok=True)
        shutil.move(str(js), str(fail / js.name))
        (fail / (js.stem + ".error.txt")).write_text(str(e), "utf-8")
        print("fail", js.name, e)


if __name__ == "__main__":
    if "--serve" in sys.argv:
        from http.server import BaseHTTPRequestHandler, HTTPServer
        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    r = {"ok": True, "images": run(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))}
                except Exception as e:
                    r = {"ok": False, "error": str(e)}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(r, ensure_ascii=False).encode())
        port = int(sys.argv[sys.argv.index("--serve") + 1])
        print("bridge http://127.0.0.1:%d" % port)
        HTTPServer(("127.0.0.1", port), H).serve_forever()
    elif "--watch" in sys.argv:
        seen = set()
        while True:
            for js in sorted(INBOX.glob("*.json")):
                if js.name not in seen:
                    seen.add(js.name)
                    do_file(js)
            time.sleep(2)
    else:
        for js in sorted(INBOX.glob("*.json")):
            do_file(js)
`

/* ------------------------- 桥接目录与文件 ------------------------- */

const README_LINES = [
  '# 画廊数据直连炼图（train-bridge）',
  '',
  '这整个目录由「知心画廊」自动维护。它是画廊和本机炼图模型之间的唯一交接点：',
  '画廊把整理好的数据写在这里，炼图工具读这里；画出来的图丢回去，画廊自动收进作品库。',
  '',
  '## 目录',
  '',
  '| 路径 | 是什么 |',
  '| --- | --- |',
  '| dataset/images/ | 导出的高分作品原图（按画师分组，方便练画风） |',
  '| dataset/captions/ | 同名 .txt，danbooru 风格标签，直接喂 LoRA 训练 |',
  '| dataset/manifest.json | 每件作品的分数、标签分桶、三套底模的 prompt 与参数 |',
  '| dataset/tags.json | 标签频次与分数统计（姿势/动作/装饰/服装/表情/场景/画风） |',
  '| inbox/ | 投递箱：<名字>.png + .txt + .json，炼图脚本读它即可出图 |',
  '| outbox/ | 回收箱：出图落这里，画廊自动解析 prompt/seed/模型并入库 |',
  '| interface.json | 机器读的协议定义（路径、字段、模型档案、端点） |',
  '| models.json | 三家底模的参数档案，可手改 |',
  '| comfy_bridge.py | 可选的最小脚本：把 inbox 里的一件作品提交给本机 ComfyUI |',
  '',
  '## 两种用法',
  '',
  '1. 让 DSH 帮你接：在画廊里点「画廊数据直连炼图」，把下面这句发给 DSH ——',
  '   读取 __IFACE__ 里的协议，把 inbox 投给本机 ComfyUI（127.0.0.1:8188），出图写回 outbox。',
  '2. 手动：把 inbox 里 .json 的 positive / negative / params 抄进 ComfyUI，出图另存到 outbox',
  '   （或在设置 -> 下载相关里指定「炼图反图文件夹」），再点一次「回收出图」。',
  '',
  '## 反图落回',
  '',
  '画廊读图时会解析 PNG 的 parameters（A1111）或 prompt / workflow（ComfyUI），',
  '所以出图带着元数据回来时，种子、模型、提示词、步数都能一起回来，标签按提示词自动补。',
  '',
  '__COMFY__',
  '',
]

const COMFY_LINES = [
  '## 本机 ComfyUI 的接口（给 DSH 或脚本用）',
  '',
  '- POST /prompt  {"prompt": <api graph>, "client_id": "<任意字符串>"}',
  '- GET  /history/{prompt_id}  ->  outputs.*.images[].filename',
  '- GET  /object_info  查可用节点与模型文件名',
  '- POST /upload/image  上传图片到 input 目录',
  '- WS   /ws?clientId=<id>  事件：executing / progress',
  '',
  'api graph 的节点形如 {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {...}}}，',
  '连线写成 ["上游节点id", 输出序号]。UI 保存的 workflow（有 nodes/links）要先转成这个格式。',
]

function readmeText(p) {
  return README_LINES.join('\n').replace('__IFACE__', p.iface) + COMFY_LINES.join('\n') + '\n'
}

function interfaceJson(p, state, home) {
  return {
    protocol: TRAIN_PROTOCOL,
    generatedAt: new Date().toISOString(),
    galleryHome: home || p.root,
    paths: {
      dataset: p.dataset, images: p.images, captions: p.captions,
      manifest: p.manifest, tags: p.tags, models: p.models,
      inbox: p.inbox, outbox: p.outbox,
      genDropDir: String(state?.config?.genDropDir || ''),
    },
    models: MODEL_PROFILES,
    captionFormat: 'danbooru 标签，逗号分隔，小写，空格代替下划线；不含质量词（训练用）',
    manifestSchema: {
      name: '作品目录名', id: 'pixiv id', title: '标题', artist: '画师', score: '0-10',
      restrict: 'all|r18|r18g', pages: '页数',
      image: 'dataset/images 下的文件名', caption: 'dataset/captions 下的文件名',
      tags: '原始标签', grouped: 'pose/action/decoration/clothing/expression/scene/style/other',
      prompts: 'illustrious / noobai / animagine 各一套 {positive,negative,params}',
    },
    endpoints: {
      status: 'GET /train/status',
      export: 'POST /train/export {minScore,tags,mode,limit,includeR18,perArtist}',
      drop: 'POST /train/drop {names:[], model}',
      ingest: 'POST /train/ingest {limit, genDropDir}',
      config: 'POST /train/config {genDropDir}',
    },
    comfyui: {
      base: 'http://127.0.0.1:8188',
      prompt: 'POST /prompt {prompt:<api graph>, client_id}',
      history: 'GET /history/{prompt_id}',
      objectInfo: 'GET /object_info',
      upload: 'POST /upload/image',
      ws: '/ws?clientId=<id>',
    },
    dshHint: '把 interface.json 的路径交给 DSH，让它把 inbox 投给 ComfyUI，并把 outbox 的图回收进画廊。',
  }
}

export function ensureBridge(pixivHome, state) {
  const p = bridgePaths(pixivHome)
  for (const d of [p.root, p.dataset, p.images, p.captions, p.inbox, p.outbox]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
  }
  try { writeFileSync(p.readme, readmeText(p), 'utf8') } catch { /* ignore */ }
  try { writeFileSync(p.iface, JSON.stringify(interfaceJson(p, state, pixivHome), null, 2), 'utf8') } catch { /* ignore */ }
  try { writeFileSync(p.script, COMFY_BRIDGE_PY, 'utf8') } catch { /* ignore */ }
  try {
    const cur = readJsonSafe(p.models, null)
    if (!cur || typeof cur !== 'object' || !cur.illustrious || !cur.illustrious.qualityPrefix || !cur.illustrious.order) writeFileSync(p.models, JSON.stringify(MODEL_PROFILES, null, 2), 'utf8')
  } catch { /* ignore */ }
  return p
}

/* ------------------------- 选片、导出 ------------------------- */

function pickWorks(pixivHome, state, opts = {}) {
  const lib = listLibrary(pixivHome, state)
  const works = Array.isArray(lib?.works) ? lib.works : []
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 7
  const tagList = Array.isArray(opts.tags) ? opts.tags.map((t) => String(t).trim()).filter(Boolean) : []
  const mode = String(opts.mode || 'any').toLowerCase() === 'and' ? 'and' : 'any'
  const includeR18 = opts.includeR18 !== false
  const perArtist = Math.max(0, Math.min(200, Number(opts.perArtist) || 0))
  let picked = works.filter((w) => Number.isFinite(Number(w.userScore)) && Number(w.userScore) >= minScore)
  if (!includeR18) picked = picked.filter((w) => String(w.restrict || 'all') === 'all')
  if (tagList.length) {
    picked = picked.filter((w) => {
      const keys = [...new Set([...(w.tagKeys || []), ...(w.tags || [])].map((t) => String(t).toLowerCase()))]
      const hit = tagList.filter((t) => keys.some((k) => k === t.toLowerCase() || k.includes(t.toLowerCase())))
      return mode === 'and' ? hit.length === tagList.length : hit.length > 0
    })
  }
  picked.sort((a, b) => Number(b.userScore) - Number(a.userScore) || String(a.name).localeCompare(String(b.name)))
  if (perArtist > 0) {
    const seen = new Map()
    const out = []
    for (const w of picked) {
      const k = String(w.artist || '_')
      const n = seen.get(k) || 0
      if (n >= perArtist) continue
      seen.set(k, n + 1)
      out.push(w)
    }
    picked = out
  }
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 200))
  return { lib, works: picked.slice(0, limit), total: picked.length }
}

function captionOf(work) {
  const tags = [...new Set([...(work.tagKeys || []), ...(work.tags || [])].map(toDanbooru).filter(Boolean))]
  const keep = tags.filter((t) => !/^(\d+users入り|r-18|r-18g)$/i.test(t) && isAsciiTag(t))
  return keep.slice(0, 60).join(', ')
}

function tagsAggregate(entries) {
  const buckets = { pose: new Map(), action: new Map(), decoration: new Map(), clothing: new Map(), expression: new Map(), scene: new Map(), style: new Map(), other: new Map() }
  for (const e of entries) {
    const sc = Number(e.score) || 0
    for (const [b, list] of Object.entries(e.grouped || {})) {
      if (!buckets[b]) continue
      for (const t of list || []) {
        const cur = buckets[b].get(t) || { tag: t, n: 0, sum: 0, max: 0 }
        cur.n += 1
        cur.sum += sc
        cur.max = Math.max(cur.max, sc)
        buckets[b].set(t, cur)
      }
    }
  }
  const out = {}
  for (const [b, m] of Object.entries(buckets)) {
    out[b] = [...m.values()]
      .map((x) => ({ tag: x.tag, n: x.n, avg: Math.round((x.sum / x.n) * 100) / 100, max: x.max }))
      .sort((x, y) => y.n - x.n || y.avg - x.avg)
      .slice(0, 60)
  }
  return out
}

/** 导出数据集：图片 + caption + manifest + 标签统计 */
export function exportDataset(pixivHome, state, opts = {}) {
  const p = ensureBridge(pixivHome, state)
  const { works, total } = pickWorks(pixivHome, state, opts)
  const entries = []
  let images = 0
  const used = new Set()
  for (const w of works) {
    const base = safeFile((w.artist ? w.artist + '_' : '') + (w.id || w.name))
    let slug = base
    let n = 2
    while (used.has(slug)) { slug = base + '_' + n; n += 1 }
    used.add(slug)
    const src = absOf(w)
    const ext = (extname(src) || '.png').toLowerCase()
    const imgName = slug + ext
    const capName = slug + '.txt'
    let copied = false
    try {
      if (src && existsSync(src)) { copyFileSync(src, join(p.images, imgName)); copied = true; images += 1 }
    } catch { copied = false }
    const cap = captionOf(w)
    try { writeFileSync(join(p.captions, capName), cap + '\n', 'utf8') } catch { /* ignore */ }
    const grouped = groupTags([...(w.tagKeys || []), ...(w.tags || [])])
    entries.push({
      name: w.name, id: w.id, title: w.title, artist: w.artist || '',
      score: Number(w.userScore) || 0, restrict: w.restrict || 'all', pages: w.pages || 0,
      image: copied ? imgName : '', caption: capName, captionText: cap,
      tags: [...new Set([...(w.tagKeys || []), ...(w.tags || [])])].slice(0, 60),
      grouped,
      prompts: {
        illustrious: promptForWork(w, 'illustrious'),
        noobai: promptForWork(w, 'noobai'),
        animagine: promptForWork(w, 'animagine'),
      },
    })
  }
  const byArtistMap = new Map()
  for (const e of entries) {
    const k = e.artist || '（未知画师）'
    const cur = byArtistMap.get(k) || { artist: k, n: 0, sum: 0 }
    cur.n += 1
    cur.sum += e.score
    byArtistMap.set(k, cur)
  }
  const manifest = {
    protocol: TRAIN_PROTOCOL,
    generatedAt: new Date().toISOString(),
    options: { minScore: Number(opts.minScore) || 7, tags: opts.tags || [], mode: opts.mode || 'any', includeR18: opts.includeR18 !== false },
    counts: { works: entries.length, images, matched: total },
    byArtist: [...byArtistMap.values()].map((x) => ({ artist: x.artist, n: x.n, avg: Math.round((x.sum / x.n) * 100) / 100 })).sort((a, b) => b.n - a.n),
    works: entries,
  }
  try { writeFileSync(p.manifest, JSON.stringify(manifest, null, 2), 'utf8') } catch { /* ignore */ }
  try {
    writeFileSync(p.tags, JSON.stringify({ generatedAt: manifest.generatedAt, counts: manifest.counts, buckets: tagsAggregate(entries) }, null, 2), 'utf8')
  } catch { /* ignore */ }
  try { writeFileSync(p.iface, JSON.stringify(interfaceJson(p, state), null, 2), 'utf8') } catch { /* ignore */ }
  return { ok: true, counts: manifest.counts, paths: p, byArtist: manifest.byArtist.slice(0, 12) }
}

/** 把作品投进 inbox：<slug>.png + .txt + .json（三件套） */
export function dropToInbox(pixivHome, state, names = [], opts = {}) {
  const p = ensureBridge(pixivHome, state)
  const lib = listLibrary(pixivHome, state)
  const all = Array.isArray(lib?.works) ? lib.works : []
  const want = Array.isArray(names) ? names.map(String) : []
  const works = want.length
    ? all.filter((w) => want.includes(String(w.name)) || want.includes(String(w.id)))
    : all.filter((w) => Number(w.userScore) >= 8).slice(0, 1)
  const out = []
  const modelKey = opts.model || 'illustrious'
  for (const w of works.slice(0, 50)) {
    const slug = safeFile((w.artist ? w.artist + '_' : '') + (w.id || w.name))
    const src = absOf(w)
    const ext = (extname(src) || '.png').toLowerCase()
    const prompt = promptForWork(w, modelKey)
    try { if (src && existsSync(src)) copyFileSync(src, join(p.inbox, slug + ext)) } catch { /* ignore */ }
    try { writeFileSync(join(p.inbox, slug + '.txt'), prompt.positive + '\n', 'utf8') } catch { /* ignore */ }
    const spec = {
      protocol: TRAIN_PROTOCOL,
      slug,
      source: { name: w.name, id: w.id, artist: w.artist || '', score: Number(w.userScore) || 0 },
      model: opts.modelFile || (modelKey + '.safetensors'),
      positive: prompt.positive,
      negative: prompt.negative,
      params: prompt.params,
      grouped: prompt.grouped,
      created: new Date().toISOString(),
    }
    try { writeFileSync(join(p.inbox, slug + '.json'), JSON.stringify(spec, null, 2), 'utf8') } catch { /* ignore */ }
    out.push({ slug, name: w.name, positive: prompt.positive })
  }
  return { ok: true, dropped: out.length, items: out, inbox: p.inbox }
}

/* ------------------------- 回收出图 ------------------------- */

const IMG_EXT = /\.(png|jpe?g|webp)$/i

/** 扫 outbox 与「炼图反图文件夹」，解析元数据，复制进作品库并登记 */
export function ingestOutputs(pixivHome, state, opts = {}) {
  const p = ensureBridge(pixivHome, state)
  const dropDir = String(opts.genDropDir || state?.config?.genDropDir || '').trim()
  const dirs = [p.outbox]
  if (dropDir && existsSync(dropDir)) dirs.push(dropDir)
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100))
  const allwork = allworkOf(pixivHome)
  try { mkdirSync(allwork, { recursive: true }) } catch { /* ignore */ }
  const ingestedFile = join(p.root, 'ingested.json')
  const seen = readJsonSafe(ingestedFile, {})
  const done = []
  for (const dir of dirs) {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isFile() || !IMG_EXT.test(e.name)) continue
      if (done.length >= limit) break
      const full = join(dir, e.name)
      let st
      try { st = statSync(full) } catch { continue }
      const key = e.name + '|' + st.size + '|' + Math.round(st.mtimeMs)
      if (seen[key]) continue
      let buf
      try { buf = readFileSync(full) } catch { continue }
      const meta = parseGenMeta(buf)
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const base = safeFile(basename(e.name, extname(e.name)), 60)
      const workName = safeFile('gen_' + stamp + '_' + base, 110)
      const target = join(allwork, workName)
      try {
        mkdirSync(target, { recursive: true })
        copyFileSync(full, join(target, e.name))
      } catch { continue }
      const tagsFromPrompt = String(meta.prompt || '')
        .split(',')
        .map((t) => t.trim().replace(/^\(|\)$/g, '').replace(/:\d+(\.\d+)?$/, '').replace(/_/g, ' '))
        .filter((t) => t && t.length <= 40 && !/^(masterpiece|best quality|amazing quality|absurdres|highres|newest|very aesthetic|aesthetic)$/i.test(t))
        .slice(0, 40)
      try {
        writeFileSync(join(target, 'metadata.json'), JSON.stringify({
          workName,
          title: basename(e.name, extname(e.name)),
          kind: 'illust',
          tags: tagsFromPrompt.map((name) => ({ name, translated: '' })),
          generated: true,
          source: 'comfyui',
          prompt: meta.prompt,
          negative: meta.negative,
          seed: meta.seed,
          steps: meta.steps,
          cfg: meta.cfg,
          sampler: meta.sampler,
          model: meta.model,
          width: meta.width,
          height: meta.height,
          importedAt: new Date().toISOString(),
        }, null, 2), 'utf8')
      } catch { /* ignore */ }
      libraryAdd(state, workName, { source: 'comfy', importedAt: new Date().toISOString(), from: dir })
      seen[key] = { at: new Date().toISOString(), workName }
      done.push({ file: e.name, workName, prompt: String(meta.prompt || '').slice(0, 120), seed: meta.seed, dir })
    }
  }
  try { writeFileSync(ingestedFile, JSON.stringify(seen, null, 2), 'utf8') } catch { /* ignore */ }
  return { ok: true, ingested: done.length, items: done, outbox: p.outbox, genDropDir: dropDir }
}

/* ------------------------- 状态 ------------------------- */

export function trainStatus(pixivHome, state) {
  const p = ensureBridge(pixivHome, state)
  const manifest = readJsonSafe(p.manifest, null)
  const listDir = (d) => { try { return readdirSync(d).length } catch { return 0 } }
  const cfg = readJsonSafe(p.models, MODEL_PROFILES)
  return {
    ok: true,
    protocol: TRAIN_PROTOCOL,
    paths: p,
    models: cfg,
    genDropDir: String(state?.config?.genDropDir || ''),
    counts: {
      images: listDir(p.images),
      captions: listDir(p.captions),
      inbox: listDir(p.inbox),
      outbox: listDir(p.outbox),
      dataset: manifest?.counts?.works || 0,
    },
    lastExport: manifest?.generatedAt || '',
    byArtist: (manifest?.byArtist || []).slice(0, 12),
    interfaceReady: existsSync(p.iface),
  }
}
