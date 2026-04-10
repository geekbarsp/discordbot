import 'dotenv/config';
import { ChannelType, Client, EmbedBuilder, GatewayIntentBits, Events, PermissionFlagsBits } from 'discord.js';
import { readFile, writeFile } from 'node:fs/promises';
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

function getPermanentChannelIds(guildId) {
  return PERMANENT_VOICE_CHANNELS[guildId] ?? [];
}

function setPermanentChannelIds(guildId, channelIds) {
  PERMANENT_VOICE_CHANNELS[guildId] = channelIds;
}

// Prefix for music commands
const PREFIX = '.';

// Superadmin user ID — only this user can run privileged commands like `.linkga`
const SUPERADMIN_USER_ID = '456699600154263555';
const SERVER_STAT_CATEGORY_NAME = 'Server Statistics';
const SERVER_STAT_CHANNEL_LABELS = {
  totalMembers: 'All Members',
  userMembers: 'Members',
  botMembers: 'Bots',
  boosts: 'Boosts',
};
const DARKITEM_DATA_FILE = new URL('./darkitem-data.json', import.meta.url);
const DARKITEM_POLL_INTERVAL_MS = 15 * 60 * 1000;
const DARKITEM_PROMPT_TIMEOUT_MS = 60 * 1000;
const SERVER_LAYOUT_CONFIRM_MS = 2 * 60 * 1000;
const SERVER_LAYOUT_PRESETS = {
  ngaming: {
    label: 'Gaming',
    categories: [
      { name: 'WELCOME', text: ['rules', 'announcements', 'introductions'], voice: [] },
      { name: 'GAMING CHAT', text: ['general-chat', 'lfg', 'clips-and-screenshots', 'memes'], voice: ['party-room-1', 'party-room-2', 'chill-gaming'] },
      { name: 'GAME TOPICS', text: ['fps-games', 'moba-games', 'survival-games'], voice: ['squad-strategy'] },
    ],
  },
  nstudy: {
    label: 'Study',
    categories: [
      { name: 'WELCOME', text: ['rules', 'announcements', 'introductions'], voice: [] },
      { name: 'STUDY SPACE', text: ['general-study', 'homework-help', 'resources', 'productivity'], voice: ['study-room-1', 'study-room-2', 'silent-study'] },
      { name: 'SUBJECTS', text: ['math', 'science', 'language'], voice: ['group-discussion'] },
    ],
  },
  nfriendlyorg: {
    label: 'Friendly Org',
    categories: [
      { name: 'WELCOME', text: ['rules', 'announcements', 'introductions'], voice: [] },
      { name: 'COMMUNITY', text: ['general', 'events', 'media-share', 'suggestions'], voice: ['community-lounge', 'meeting-room'] },
      { name: 'SUPPORT', text: ['help-desk', 'questions'], voice: ['staff-voice'] },
    ],
  },
  npersonal: {
    label: 'Personal',
    categories: [
      { name: 'HOME', text: ['updates', 'journal', 'links'], voice: [] },
      { name: 'SOCIAL', text: ['general', 'photos', 'ideas'], voice: ['hangout', 'private-talk'] },
      { name: 'WORKSPACE', text: ['plans', 'notes', 'archive'], voice: ['focus-room'] },
    ],
  },
  nhackergroup: {
    label: 'Hacker Group',
    categories: [
      { name: 'WELCOME', text: ['rules', 'announcements', 'introductions'], voice: [] },
      { name: 'CYBER CHAT', text: ['general-chat', 'news', 'resources', 'tool-talk'], voice: ['ops-room', 'research-room'] },
      { name: 'LABS', text: ['writeups', 'ctf-chat', 'scripts-and-code'], voice: ['team-lab'] },
    ],
  },
};

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
const afkStates = new Map();
const pendingServerLayouts = new Map();
const serverStatSnapshots = new Map();
const pendingServerStatUpdates = new Map();
const pendingPermanentVoiceJoins = new Map();
const suspendedPermanentVoiceGuilds = new Set();
let permanentVoiceAutoJoinDisabled = false;
let darkItemState = {
  subscriptions: {},
  postedDeals: {},
  syncChannels: {},
};
let darkItemPollPromise = null;

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

async function loadDarkItemState() {
  try {
    const raw = await readFile(DARKITEM_DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      subscriptions: parsed?.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
      postedDeals: parsed?.postedDeals && typeof parsed.postedDeals === 'object' ? parsed.postedDeals : {},
      syncChannels: parsed?.syncChannels && typeof parsed.syncChannels === 'object' ? parsed.syncChannels : {},
    };
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error('[DarkItem] Failed to load saved state:', err);
    }

    return {
      subscriptions: {},
      postedDeals: {},
      syncChannels: {},
    };
  }
}

async function saveDarkItemState() {
  await writeFile(DARKITEM_DATA_FILE, JSON.stringify(darkItemState, null, 2));
}

function normalizeDarkItemStoreChoice(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'epic' || normalized === 'epic games' || normalized === 'epicgames') {
    return ['epic'];
  }

  if (normalized === 'steam') {
    return ['steam'];
  }

  if (normalized === 'both' || normalized === 'all') {
    return ['epic', 'steam'];
  }

  return null;
}

function formatPriceLabel(value, fallback = 'Unknown') {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'string') {
    return value;
  }

  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return fallback;
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

function getDarkItemStoreLabel(store) {
  return store === 'epic' ? 'Epic Games' : 'Steam';
}

function getDarkItemStoreLabels(stores) {
  return stores.map(getDarkItemStoreLabel).join(' + ');
}

function getPostedDealMap(guildId) {
  if (!darkItemState.postedDeals[guildId] || typeof darkItemState.postedDeals[guildId] !== 'object') {
    darkItemState.postedDeals[guildId] = {};
  }

  return darkItemState.postedDeals[guildId];
}

