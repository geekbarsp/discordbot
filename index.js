import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { Player } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import OpenAI from 'openai';

// ─── Config ────────────────────────────────────────────────────────────────────

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;

// Guild ID → array of voice channel IDs the bot should permanently occupy.
// Add your own guild/channel IDs here.
const PERMANENT_VOICE_CHANNELS = {
  // 'YOUR_GUILD_ID': ['VOICE_CHANNEL_ID_1', 'VOICE_CHANNEL_ID_2'],
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

const openai = new OpenAI({
  apiKey:  OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

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
    selfMute:       true,
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
  try {
    await message.channel.sendTyping();

    const completion = await openai.chat.completions.create({
      model:    'gpt-3.5-turbo',
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
      max_tokens: 500,
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
        metadata: { channel: message.channel },
        selfDeaf:  true,
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

client.login(DISCORD_TOKEN);
