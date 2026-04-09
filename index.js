import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import http from 'node:http';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import OpenAI from 'openai';
import play from 'play-dl';
import ytSearch from 'yt-search';

// ─── Config ────────────────────────────────────────────────────────────────────

function readEnv(name, placeholder) {
  const rawValue = process.env[name]?.trim();
  const value = rawValue?.replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!value || value === placeholder) {
    return null;
  }
  return value;
}

const DISCORD_TOKEN   = readEnv('DISCORD_TOKEN', 'your-discord-bot-token-here');
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
const OPENAI_API_KEY  = readEnv('OPENAI_API_KEY', 'your-openai-key-here');
const OPENAI_MODEL    = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
const SPOTIFY_CLIENT_ID     = readEnv('SPOTIFY_CLIENT_ID', 'your-spotify-client-id-here');
const SPOTIFY_CLIENT_SECRET = readEnv('SPOTIFY_CLIENT_SECRET', 'your-spotify-client-secret-here');
const SPOTIFY_REFRESH_TOKEN = readEnv('SPOTIFY_REFRESH_TOKEN', 'your-spotify-refresh-token-here');
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI?.trim() || 'https://dark-bot-production-d2fb.up.railway.app/callback';
const SPOTIFY_MARKET        = process.env.SPOTIFY_MARKET?.trim() || 'US';
const YOUTUBE_COOKIE        = readEnv('YOUTUBE_COOKIE', 'your-youtube-cookie-here');
const YOUTUBE_USER_AGENT    = readEnv(
  'YOUTUBE_USER_AGENT',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
);
const PORT                 = Number(process.env.PORT || 3000);

if (!DISCORD_TOKEN) {
  console.error('[Config] DISCORD_TOKEN is missing in .env. Add your Discord bot token and restart the bot.');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.warn('[Config] OPENAI_API_KEY is missing in .env. The `link` command will stay disabled until it is set.');
}

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
  console.warn('[Config] Spotify credentials are missing in .env. Spotify links may not resolve until they are added.');
}

if (!YOUTUBE_COOKIE) {
  console.warn('[Config] YOUTUBE_COOKIE is missing in .env. YouTube may block playback on cloud hosts.');
}

// Guild ID → array of voice channel IDs the bot should permanently occupy.
const PERMANENT_VOICE_CHANNELS = {
  '940723783491272754':  ['952814235803611167'],   // Hideout - chikahan
  '1423247354491965452': ['1423247355423096845'],  // Hideout with Ashe - General
  '1408251802620530769': ['1408251803388350634'],  // Verdantia - gameplay
};

// Prefix for music commands
const PREFIX = '.';

// Superadmin user ID — only this user can run privileged commands like `.linkga`
const SUPERADMIN_USER_ID = '456699600154263555';

// ─── Discord client ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── OpenAI client ──────────────────────────────────────────────────────────────

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey:  OPENAI_API_KEY,
      baseURL: OPENAI_BASE_URL,
    })
  : null;

// ─── Music state ────────────────────────────────────────────────────────────────

const musicStates = new Map();

play.setToken({
  useragent: [YOUTUBE_USER_AGENT],
  ...(YOUTUBE_COOKIE
    ? {
        youtube: {
          cookie: YOUTUBE_COOKIE,
        },
      }
    : {}),
});

if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_REFRESH_TOKEN) {
  await play.setToken({
    spotify: {
      client_id:     SPOTIFY_CLIENT_ID,
      client_secret: SPOTIFY_CLIENT_SECRET,
      refresh_token: SPOTIFY_REFRESH_TOKEN,
      market:        SPOTIFY_MARKET,
    },
  });
}

