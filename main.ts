import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { cors } from 'https://deno.land/x/hono/middleware.ts'
import ytdl from "npm:@distube/ytdl-core"

/* ================= Config (minimal + descriptor & cover) ================= */
const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN")

/* ========== 1. ノイズ / descriptor 拡張 (既存に追加) ========== */
const BASE_BAD_WORDS = [
  "cover","karaoke","tribute","sped up","speed up","slowed","nightcore"
]
const BAD_WORDS = [...BASE_BAD_WORDS]

/** 追加ノイズ / ディスクリプタ候補（前のロジックを壊さないよう既存集合へ合流） */
const EXTRA_NOISE = [
  "the","first","take","thefirsttake","youtube","yt","official","offical",
  "mv","musicvideo","live","tour","livetour","session","lounge",
  "behind","scenes","behindthescenes","making","makingof",
  "remix","mix","alternate","alt","remastered","remaster",
  "tv","tvsize","short","demo","edit","piano","acoustic",
  "english","translation","romanized","romaji","by","from",
  "original","ost","soundtrack","version","ver","eng",
  "lyric","lyrics"
]

// Romanized/翻訳ページ優先度制御用マーカー（BAD_WORDS には入れず）
const ROMANIZED_MARKERS = ["romanized","translation","translated","english"]

/* 既存 NOISE_WORDS を拡張 */
const NOISE_WORDS = new Set([
  "official","music","video","musicvideo","mv","pv","lyric","lyrics","ver","version",
  "visualizer","teaser","trailer","short","shorts","full","performance","live",
  "romanized","translation","translated","clip","hd","hq",
  ...EXTRA_NOISE
])

/* STOPWORDS は元のロジックを維持しつつ NOISE_WORDS を継承 */
const STOPWORDS = new Set([...NOISE_WORDS])

const MIN_TOKEN_OVERLAP = 0.6
const DASH_SPLIT_SEPARATORS = [" - ", " | "]

/* Cover detection */
const COVER_MARKERS = /(歌ってみた|covered?\s+by|cover\s+by|カバー|cover)/i
const COVER_REMOVE_PATTERNS: RegExp[] = [
  /\bcovered?\s+by\s+[^\s].*$/i,
  /\bcover\s+by\s+[^\s].*$/i,
  /\bcovered?\s+[^\s].*$/i,
  /カバー(?:\s*by)?\s*.+$/i,
  /歌ってみた.*$/i
]

/* feat / descriptor */
const FEAT_WORDS = new Set(["feat","ft","featuring","with"])

const DESCRIPTOR_KEYWORDS = new Set([
  "instrumental","inst","offvocal","off-vocal","acoustic","acapella","a","cappella",
  "karaoke","カラオケ","カラオケver","カラオケversion","カラオケ音源",
  "original",
  // 追加 (項目3対応)
  "remix","mix","alternate","alt","remastered","remaster",
  "tv","tvsize","demo","edit","short","piano","acoustic","live","version","ver"
])

/* ================ Utility ================ */
function normalizeSpaces(s: string) {
  return s.replace(/\s+/g," ").trim()
}

/* 日本語括弧正規化 (項目1) */
function normalizeJapaneseBrackets(s: string): string {
  return s
    .replace(/[「『【〈《]/g,"[")
    .replace(/[」』】〉》]/g,"]")
}

/* 記号・スマートクォート 正規化 */
function normalizeQuotes(s: string): string {
  return s.replace(/[“”]/g,'"').replace(/[’‘]/g,"'")
}

