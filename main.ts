import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { cors } from 'https://deno.land/x/hono/middleware.ts'
import ytdl from "npm:@distube/ytdl-core"

/* ================= Config (minimal + descriptor & cover) ================= */
const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN")

/* ========= BAD / NOISE / DESCRIPTOR (拡張保持) ========= */
const BASE_BAD_WORDS = [
  "cover","karaoke","tribute","sped up","speed up","slowed","nightcore"
]
const BAD_WORDS = [...BASE_BAD_WORDS]

/* ノイズ語 (既存+拡張) */
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

/* Romanized/翻訳ページマーカー (reject ではなく penalize) */
const ROMANIZED_MARKERS = ["romanized","translation","translated","english"]

const NOISE_WORDS = new Set([
  "official","music","video","musicvideo","mv","pv","lyric","lyrics","ver","version",
  "visualizer","teaser","trailer","short","shorts","full","performance","live",
  "romanized","translation","translated","clip","hd","hq",
  ...EXTRA_NOISE
])
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
  "remix","mix","alternate","alt","remastered","remaster",
  "tv","tvsize","demo","edit","short","piano","acoustic","live","version","ver"
])

/* ========= Aggressive 括弧内削除トリガ (要望により随時追加) =========
   ここに含まれる語を ( ) / [ ] 内に一つでも含めば丸ごと除去
   （大文字小文字無視・部分一致）
*/
const BRACKET_INNER_REMOVE_TRIGGERS = [
  // 一般 MV / ライブ
  "music","video","mv","pv","official","live","live ver","live version","performance",
  "session","lounge","tour","stage","studio",
  // メイキング / 舞台裏
  "behind","behind the scenes","bts","making","making of","making-of",
  // 配信/企画
  "the first take","first take","youtube ver","youtube version","yt ver",
  // 表記/歌詞
  "lyric","lyrics","english translation","translation","translated","romanized","romaji",
  // バージョン区分
  "ver","version","alt ver","alternate","alternate ver","alternate version",
  "remix","mix","edit","demo","short ver","short version","short",
  "tv","tv size","tv-size","tvsize",
  // 音源種別
  "acoustic","piano","inst","instrumental","off vocal","off-vocal","offvocal",
  // その他よくある
  "visualizer","teaser","trailer","clip","full ver","full version",
  // 言語タグ
  "english ver","english version","japanese ver","japanese version"
]

function bracketInnerShouldRemove(inner: string): boolean {
  const low = inner.toLowerCase()
  return BRACKET_INNER_REMOVE_TRIGGERS.some(w => low.includes(w))
}

/* ================ Utility ================ */
function normalizeSpaces(s: string) {
  return s.replace(/\s+/g," ").trim()
}

/* 日本語括弧を [] に正規化 */
function normalizeJapaneseBrackets(s: string): string {
  return s
    .replace(/[「『【〈《]/g,"[")
    .replace(/[」』】〉》]/g,"]")
}

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

/* 括弧ノイズ除去 (要望に基づきトリガベースで積極削除) */
function stripBracketedNoise(title: string): string {
  // [ ... ]
  title = title.replace(/(\[[^\]]*])/g, (m) => {
    const inner = m.slice(1,-1).trim()
    if (!inner) return " "
    if (bracketInnerShouldRemove(inner)) return " "
    const toks = inner.toLowerCase().split(/\s+/)
    if (toks.length && toks.every(w => NOISE_WORDS.has(w) || /^(official|mv|pv)$/.test(w))) {
      return " "
    }
    return m
  })
  // ( ... )
  title = title.replace(/(\([^)]*\))/g, (m) => {
    const inner = m.slice(1,-1).trim()
    if (!inner) return " "
    if (bracketInnerShouldRemove(inner)) return " "
    const lower = inner.toLowerCase()
    if (
      /(official|music|video|lyrics?|romanized|translation|ver|version|live|remix|mix|alternate|remastered|tv\s*size)/.test(lower) &&
      lower.split(/\s+/).every(w => NOISE_WORDS.has(w) || DESCRIPTOR_KEYWORDS.has(w))
    ) {
      return " "
    }
    return m
  })
  return title
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