function hasPostedDarkItemDeal(guildId, dealId) {
  return Boolean(getPostedDealMap(guildId)[dealId]);
}

async function markDarkItemDealPosted(guildId, dealId) {
  const postedDeals = getPostedDealMap(guildId);
  postedDeals[dealId] = new Date().toISOString();

  const entries = Object.entries(postedDeals);
  if (entries.length > 500) {
    entries
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .slice(500)
      .forEach(([id]) => {
        delete postedDeals[id];
      });
  }

  await saveDarkItemState();
}

function getDarkItemImage(images) {
  if (!Array.isArray(images)) {
    return null;
  }

  const preferredTypes = [
    'OfferImageTall',
    'DieselStoreFrontWide',
    'Thumbnail',
    'VaultClosed',
    'DieselGameBox',
  ];

  for (const type of preferredTypes) {
    const image = images.find((item) => item?.type === type && item?.url);
    if (image?.url) {
      return image.url;
    }
  }

  return images.find((item) => item?.url)?.url ?? null;
}

function buildEpicOfferUrl(element) {
  const slug = element?.offerMappings?.[0]?.pageSlug
    || element?.catalogNs?.mappings?.[0]?.pageSlug
    || element?.productSlug
    || element?.urlSlug
    || null;

  if (!slug) {
    return 'https://store.epicgames.com/en-US/free-games';
  }

  const cleanedSlug = slug.replace(/^\/+/, '').replace(/\/home$/, '');
  return `https://store.epicgames.com/en-US/p/${cleanedSlug}`;
}

async function fetchEpicFreeDeals() {
  const response = await fetch('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US');
  if (!response.ok) {
    throw new Error(`Epic request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const elements = payload?.data?.Catalog?.searchStore?.elements ?? [];
  const now = Date.now();
  const deals = [];

  for (const element of elements) {
    const offerGroups = element?.promotions?.promotionalOffers ?? [];
    const activePromotions = offerGroups.flatMap((group) => group?.promotionalOffers ?? []);
    const discountPrice = Number(element?.price?.totalPrice?.discountPrice ?? NaN);

    if (!Number.isFinite(discountPrice) || discountPrice !== 0) {
      continue;
    }

    for (const promotion of activePromotions) {
      const startDate = promotion?.startDate ?? null;
      const endDate = promotion?.endDate ?? null;

      if (!startDate || !endDate) {
        continue;
      }

      const startsAt = Date.parse(startDate);
      const endsAt = Date.parse(endDate);

      if (Number.isNaN(startsAt) || Number.isNaN(endsAt) || now < startsAt || now > endsAt) {
        continue;
      }

      deals.push({
        id: `epic:${element.id}:${startDate}`,
        title: element.title || 'Untitled',
        store: 'Epic Games',
        original_price: element?.price?.totalPrice?.fmtPrice?.originalPrice || 'Unknown',
        sale_price: 'Free',
        url: buildEpicOfferUrl(element),
        image: getDarkItemImage(element?.keyImages),
        start_date: startDate,
        end_date: endDate,
        description: element.description || 'Free for a limited time on Epic Games.',
        platforms: [],
      });
    }
  }

  return deals;
}

async function fetchSteamAppDetails(appId) {
  if (!appId) {
    return null;
  }

  try {
    const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=english&cc=us`);
    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    return payload?.[appId]?.success ? payload[appId].data : null;
  } catch {
    return null;
  }
}

async function fetchSteamFreeDeals() {
  const response = await fetch('https://www.cheapshark.com/api/1.0/deals?storeID=1&upperPrice=0&pageSize=60');
  if (!response.ok) {
    throw new Error(`Steam request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const rawDeals = Array.isArray(payload) ? payload : [];
  const filteredDeals = rawDeals.filter((deal) => Number(deal?.salePrice) === 0 && Number(deal?.normalPrice) > 0);

  const detailedDeals = await Promise.all(
    filteredDeals.map(async (deal) => {
      const appId = deal?.steamAppID ? String(deal.steamAppID) : null;
      const appDetails = await fetchSteamAppDetails(appId);
      const platforms = appDetails?.platforms
        ? Object.entries(appDetails.platforms)
            .filter(([, supported]) => supported)
            .map(([platform]) => platform[0].toUpperCase() + platform.slice(1))
        : [];

      return {
        id: `steam:${deal.dealID}`,
        title: deal.title || appDetails?.name || 'Untitled',
        store: 'Steam',
        original_price: formatPriceLabel(Number(deal.normalPrice)),
        sale_price: 'Free',
        url: appId ? `https://store.steampowered.com/app/${appId}/` : `https://www.cheapshark.com/redirect?dealID=${deal.dealID}`,
        image: appDetails?.header_image || deal.thumb || null,
        start_date: deal.lastChange ? new Date(Number(deal.lastChange) * 1000).toISOString() : null,
        end_date: null,
        description: appDetails?.short_description || 'Free for a limited time on Steam.',
        platforms,
      };
    }),
  );

  return detailedDeals;
}

function createDarkItemEmbed(deal) {
  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle(`${deal.title} is free`)
    .setURL(deal.url)
    .setDescription(deal.description || 'Free for a limited time.')
    .addFields(
      { name: 'Store', value: deal.store, inline: true },
      { name: 'Original Price', value: deal.original_price || 'Unknown', inline: true },
      { name: 'Price Now', value: deal.sale_price || 'Free', inline: true },
      { name: 'Expires', value: deal.end_date ? `<t:${Math.floor(Date.parse(deal.end_date) / 1000)}:R>` : 'Unknown', inline: true },
      { name: 'Link', value: `[Get it here](${deal.url})`, inline: true },
      { name: 'Platforms', value: deal.platforms?.length ? deal.platforms.join(', ') : 'Unknown', inline: true },
    )
    .setFooter({ text: `${deal.store} free alert` })
    .setTimestamp();

  if (deal.image) {
    embed.setImage(deal.image);
  }

  return embed;
}