function formatDuration(totalSeconds) {
  if (!totalSeconds || Number.isNaN(totalSeconds)) {
    return 'live';
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${htmlEscape(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f4ec;
        --card: #fffaf0;
        --text: #1f1a14;
        --muted: #675b4f;
        --accent: #1db954;
        --danger: #b23a2c;
        --border: #e4d8c8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top, rgba(29, 185, 84, 0.14), transparent 32%),
          linear-gradient(180deg, #fbf8f1 0%, var(--bg) 100%);
        color: var(--text);
        font-family: Georgia, "Times New Roman", serif;
      }
      main {
        width: min(760px, 100%);
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 18px 60px rgba(48, 35, 20, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 4vw, 3rem);
      }
      p {
        margin: 0 0 14px;
        color: var(--muted);
        line-height: 1.55;
      }
      pre {
        overflow-x: auto;
        padding: 14px 16px;
        border-radius: 16px;
        background: #16130f;
        color: #f8f4ef;
        font-size: 0.95rem;
      }
      code {
        font-family: Consolas, "Courier New", monospace;
      }
      .ok { color: var(--accent); }
      .error { color: var(--danger); }
    </style>
  </head>
  <body>
    <main>
      ${body}
    </main>
  </body>
</html>`;
}

function createSpotifyAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID || '',
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: 'user-read-private user-read-email',
  });

  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeSpotifyCodeForTokens(code) {
  const basicToken = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
  });

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error_description || payload.error || `Spotify token exchange failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function startCallbackServer() {
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

    if (requestUrl.pathname === '/') {
      const authorizeUrl = createSpotifyAuthorizeUrl();
      const body = `
        <h1>Spotify Setup</h1>
        <p>Use the link below to approve your Spotify app and generate a refresh token for this bot.</p>
        <p><a href="${htmlEscape(authorizeUrl)}">Authorize Spotify</a></p>
        <p>Callback URL: <code>${htmlEscape(SPOTIFY_REDIRECT_URI)}</code></p>
      `;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtmlPage('Spotify Setup', body));
      return;
    }

    if (requestUrl.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtmlPage(
        'Spotify Callback Error',
        '<h1 class="error">Missing Spotify config</h1><p>Add <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> before using this callback.</p>',
      ));
      return;
    }

    const error = requestUrl.searchParams.get('error');
    const code = requestUrl.searchParams.get('code');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtmlPage(
        'Spotify Callback Error',
        `<h1 class="error">Spotify returned an error</h1><p><code>${htmlEscape(error)}</code></p>`,
      ));
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtmlPage(
        'Spotify Callback Error',
        '<h1 class="error">Missing code</h1><p>Open the Spotify authorize URL first, then come back through the callback.</p>',
      ));
      return;
    }

    try {
      const tokens = await exchangeSpotifyCodeForTokens(code);
      console.log('[Spotify] Refresh token generated via callback route.');

      const body = `
        <h1 class="ok">Spotify connected</h1>
        <p>Copy this refresh token into your environment as <code>SPOTIFY_REFRESH_TOKEN</code> and redeploy or restart the bot.</p>
        <pre><code>${htmlEscape(tokens.refresh_token || 'No refresh token returned')}</code></pre>
        <p>You can also keep this access token for quick checks, but the refresh token is the important one.</p>
      `;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtmlPage('Spotify Connected', body));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtmlPage(
        'Spotify Callback Error',
        `<h1 class="error">Token exchange failed</h1><p>${htmlEscape(err.message || 'Unknown error')}</p>`,
      ));
    }
  });

  server.listen(PORT, () => {
    console.log(`[Web] Callback server listening on port ${PORT}`);
    console.log(`[Web] Spotify callback URL: ${SPOTIFY_REDIRECT_URI}`);
  });
}

function createMusicState(guildId) {
  const audioPlayer = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  const state = {
    guildId,
    audioPlayer,
    connection: null,
    textChannel: null,
    queue: [],
    currentTrack: null,
    isAdvancing: false,
  };

  audioPlayer.on(AudioPlayerStatus.Idle, () => {
    state.currentTrack = null;
    void advancePlayback(guildId);
  });

  audioPlayer.on('error', (error) => {
    console.error(`[Music] Playback error in guild ${guildId}:`, error.message);
    state.textChannel?.send(`❌ Playback failed: ${error.message}`);
    state.currentTrack = null;
    void advancePlayback(guildId);
  });

  return state;
}