function tokenizeRaw(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[“”"’']/g," ")
    .replace(/[#(){}]/g," ")
    .split(/[\s\-_:/|.,!?]+/)
    .map(t=>t.trim())
    .filter(Boolean)
}
function tokenizeForMatch(s: string) {
  return tokenizeRaw(s).filter(t => !STOPWORDS.has(t) && !/^\d+$/.test(t))
}
function stripPunctLower(s: string) {
  return s.toLowerCase().replace(/[\s'"!?:.,\-–—_]/g,"")
}
function stripBracketedNoise(title: string): string {
  return title
    .replace(/(\[[^\]]*])/g, (m) => {
      const inner = m.slice(1,-1).toLowerCase()
      if (inner.split(/\s+/).every(w => NOISE_WORDS.has(w) || /^(official|mv|pv)$/.test(w))) return " "
      return m
    })
    .replace(/(\([^)]*\))/g, (m) => {
      const inner = m.slice(1,-1).toLowerCase()
      if (/(official|music|video|lyrics?|romanized|translation|ver|version|live|remix|mix|alternate|remastered|tv\s*size)/.test(inner) &&
          inner.split(/\s+/).every(w => NOISE_WORDS.has(w) || DESCRIPTOR_KEYWORDS.has(w))) {
        return " "
      }
      return m
    })
}
function removeMatchedParens(title: string): string {
  return title.replace(/\(\s*\)/g," ").replace(/\s+/g," ").trim()
}
function dashTruncateIfNoise(title: string): string {
  let best = title
  for (const sep of DASH_SPLIT_SEPARATORS) {
    if (title.toLowerCase().includes(sep.trim())) {
      const parts = title.split(sep)
      if (parts.length > 1) {
        const first = parts[0].trim()
        const rest = parts.slice(1).join(" ").toLowerCase()
        const restTokens = tokenizeRaw(rest)
        if (restTokens.length && restTokens.every(t => NOISE_WORDS.has(t))) {
          if (first.length >= 3) best = first
        }
      }
    }
  }
  return best
}

/* Artist - Title 形式 / by-removal 前処理 (項目2) */
function preNormalizeTitle(raw: string, artist: string): string {
  let t = normalizeJapaneseBrackets(normalizeQuotes(raw))
  // Artist - Title (先頭) パターン
  const artistLc = artist.trim().toLowerCase()
  // 区切り候補
  const sepRegex = new RegExp(`^\\s*(${escapeRegex(artistLc)})\\s*[-–—/:|]\\s*(.+)$`,"i")
  const m = t.match(sepRegex)
  if (m) {
    t = m[2]
  }
  // by X of Y 末尾除去
  t = t.replace(/\bby\s+[a-z0-9 .'\-]+(\s+of\s+[a-z0-9 .'\-]+)?$/i,"").trim()
  return t
}
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")
}

/* スラッシュ等でのメドレー/複合分割 (項目4) */
function splitTitleFragments(title: string): string[] {
  const sep = /\s*[\/／｜|]\s*/  // 半角/全角スラッシュ & 縦線
  if (!sep.test(title)) return [title]
  const parts = title.split(sep)
  // 短すぎるものや純ノイズを除外せず一旦全部返し、後段でフィルタ
  return parts.filter(p => p.trim().length > 0)
}

function basicCleanTitle(raw: string): string {
  let t = raw
  t = stripBracketedNoise(t)
  t = removeMatchedParens(t)
  t = dashTruncateIfNoise(t)
  const toks = tokenizeRaw(t)
  const dedup: string[] = []
  const seen = new Set<string>()
  for (const tk of toks) {
    if (seen.has(tk)) continue
    seen.add(tk)
    dedup.push(tk)
  }
  return dedup.join(" ")
}

/* ================ Cover extraction ================ */
interface CoverExtraction { coverDetected: boolean; coreTitle: string; originalRaw: string }
function extractCoreTitle(raw: string): CoverExtraction {
  let work = raw
  let coverDetected = false
  work = work.replace(/^[【\[]([^】\]]+)[】\]]\s*/g, (_m, inner) => {
    if (COVER_MARKERS.test(inner)) { coverDetected = true; return "" }
    return _m
  })
  for (const re of COVER_REMOVE_PATTERNS) {
    if (re.test(work)) {
      coverDetected = true
      work = work.replace(re, "").trim()
    }
  }
  work = work.replace(/\bcover\s*$/i, () => { coverDetected = true; return "" }).trim()
  work = normalizeSpaces(work)
  return { coverDetected, coreTitle: work, originalRaw: raw }
}

/* ================ Descriptor / feat variants (項目3 拡張) ================ */
function extractDescriptorBase(text: string): string {
  let out = text.replace(/\(([^)]*)\)/g, (m, inner) => {
    const innerTokens = tokenizeRaw(inner)
    if (innerTokens.length && innerTokens.every(t => DESCRIPTOR_KEYWORDS.has(t) || NOISE_WORDS.has(t))) {
      return " "
    }
    return m
  })
  const toks = tokenizeRaw(out)
  while (toks.length) {
    const last = toks[toks.length - 1]
    if (DESCRIPTOR_KEYWORDS.has(last) || NOISE_WORDS.has(last)) { toks.pop(); continue }
    break
  }
  out = toks.join(" ")
  return normalizeSpaces(out)
}

