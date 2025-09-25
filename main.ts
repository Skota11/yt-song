import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { cors } from 'https://deno.land/x/hono/middleware.ts'
import ytdl from "npm:@distube/ytdl-core"

/* ================= Config ================= */
const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN")

const BAD_WORDS = [
  "cover","karaoke","tribute","sped up","speed up","slowed","nightcore"
]

const NOISE_WORDS = new Set([
  "official","music","video","musicvideo","mv","pv","lyric","lyrics","ver","version",
  "visualizer","teaser","trailer","short","shorts","full","performance","live",
  "romanized","translation","translated","clip","hd","hq"
])

const STOPWORDS = new Set([...NOISE_WORDS])
const MIN_TOKEN_OVERLAP = 0.6
const DASH_SPLIT_SEPARATORS = [" - ", " | "]

/* --- Cover detection patterns --- */
const COVER_MARKERS = /(歌ってみた|covered?\s+by|cover\s+by|カバー|cover)/i
const COVER_REMOVE_PATTERNS: RegExp[] = [
  /\bcovered?\s+by\s+[^\s].*$/i,
  /\bcover\s+by\s+[^\s].*$/i,
  /\bcovered?\s+[^\s].*$/i,
  /カバー(?:\s*by)?\s*.+$/i,
  /歌ってみた.*$/i
]

/* --- NEW: feat 判定語 --- */
const FEAT_WORDS = new Set(["feat","ft","featuring"])

/* ================ Utility: Normalization ================ */
function normalizeSpaces(s: string) {
  return s.replace(/\s+/g," ").trim()
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
      if (/(official|music|video|lyrics?|romanized|translation|ver|version)/.test(inner) &&
          inner.split(/\s+/).every(w => NOISE_WORDS.has(w) || /^(official|mv|pv)$/.test(w))) {
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

/* ================ Cover Title Extraction ================ */
interface CoverExtraction {
  coverDetected: boolean
  coreTitle: string
  originalRaw: string
}

function extractCoreTitle(raw: string): CoverExtraction {
  let work = raw
  let coverDetected = false

  work = work.replace(/^[【\[]([^】\]]+)[】\]]\s*/g, (_m, inner) => {
    if (COVER_MARKERS.test(inner)) {
      coverDetected = true
      return ""
    }
    return _m
  })

  for (const re of COVER_REMOVE_PATTERNS) {
    if (re.test(work)) {
      coverDetected = true
      work = work.replace(re, "").trim()
    }
  }

  work = work.replace(/\bcover\s*$/i, () => {
    coverDetected = true
    return ""
  }).trim()

  work = normalizeSpaces(work)

  return {
    coverDetected,
    coreTitle: work,
    originalRaw: raw
  }
}

/* ================ Artist Matching (dynamic only) ================ */
function artistVariants(name: string): string[] {
  const variants = new Set<string>()
  const trimmed = name.trim()
  if (trimmed) variants.add(trimmed.toLowerCase())

  const parens = name.match(/\(([^)]*)\)/g)
  if (parens) {
    for (const p of parens) {
      const inner = p.replace(/[()]/g,"").trim().toLowerCase()
      if (inner) variants.add(inner)
    }
  }
  const noParen = name.replace(/\([^)]*\)/g," ").replace(/\s+/g," ").trim().toLowerCase()
  if (noParen) variants.add(noParen)

  return Array.from(variants)
}

function artistRoughMatch(queryArtist: string, candidateArtist: string) {
  const qVars = artistVariants(queryArtist)
  const cVars = artistVariants(candidateArtist)

  for (const qv of qVars) {
    for (const cv of cVars) {
      if (!qv || !cv) continue
      const qStr = stripPunctLower(qv)
      const cStr = stripPunctLower(cv)
      if (!qStr || !cStr) continue

      if (qStr === cStr) return true
      if ((qStr.length >= 3 && cStr.includes(qStr)) || (cStr.length >= 3 && qStr.includes(cStr))) return true

      const qTokens = tokenizeForMatch(qv)
      const cTokens = tokenizeForMatch(cv)
      if (qTokens.length && cTokens.length) {
        const shared = qTokens.filter(t => cTokens.includes(t))
        if (shared.length > 0) return true
      }

      if (qStr.length <= 6 || cStr.length <= 6) {
        if (cStr.startsWith(qStr) || cStr.endsWith(qStr) || qStr.startsWith(cStr) || qStr.endsWith(cStr)) {
          return true
        }
      }
    }
  }
  return false
}