function getMusicState(guildId) {
  let state = musicStates.get(guildId);
  if (!state) {
    state = createMusicState(guildId);
    musicStates.set(guildId, state);
  }
  return state;
}

function toYouTubeWatchUrl(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return (
      toYouTubeWatchUrl(value.id)
      || toYouTubeWatchUrl(value.videoId)
      || toYouTubeWatchUrl(value.url)
      || toYouTubeWatchUrl(value.watch_url)
      || toYouTubeWatchUrl(value.webpage_url)
      || null
    );
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  // Plain YouTube video IDs are the most reliable input for play-dl.
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
    return `https://www.youtube.com/watch?v=${raw}`;
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();

    if (host === 'youtu.be') {
      const videoId = parsed.pathname.split('/').filter(Boolean)[0];
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    }

    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const watchId = parsed.searchParams.get('v');
      if (watchId) {
        return `https://www.youtube.com/watch?v=${watchId}`;
      }

      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
        const videoId = parts[1];
        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function advancePlayback(guildId) {
  const state = musicStates.get(guildId);
  if (!state || state.isAdvancing) {
    return;
  }

  state.isAdvancing = true;

  try {
    await playNext(guildId);
  } finally {
    const latestState = musicStates.get(guildId);
    if (latestState) {
      latestState.isAdvancing = false;
    }
  }
}

function normalizeYouTubeTrack(video) {
  const canonicalUrl = toYouTubeWatchUrl(video);

  return {
    title:    video.title || 'Unknown title',
    url:      canonicalUrl,
    author:   video.channel?.name || video.channel?.url || 'YouTube',
    duration: video.durationInSec ?? 0,
    source:   'YouTube',
  };
}

function normalizeSpotifyTrack(track, bridgedVideo) {
  return {
    title:        `${track.name} - ${track.artists.map((artist) => artist.name).join(', ')}`,
    url:          bridgedVideo.url,
    originalUrl:  track.url,
    author:       track.artists.map((artist) => artist.name).join(', '),
    duration:     track.durationInSec ?? bridgedVideo.durationInSec ?? 0,
    source:       'Spotify',
    bridgedTitle: bridgedVideo.title,
  };
}

async function searchYouTubeVideo(query) {
  const result = await ytSearch(query);
  const firstVideo = result.videos?.[0] ?? null;

  if (!firstVideo) {
    return null;
  }

  return {
    id:            firstVideo.videoId,
    url:           toYouTubeWatchUrl(firstVideo.videoId) || toYouTubeWatchUrl(firstVideo.url),
    title:         firstVideo.title,
    durationInSec: firstVideo.seconds ?? 0,
    channel: {
      name: firstVideo.author?.name || firstVideo.author || 'YouTube',
      url:  firstVideo.author?.url,
    },
  };
}

async function bridgeSpotifyTrack(track) {
  const artistNames = track.artists.map((artist) => artist.name).join(' ');

  // First attempt: include "audio" keyword for better results
  const primaryQuery = `${track.name} ${artistNames} audio`;
  console.log(`[Music] Bridging Spotify track "${track.name}" → searching: "${primaryQuery}"`);
  let bridgedVideo = await searchYouTubeVideo(primaryQuery);

  // Retry without "audio" keyword if first attempt fails
  if (!bridgedVideo) {
    const fallbackQuery = `${track.name} ${artistNames}`;
    console.log(`[Music] Primary search failed for "${track.name}" — retrying without "audio": "${fallbackQuery}"`);
    bridgedVideo = await searchYouTubeVideo(fallbackQuery);
  }

  if (!bridgedVideo) {
    throw new Error(`Could not find a playable YouTube match for Spotify track "${track.name}" by ${artistNames}.`);
  }

  return normalizeSpotifyTrack(track, bridgedVideo);
}

/**
 * Returns true if the input string looks like a URL (has a recognisable scheme
 * or a hostname-style prefix).  Partial strings like ".p" or plain song names
 * will return false so we skip straight to YouTube search.
 */
function isValidLink(input) {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();

  // Must start with a known scheme or a bare hostname pattern
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^(www\.|youtu\.be\/|youtube\.com\/|spotify\.com\/|open\.spotify\.com\/)/i.test(trimmed)) return true;

  return false;
}