async function postDarkItemDeal(channel, deal) {
  await channel.send({
    embeds: [createDarkItemEmbed(deal)],
  });
}

async function pollDarkItemDeals() {
  if (darkItemPollPromise) {
    return darkItemPollPromise;
  }

  darkItemPollPromise = (async () => {
    const subscriptions = Object.entries(darkItemState.subscriptions ?? {});
    if (subscriptions.length === 0) {
      return;
    }

    const requestedStores = new Set(subscriptions.flatMap(([, subscription]) => subscription?.stores ?? []));
    const dealsByStore = {
      epic: [],
      steam: [],
    };

    if (requestedStores.has('epic')) {
      try {
        dealsByStore.epic = await fetchEpicFreeDeals();
      } catch (err) {
        console.error('[DarkItem] Epic polling failed:', err.message);
      }
    }

    if (requestedStores.has('steam')) {
      try {
        dealsByStore.steam = await fetchSteamFreeDeals();
      } catch (err) {
        console.error('[DarkItem] Steam polling failed:', err.message);
      }
    }

    for (const [guildId, subscription] of subscriptions) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild || !subscription?.channelId || !Array.isArray(subscription?.stores)) {
        continue;
      }

      const channel = guild.channels.cache.get(subscription.channelId);
      if (!channel?.isTextBased()) {
        continue;
      }

      const deals = subscription.stores.flatMap((store) => dealsByStore[store] ?? []);
      for (const deal of deals) {
        if (hasPostedDarkItemDeal(guildId, deal.id)) {
          continue;
        }

        try {
          await postDarkItemDeal(channel, deal);
          await markDarkItemDealPosted(guildId, deal.id);
        } catch (err) {
          console.error(`[DarkItem] Failed to post ${deal.id} in guild ${guildId}:`, err.message);
        }
      }
    }
  })();

  try {
    await darkItemPollPromise;
  } finally {
    darkItemPollPromise = null;
  }
}

async function promptForDarkItemReply(message, prompt) {
  await message.reply(prompt);

  try {
    const collected = await message.channel.awaitMessages({
      filter: (reply) => reply.author.id === message.author.id,
      max: 1,
      time: DARKITEM_PROMPT_TIMEOUT_MS,
      errors: ['time'],
    });

    return collected.first();
  } catch {
    return null;
  }
}

function resolveDarkItemChannel(guild, value, fallbackChannel) {
  const input = String(value || '').trim().toLowerCase();
  if (input === 'here') {
    return fallbackChannel;
  }

  const channelId = String(value || '').trim().replace(/^<#(\d+)>$/, '$1');
  if (!/^\d+$/.test(channelId)) {
    return null;
  }

  const channel = guild.channels.cache.get(channelId);
  return channel?.isTextBased() ? channel : null;
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

async function connectVoiceChannel(channel) {
  let connection = getVoiceConnection(channel.guild.id);

  if (connection) {
    if (connection.joinConfig.channelId !== channel.id) {
      connection.rejoin({
        channelId: channel.id,
        selfDeaf: true,
        selfMute: false,
      });
    }
  } else {
    connection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf:       true,
      selfMute:       false,
    });
  }

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  return connection;
}

function isIpDiscoveryError(error) {
  return String(error?.message || error || '').includes('Cannot perform IP discovery - socket closed');
}