/* ================ NEW: Title Variants (feat/英語括弧無視) ================ */
function generateTitleVariants(raw: string): string[] {
  const variants = new Set<string>()
  const cleaned = basicCleanTitle(raw)
  variants.add(cleaned)

  // feat 部分を落とす
  const noFeat = cleaned.replace(/\b(feat|ft|featuring)\b.*$/i, "").trim()
  if (noFeat && noFeat !== cleaned) variants.add(noFeat)

  // 英語のみ括弧 (translation / romaji っぽい) を削除
  const noEngParen = cleaned.replace(/\([A-Za-z0-9 ,.'&\-]+\)/g, " ").replace(/\s+/g," ").trim()
  if (noEngParen && !variants.has(noEngParen)) variants.add(noEngParen)

  // 両方適用（順序関係あるので再度）
  const noFeatNoEngParen = noFeat
    .replace(/\([A-Za-z0-9 ,.'&\-]+\)/g, " ")
    .replace(/\s+/g," ").trim()
  if (noFeatNoEngParen && !variants.has(noFeatNoEngParen)) variants.add(noFeatNoEngParen)

  return Array.from(variants).filter(v => v.length > 0)
}

function tokensWithoutFeatWords(tokens: string[]) {
  return tokens.filter(t => !FEAT_WORDS.has(t))
}

/* ================ Title Matching (with variants) ================ */
function hasBadWord(candidateTitle: string, originalTitle: string) {
  const c = candidateTitle.toLowerCase()
  const o = originalTitle.toLowerCase()
  for (const w of BAD_WORDS) {
    if (c.includes(w) && !o.includes(w)) return true
  }
  return false
}

/**
 * 変更点:
 *  - 両タイトルのバリアント生成
 *  - 各組合せで従来の一致基準 (完全一致 / overlap / 包含) を評価
 *  - overlap は feat 語と英訳括弧除去後の token set でも再計算
 */
function titleLikelySame(origTitle: string, candTitle: string) {
  const origVariants = generateTitleVariants(origTitle)
  const candVariants = generateTitleVariants(candTitle)

  for (const ov of origVariants) {
    for (const cv of candVariants) {
      if (ov.toLowerCase() === cv.toLowerCase()) return true

      const oTokens = tokenizeForMatch(ov)
      const cTokens = tokenizeForMatch(cv)
      if (!oTokens.length || !cTokens.length) continue

      const oCore = tokensWithoutFeatWords(oTokens)
      const cCore = tokensWithoutFeatWords(cTokens)

      // コアが空になった場合 fallback
      const oUse = oCore.length ? oCore : oTokens
      const cUse = cCore.length ? cCore : cTokens

      const shared = oUse.filter(t => cUse.includes(t))
      const minLen = Math.min(oUse.length, cUse.length)
      const overlap = shared.length / (minLen || 1)

      if (overlap >= MIN_TOKEN_OVERLAP) return true

      // subset（小さい方の全トークンがもう片方に含まれる）
      if (shared.length === minLen && minLen >= 1) return true

      // 文字列包含
      const oStr = stripPunctLower(ov)
      const cStr = stripPunctLower(cv)
      if (oStr.includes(cStr) || cStr.includes(oStr)) return true
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

/* ================ Matching Core ================ */
interface MatchResult {
  url: string | null
  debug?: any
}

async function findGeniusUrl(title: string, artist: string, debug: boolean): Promise<MatchResult> {
  if (!geniusToken) return { url: null, debug: debug ? { reason: "no_token" } : undefined }

  const cleanedTitle = basicCleanTitle(title)
  const dashReduced = dashTruncateIfNoise(cleanedTitle)
  const { coverDetected, coreTitle } = extractCoreTitle(cleanedTitle)

  const queries: { label: string; q: string }[] = []
  queries.push({ label: "raw", q: `${title} ${artist}` })
  if (cleanedTitle !== title) queries.push({ label: "cleaned", q: `${cleanedTitle} ${artist}` })
  if (dashReduced !== cleanedTitle) queries.push({ label: "dash_reduced", q: `${dashReduced} ${artist}` })

  if (coverDetected) {
    if (coreTitle && coreTitle !== cleanedTitle) {
      queries.push({ label: "cover_core", q: `${coreTitle} ${artist}` })
      queries.push({ label: "cover_core_title_only", q: coreTitle })
    } else {
      queries.push({ label: "cover_title_only", q: cleanedTitle })
    }
  }

  const debugLogs: any[] = []
  let acceptedGlobal: any = null

  for (const q of queries) {
    let hits: any[] = []
    try {
      hits = await geniusSearch(q.q)
    } catch {
      continue
    }

    let accepted: any = null
    const examined: any[] = []

    for (const h of hits) {
      const r = h.result
      const cTitle = r.title || r.full_title || ""
      const cArtist = r.primary_artist?.name || ""
      const reasons: string[] = []

      if (hasBadWord(cTitle, title)) {
        reasons.push("reject:bad_word")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|") })
        continue
      }

      const needArtistMatch = !q.label.endsWith("title_only")
      if (needArtistMatch && !artistRoughMatch(artist, cArtist)) {
        reasons.push("reject:artist_mismatch")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|") })
        continue
      }

      // coreTitle も fallback としてチェック
      if (!titleLikelySame(title, cTitle) &&
          !(coreTitle && titleLikelySame(coreTitle, cTitle))) {
        reasons.push("reject:title_mismatch")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|") })
        continue
      }

      reasons.push("accept")
      accepted = {
        id: r.id,
        title: cTitle,
        artist: cArtist,
        url: r.url,
        decision: reasons.join("|"),
        usedQuery: q.label
      }
      examined.push(accepted)
      break
    }

    debugLogs.push({ query: q, examined })
    if (accepted) {
      acceptedGlobal = accepted
      break
    }
  }

  return {
    url: acceptedGlobal ? acceptedGlobal.url : null,
    debug: debug ? {
      accepted: acceptedGlobal,
      coverDetected,
      coreTitle,
      steps: debugLogs
    } : undefined
  }
}

/* ================ Route ================ */
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
    d.engagementPanelSectionListRenderer?.panelIdentifier ===
    "engagement-panel-structured-description"
  )

  const songsSection = engagementPanel?.engagementPanelSectionListRenderer?.content
    ?.structuredDescriptionContentRenderer?.items?.find((d: any) =>
      d.horizontalCardListRenderer !== undefined
    )

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
