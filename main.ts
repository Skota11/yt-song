import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { cors } from 'https://deno.land/x/hono/middleware.ts'
import ytdl from "npm:@distube/ytdl-core"

const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN")

const BAD_WORDS = [
  "cover" , "romanized" , "translation"
]

const FEATURE_WORDS = ["feat","ft","featuring","with"]

const PAREN_REMOVABLE_MULTI = [
  "the first take",
  "english translation","live ver","live version","short ver","short version",
  "alt ver","alternate ver","alternate version","tv size","first take",
  "music video","official video","official mv"
]

const PAREN_REMOVABLE_SINGLE = [
  "instrumental","inst","offvocal","off-vocal","acoustic","piano","remix","mix","edit","demo",
  "live","ver","version","romanized","romaji","translation","english","tv","short","karaoke",
  "mv","official","video","visualizer","teaser","trailer","music"
]

const TOKEN_SPLIT = /[ \t\-–—_:|\/.,!?()\[\]]+/
const JP_REGEX = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}々ー〇ヶ]/u
const ASCII_ROMAJI_PAREN = /^[A-Za-z0-9 .'_+\-]+$/

function nfkcLower(s:string){ return s.normalize("NFKC").toLowerCase() }
function stripPunctCanonical(s:string){
  return nfkcLower(s)
    .replace(/[\s'"!?:.,\-–—_]/g,"")
    .replace(/[！？。、（）【】「」『』·・…‥～]/g,"")
}

function isAllRemovableTokens(seg: string): boolean {
  let low = nfkcLower(seg).trim()
  if (!low) return true
  low = low.replace(/(\([^)]*\)|\[[^\]]*])/g, " ").replace(/\s+/g, " ").trim()
  if (!low) return true
  for (const phrase of PAREN_REMOVABLE_MULTI) {
    if (low === phrase) return true
    if (low.startsWith(phrase + " ")) {
      const rest = low.slice(phrase.length).trim()
      if (isAllRemovableTokens(rest)) return true
    }
  }
  const toks = low.split(TOKEN_SPLIT).filter(Boolean)
  if (!toks.length) return true
  return toks.every(t =>
    PAREN_REMOVABLE_SINGLE.includes(t) ||
    PAREN_REMOVABLE_MULTI.includes(t)
  )
}

function stripTrailingSeparatorNoise(raw: string): string {
  const sepRegex = /(.+?)[\s]*[-–—|｜][\s]*([^]+)$/
  const m = raw.match(sepRegex)
  if (!m) return raw
  const left = m[1].trim()
  const right = m[2].trim()
  if (!right) return left
  if (isAllRemovableTokens(right)) return left
  return raw
}

interface ParenInfo { raw:string; inner:string; role:ParenRole }
type ParenRole = "romanization" | "translation" | "descriptor" | "feature" | "edition" | "other"

interface ParsedTitle {
  raw: string
  base: string
  parens: ParenInfo[]
  featureTail: string[]
  hasJapanese: boolean
}

function classifyParen(inner: string, contextHasJapanese: boolean): ParenRole {
  const low = nfkcLower(inner).trim()
  if (!low) return "other"
  if (/^(feat|ft|featuring|with)\b/.test(low)) return "feature"
  if (PAREN_REMOVABLE_MULTI.some(m => low.includes(m))) {
    if (/(translation|english)/.test(low)) return "translation"
    if (/live/.test(low)) return "descriptor"
    return "edition"
  }
  if (/(translation|english)/.test(low)) return "translation"
  if (/(romanized|romaji)/.test(low)) return "romanization"
  if (contextHasJapanese && ASCII_ROMAJI_PAREN.test(inner) && /^[A-Za-z]/.test(inner)) {
    return "romanization"
  }
  if (/(instrumental|inst|live|ver|version|remix|mix|short|demo|edit|acoustic|piano|karaoke|off vocal|off-vocal|offvocal)/.test(low)) return "descriptor"
  if (/(official|mv|music|video|visualizer|teaser|trailer)/.test(low)) return "edition"
  return "other"
}

function trimTrailingNoise(tokens: string[]): string[] {
  while (tokens.length) {
    let removed = false
    const multiSorted = [...PAREN_REMOVABLE_MULTI].sort((a,b)=> b.length - a.length)
    for (const phrase of multiSorted) {
      const pToks = phrase.split(/\s+/)
      if (tokens.length >= pToks.length) {
        const tail = tokens.slice(-pToks.length).join(" ")
        if (tail === phrase) {
          tokens.splice(-pToks.length, pToks.length)
            removed = true
          break
        }
      }
    }
    if (removed) continue
    const last = tokens[tokens.length - 1]
    if (PAREN_REMOVABLE_SINGLE.includes(last)) {
      tokens.pop()
      continue
    }
    break
  }
  return tokens
}

function parseTitle(raw: string): ParsedTitle {
  let normalized = raw
    .replace(/[「『【〈《]/g,"(")
    .replace(/[」』】〉》]/g,")")
  normalized = stripTrailingSeparatorNoise(normalized)
  const hasJp = JP_REGEX.test(normalized)
  const parens: ParenInfo[] = []
  let work = normalized
  work = work.replace(/(\([^)]*\)|\[[^\]]*])/g, (m)=>{
    const inner = m.slice(1,-1)
    parens.push({ raw:m, inner, role: classifyParen(inner, hasJp) })
    return " "
  })
  const tokens = nfkcLower(work).split(TOKEN_SPLIT).filter(Boolean)
  let featureTail: string[] = []
  const idx = tokens.findIndex(t => FEATURE_WORDS.includes(t))
  let baseTokens: string[]
  if (idx !== -1) {
    featureTail = tokens.slice(idx)
    baseTokens = tokens.slice(0, idx)
  } else {
    baseTokens = tokens
  }
  baseTokens = trimTrailingNoise(baseTokens)
  return {
    raw,
    base: baseTokens.join(" ").trim(),
    parens,
    featureTail,
    hasJapanese: hasJp
  }
}