async function resolveTracks(query) {
  // If the input doesn't look like a URL at all, skip link parsing entirely
  // and go straight to a YouTube keyword search.
  if (!isValidLink(query)) {
    console.log(`[Music] "${query}" is not a link — searching YouTube directly`);
    const firstVideo = await searchYouTubeVideo(query);
    return firstVideo ? [normalizeYouTubeTrack(firstVideo)] : [];
  }

  // Attempt to classify the link; fall back to search if validation throws.
  let queryType;
  try {
    queryType = await play.validate(query);
  } catch (validateError) {
    console.warn(`[Music] play.validate() failed for "${query}": ${validateError.message} — falling back to YouTube search`);
    const firstVideo = await searchYouTubeVideo(query);
    return firstVideo ? [normalizeYouTubeTrack(firstVideo)] : [];
  }

  switch (queryType) {
    case 'yt_video': {
      const info = await play.video_info(query);
      return [normalizeYouTubeTrack(info.video_details)];
    }

    case 'yt_playlist': {
      const playlist = await play.playlist_info(query, { incomplete: true });
      const videos = await playlist.all_videos();
      return videos.map(normalizeYouTubeTrack);
    }

    case 'sp_track': {
      const track = await play.spotify(query);
      return [await bridgeSpotifyTrack(track)];
    }

    case 'sp_album':
    case 'sp_playlist': {
      const collection = await play.spotify(query);
      const tracks = await collection.all_tracks();
      return Promise.all(tracks.map((track) => bridgeSpotifyTrack(track)));
    }

    default: {
      // play.validate() returned a falsy / unrecognised type — treat as search
      console.log(`[Music] Unrecognised link type "${queryType}" for "${query}" — falling back to YouTube search`);
      const firstVideo = await searchYouTubeVideo(query);
      return firstVideo ? [normalizeYouTubeTrack(firstVideo)] : [];
    }
  }
}

async function ensureMusicConnection(voiceChannel) {
  const state = getMusicState(voiceChannel.guild.id);
  let connection = getVoiceConnection(voiceChannel.guild.id);

  if (!connection || connection.joinConfig.channelId !== voiceChannel.id) {
    if (connection) {
      connection.destroy();
    }

    connection = joinVoiceChannel({
      channelId:      voiceChannel.id,
      guildId:        voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf:       true,
      selfMute:       false,
    });
  }

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  connection.subscribe(state.audioPlayer);
  state.connection = connection;

  return state;
}