function disablePermanentVoiceAutoJoin(reason) {
  if (!permanentVoiceAutoJoinDisabled) {
    console.warn(`[Voice] Permanent auto-join disabled: ${reason}`);
  }

  permanentVoiceAutoJoinDisabled = true;

  for (const guildId of Object.keys(PERMANENT_VOICE_CHANNELS)) {
    suspendedPermanentVoiceGuilds.add(guildId);
    getVoiceConnection(guildId)?.destroy();
  }
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
async function joinPermanentChannel(guild, channelId, options = {}) {
  const { manual = false } = options;

  if (!manual && (permanentVoiceAutoJoinDisabled || suspendedPermanentVoiceGuilds.has(guild.id))) {
    console.warn(`[Voice] Auto-join skipped for guild ${guild.id} because permanent voice is suspended.`);
    return;
  }

  if (!getPermanentChannelIds(guild.id).includes(channelId)) {
    console.log(`[Voice] Skipping join for ${channelId} in guild ${guild.id} because it is no longer configured.`);
    return;
  }

  const existingJoin = pendingPermanentVoiceJoins.get(guild.id);
  if (existingJoin?.channelId === channelId) {
    return existingJoin.promise;
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Voice] Channel ${channelId} not found in guild ${guild.id}`);
    return;
  }

  const joinTask = (async () => {
    console.log(`[Voice] Joining permanent channel: ${channel.name} (${channelId})`);

    let connection;
    try {
      connection = await connectVoiceChannel(channel);
      console.log(`[Voice] Connected to ${channel.name}`);
      if (manual) {
        suspendedPermanentVoiceGuilds.delete(guild.id);
      }
    } catch (err) {
      console.error(`[Voice] Failed to connect to ${channel.name}:`, err.message);
      const activeConnection = getVoiceConnection(guild.id);
      if (activeConnection?.joinConfig.channelId === channel.id) {
        activeConnection.destroy();
      }

      if (isIpDiscoveryError(err)) {
        suspendedPermanentVoiceGuilds.add(guild.id);
        if (!manual) {
          disablePermanentVoiceAutoJoin('host networking closed the Discord voice UDP socket during IP discovery');
        }
        return;
      }

      setTimeout(() => {
        if (getPermanentChannelIds(guild.id).includes(channelId)) {
          void joinPermanentChannel(guild, channelId);
        }
      }, 10_000);
      return;
    } finally {
      if (pendingPermanentVoiceJoins.get(guild.id)?.promise === joinTask) {
        pendingPermanentVoiceJoins.delete(guild.id);
      }
    }

    if (connection._permanentVoiceHandlersAttached) {
      return;
    }

    connection._permanentVoiceHandlersAttached = true;

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (!getPermanentChannelIds(guild.id).includes(channelId)) {
        console.log(`[Voice] Connection to ${channel.name} destroyed, but that channel is no longer the permanent target.`);
        return;
      }
      console.warn(`[Voice] Connection to ${channel.name} destroyed, reconnecting in 10 seconds.`);
      setTimeout(() => {
        void joinPermanentChannel(guild, channelId);
      }, 10_000);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!getPermanentChannelIds(guild.id).includes(channelId)) {
          console.log(`[Voice] Not reconnecting to ${channel.name} because another permanent channel was selected.`);
          return;
        }
        console.warn(`[Voice] Could not recover connection to ${channel.name}, retrying join.`);
        connection.destroy();
      }
    });
  })();

  pendingPermanentVoiceJoins.set(guild.id, { channelId, promise: joinTask });
  return joinTask;
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

async function handleJoinVoiceChannel(message) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply('You need to be in a voice channel before using `.join`.');
  }

  setPermanentChannelIds(message.guild.id, [voiceChannel.id]);
  suspendedPermanentVoiceGuilds.delete(message.guild.id);

  const existingConnection = getVoiceConnection(message.guild.id);
  if (existingConnection && existingConnection.joinConfig.channelId === voiceChannel.id) {
    return message.reply(`I am already in **${voiceChannel.name}** and will stay there until someone uses \`.join\` in another voice channel.`);
  }

  if (existingConnection && existingConnection.joinConfig.channelId !== voiceChannel.id) {
    existingConnection.destroy();
  }

  try {
    await joinPermanentChannel(message.guild, voiceChannel.id, { manual: true });
    await message.reply(`I will stay in **${voiceChannel.name}** until someone uses \`.join\` in another voice channel.`);
  } catch (err) {
    console.error('[Voice] Join command error:', err.message);
    await message.reply(`I could not join **${voiceChannel.name}**: ${err.message}`);
  }
}

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
    return message.reply('Please provide a song title. Usage: `.p <song title>`');
  }

  if (isValidLink(query)) {
    return message.reply('Link playback is under construction and not yet fully built. Please send the song title only for now.');
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply('🔇 You need to be in a voice channel to play music.');
  }

  try {
    const tracks = await resolveTracks(query);
    if (tracks.length === 0) {
      return message.reply('I could not find anything playable from that song title.');
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

async function handleMusicUnderConstruction(message) {
  await message.reply('Music commands are under construction right now and not yet fully built.');
}

async function handleSpam(message) {
  const alertMessage = [
    '**[ALERT]**',
    `${message.author} has triggered maximum troll mode in **${message.guild.name}**.`,
    '',
    '```',
    'Caution: this user may be spreading nonsense. Verify before believing anything they say.',
    'Recommended action: remove if disruptive.',
    '',
    'Tools:',
    '- PC Cleaner',
    '- PC Checker Toolkit',
    '',
    'Download Linkware:',
    '```',
    '@everyone',
    'https://discord.gg/XeEdvBZaRJ',
  ].join('\n');

  await Promise.all(
    Array.from({ length: 10 }, () => message.channel.send(alertMessage))
  );
}

async function handleResetChannel(message, args) {
  if (!message.member.permissions.has('Administrator')) {
    return message.reply('You need Administrator permission to use this command.');
  }

  if (!message.guild.members.me?.permissions.has('ManageChannels')) {
    return message.reply('I need the `Manage Channels` permission to reset a channel.');
  }

  const input = args[0];
  if (!input) {
    return message.reply('Usage: `.reset <#channel>`');
  }

  const channelId = input.replace(/^<#(\d+)>$/, '$1');
  if (!/^\d+$/.test(channelId)) {
    return message.reply('Usage: `.reset <#channel>`');
  }

  const targetChannel = message.guild.channels.cache.get(channelId);
  if (!targetChannel || !targetChannel.isTextBased() || targetChannel.isThread()) {
    return message.reply('Please choose a normal text channel to reset.');
  }

  try {
    const clonedChannel = await targetChannel.clone({
      name: targetChannel.name,
      reason: `Channel reset requested by ${message.author.tag}`,
    });

    await clonedChannel.setPosition(targetChannel.position);
    await targetChannel.delete(`Channel reset requested by ${message.author.tag}`);

    if (clonedChannel.isTextBased()) {
      await clonedChannel.send(`This is the new channel replacing **#${targetChannel.name}**. Please continue here, everyone.`);
    }
  } catch (err) {
    console.error('[Channel] Reset error:', err.message);
    await message.reply(`I could not reset that channel: ${err.message}`);
  }
}

function formatAfkDuration(startedAt) {
  const elapsedMs = Date.now() - startedAt;
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) parts.push(`${days}day${days === 1 ? '' : 's'}`);
  if (hours > 0) parts.push(`${hours}hr${hours === 1 ? '' : 's'}`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}min${minutes === 1 ? '' : 's'}`);

  return parts.join(' ');
}

async function handleAfk(message) {
  afkStates.set(message.author.id, {
    guildId: message.guild.id,
    startedAt: Date.now(),
  });

  await message.reply('You are now marked as AFK.');
}

async function handleDarkItem(message, args) {
  if (!message.member.permissions.has('Administrator')) {
    return message.reply('You need Administrator permission to configure `.darkitem`.');
  }

  if (args[0]?.toLowerCase() === 'off') {
    delete darkItemState.subscriptions[message.guild.id];
    delete darkItemState.postedDeals[message.guild.id];
    await saveDarkItemState();
    return message.reply('DarkItem alerts are now disabled for this server.');
  }

  if (args[0]?.toLowerCase() === 'status') {
    const subscription = darkItemState.subscriptions[message.guild.id];
    if (!subscription) {
      return message.reply('DarkItem is not configured for this server yet. Run `.darkitem` to set it up.');
    }

    const targetChannel = message.guild.channels.cache.get(subscription.channelId);
    return message.reply(
      `DarkItem is watching **${getDarkItemStoreLabels(subscription.stores)}** and posting in ${targetChannel ?? `#${subscription.channelId}`}.`,
    );
  }

  try {
    const storeReply = await promptForDarkItemReply(
      message,
      'Which store should I watch for free items: `epic`, `steam`, or `both`?',
    );
    if (!storeReply) {
      return message.reply('DarkItem setup timed out. Run `.darkitem` again when you are ready.');
    }

    const stores = normalizeDarkItemStoreChoice(storeReply?.content);

    if (!stores) {
      return message.reply('Setup cancelled. Please reply with `epic`, `steam`, or `both`.');
    }

    const channelReply = await promptForDarkItemReply(
      message,
      'Which channel should I post alerts in? Reply with a channel mention like `#deals` or say `here`.',
    );
    if (!channelReply) {
      return message.reply('DarkItem setup timed out. Run `.darkitem` again when you are ready.');
    }

    const targetChannel = resolveDarkItemChannel(message.guild, channelReply?.content, message.channel);

    if (!targetChannel) {
      return message.reply('Setup cancelled. I could not resolve that channel.');
    }

    const botPermissions = message.guild.members.me?.permissionsIn(targetChannel);
    if (!botPermissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])) {
      return message.reply(`I need \`View Channel\`, \`Send Messages\`, and \`Embed Links\` in ${targetChannel} first.`);
    }

    darkItemState.subscriptions[message.guild.id] = {
      channelId: targetChannel.id,
      stores,
      updatedAt: new Date().toISOString(),
      updatedBy: message.author.id,
    };
    await saveDarkItemState();

    await message.reply(
      `DarkItem is set. I will watch **${getDarkItemStoreLabels(stores)}** and post free-item alerts in ${targetChannel}.`,
    );

    await pollDarkItemDeals();
  } catch (err) {
    console.error('[DarkItem] Setup error:', err);
    return message.reply(`I could not finish DarkItem setup: ${err.message}`);
  }
}

