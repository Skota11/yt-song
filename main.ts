import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { cors } from 'https://deno.land/x/hono/middleware.ts'
import ytdl from "npm:@distube/ytdl-core"

/* ================= Config (minimal + descriptor & cover) ================= */
const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN")

const BAD_WORDS = [
  "cover","karaoke","tribute","sped up","speed up","slowed","nightcore"
]

// Romanized/翻訳ページ優先度制御用マーカー（BAD_WORDS には入れず保留評価）
const ROMANIZED_MARKERS = ["romanized","translation","translated"]

const NOISE_WORDS = new Set([
  "official","music","video","musicvideo","mv","pv","lyric","lyrics","ver","version",
  "visualizer","teaser","trailer","short","shorts","full","performance","live",
  "romanized","translation","translated","clip","hd","hq"
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
  "original"
])

/* ================ Utility ================ */
function normalizeSpaces(s: string) {
  return s.replace(/\s+/g," ").trim()
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
    const innerTokens = tokenizeRaw(inner)
    if (innerTokens.length && innerTokens.every(t => DESCRIPTOR_KEYWORDS.has(t))) {
      return " "
    }
    return m
  })
  const toks = tokenizeRaw(out)
  while (toks.length) {
    const last = toks[toks.length - 1]
    if (DESCRIPTOR_KEYWORDS.has(last)) { toks.pop(); continue }
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
  const noEngParen = cleaned.replace(/\([A-Za-z0-9 ,.'&\-]+\)/g, " ").replace(/\s+/g," ").trim()
  if (noEngParen && !set.has(noEngParen)) set.add(noEngParen)
  const descBase = extractDescriptorBase(cleaned)
  if (descBase && !set.has(descBase)) set.add(descBase)
  const noFeatDesc = extractDescriptorBase(noFeat)
  if (noFeatDesc && !set.has(noFeatDesc)) set.add(noFeatDesc)
  const noEngDesc = extractDescriptorBase(noEngParen)
  if (noEngDesc && !set.has(noEngDesc)) set.add(noEngDesc)
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
function titleLikelySame(a: string, b: string) {
  const av = generateTitleVariants(a)
  const bv = generateTitleVariants(b)
  for (const x of av) {
    for (const y of bv) {
      if (x.toLowerCase() === y.toLowerCase()) return true
      const xTokens = tokenizeForMatch(x)
      const yTokens = tokenizeForMatch(y)
      if (!xTokens.length || !yTokens.length) continue
      const xCore = tokensWithoutFeatWords(removeDescriptorsTokens(xTokens))
      const yCore = tokensWithoutFeatWords(removeDescriptorsTokens(yTokens))
      const X = xCore.length ? xCore : xTokens
      const Y = yCore.length ? yCore : yTokens
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

  const cleaned = basicCleanTitle(title)
  const dashReduced = dashTruncateIfNoise(cleaned)
  const { coverDetected, coreTitle } = extractCoreTitle(cleaned)
  const descriptorBase = extractDescriptorBase(cleaned)
  const baseTitle = extractDescriptorBase(
    cleaned.replace(/\b(feat|ft|featuring|with)\b.*$/i,"").trim()
  ) || cleaned

  const queries: { label: string; q: string }[] = []
  queries.push({ label: "raw", q: `${title} ${artist}` })
  if (cleaned !== title) queries.push({ label: "cleaned", q: `${cleaned} ${artist}` })
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

      // Romanized / Translation ページ判定（元タイトルに無い場合のみ penalize）
      const cLower = cTitle.toLowerCase()
      let isPenalized = false
      if (!ROMANIZED_MARKERS.some(m => origLower.includes(m))) {
        if (ROMANIZED_MARKERS.some(m => cLower.includes(m))) {
          isPenalized = true
        }
      }

      // タイトル一致判定
      const same =
        titleLikelySame(title, cTitle) ||
        (coreTitle && titleLikelySame(coreTitle, cTitle)) ||
        (descriptorBase && titleLikelySame(descriptorBase, cTitle)) ||
        (baseTitle && titleLikelySame(baseTitle, cTitle))

      if (!same) {
        reasons.push("reject:title_mismatch")
        examined.push({ id: r.id, title: cTitle, artist: cArtist, decision: reasons.join("|"), penalized: isPenalized })
        continue
      }

      if (isPenalized) {
        // まだ非 penalized を確定していなければ保留
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
        // 最初の penalized 保留だけ保持（より後ろの penalized は無視）
        if (!penalizedFallback) penalizedFallback = penal
        continue
      }

      // 非 penalized accept
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
    // 非 penalized が取れず、他クエリをまだ試す。最後まで無ければ penalizedFallback を使う
  }

  if (!acceptedGlobal && penalizedFallback) {
    // 最終的に非 penalized なし → penalizedFallback 採用
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
