import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { cors } from 'https://deno.land/x/hono/middleware.ts'
import ytdl from "npm:@distube/ytdl-core"

/* ================= Config ================= */
const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN")

/* ========= BAD / NOISE / DESCRIPTOR ========= */
const BASE_BAD_WORDS = ["cover","karaoke","tribute","sped up","speed up","slowed","nightcore"]
const BAD_WORDS = [...BASE_BAD_WORDS]

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

const ROMANIZED_MARKERS = ["romanized","translation","translated","english"]

const NOISE_WORDS = new Set([
  "official","music","video","musicvideo","mv","pv","lyric","lyrics","ver","version",
  "visualizer","teaser","trailer","short","shorts","full","performance","live",
  "romanized","translation","translated","clip","hd","hq",
  ...EXTRA_NOISE
])
const STOPWORDS = new Set([...NOISE_WORDS])

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

/* Aggressive 括弧内削除トリガ */
const BRACKET_INNER_REMOVE_TRIGGERS = [
  "music","video","mv","pv","official","live","live ver","live version","performance",
  "session","lounge","tour","stage","studio",
  "behind","behind the scenes","bts","making","making of","making-of",
  "the first take","first take","youtube ver","youtube version","yt ver",
  "lyric","lyrics","english translation","translation","translated","romanized","romaji",
  "ver","version","alt ver","alternate","alternate ver","alternate version",
  "remix","mix","edit","demo","short ver","short version","short",
  "tv","tv size","tv-size","tvsize",
  "acoustic","piano","inst","instrumental","off vocal","off-vocal","offvocal",
  "visualizer","teaser","trailer","clip","full ver","full version",
  "english ver","english version","japanese ver","japanese version"
]

/* ================ Utility ================ */
const TOKEN_SPLIT_REGEX = /[\s\-_:/|.,!?]+/
const EMPTY_PARENS_REGEX = /\(\s*\)/g
const MULTI_SPACES_REGEX = /\s+/g
const ENGLISH_PARENS_STRIP = /\([A-Za-z0-9 ,.'&\-]+\)/g
const BRACKETS_SQ = /(\[[^\]]*])/g
const BRACKETS_ROUND = /(\([^)]*\))/g
const ARTIST_PREFIX_REGEX_PARTS_CACHE = new Map<string, RegExp>()