async function playNext(guildId) {
  const state = musicStates.get(guildId);
  if (!state) return;

  const nextTrack = state.queue.shift();
  if (!nextTrack) {
    state.textChannel?.send('✅ Queue finished.');
    return;
  }

  state.currentTrack = nextTrack;
  let streamUrl = null;

  try {
    streamUrl = toYouTubeWatchUrl(nextTrack.url) || nextTrack.url;

    if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) {
      const recoveredVideo = await searchYouTubeVideo(`${nextTrack.title} ${nextTrack.author}`);
      streamUrl = toYouTubeWatchUrl(recoveredVideo) || recoveredVideo?.url || null;
    }

    if (!streamUrl) {
      throw new Error('No playable URL found');
    }

    let resource;

    try {
      const stream = await play.stream(streamUrl, { discordPlayerCompatibility: true });

      resource = createAudioResource(stream.stream, {
        inputType: stream.type || StreamType.Arbitrary,
      });
    } catch (streamError) {
      // Always attempt a YouTube search as recovery — don't retry the same URL
      const searchQuery = `${nextTrack.title} ${nextTrack.author}`;
      console.warn(`[Music] Stream failed for "${nextTrack.title}" (${streamError.message}) — recovering via YouTube search: "${searchQuery}"`);

      const recoveredVideo = await searchYouTubeVideo(searchQuery);
      const recoveredUrl = toYouTubeWatchUrl(recoveredVideo) || recoveredVideo?.url || null;

      if (!recoveredUrl) {
        console.error(`[Music] YouTube search recovery found no results for "${searchQuery}"`);
        throw streamError;
      }

      console.log(`[Music] Recovery: streaming "${recoveredVideo.title}" (${recoveredUrl})`);
      const fallbackStream = await play.stream(recoveredUrl, { discordPlayerCompatibility: true });

      resource = createAudioResource(fallbackStream.stream, {
        inputType: fallbackStream.type || StreamType.Arbitrary,
      });
    }

    state.audioPlayer.play(resource);

    const sourceLabel = nextTrack.source === 'Spotify' && nextTrack.originalUrl
      ? ` (from Spotify)`
      : '';

    await state.textChannel?.send(`▶️ **Now playing:** ${nextTrack.title}${sourceLabel}`);
  } catch (error) {
    console.error(`[Music] Stream error in guild ${guildId}:`, error.message, '| URL:', streamUrl ?? 'none');
    const errorMessage = String(error.message || '');
    const youtubeStreamBlocked = (
      errorMessage.includes('Sign in to confirm you')
      || (errorMessage.includes('Invalid URL') && String(streamUrl).includes('youtube.com/watch'))
    );
    if (youtubeStreamBlocked) {
      await state.textChannel?.send(
        '❌ YouTube blocked this server request. Add `YOUTUBE_COOKIE` in Railway Variables, redeploy, and try again.',
      );
    } else {
      await state.textChannel?.send(`❌ Could not play **${nextTrack.title}**: ${error.message}`);
    }
    state.currentTrack = null;
    await playNext(guildId);
  }
}

// ─── Permanent voice channel helpers ────────────────────────────────────────────

/**
 * Attempt to join a voice channel and keep the connection alive.
 * Reconnects automatically if the connection is destroyed.
 */
async function joinPermanentChannel(guild, channelId) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Voice] Channel ${channelId} not found in guild ${guild.id}`);
    return;
  }

  console.log(`[Voice] Joining permanent channel: ${channel.name} (${channelId})`);

  const connection = joinVoiceChannel({
    channelId:      channel.id,
    guildId:        guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf:       true,
    selfMute:       false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[Voice] Connected to ${channel.name}`);
  } catch (err) {
    console.error(`[Voice] Failed to connect to ${channel.name}:`, err.message);
    connection.destroy();
    return;
  }

  // Reconnect if the connection is unexpectedly destroyed
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.warn(`[Voice] Connection to ${channel.name} destroyed — reconnecting in 5 s…`);
    setTimeout(() => joinPermanentChannel(guild, channelId), 5_000);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Try to recover the connection first (e.g. network blip)
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      console.warn(`[Voice] Could not recover connection to ${channel.name} — reconnecting…`);
      connection.destroy();
    }
  });
}

/**
 * Join all configured permanent voice channels for every guild the bot is in.
 */
async function joinAllPermanentChannels() {
  for (const [guildId, channelIds] of Object.entries(PERMANENT_VOICE_CHANNELS)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.warn(`[Voice] Guild ${guildId} not found in cache — skipping.`);
      continue;
    }
    for (const channelId of channelIds) {
      await joinPermanentChannel(guild, channelId);
    }
  }
}

// ─── AI chat helper ─────────────────────────────────────────────────────────────