interface TitleVariants {
  parsed: ParsedTitle
  variants: Set<string>
  romaji: string[]
  jp?: string
  tokens: string[]
}

function asciiRomajiNormalize(s:string){
  return nfkcLower(s).replace(/[^a-z0-9]+/g,"")
}

function buildTitleVariants(raw: string): TitleVariants {
  const parsed = parseTitle(raw)
  const variants = new Set<string>()
  const baseCanon = stripPunctCanonical(parsed.base)
  if (baseCanon) variants.add(baseCanon)
  const romajiList: string[] = []
  for (const p of parsed.parens) {
    if (p.role === "romanization") {
      const r = asciiRomajiNormalize(p.inner)
      if (r) { variants.add(r); romajiList.push(r) }
    } else if (p.role === "translation") {
      const t = stripPunctCanonical(p.inner)
      if (t) variants.add(t)
    }
  }
  if (parsed.parens.some(p => p.role==="romanization" || p.role==="translation")) {
    const collapsed = parsed.base + parsed.parens
      .filter(p => p.role==="romanization"||p.role==="translation")
      .map(p=>p.inner).join("")
    const colCanon = stripPunctCanonical(collapsed)
    if (colCanon) variants.add(colCanon)
  }
  if (!parsed.hasJapanese) {
    const asciiNorm = asciiRomajiNormalize(parsed.base)
    if (asciiNorm) variants.add(asciiNorm)
  }
  const tokens = parsed.base.split(/\s+/).filter(Boolean).map(t => stripPunctCanonical(t)).filter(Boolean)
  return {
    parsed,
    variants,
    romaji: romajiList,
    jp: parsed.hasJapanese ? parsed.base : undefined,
    tokens
  }
}

function titleMatches(query: TitleVariants, candidate: TitleVariants, opts:{allowJapaneseVsRomajiAlone:boolean}): boolean {
  for (const v of query.variants) {
    if (candidate.variants.has(v)) return true
  }
  if (opts.allowJapaneseVsRomajiAlone) {
    if (query.jp && candidate.romaji.includes(asciiRomajiNormalize(query.jp))) return true
    if (candidate.jp && query.romaji.includes(asciiRomajiNormalize(candidate.jp))) return true
  }
  const qTokens = query.tokens
  const cTokens = candidate.tokens
  if (qTokens.length && cTokens.length) {
    const setQ = new Set(qTokens)
    const shared = cTokens.filter(t => setQ.has(t))
    const minLen = Math.min(qTokens.length, cTokens.length)
    if (minLen >= 2 && shared.length === minLen && minLen <= 3) return true
  }
  return false
}

function buildArtistVariants(name: string): Set<string> {
  const low = nfkcLower(name)
  const segments = low.split(/[,&/・＋+]/).map(s=>s.trim()).filter(Boolean)
  const out = new Set<string>()
  for (const seg of segments) {
    const main = seg.replace(/\([^)]*\)/g," ").replace(/\s+/g," ").trim()
    if (main) out.add(stripPunctCanonical(main))
    const parens = seg.match(/\(([^)]*)\)/g)
    if (parens) {
      for (const p of parens) {
        const inner = p.slice(1,-1).trim()
        if (inner) out.add(stripPunctCanonical(inner))
      }
    }
  }
  return out
}