function normalizeJapaneseBrackets(s: string): string {
  return s.replace(/[「『【〈《]/g,"[").replace(/[」』】〉》]/g,"]")
}
function normalizeQuotes(s: string): string {
  return s.replace(/[“”]/g,'"').replace(/[’‘]/g,"'")
}
function normalizeSpaces(s: string) {
  return s.replace(MULTI_SPACES_REGEX," ").trim()
}
function tokenizeRaw(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[“”"’']/g," ")
    .replace(/[#(){}]/g," ")
    .split(TOKEN_SPLIT_REGEX)
    .filter(Boolean)
}
function tokenizeForMatch(s: string) {
  const raw = tokenizeRaw(s)
  const out: string[] = []
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue
    if (/^\d+$/.test(t)) continue
    out.push(t)
  }
  return out
}

/* 文字列 → 小文字＆記号除去（和文含む） */
function stripPunctLower(s: string) {
  return s.toLowerCase()
    .replace(/[\s'"!?:.,\-–—_]/g,"")
    .replace(/[！？。、（）（)【】「」『』·・…‥～]/g,"")
}

/* 括弧内削除条件 */
function bracketInnerShouldRemove(inner: string): boolean {
  const low = inner.toLowerCase()
  for (const w of BRACKET_INNER_REMOVE_TRIGGERS) {
    if (low.includes(w)) return true
  }
  return false
}

/* 括弧ノイズ除去 */
function stripBracketedNoise(title: string): string {
  // [ ... ]
  title = title.replace(BRACKETS_SQ, (m) => {
    const inner = m.slice(1,-1).trim()
    if (!inner) return " "
    if (bracketInnerShouldRemove(inner)) return " "
    const toks = inner.toLowerCase().split(/\s+/)
    if (toks.length && toks.every(w => NOISE_WORDS.has(w) || w === "official" || w === "mv" || w === "pv")) {
      return " "
    }
    return m
  })
  // ( ... )
  title = title.replace(BRACKETS_ROUND, (m) => {
    const inner = m.slice(1,-1).trim()
    if (!inner) return " "
    if (bracketInnerShouldRemove(inner)) return " "
    const lower = inner.toLowerCase()
    if (
      /(official|music|video|lyrics?|romanized|translation|ver|version|live|remix|mix|alternate|remastered|tv\s*size)/.test(lower)
    ) {
      const allNoise = lower.split(/\s+/).every(w => NOISE_WORDS.has(w) || DESCRIPTOR_KEYWORDS.has(w))
      if (allNoise) return " "
    }
    return m
  })
  return title
}

function removeMatchedParens(title: string): string {
  return title.replace(EMPTY_PARENS_REGEX," ").replace(MULTI_SPACES_REGEX," ").trim()
}

function dashTruncateIfNoise(title: string): string {
  for (const sep of DASH_SPLIT_SEPARATORS) {
    const idx = title.toLowerCase().indexOf(sep.trim())
    if (idx !== -1) {
      const parts = title.split(sep)
      if (parts.length > 1) {
        const first = parts[0].trim()
        const restTokens = tokenizeRaw(parts.slice(1).join(" ").toLowerCase())
        if (restTokens.length && restTokens.every(t => NOISE_WORDS.has(t)) && first.length >= 3) {
          return first
        }
      }
    }
  }
  return title
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")
}

function preNormalizeTitle(raw: string, artist: string): string {
  let t = normalizeJapaneseBrackets(normalizeQuotes(raw))
  const artistLc = artist.trim().toLowerCase()
  if (artistLc) {
    let reg = ARTIST_PREFIX_REGEX_PARTS_CACHE.get(artistLc)
    if (!reg) {
      reg = new RegExp(`^\\s*(${escapeRegex(artistLc)})\\s*[-–—/:|]\\s*(.+)$`,"i")
      ARTIST_PREFIX_REGEX_PARTS_CACHE.set(artistLc, reg)
    }
    const m = t.match(reg)
    if (m) t = m[2]
  }
  return t.replace(/\bby\s+[a-z0-9 .'\-]+(\s+of\s+[a-z0-9 .'\-]+)?$/i,"").trim()
}

function splitTitleFragments(title: string): string[] {
  return /\s*[\/／｜|]\s*/.test(title)
    ? title.split(/\s*[\/／｜|]\s*/).filter(p => p.trim().length > 0)
    : [title]
}

function basicCleanTitle(raw: string): string {
  let t = stripBracketedNoise(raw)
  t = removeMatchedParens(t)
  t = dashTruncateIfNoise(t)
  const toks = tokenizeRaw(t)
  if (toks.length <= 1) return toks.join(" ")
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
  return { coverDetected, coreTitle: normalizeSpaces(work), originalRaw: raw }
}

/* ================ Descriptor / feat 処理（厳密用） ================ */
function extractDescriptorBase(text: string): string {
  let out = text.replace(/\(([^)]*)\)/g, (m, inner) => {
    const innerTrim = String(inner).trim()
    if (!innerTrim) return " "
    if (bracketInnerShouldRemove(innerTrim)) return " "
    const innerTokens = tokenizeRaw(innerTrim)
    if (innerTokens.length && innerTokens.every(t => DESCRIPTOR_KEYWORDS.has(t) || NOISE_WORDS.has(t))) return " "
    return m
  })
  const toks = tokenizeRaw(out)
  while (toks.length) {
    const last = toks[toks.length - 1]
    if (DESCRIPTOR_KEYWORDS.has(last) || NOISE_WORDS.has(last)) { toks.pop(); continue }
    break
  }
  return normalizeSpaces(toks.join(" "))
}

/* ================ Artist match (cached) ================ */
const artistMatchCache = new Map<string, boolean>()
function artistVariants(name: string): string[] {
  const v = new Set<string>()
  const trimmed = name.trim()
  if (trimmed) v.add(trimmed.toLowerCase())
  const parens = name.match(/\(([^)]*)\)/g)
  if (parens) {
    for (const p of parens) {
      const inner = p.slice(1,-1).trim().toLowerCase()
      if (inner) v.add(inner)
    }
  }
  const noParen = name.replace(/\([^)]*\)/g," ").replace(MULTI_SPACES_REGEX," ").trim().toLowerCase()
  if (noParen) v.add(noParen)
  return [...v]
}