async function handleAIChat(message, prompt) {
  if (!openai) {
    await message.reply('❌ `OPENAI_API_KEY` is missing or still set to the placeholder in `.env`, so the `link` command is unavailable right now.');
    return;
  }

  try {
    await message.channel.sendTyping();

    const completion = await openai.chat.completions.create({
      model:    OPENAI_MODEL,
      messages: [
        {
          role:    'system',
          content: 'You are a helpful and friendly Discord bot assistant. Keep responses concise and suitable for chat.',
        },
        {
          role:    'user',
          content: prompt,
        },
      ],
      max_tokens: 1024,
    });

    const reply = completion.choices[0]?.message?.content?.trim();
    if (reply) {
      await message.reply(reply);
    } else {
      await message.reply('🤔 I got an empty response. Please try again.');
    }
  } catch (err) {
    console.error('[AI] OpenAI error:', err.message);
    if (err?.status === 401) {
      await message.reply('❌ `OPENAI_API_KEY` is invalid. Replace it in `.env` and restart the bot.');
      return;
    }

    if (err?.status === 404 || err?.code === 'model_not_found') {
      await message.reply(`❌ The OpenAI model \`${OPENAI_MODEL}\` is not available for this API key. Set \`OPENAI_MODEL\` in \`.env\` to a model your account can use.`);
      return;
    }

    await message.reply(`❌ AI request failed: ${err.message}`);
  }
}

// ─── Music command helpers ───────────────────────────────────────────────────────

async function handlePlay(message, query) {
  if (!query) {
    return message.reply('❓ Please provide a song name or URL. Usage: `.p <song>`');
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply('🔇 You need to be in a voice channel to play music.');
  }

  try {
    const tracks = await resolveTracks(query);
    if (tracks.length === 0) {
      return message.reply('❌ I could not find anything playable from that title or link.');
    }

    const state = await ensureMusicConnection(voiceChannel);
    state.textChannel = message.channel;

    const startingFresh = !state.currentTrack && state.audioPlayer.state.status !== AudioPlayerStatus.Playing;
    state.queue.push(...tracks);

    if (tracks.length === 1) {
      await message.reply(`🎵 **Queued:** ${tracks[0].title} \`[${formatDuration(tracks[0].duration)}]\``);
    } else {
      await message.reply(`🎵 **Queued ${tracks.length} tracks** from ${tracks[0].source}.`);
    }

    if (startingFresh) {
      await advancePlayback(message.guild.id);
    }
  } catch (err) {
    console.error('[Music] Play error:', err.message);
    await message.reply(`❌ Could not play that track: ${err.message}`);
  }
}

async function handleSkip(message) {
  const state = musicStates.get(message.guild.id);
  if (!state || !state.currentTrack) {
    return message.reply('⏹️ Nothing is currently playing.');
  }

  state.audioPlayer.stop();
  await message.reply('⏭️ Skipped.');
}

async function handleQueue(message) {
  const state = musicStates.get(message.guild.id);
  const queuedTracks = state ? (state.currentTrack ? [state.currentTrack, ...state.queue] : [...state.queue]) : [];

  if (queuedTracks.length === 0) {
    return message.reply('📭 The queue is empty.');
  }

  const upcoming = state.queue.slice(0, 10);
  const list = upcoming.map((track, i) => `**${i + 1}.** ${track.title} \`[${formatDuration(track.duration)}]\``).join('\n');
  const current = state.currentTrack ? `▶️ **Now playing:** ${state.currentTrack.title} \`[${formatDuration(state.currentTrack.duration)}]\`\n\n` : '';

  if (upcoming.length === 0) {
    return message.reply(`${current}📭 No queued tracks after the current song.`);
  }

  await message.reply(`${current}**Up next:**\n${list}${state.queue.length > 10 ? `\n…and ${state.queue.length - 10} more` : ''}`);
}