function artistMatches(queryArtist: string, candidateArtist: string): boolean {
  if (!queryArtist) return true
  const qa = buildArtistVariants(queryArtist)
  const ca = buildArtistVariants(candidateArtist)
  for (const v of qa) {
    if (ca.has(v)) return true
    for (const w of ca) {
      if (v.length >= 4 && (w.includes(v) || v.includes(w))) return true
    }
  }
  return false
}

function containsBadWordOnlyInCandidate(candidateTitle: string, originalTitle: string): boolean {
  const c = nfkcLower(candidateTitle)
  const o = nfkcLower(originalTitle)
  for (const w of BAD_WORDS) {
    if (c.includes(w) && !o.includes(w)) return true
  }
  return false
}

async function geniusSearch(q: string) {
  if (!geniusToken) return []
  const url = `https://api.genius.com/search?q=${encodeURIComponent(q)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${geniusToken}` } })
  if (!res.ok) return []
  const json = await res.json()
  return json.response?.hits || []
}

function stripLeadingArtistFromBase(base: string, artist: string): string {
  if (!artist) return base
  const artistTokens = nfkcLower(artist).split(TOKEN_SPLIT).filter(Boolean)
  if (!artistTokens.length) return base
  const baseTokens = nfkcLower(base).split(/\s+/).filter(Boolean)
  let i = 0
  while (i < artistTokens.length && i < baseTokens.length && baseTokens[i] === artistTokens[i]) {
    i++
  }
  if (i > 0) {
    return baseTokens.slice(i).join(' ') || base
  }
  return base
}

function buildQueriesFor(title: string, artist: string, tv: TitleVariants) {
  const qs: {label:string; q:string; requireArtist:boolean}[] = []
  const rawBase = tv.parsed.base
  const baseWithoutArtist = stripLeadingArtistFromBase(rawBase, artist) || rawBase
  const jpTokens = baseWithoutArtist
    .split(/\s+/)
    .filter(t => JP_REGEX.test(t))
  const jpOnly = jpTokens.join(' ').trim()
  if (jpOnly) qs.push({ label:"jp_base+artist", q: `${jpOnly} ${artist}`, requireArtist:true })
  qs.push({ label:"base+artist", q: `${baseWithoutArtist} ${artist}`, requireArtist:true })
  if (jpOnly) qs.push({ label:"jp_only", q: jpOnly, requireArtist:false })
  qs.push({ label:"base_only", q: baseWithoutArtist, requireArtist:false })
  for (const p of tv.parsed.parens) {
    if (p.role === "romanization" || p.role === "translation") {
      qs.push({ label:`paren_${p.role}`, q: `${p.inner} ${artist}`, requireArtist:true })
    }
  }
  for (const p of tv.parsed.parens) {
    if (p.role === "romanization") {
      qs.push({ label:"romaji_only", q: p.inner, requireArtist:false })
    }
  }
  const seen = new Set<string>()
  return qs.filter(x=>{
    const k = x.q.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

async function findGeniusUrl(title: string, artist: string): Promise<string | null> {
  if (!geniusToken) return null
  const queryTV = buildTitleVariants(title)
  const queries = buildQueriesFor(title, artist, queryTV)
  for (const q of queries) {
    let hits: any[] = []
    try {
      hits = await geniusSearch(q.q)
    } catch {}
    for (const h of hits) {
      const r = h.result
      const cTitle = r.title || r.full_title || ""
      const cArtist = r.primary_artist?.name || ""
      if (/\b(chapter|interview|review|article)\b/i.test(cTitle)) continue
      if (containsBadWordOnlyInCandidate(cTitle, title)) continue
      const candidateTV = buildTitleVariants(cTitle)
      const titlesOk = titleMatches(queryTV, candidateTV, { allowJapaneseVsRomajiAlone:true })
      if (!titlesOk) continue
      if (q.requireArtist && !artistMatches(artist, cArtist)) continue
      return {url : r.url , id : r.id}
    }
  }
  return null
}

const app = new Hono()
app.use("/", cors())

app.get("/track", async (c) => {
  const videoId = c.req.query("v")
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
  const genius_result = await findGeniusUrl(title, artist)
  return c.json({ song: true, title, artist, thumbnail, genius_url : genius_result.url , genius_id : genius_result.id })
})

Deno.serve(app.fetch)