function generateTitleVariants(raw: string): string[] {
  const set = new Set<string>()
  const cleaned = basicCleanTitle(raw)
  set.add(cleaned)

  const noFeat = cleaned.replace(/\b(feat|ft|featuring|with)\b.*$/i, "").trim()
  if (noFeat && noFeat !== cleaned) set.add(noFeat)

  // descriptor 除去段階
  const descBase = extractDescriptorBase(cleaned)
  if (descBase && descBase !== cleaned) set.add(descBase)

  if (noFeat) {
    const noFeatDesc = extractDescriptorBase(noFeat)
    if (noFeatDesc && noFeatDesc !== noFeat) set.add(noFeatDesc)
  }

  const noEngParen = cleaned
    .replace(/\([A-Za-z0-9 ,.'&\-]+\)/g, " ")
    .replace(/\s+/g," ").trim()
  if (noEngParen && !set.has(noEngParen)) set.add(noEngParen)

  const noEngDesc = extractDescriptorBase(noEngParen)
  if (noEngDesc && !set.has(noEngDesc)) set.add(noEngDesc)

  // 追加: 末尾 descriptor 語を逐次落としていく
  const toks = tokenizeRaw(cleaned)
  for (let i = toks.length; i > 1; i--) {
    const head = toks.slice(0,i)
    const last = head[head.length-1]
    if (DESCRIPTOR_KEYWORDS.has(last) || NOISE_WORDS.has(last)) {
      const variant = head.slice(0,-1).join(" ")
      if (variant.length > 1) set.add(variant)
    }
  }

  return [...set].filter(v => v.length > 0)
}

function removeDescriptorsTokens(tokens: string[]) {
  return tokens.filter(t => !DESCRIPTOR_KEYWORDS.has(t))
}
function tokensWithoutFeatWords(tokens: string[]) {
  return tokens.filter(t => !FEAT_WORDS.has(t))
}

/* ================ Artist match (simple) ================ */
function artistVariants(name: string): string[] {
  const v = new Set<string>()
  const trimmed = name.trim()
  if (trimmed) v.add(trimmed.toLowerCase())
  const parens = name.match(/\(([^)]*)\)/g)
  if (parens) {
    for (const p of parens) {
      const inner = p.replace(/[()]/g,"").trim().toLowerCase()
      if (inner) v.add(inner)
    }
  }
  const noParen = name.replace(/\([^)]*\)/g," ").replace(/\s+/g," ").trim().toLowerCase()
  if (noParen) v.add(noParen)
  return [...v]
}
function artistRoughMatch(queryArtist: string, candidateArtist: string) {
  const qVars = artistVariants(queryArtist)
  const cVars = artistVariants(candidateArtist)
  for (const qa of qVars) {
    for (const ca of cVars) {
      const qs = stripPunctLower(qa)
      const cs = stripPunctLower(ca)
      if (!qs || !cs) continue
      if (qs === cs) return true
      if ((qs.length >= 3 && cs.includes(qs)) || (cs.length >= 3 && qs.includes(cs))) return true
      const qTokens = tokenizeForMatch(qa)
      const cTokens = tokenizeForMatch(ca)
      if (qTokens.length && cTokens.length) {
        const shared = qTokens.filter(t => cTokens.includes(t))
        if (shared.length > 0) return true
      }
    }
  }
  return false
}

/* ================ Title match (項目5 改良) ================ */
function hasBadWord(candidateTitle: string, originalTitle: string) {
  const c = candidateTitle.toLowerCase()
  const o = originalTitle.toLowerCase()
  for (const w of BAD_WORDS) {
    if (c.includes(w) && !o.includes(w)) return true
  }
  return false
}

function removeParentheticalRomanization(s: string): string {
  // “(English Translation)”, “(Romanized)” 等を除いた版
  return s.replace(/\(([^(]*?(?:english|translation|romanized|romaji|transliteration)[^)]*)\)/gi," ")
          .replace(/\s+/g," ").trim()
}

// descriptor 差分許容: 片側にしかない descriptor がある場合でも core tokens が同一なら OK
function coreDescriptorAgnosticTokens(tokens: string[]) {
  return tokens.filter(t => !DESCRIPTOR_KEYWORDS.has(t) && !NOISE_WORDS.has(t))
}

function titleLikelySame(a: string, b: string) {
  const av = generateTitleVariants(a)
  const bv = generateTitleVariants(b)

  // 追加: 括弧内翻訳/ローマ字除いた variant
  const extraA = new Set<string>()
  const extraB = new Set<string>()
  av.forEach(v => extraA.add(removeParentheticalRomanization(v)))
  bv.forEach(v => extraB.add(removeParentheticalRomanization(v)))

  const allA = [...new Set([...av, ...extraA])]
  const allB = [...new Set([...bv, ...extraB])]

  for (const x of allA) {
    for (const y of allB) {
      if (!x || !y) continue
      if (x.toLowerCase() === y.toLowerCase()) return true

      const xTokens = tokenizeForMatch(x)
      const yTokens = tokenizeForMatch(y)
      if (!xTokens.length || !yTokens.length) continue

      // ディスクリプタ/feat 除去
      const xCore = tokensWithoutFeatWords(removeDescriptorsTokens(xTokens))
      const yCore = tokensWithoutFeatWords(removeDescriptorsTokens(yTokens))
      const X = xCore.length ? xCore : xTokens
      const Y = yCore.length ? yCore : yTokens

      // descriptor 無視比較
      const XD = coreDescriptorAgnosticTokens(X)
      const YD = coreDescriptorAgnosticTokens(Y)
      const sharedD = XD.filter(t => YD.includes(t))

      if (sharedD.length && sharedD.length === Math.min(XD.length, YD.length)) return true

      const shared = X.filter(t => Y.includes(t))
      const minLen = Math.min(X.length, Y.length)
      if (shared.length === minLen && minLen >= 1) return true
      const overlap = shared.length / (minLen || 1)
      if (overlap >= MIN_TOKEN_OVERLAP) return true

      const xs = stripPunctLower(x)
      const ys = stripPunctLower(y)
      if (xs.includes(ys) || ys.includes(xs)) return true
    }
  }
  return false
}

/* ================ Genius API ================ */
async function geniusSearch(q: string) {
  if (!geniusToken) return []
  const url = `https://api.genius.com/search?q=${encodeURIComponent(q)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${geniusToken}` } })
  if (!res.ok) return []
  const json = await res.json()
  return json.response?.hits || []
}