async function handleLeave(message) {
  const state = musicStates.get(message.guild.id);
  if (state) {
    state.queue = [];
    state.currentTrack = null;
    state.audioPlayer.stop();
  }

  const connection = getVoiceConnection(message.guild.id);
  if (connection) {
    connection.destroy();
    musicStates.delete(message.guild.id);
    await message.reply('👋 Left the voice channel.');
  } else {
    await message.reply('🤷 I\'m not in a voice channel.');
  }
}

// ─── Superadmin commands ─────────────────────────────────────────────────────────

async function handleHelp(message) {
  const helpText = [
    '**Bot Commands**',
    '`.help` - Show this command list.',
    '`.p <song or URL>` or `.play <song or URL>` - Play music or add it to the queue.',
    '`.s` or `.skip` - Skip the current song.',
    '`.q` or `.queue` - Show the songs in the queue.',
    '`.l`, `.leave`, or `.stop` - Stop playback, clear the queue, and leave the voice channel.',
    '`link <message>` - Chat with the AI assistant.',
    '`.nuke <@user or user_id>` - Kick a user with a dramatic sequence. Admin only.',
    '`.helpsa` - Show superadmin-only commands.',
  ].join('\n');

  await message.reply(helpText);
}

async function handleHelpSuperadmin(message) {
  if (message.author.id !== SUPERADMIN_USER_ID) {
    return message.reply('❌ You do not have permission to use this command.');
  }

  const helpText = [
    '**Superadmin Commands**',
    '`.linkga <announcement text>` - Send a global announcement to every server the bot is in.',
  ].join('\n');

  await message.reply(helpText);
}

async function handleLinkga(message, text) {
  if (message.author.id !== SUPERADMIN_USER_ID) {
    return message.reply('❌ You don\'t have permission to use this command.');
  }

  if (!text) {
    return message.reply('❓ Usage: `.linkga <announcement text>`');
  }

  const announcement = `📢 **Global Announcement from Admin:**\n\n${text}`;
  const preferredNames = ['general', 'announcements', 'main'];
  let sentCount = 0;

  for (const guild of client.guilds.cache.values()) {
    try {
      // Fetch all channels if not already cached
      const channels = guild.channels.cache;

      // 1. Try preferred channel names first
      let target = channels.find(
        (ch) =>
          ch.isTextBased() &&
          !ch.isThread() &&
          preferredNames.includes(ch.name.toLowerCase()) &&
          ch.permissionsFor(guild.members.me)?.has('SendMessages'),
      );

      // 2. Fall back to the first writable text channel
      if (!target) {
        target = channels.find(
          (ch) =>
            ch.isTextBased() &&
            !ch.isThread() &&
            ch.permissionsFor(guild.members.me)?.has('SendMessages'),
        );
      }

      if (!target) {
        console.warn(`[Linkga] No writable text channel found in guild ${guild.name} (${guild.id}) — skipping.`);
        continue;
      }

      await target.send(announcement);
      sentCount++;
    } catch (err) {
      console.error(`[Linkga] Failed to send announcement to guild ${guild.name} (${guild.id}):`, err.message);
    }
  }

  await message.reply(`✅ Announcement sent to ${sentCount} server${sentCount !== 1 ? 's' : ''}.`);
}

// ─── Admin commands ──────────────────────────────────────────────────────────────