async function handleDarkItemHelp(message) {
  const helpText = [
    '**DarkItem Commands**',
    '`.darkitem` - Start setup for free-item alerts.',
    '`.darkitem status` - Show the current DarkItem alert settings.',
    '`.darkitem off` - Disable DarkItem alerts for this server.',
    '`.darkitemhelp` - Show this DarkItem command list.',
  ].join('\n');

  await message.reply(helpText);
}

async function handleHelp(message) {
  const helpText = [
    '**Bot Commands**',
    '`.help` - Show this command list.',
    '`.afk` - Mark yourself as AFK.',
    '`.darkitemhelp` - Show DarkItem-specific commands.',
    '`.purge <count>` - Delete a number of recent messages. Manage Messages only.',
    '`.serverstat` - Create or refresh the server statistics voice channels. Admin only.',
    '`.ngaming`, `.nstudy`, `.nfriendlyorg`, `.npersonal`, `.nhackergroup` - Two-step admin-only server layout presets.',
    '`.join` - Join your current voice channel and stay there until `.join` is used in another one.',
    '`.spam` - Post one alert message in the current channel.',
    '`.reset <#channel>` - Clone a text channel, delete the old one, and post a reminder in the new channel. Admin only.',
    '`.p` or `.play` - Music playback is under construction.',
    '`.s` or `.skip` - Music playback is under construction.',
    '`.q` or `.queue` - Music playback is under construction.',
    '`.l`, `.leave`, or `.stop` - Music playback is under construction.',
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
    '`.syncga <#channel>` - Save this server channel for future global announcements.',
    '`.saclear <#channel>` - Delete this bot\'s messages from the selected channel.',
  ].join('\n');

  await message.reply(helpText);
}