/* Artist - Title 形式などの前処理 */
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")
}
function preNormalizeTitle(raw: string, artist: string): string {
  let t = normalizeJapaneseBrackets(normalizeQuotes(raw))
  const artistLc = artist.trim().toLowerCase()
  if (artistLc) {
    const sepRegex = new RegExp(`^\\s*(${escapeRegex(artistLc)})\\s*[-–—/:|]\\s*(.+)$`,"i")
    const m = t.match(sepRegex)
    if (m) t = m[2]
  }
  t = t.replace(/\bby\s+[a-z0-9 .'\-]+(\s+of\s+[a-z0-9 .'\-]+)?$/i,"").trim()
  return t
}

/* スラッシュ/縦線 分割 (メドレー等) */
function splitTitleFragments(title: string): string[] {
  const sep = /\s*[\/／｜|]\s*/
  if (!sep.test(title)) return [title]
  return title.split(sep).filter(p => p.trim().length > 0)
}

function basicCleanTitle(raw: string): string {
  let t = raw
  t = stripBracketedNoise(t)
  t = removeMatchedParens(t)
  t = dashTruncateIfNoise(t)
  // 重複除去は既存仕様維持（“danger danger” 問題を避けたいなら別 variant 追加で対応）
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

/* ================ Descriptor / feat variants ================ */
function extractDescriptorBase(text: string): string {
  let out = text.replace(/\(([^)]*)\)/g, (m, inner) => {
    const innerTrim = String(inner).trim()
    if (!innerTrim) return " "
    if (bracketInnerShouldRemove(innerTrim)) return " "
    const innerTokens = tokenizeRaw(innerTrim)
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

  // 末尾 descriptor/ノイズ語を段階的に落として追加
  const toks = tokenizeRaw(cleaned)
  for (let i = toks.length; i > 1; i--) {
    const head = toks.slice(0,i)
    const last = head[head.length-1]
    if (DESCRIPTOR_KEYWORDS.has(last) || NOISE_WORDS.has(last)) {
      const variant = head.slice(0,-1).join(" ")
      if (variant.length > 1) set.add(variant)
    }
  }

  // オリジナルトークン順保持 (重複含む) も variant に
  const origTokens = tokenizeRaw(raw)
  if (origTokens.length) {
    const originalSeq = origTokens.join(" ")
    set.add(originalSeq)
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

/* ================ Title match ================ */
function hasBadWord(candidateTitle: string, originalTitle: string) {
  const c = candidateTitle.toLowerCase()
  const o = originalTitle.toLowerCase()
  for (const w of BAD_WORDS) {
    if (c.includes(w) && !o.includes(w)) return true
  }
  return false
}

function removeParentheticalRomanization(s: string): string {
  // 括弧内が翻訳/ローマ字/英訳系なら削除 (キーワード拡張)
  return s.replace(/\(([^(]*?(?:english|translation|romanized|romaji|transliteration)[^)]*)\)/gi," ")
          .replace(/\s+/g," ").trim()
}

function coreDescriptorAgnosticTokens(tokens: string[]) {
  return tokens.filter(t => !DESCRIPTOR_KEYWORDS.has(t) && !NOISE_WORDS.has(t))
}

function titleLikelySame(a: string, b: string) {
  const av = generateTitleVariants(a)
  const bv = generateTitleVariants(b)
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

      const xCore = tokensWithoutFeatWords(removeDescriptorsTokens(xTokens))
      const yCore = tokensWithoutFeatWords(removeDescriptorsTokens(yTokens))
      const X = xCore.length ? xCore : xTokens
      const Y = yCore.length ? yCore : yTokens

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

interface MatchResult { url: string | null; debug?: any }

/* ================ Matching core ================ */
async function findGeniusUrl(title: string, artist: string, debug: boolean): Promise<MatchResult> {
  if (!geniusToken) return { url: null, debug: debug ? { reason: "no_token" } : undefined }

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
    penalizedFallback = penalizedFallback

    for (const h of hits) {
      const r = h.result
      const cTitle: string = r.title || r.full_title || ""
      const cArtist: string = r.primary_artist?.name || ""
      const reasons: string[] = []

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
        examined.push({
          id: r.id, title: cTitle, artist: cArtist,
          decision: reasons.join("|"), penalized: isPenalized
        })
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