async function handleNuke(message, args) {
  // Check administrator permission
  if (!message.member.permissions.has('Administrator')) {
    return message.reply('❌ You need Administrator permission to use this command.');
  }

  // Parse user from mention or raw ID
  const input = args[0];
  if (!input) {
    return message.reply('❓ Usage: `.nuke <@user>` or `.nuke <user_id>`');
  }

  const userId = input.replace(/^<@!?(\d+)>$/, '$1');
  if (!/^\d+$/.test(userId)) {
    return message.reply('❓ Usage: `.nuke <@user>` or `.nuke <user_id>`');
  }

  // Resolve the member from the guild
  let target;
  try {
    target = await message.guild.members.fetch(userId);
  } catch {
    return message.reply('❌ That user is not in this server.');
  }

  if (!target) {
    return message.reply('❌ That user is not in this server.');
  }

  // Safety checks
  if (target.id === message.author.id) {
    return message.reply('❌ You can\'t nuke yourself!');
  }

  if (target.id === client.user.id) {
    return message.reply('❌ You can\'t nuke me!');
  }

  if (target.roles.highest.position >= message.member.roles.highest.position) {
    return message.reply('❌ You can\'t nuke a user with equal or higher role!');
  }

  if (!target.kickable) {
    return message.reply('❌ I don\'t have permission to kick this user.');
  }

  const userName = target.user.username;
  const serverName = message.guild.name;

  // Dramatic sequence
  await message.channel.send(`Initializing nuke sequence for ${target}...`);
  await new Promise(resolve => setTimeout(resolve, 600));
  await message.channel.send('Preparing nuke....');
  await new Promise(resolve => setTimeout(resolve, 600));
  await message.channel.send('Loading payload....');
  await new Promise(resolve => setTimeout(resolve, 600));
  await message.channel.send('Bypassing shields....');
  await new Promise(resolve => setTimeout(resolve, 600));
  await message.channel.send('Target locked....');
  await new Promise(resolve => setTimeout(resolve, 600));
  await message.channel.send('Final countdown engaged....');
  await new Promise(resolve => setTimeout(resolve, 600));
  await message.channel.send('Nuke launched. Impact confirmed.');
  await new Promise(resolve => setTimeout(resolve, 600));
  await message.channel.send(`${userName} nuke away from the ${serverName}`);

  // Kick the user
  try {
    await target.kick('Nuked by admin command');
  } catch (err) {
    await message.channel.send(`❌ Failed to kick ${userName}: ${err.message}`);
  }
}

// ─── Event: ready ───────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`[Bot] Logged in as ${c.user.tag}`);
  c.user.setActivity('24/7 | .help for commands');

  await joinAllPermanentChannels();
});

// ─── Event: guildCreate (join new guilds) ────────────────────────────────────────

client.on(Events.GuildCreate, async (guild) => {
  const channelIds = PERMANENT_VOICE_CHANNELS[guild.id];
  if (channelIds) {
    for (const channelId of channelIds) {
      await joinPermanentChannel(guild, channelId);
    }
  }
});

// ─── Event: messageCreate ────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and DMs
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();

  // ── AI chat: triggered by messages starting with "link" ──────────────────────
  if (content.toLowerCase().startsWith('link ') || content.toLowerCase() === 'link') {
    const prompt = content.slice(4).trim();
    if (!prompt) {
      return message.reply('💬 Usage: `link <your question or message>`');
    }
    return handleAIChat(message, prompt);
  }

  // ── Music commands ────────────────────────────────────────────────────────────
  if (!content.startsWith(PREFIX)) return;

  const args    = content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  switch (command) {
    case 'help':
      return handleHelp(message);

    case 'helpsa':
      return handleHelpSuperadmin(message);

    case 'linkga':
      return handleLinkga(message, args.join(' '));

    case 'nuke':
      return handleNuke(message, args);

    case 'p':
    case 'play':
      return handlePlay(message, args.join(' '));

    case 's':
    case 'skip':
      return handleSkip(message);

    case 'q':
    case 'queue':
      return handleQueue(message);

    case 'l':
    case 'leave':
    case 'stop':
      return handleLeave(message);

    default:
      // Unknown command — silently ignore
      break;
  }
});

// ─── Login ───────────────────────────────────────────────────────────────────────

startCallbackServer();

try {
  await client.login(DISCORD_TOKEN);
} catch (err) {
  if (err?.code === 'TokenInvalid') {
    console.error('[Config] Discord rejected DISCORD_TOKEN. Make sure you copied the bot token from the Discord Developer Portal Bot page.');
    process.exit(1);
  }
  throw err;
}