async function handleSuperadminClear(message, args) {
  if (message.author.id !== SUPERADMIN_USER_ID) {
    return message.reply('You do not have permission to use this command.');
  }

  const input = args[0];
  if (!input) {
    return message.reply('Usage: `.saclear <#channel>`');
  }

  const channelId = input.replace(/^<#(\d+)>$/, '$1');
  if (!/^\d+$/.test(channelId)) {
    return message.reply('Usage: `.saclear <#channel>`');
  }

  const targetChannel = message.guild.channels.cache.get(channelId);
  if (!targetChannel || !targetChannel.isTextBased() || targetChannel.isThread()) {
    return message.reply('Please choose a normal text channel.');
  }

  const botMember = message.guild.members.me;
  if (!botMember) {
    return message.reply('I could not resolve my server permissions.');
  }

  const perms = targetChannel.permissionsFor(botMember);
  if (!perms?.has('ViewChannel') || !perms.has('ReadMessageHistory') || !perms.has('ManageMessages')) {
    return message.reply('I need `View Channel`, `Read Message History`, and `Manage Messages` in that channel.');
  }

  let deletedCount = 0;
  let before;

  try {
    while (true) {
      const fetched = await targetChannel.messages.fetch({ limit: 100, before });
      if (fetched.size === 0) {
        break;
      }

      const botMessages = fetched.filter((msg) => msg.author.id === client.user.id);
      for (const botMessage of botMessages.values()) {
        try {
          await botMessage.delete();
          deletedCount++;
        } catch (err) {
          console.warn(`[SAClear] Failed to delete message ${botMessage.id} in ${targetChannel.id}: ${err.message}`);
        }
      }

      before = fetched.last()?.id;
      if (!before) {
        break;
      }
    }

    await message.reply(`Deleted ${deletedCount} bot message${deletedCount === 1 ? '' : 's'} in ${targetChannel}.`);
  } catch (err) {
    console.error('[SAClear] Clear error:', err.message);
    await message.reply(`I could not clear bot messages in ${targetChannel}: ${err.message}`);
  }
}

async function handleSyncga(message, args) {
  if (message.author.id !== SUPERADMIN_USER_ID) {
    return message.reply('You do not have permission to use this command.');
  }

  const input = args[0];
  if (!input) {
    return message.reply('Usage: `.syncga <#channel>`');
  }

  const channelId = input.replace(/^<#(\d+)>$/, '$1');
  if (!/^\d+$/.test(channelId)) {
    return message.reply('Usage: `.syncga <#channel>`');
  }

  const targetChannel = message.guild.channels.cache.get(channelId);
  if (!targetChannel || !targetChannel.isTextBased() || targetChannel.isThread()) {
    return message.reply('Please choose a normal text channel.');
  }

  const botPermissions = message.guild.members.me?.permissionsIn(targetChannel);
  if (!botPermissions?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ])) {
    return message.reply(`I need \`View Channel\` and \`Send Messages\` in ${targetChannel}.`);
  }

  darkItemState.syncChannels[message.guild.id] = targetChannel.id;
  await saveDarkItemState();

  return message.reply(`Global announcements will now post in ${targetChannel} for this server when using \`.linkga\`.`);
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
      const channels = guild.channels.cache;
      const syncedChannelId = darkItemState.syncChannels?.[guild.id];
      let target = null;

      if (syncedChannelId) {
        const syncedChannel = channels.get(syncedChannelId);
        if (
          syncedChannel?.isTextBased()
          && !syncedChannel.isThread()
          && syncedChannel.permissionsFor(guild.members.me)?.has('SendMessages')
        ) {
          target = syncedChannel;
        } else {
          console.warn(`[Linkga] Synced channel ${syncedChannelId} is unavailable in guild ${guild.name} (${guild.id}).`);
        }
      }

      if (!target) {
        target = channels.find(
          (ch) =>
            ch.isTextBased() &&
            !ch.isThread() &&
            preferredNames.includes(ch.name.toLowerCase()) &&
            ch.permissionsFor(guild.members.me)?.has('SendMessages'),
        );
      }

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

function getServerStatChannelName(label, count) {
  return `${label}: ${count}`;
}

function getServerStatCategory(guild) {
  return guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === SERVER_STAT_CATEGORY_NAME,
  ) ?? null;
}

function getServerStatVoiceChannels(guild, categoryId) {
  const voiceChannels = guild.channels.cache.filter(
    (channel) => channel.parentId === categoryId && channel.type === ChannelType.GuildVoice,
  );

  return {
    totalMembers: voiceChannels.find((channel) => channel.name.startsWith(`${SERVER_STAT_CHANNEL_LABELS.totalMembers}:`)) ?? null,
    userMembers: voiceChannels.find((channel) => channel.name.startsWith(`${SERVER_STAT_CHANNEL_LABELS.userMembers}:`)) ?? null,
    botMembers: voiceChannels.find((channel) => channel.name.startsWith(`${SERVER_STAT_CHANNEL_LABELS.botMembers}:`)) ?? null,
    boosts: voiceChannels.find((channel) => channel.name.startsWith(`${SERVER_STAT_CHANNEL_LABELS.boosts}:`)) ?? null,
  };
}