function artistRoughMatch(queryArtist: string, candidateArtist: string) {
  const key = queryArtist + "||" + candidateArtist
  if (artistMatchCache.has(key)) return artistMatchCache.get(key)!
  const qVars = artistVariants(queryArtist)
  const cVars = artistVariants(candidateArtist)
  for (const qa of qVars) {
    const qs = stripPunctLower(qa)
    if (!qs) continue
    for (const ca of cVars) {
      const cs = stripPunctLower(ca)
      if (!cs) continue
      if (qs === cs) { artistMatchCache.set(key,true); return true }
      if ((qs.length >= 3 && cs.includes(qs)) || (cs.length >= 3 && qs.includes(cs))) { artistMatchCache.set(key,true); return true }
      const qTokens = tokenizeForMatch(qa)
      const cTokens = tokenizeForMatch(ca)
      if (qTokens.length && cTokens.length) {
        for (const t of qTokens) {
          if (cTokens.includes(t)) { artistMatchCache.set(key,true); return true }
        }
      }
    }
  }
  artistMatchCache.set(key,false)
  // 簡易 LRU: サイズ超過時に先頭要素削除
  if (artistMatchCache.size > 512) {
    const firstKey = artistMatchCache.keys().next().value
    artistMatchCache.delete(firstKey)
  }
  return false
}

/* ================ Title match (strict with cache) ================ */
function removeParentheticalRomanization(s: string): string {
  return s.replace(/\(([^(]*?(?:english|translation|romanized|romaji|transliteration)[^)]*)\)/gi," ")
          .replace(MULTI_SPACES_REGEX," ").trim()
}

const canonicalCache = new Map<string,string>()
function canonicalBase(raw: string): string {
  if (!raw) return ""
  if (canonicalCache.has(raw)) return canonicalCache.get(raw)!
  let t = basicCleanTitle(raw)
  t = t.replace(/\b(feat|ft|featuring|with)\b.*$/i,"").trim()
  const desc = extractDescriptorBase(t)
  if (desc) t = desc
  t = removeParentheticalRomanization(t)
  t = stripPunctLower(t.normalize("NFKC"))
  canonicalCache.set(raw, t)
  if (canonicalCache.size > 512) {
    const fk = canonicalCache.keys().next().value
    canonicalCache.delete(fk)
  }
  return t
}

function titleLikelySame(a: string, b: string) {
  const ca = canonicalBase(a)
  const cb = canonicalBase(b)
  return !!ca && ca === cb
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

/* ================ Helpers ================ */
function hasBadWord(candidateTitle: string, originalTitle: string) {
  const c = candidateTitle.toLowerCase()
  const o = originalTitle.toLowerCase()
  for (const w of BAD_WORDS) {
    if (c.includes(w) && !o.includes(w)) return true
  }
  return false
}

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
  if (descriptorBase && descriptorBase !== cleaned) queries.push({ label: "no_descriptor", q: `${descriptorBase} ${artist}` })
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

  for (let i = 0; i < fragmentCores.length; i++) {
    const fc = fragmentCores[i]
    if (fc !== baseTitle) {
      queries.push({ label: `fragment_${i}`, q: `${fc} ${artist}` })
      queries.push({ label: `fragment_${i}_title_only`, q: fc })
    }
  }

  // 重複除去
  const seen = new Set<string>()
  const finalQueries: { label: string; q: string }[] = []
  for (const q of queries) {
    const k = q.q.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    finalQueries.push(q)
  }

  const debugLogs: any[] = []
  let acceptedGlobal: any = null
  let penalizedFallback: any = null

  const origLower = title.toLowerCase()
  const queryCanonical = canonicalBase(title)

  for (const q of finalQueries) {
    let hits: any[] = []
    try {
      hits = await geniusSearch(q.q)
    } catch {
      /* ignore network errors */
    }

    const examined: any[] = []
    let acceptedInQuery: any = null

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

      const needArtist = !(q.label.includes("title_only"))
      if (needArtist && !artistRoughMatch(artist, cArtist)) {
        reasons.push("reject:artist_mismatch")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|") })
        continue
      }

      const cLower = cTitle.toLowerCase()
      let isPenalized = false
      if (!ROMANIZED_MARKERS.some(m => origLower.includes(m))) {
        if (ROMANIZED_MARKERS.some(m => cLower.includes(m))) isPenalized = true
      }

      const candidateCanonical = canonicalBase(cTitle)
      const same = queryCanonical && candidateCanonical && queryCanonical === candidateCanonical
      if (!same) {
        reasons.push("reject:title_mismatch_strict")
        examined.push({
          id: r.id,
            title: cTitle,
            artist: cArtist,
            decision: reasons.join("|"),
            penalized: isPenalized,
            canonical_query: queryCanonical,
            canonical_candidate: candidateCanonical
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
          penalized: true,
          canonical_query: queryCanonical,
          canonical_candidate: candidateCanonical
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
        penalized: false,
        canonical_query: queryCanonical,
        canonical_candidate: candidateCanonical
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
      strictMode: true,
      canonical_query: queryCanonical,
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