/* ================ Matching core ================ */
interface MatchResult { url: string | null; debug?: any }

async function findGeniusUrl(title: string, artist: string, debug: boolean): Promise<MatchResult> {
  if (!geniusToken) return { url: null, debug: debug ? { reason: "no_token" } : undefined }

  // 前処理 (1,2)
  const preNormTitle = preNormalizeTitle(title, artist)
  const normalizedTitle = normalizeSpaces(preNormTitle)

  const cleaned = basicCleanTitle(normalizedTitle)
  const dashReduced = dashTruncateIfNoise(cleaned)
  const { coverDetected, coreTitle } = extractCoreTitle(cleaned)
  const descriptorBase = extractDescriptorBase(cleaned)
  const baseTitle = extractDescriptorBase(
    cleaned.replace(/\b(feat|ft|featuring|with)\b.*$/i,"").trim()
  ) || cleaned

  const fragments = splitTitleFragments(normalizedTitle)
  const fragmentCores = fragments
    .map(f => extractDescriptorBase(basicCleanTitle(f)))
    .filter(f => f && f.length > 1)

  const queries: { label: string; q: string }[] = []
  queries.push({ label: "raw", q: `${title} ${artist}` })

  if (normalizedTitle !== title) queries.push({ label: "pre_norm", q: `${normalizedTitle} ${artist}` })
  if (cleaned !== normalizedTitle) queries.push({ label: "cleaned", q: `${cleaned} ${artist}` })
  if (dashReduced !== cleaned) queries.push({ label: "dash_reduced", q: `${dashReduced} ${artist}` })
  if (descriptorBase && descriptorBase !== cleaned) {
    queries.push({ label: "no_descriptor", q: `${descriptorBase} ${artist}` })
  }
  if (coverDetected) {
    if (coreTitle && coreTitle !== cleaned) {
      queries.push({ label: "cover_core", q: `${coreTitle} ${artist}` })
      queries.push({ label: "cover_core_title_only", q: coreTitle })
    } else {
      queries.push({ label: "cover_title_only", q: cleaned })
    }
  }
  if (descriptorBase && descriptorBase !== cleaned) {
    queries.push({ label: "no_descriptor_title_only", q: descriptorBase })
  }
  queries.push({ label: "title_only_final", q: baseTitle })

  // 追加: フラグメント個別 (項目4)
  fragmentCores.forEach((fc, idx) => {
    if (fc !== baseTitle) {
      queries.push({ label: `fragment_${idx}`, q: `${fc} ${artist}` })
      queries.push({ label: `fragment_${idx}_title_only`, q: fc })
    }
  })

  const seen = new Set<string>()
  const finalQueries = queries.filter(q => {
    const k = q.q.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const debugLogs: any[] = []
  let acceptedGlobal: any = null
  let penalizedFallback: any = null

  const origLower = title.toLowerCase()

  for (const q of finalQueries) {
    let hits: any[] = []
    try { hits = await geniusSearch(q.q) } catch { /* ignore */ }

    const examined: any[] = []
    let acceptedInQuery: any = null
    penalizedFallback = penalizedFallback // keep previous if set

    for (const h of hits) {
      const r = h.result
      const cTitle: string = r.title || r.full_title || ""
      const cArtist: string = r.primary_artist?.name || ""
      const reasons: string[] = []

      // コンテンツ種別 (Chapter/Interview 等) は軽い early skip (既存挙動維持: reject:title_mismatch でも良いが最適化)
      if (/\b(chapter|interview|review|article)\b/i.test(cTitle)) {
        reasons.push("reject:non_song_content")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|") })
        continue
      }

      if (hasBadWord(cTitle, title)) {
        reasons.push("reject:bad_word")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|") })
        continue
      }

      const needArtist = !q.label.endsWith("title_only") && !q.label.includes("title_only")
      if (needArtist && !artistRoughMatch(artist, cArtist)) {
        reasons.push("reject:artist_mismatch")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|") })
        continue
      }

      // Romanized / Translation ページ
      const cLower = cTitle.toLowerCase()
      let isPenalized = false
      if (!ROMANIZED_MARKERS.some(m => origLower.includes(m))) {
        if (ROMANIZED_MARKERS.some(m => cLower.includes(m))) {
          isPenalized = true
        }
      }

      const same =
        titleLikelySame(title, cTitle) ||
        titleLikelySame(normalizedTitle, cTitle) ||
        (coreTitle && titleLikelySame(coreTitle, cTitle)) ||
        (descriptorBase && titleLikelySame(descriptorBase, cTitle)) ||
        (baseTitle && titleLikelySame(baseTitle, cTitle))

      if (!same) {
        reasons.push("reject:title_mismatch")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|"), penalized: isPenalized })
        continue
      }

      if (isPenalized) {
        reasons.push("penalized_candidate")
        const penal = {
          id: r.id,
          title: cTitle,
          artist: cArtist,
          url: r.url,
          decision: reasons.join("|"),
          usedQuery: q.label,
          penalized: true
        }
        examined.push(penal)
        if (!penalizedFallback) penalizedFallback = penal
        continue
      }

      reasons.push("accept")
      acceptedInQuery = {
        id: r.id,
        title: cTitle,
        artist: cArtist,
        url: r.url,
        decision: reasons.join("|"),
        usedQuery: q.label,
        penalized: false
      }
      examined.push(acceptedInQuery)
      break
    }

    debugLogs.push({ query: q, examined })

    if (acceptedInQuery) {
      acceptedGlobal = acceptedInQuery
      break
    }
  }

  if (!acceptedGlobal && penalizedFallback) {
    penalizedFallback.decision += "|accept:penalized_fallback"
    acceptedGlobal = penalizedFallback
  }

  return {
    url: acceptedGlobal ? acceptedGlobal.url : null,
    debug: debug ? {
      accepted: acceptedGlobal,
      penalizedUsed: !!(acceptedGlobal && acceptedGlobal.penalized),
      coverDetected,
      coreTitle,
      descriptorBase,
      baseTitle,
      fragments: fragmentCores,
      steps: debugLogs
    } : undefined
  }
}

/* ================ HTTP route ================ */
const app = new Hono()
app.use("/", cors())

app.get("/track", async (c) => {
  const videoId = c.req.query("v")
  const debug = c.req.query("debug") === "1"
  if (!videoId) return c.json({ error: "Video ID is required" }, 400)

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
  let info: any
  try {
    info = await ytdl.getBasicInfo(videoUrl)
  } catch (e) {
    return c.json({ error: "Failed to fetch video info", detail: String(e) }, 500)
  }

  const engagementPanel = info.response?.engagementPanels?.find((d: any) =>
    d.engagementPanelSectionListRenderer?.panelIdentifier === "engagement-panel-structured-description"
  )

  const songsSection = engagementPanel?.engagementPanelSectionListRenderer?.content
    ?.structuredDescriptionContentRenderer?.items?.find((d: any) => d.horizontalCardListRenderer !== undefined)

  if (!songsSection) return c.json({ song: false })

  const card = songsSection.horizontalCardListRenderer.cards?.[0]?.videoAttributeViewModel
  if (!card) return c.json({ song: false })

  const title = card.title
  const artist = card.subtitle
  const thumbnail = card.image?.sources?.[0]?.url

  const { url: genius_url, debug: debugInfo } = await findGeniusUrl(title, artist, debug)

  const resp: any = { song: true, title, artist, thumbnail, genius_url }
  if (debug) resp.debug = debugInfo
  return c.json(resp)
})

Deno.serve(app.fetch)