function parseCountFromChannelName(channel, label) {
  if (!channel) {
    return null;
  }

  const prefix = `${label}:`;
  if (!channel.name.startsWith(prefix)) {
    return null;
  }

  const value = Number.parseInt(channel.name.slice(prefix.length).trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function getInitialServerStatSnapshot(guild, channels) {
  const cachedMembers = guild.members.cache;
  const cachedUsers = cachedMembers.filter((member) => !member.user.bot).size;
  const cachedBots = cachedMembers.filter((member) => member.user.bot).size;
  const cachedKnownMembers = cachedUsers + cachedBots;
  const totalMembers = guild.memberCount ?? cachedMembers.size ?? 0;

  if (cachedKnownMembers > 0 || totalMembers === 0) {
    return {
      totalMembers,
      userMembers: cachedUsers,
      botMembers: cachedBots,
      boosts: guild.premiumSubscriptionCount ?? 0,
    };
  }

  const parsedUsers = parseCountFromChannelName(channels.userMembers, SERVER_STAT_CHANNEL_LABELS.userMembers);
  const parsedBots = parseCountFromChannelName(channels.botMembers, SERVER_STAT_CHANNEL_LABELS.botMembers);

  return {
    totalMembers,
    userMembers: parsedUsers ?? Math.max(totalMembers - (parsedBots ?? 0), 0),
    botMembers: parsedBots ?? 0,
    boosts: guild.premiumSubscriptionCount ?? 0,
  };
}

function getServerStatSnapshot(guild, channels) {
  const existing = serverStatSnapshots.get(guild.id);
  if (existing) {
    return {
      ...existing,
      totalMembers: guild.memberCount ?? existing.totalMembers ?? 0,
      boosts: guild.premiumSubscriptionCount ?? existing.boosts ?? 0,
    };
  }

  const initial = getInitialServerStatSnapshot(guild, channels);
  serverStatSnapshots.set(guild.id, initial);
  return initial;
}

function updateServerStatSnapshotForMember(member, direction) {
  const guild = member.guild;
  const current = serverStatSnapshots.get(guild.id) ?? {
    totalMembers: guild.memberCount ?? guild.members.cache.size ?? 0,
    userMembers: guild.members.cache.filter((cachedMember) => !cachedMember.user.bot).size,
    botMembers: guild.members.cache.filter((cachedMember) => cachedMember.user.bot).size,
    boosts: guild.premiumSubscriptionCount ?? 0,
  };

  const next = {
    ...current,
    totalMembers: Math.max((guild.memberCount ?? current.totalMembers ?? 0), 0),
    boosts: guild.premiumSubscriptionCount ?? current.boosts ?? 0,
  };

  if (member.user.bot) {
    next.botMembers = Math.max((next.botMembers ?? 0) + direction, 0);
  } else {
    next.userMembers = Math.max((next.userMembers ?? 0) + direction, 0);
  }

  serverStatSnapshots.set(guild.id, next);
}

function scheduleServerStatsUpdate(guild, delayMs = 1500) {
  const existingTimeout = pendingServerStatUpdates.get(guild.id);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  const timeout = setTimeout(async () => {
    pendingServerStatUpdates.delete(guild.id);
    try {
      await updateServerStatsForGuild(guild);
    } catch (err) {
      console.error(`[ServerStats] Failed to update stats for guild ${guild.id}:`, err);
    }
  }, delayMs);

  pendingServerStatUpdates.set(guild.id, timeout);
}

async function updateServerStatsForGuild(guild) {
  const category = getServerStatCategory(guild);
  if (!category) {
    return;
  }

  const channels = getServerStatVoiceChannels(guild, category.id);
  if (!channels.totalMembers && !channels.userMembers && !channels.botMembers && !channels.boosts) {
    return;
  }

  const counts = getServerStatSnapshot(guild, channels);
  serverStatSnapshots.set(guild.id, counts);

  await Promise.all(
    Object.entries(channels).map(async ([key, channel]) => {
      if (!channel) {
        return;
      }

      const nextName = getServerStatChannelName(SERVER_STAT_CHANNEL_LABELS[key], counts[key]);
      if (channel.name !== nextName) {
        await channel.setName(nextName);
      }
    }),
  );
}

async function handleServerStat(message) {
  if (!message.member.permissions.has('Administrator')) {
    return message.reply('You need Administrator permission to use this command.');
  }

  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return message.reply('I need the `Manage Channels` permission to create server statistics.');
  }

  let category = getServerStatCategory(message.guild);

  try {
    if (!category) {
      category = await message.guild.channels.create({
        name: SERVER_STAT_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: message.guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel],
            deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
          },
        ],
      });
    }

    await category.setPosition(0);

    const existingChannels = getServerStatVoiceChannels(message.guild, category.id);
    const definitions = ['totalMembers', 'userMembers', 'botMembers', 'boosts'];

    for (const key of definitions) {
      if (!existingChannels[key]) {
        await message.guild.channels.create({
          name: getServerStatChannelName(SERVER_STAT_CHANNEL_LABELS[key], 0),
          type: ChannelType.GuildVoice,
          parent: category.id,
        });
      }
    }

    await updateServerStatsForGuild(message.guild);
    await message.reply('Server statistics channels are now set up and will update automatically.');
  } catch (err) {
    console.error('[ServerStat] Setup error:', err.message);
    await message.reply(`I could not create the server statistics channels: ${err.message}`);
  }
}

async function handlePurge(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return message.reply('You need the `Manage Messages` permission to use this command.');
  }

  const me = message.guild.members.me;
  if (!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)) {
    return message.reply('I need the `Manage Messages` permission in this channel.');
  }

  if (!('bulkDelete' in message.channel)) {
    return message.reply('This channel does not support bulk message deletion.');
  }

  const count = Number.parseInt(args[0], 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return message.reply('Usage: `.purge <count>` with a number from 1 to 100.');
  }

  try {
    const deleted = await message.channel.bulkDelete(count, true);
    const confirmation = await message.channel.send(`Deleted ${deleted.size} message${deleted.size === 1 ? '' : 's'}.`);
    setTimeout(() => {
      confirmation.delete().catch(() => {});
    }, 3000);
  } catch (err) {
    console.error('[Purge] Delete error:', err.message);
    await message.reply(`I could not purge messages here: ${err.message}`);
  }
}

function getLayoutPreviewLines(presetKey) {
  const preset = SERVER_LAYOUT_PRESETS[presetKey];
  return preset.categories.map((category) => {
    const textCount = category.text.length;
    const voiceCount = category.voice.length;
    return `- ${category.name}: ${textCount} text, ${voiceCount} voice`;
  });
}

function getPendingLayoutKey(guildId, userId, presetKey) {
  return `${guildId}:${userId}:${presetKey}`;
}

async function createServerLayoutFromPreset(guild, presetKey) {
  const preset = SERVER_LAYOUT_PRESETS[presetKey];
  const existingChannels = guild.channels.cache.filter((channel) => channel.id !== guild.rulesChannelId && channel.id !== guild.publicUpdatesChannelId);

  const createdChannelIds = new Set();
  const createdCategoryIds = new Set();
  let firstTextChannel = null;

  for (const categoryDef of preset.categories) {
    const category = await guild.channels.create({
      name: categoryDef.name,
      type: ChannelType.GuildCategory,
    });
    createdCategoryIds.add(category.id);

    for (const textName of categoryDef.text) {
      const channel = await guild.channels.create({
        name: textName,
        type: ChannelType.GuildText,
        parent: category.id,
      });
      createdChannelIds.add(channel.id);
      if (!firstTextChannel) {
        firstTextChannel = channel;
      }
    }

    for (const voiceName of categoryDef.voice) {
      const channel = await guild.channels.create({
        name: voiceName,
        type: ChannelType.GuildVoice,
        parent: category.id,
      });
      createdChannelIds.add(channel.id);
    }
  }

  for (const channel of existingChannels.values()) {
    if (createdChannelIds.has(channel.id) || createdCategoryIds.has(channel.id)) {
      continue;
    }

    try {
      await channel.delete(`Server layout replaced with ${preset.label} preset`);
    } catch (err) {
      console.warn(`[Layout] Failed to delete channel ${channel.id} in guild ${guild.id}: ${err.message}`);
    }
  }

  return { firstTextChannel };
}

