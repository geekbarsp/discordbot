import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { Player } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import OpenAI from 'openai';

// ─── Config ────────────────────────────────────────────────────────────────────

function readEnv(name, placeholder) {
  const value = process.env[name]?.trim();
  if (!value || value === placeholder) {
    return null;
  }
  return value;
}

const DISCORD_TOKEN   = readEnv('DISCORD_TOKEN', 'your-discord-bot-token-here');
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
const OPENAI_API_KEY  = readEnv('OPENAI_API_KEY', 'your-openai-key-here');

if (!DISCORD_TOKEN) {
  console.error('[Config] DISCORD_TOKEN is missing in .env. Add your Discord bot token and restart the bot.');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.warn('[Config] OPENAI_API_KEY is missing in .env. The `link` command will stay disabled until it is set.');
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

// ─── discord-player setup ───────────────────────────────────────────────────────

const player = new Player(client);

(async () => {
  await player.extractors.loadMulti(DefaultExtractors);
  console.log('[Player] Extractors loaded.');
})();

player.events.on('playerError', (queue, error) => {
  console.error(`[Player] Error in guild ${queue.guild.id}:`, error.message);
});

player.events.on('error', (queue, error) => {
  console.error(`[Player] Queue error in guild ${queue.guild.id}:`, error.message);
});

player.events.on('audioTrackAdd', (queue, track) => {
  queue.metadata?.channel?.send(`🎵 **Queued:** ${track.title}`);
});

player.events.on('playerStart', (queue, track) => {
  queue.metadata?.channel?.send(`▶️ **Now playing:** ${track.title}`);
});

player.events.on('emptyQueue', (queue) => {
  queue.metadata?.channel?.send('✅ Queue finished.');
});

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
    await message.reply('❌ `OPENAI_API_KEY` is missing in `.env`, so the `link` command is unavailable right now.');
    return;
  }

  try {
    await message.channel.sendTyping();

    const completion = await openai.chat.completions.create({
      model:    'gpt-4o',
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
    await message.reply('❌ AI service is unavailable right now. Please try again later.');
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
    const { track } = await player.play(voiceChannel, query, {
      nodeOptions: {
        metadata:     { channel: message.channel },
        selfDeaf:     true,
        volume:       80,
        leaveOnEnd:   false,
        leaveOnEmpty: false,
      },
    });

    // audioTrackAdd / playerStart events handle the reply
  } catch (err) {
    console.error('[Music] Play error:', err.message);
    await message.reply(`❌ Could not play that track: ${err.message}`);
  }
}

async function handleSkip(message) {
  const queue = player.nodes.get(message.guild.id);
  if (!queue || !queue.isPlaying()) {
    return message.reply('⏹️ Nothing is currently playing.');
  }
  queue.node.skip();
  await message.reply('⏭️ Skipped.');
}

async function handleQueue(message) {
  const queue = player.nodes.get(message.guild.id);
  if (!queue || queue.tracks.size === 0) {
    return message.reply('📭 The queue is empty.');
  }

  const tracks = queue.tracks.toArray().slice(0, 10);
  const list   = tracks.map((t, i) => `**${i + 1}.** ${t.title}`).join('\n');
  const current = queue.currentTrack ? `▶️ **Now playing:** ${queue.currentTrack.title}\n\n` : '';

  await message.reply(`${current}**Up next:**\n${list}${queue.tracks.size > 10 ? `\n…and ${queue.tracks.size - 10} more` : ''}`);
}

async function handleLeave(message) {
  const queue = player.nodes.get(message.guild.id);
  if (queue) {
    queue.delete();
  }

  const connection = (await import('@discordjs/voice')).getVoiceConnection(message.guild.id);
  if (connection) {
    connection.destroy();
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
