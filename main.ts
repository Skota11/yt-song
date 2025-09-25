import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { cors } from 'https://deno.land/x/hono/middleware.ts'
import ytdl from "npm:@distube/ytdl-core";

const app = new Hono()
const geniusToken = Deno.env.get("GENIUS_ACCESS_TOKEN")

app.use('/', cors())
app.get("/track", async (c) => {
  const videoId = c.req.query("v");

  if (!videoId) {
    return c.json({ error: "Video ID is required" }, 400);
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const info = await ytdl.getBasicInfo(videoUrl);

  const engagementPanel = info.response.engagementPanels.find((d) => {
    return (
      d.engagementPanelSectionListRenderer.panelIdentifier ==
      "engagement-panel-structured-description"
    );
  });
  const songs =
    engagementPanel.engagementPanelSectionListRenderer.content.structuredDescriptionContentRenderer.items.find(
      (d) => {
        return d.horizontalCardListRenderer !== undefined;
      }
    );
  if (songs) {
    const title = songs.horizontalCardListRenderer.cards[0].videoAttributeViewModel.title
    const artist = songs.horizontalCardListRenderer.cards[0].videoAttributeViewModel.subtitle
    let lyricsUrl = null;
    const searchQuery = `${title} ${artist}`;
    const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(searchQuery)}`;

    const searchResponse = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${geniusToken}`,
      },
    });

    const searchData = await searchResponse.json();
    if (searchData.response.hits.length) {
      const song = searchData.response.hits[0].result;
      lyricsUrl = song.url;
      console.log(song)
    }
    return c.json({
      song: true,
      title:
        songs.horizontalCardListRenderer.cards[0].videoAttributeViewModel.title,
      artist:
        songs.horizontalCardListRenderer.cards[0].videoAttributeViewModel
          .subtitle,
      thumbnail:
        songs.horizontalCardListRenderer.cards[0].videoAttributeViewModel.image
          .sources[0].url,
      genius_url : lyricsUrl
    });
  } else {
    return c.json({ song: false });
  }
});
Deno.serve(app.fetch)