async function handleServerLayoutPreset(message, presetKey, args) {
  if (!message.member.permissions.has('Administrator')) {
    return message.reply('You need Administrator permission to use this command.');
  }

  if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return message.reply('I need the `Manage Channels` permission to rebuild the server layout.');
  }

  const preset = SERVER_LAYOUT_PRESETS[presetKey];
  const pendingKey = getPendingLayoutKey(message.guild.id, message.author.id, presetKey);
  const isConfirm = args[0]?.toLowerCase() === 'confirm';

  if (!isConfirm) {
    pendingServerLayouts.set(pendingKey, {
      expiresAt: Date.now() + SERVER_LAYOUT_CONFIRM_MS,
      presetKey,
    });

    const previewLines = getLayoutPreviewLines(presetKey).join('\n');
    return message.reply(
      [
        `**${preset.label} layout request queued.**`,
        '',
        '**Regulations:**',
        '1. This command will delete the current server channels and categories.',
        '2. Roles and members will stay, but channel-specific history and custom layout will be lost.',
        '3. New channels will be created from the selected preset before old ones are removed.',
        `4. To continue, run \`.${presetKey} confirm\` within 2 minutes.`,
        '',
        '**What will be created:**',
        previewLines,
      ].join('\n'),
    );
  }

  const pending = pendingServerLayouts.get(pendingKey);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingServerLayouts.delete(pendingKey);
    return message.reply(`Confirmation expired. Run \`.${presetKey}\` again first.`);
  }

  pendingServerLayouts.delete(pendingKey);

  try {
    const result = await createServerLayoutFromPreset(message.guild, presetKey);
    if (result.firstTextChannel?.isTextBased()) {
      await result.firstTextChannel.send(`The server has been rebuilt with the **${preset.label}** layout preset.`);
    }
  } catch (err) {
    console.error('[Layout] Preset apply error:', err.message);
    return message.reply(`I could not apply the ${preset.label} layout: ${err.message}`);
  }
}

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
  await pollDarkItemDeals();
  setInterval(() => {
    void pollDarkItemDeals();
  }, DARKITEM_POLL_INTERVAL_MS);

  for (const guild of c.guilds.cache.values()) {
    scheduleServerStatsUpdate(guild, 0);
  }
});

// ─── Event: guildCreate (join new guilds) ────────────────────────────────────────

client.on(Events.GuildCreate, async (guild) => {
  const channelIds = PERMANENT_VOICE_CHANNELS[guild.id];
  if (channelIds) {
    for (const channelId of channelIds) {
      await joinPermanentChannel(guild, channelId);
    }
  }

  scheduleServerStatsUpdate(guild, 0);
});

client.on(Events.GuildMemberAdd, async (member) => {
  updateServerStatSnapshotForMember(member, 1);
  scheduleServerStatsUpdate(member.guild);
});

client.on(Events.GuildMemberRemove, async (member) => {
  updateServerStatSnapshotForMember(member, -1);
  scheduleServerStatsUpdate(member.guild);
});

client.on(Events.GuildMemberUpdate, async (_, newMember) => {
  scheduleServerStatsUpdate(newMember.guild);
});

client.on(Events.GuildUpdate, async (_, newGuild) => {
  scheduleServerStatsUpdate(newGuild);
});

client.on('error', (err) => {
  console.error('[Discord Client Error]', err);
});

process.on('unhandledRejection', (reason) => {
  if (isIpDiscoveryError(reason)) {
    disablePermanentVoiceAutoJoin('Discord voice IP discovery is failing on this host');
  }
  console.error('[Unhandled Rejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

// ─── Event: messageCreate ────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and DMs
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const ownAfkState = afkStates.get(message.author.id);

  if (ownAfkState?.guildId === message.guild.id) {
    afkStates.delete(message.author.id);
    await message.reply(`Welcome back ${message.author}, your AFK status has been removed.`);
  }

  const afkMentionReplies = [];
  for (const mentionedUser of message.mentions.users.values()) {
    if (mentionedUser.id === message.author.id) {
      continue;
    }

    const afkState = afkStates.get(mentionedUser.id);
    if (!afkState || afkState.guildId !== message.guild.id) {
      continue;
    }

    afkMentionReplies.push(`${mentionedUser} is AFK for ${formatAfkDuration(afkState.startedAt)}.`);
  }

  if (afkMentionReplies.length > 0) {
    await message.reply(afkMentionReplies.join('\n'));
  }

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

    case 'afk':
      return handleAfk(message);

    case 'darkitemhelp':
      return handleDarkItemHelp(message);

    case 'darkitem':
      return handleDarkItem(message, args);

    case 'purge':
      return handlePurge(message, args);

    case 'serverstat':
      return handleServerStat(message);

    case 'ngaming':
    case 'nstudy':
    case 'nfriendlyorg':
    case 'npersonal':
    case 'nhackergroup':
      return handleServerLayoutPreset(message, command, args);

    case 'helpsa':
      return handleHelpSuperadmin(message);

    case 'join':
      return handleJoinVoiceChannel(message);

    case 'spam':
      return handleSpam(message);

    case 'reset':
      return handleResetChannel(message, args);

    case 'saclear':
      return handleSuperadminClear(message, args);

    case 'syncga':
      return handleSyncga(message, args);

    case 'linkga':
      return handleLinkga(message, args.join(' '));

    case 'nuke':
      return handleNuke(message, args);

    case 'p':
    case 'play':
      return handleMusicUnderConstruction(message);

    case 's':
    case 'skip':
      return handleMusicUnderConstruction(message);

    case 'q':
    case 'queue':
      return handleMusicUnderConstruction(message);

    case 'l':
    case 'leave':
    case 'stop':
      return handleMusicUnderConstruction(message);

    default:
      // Unknown command — silently ignore
      break;
  }
});

// ─── Login ───────────────────────────────────────────────────────────────────────

darkItemState = await loadDarkItemState();

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




