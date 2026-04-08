import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
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
const SPOTIFY_MARKET        = process.env.SPOTIFY_MARKET?.trim() || 'US';
const YOUTUBE_COOKIE        = readEnv('YOUTUBE_COOKIE', 'your-youtube-cookie-here');
const YOUTUBE_USER_AGENT    = readEnv(
  'YOUTUBE_USER_AGENT',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
);

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
  };

  audioPlayer.on(AudioPlayerStatus.Idle, () => {
    state.currentTrack = null;
    void playNext(guildId);
  });

  audioPlayer.on('error', (error) => {
    console.error(`[Music] Playback error in guild ${guildId}:`, error.message);
    state.textChannel?.send(`❌ Playback failed: ${error.message}`);
    state.currentTrack = null;
    void playNext(guildId);
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

function normalizeYouTubeTrack(video) {
  const canonicalUrl = video.id
    ? `https://www.youtube.com/watch?v=${video.id}`
    : (video.url || video.watch_url || video.webpage_url || null);

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
  const results = await play.search(query, {
    limit: 1,
    source: {
      youtube: 'video',
    },
  });

  const firstResult = results[0] ?? null;
  if (!firstResult) {
    return null;
  }

  const candidateUrl = firstResult.id
    ? `https://www.youtube.com/watch?v=${firstResult.id}`
    : (firstResult.url || firstResult.watch_url || firstResult.webpage_url || null);

  if (!candidateUrl) {
    return firstResult;
  }

  try {
    const info = await play.video_info(candidateUrl);
    return info.video_details;
  } catch {
    return firstResult;
  }
}

async function bridgeSpotifyTrack(track) {
  const searchQuery = `${track.name} ${track.artists.map((artist) => artist.name).join(' ')} audio`;
  const bridgedVideo = await searchYouTubeVideo(searchQuery);

  if (!bridgedVideo) {
    throw new Error(`Could not find a playable YouTube match for Spotify track "${track.name}".`);
  }

  return normalizeSpotifyTrack(track, bridgedVideo);
}

async function resolveTracks(query) {
  const queryType = await play.validate(query);

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

  try {
    let streamUrl = nextTrack.url;

    if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) {
      const recoveredVideo = await searchYouTubeVideo(`${nextTrack.title} ${nextTrack.author}`);
      streamUrl = recoveredVideo?.id
        ? `https://www.youtube.com/watch?v=${recoveredVideo.id}`
        : (recoveredVideo?.url || recoveredVideo?.watch_url || recoveredVideo?.webpage_url || null);
    }

    if (!streamUrl) {
      throw new Error('No playable URL found');
    }

    const stream = await play.stream(streamUrl);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type || StreamType.Arbitrary,
    });

    state.audioPlayer.play(resource);

    const sourceLabel = nextTrack.source === 'Spotify' && nextTrack.originalUrl
      ? ` (from Spotify)`
      : '';

    await state.textChannel?.send(`▶️ **Now playing:** ${nextTrack.title}${sourceLabel}`);
  } catch (error) {
    console.error(`[Music] Stream error in guild ${guildId}:`, error.message);
    if (String(error.message).includes('Sign in to confirm you’re not a bot')) {
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
      await playNext(message.guild.id);
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

// ─── Event: ready ───────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`[Bot] Logged in as ${c.user.tag}`);
  c.user.setActivity('24/7 | .p to play music');

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

try {
  await client.login(DISCORD_TOKEN);
} catch (err) {
  if (err?.code === 'TokenInvalid') {
    console.error('[Config] Discord rejected DISCORD_TOKEN. Make sure you copied the bot token from the Discord Developer Portal Bot page.');
    process.exit(1);
  }
  throw err;
}
