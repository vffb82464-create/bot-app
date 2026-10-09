require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  StreamType,
} = require('@discordjs/voice');
const play = require('play-dl');

const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.DISCORD_REDIRECT_URI?.replace(/\/auth\/callback\/?$/, '');
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BOT_SYNC_SECRET = process.env.BOT_SYNC_SECRET;
const BOT_SYNC_ONLY = process.env.BOT_SYNC_ONLY === 'true';
const GIPHY_API_KEY = process.env.GIPHY_API_KEY;
const ALLOWED_GUILD_ID = '1508431497433190420';
const ALLOWED_ROLE_ID = '1540132253097664572';
const MAX_ACTIVITY_LOGS = 200;
const DATA_PATH = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_PATH, 'config.json');
const WARNINGS_PATH = path.join(DATA_PATH, 'warnings.json');
const ACTIVITY_LOG_PATH = path.join(DATA_PATH, 'activity-logs.json');

if ((!DISCORD_TOKEN && !BOT_SYNC_ONLY) || !CLIENT_ID || !CLIENT_SECRET || !SESSION_SECRET || !APP_URL) {
  throw new Error(
    'Configure DISCORD_TOKEN (unless BOT_SYNC_ONLY=true), DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, '
    + 'DISCORD_REDIRECT_URI et SESSION_SECRET avant de démarrer le site.'
  );
}
if (BOT_SYNC_ONLY && (!BOT_SYNC_SECRET || BOT_SYNC_SECRET.length < 32)) {
  throw new Error('BOT_SYNC_SECRET doit contenir au moins 32 caractères aléatoires.');
}
if (SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET doit contenir au moins 32 caractères aléatoires.');
}

fs.mkdirSync(DATA_PATH, { recursive: true });

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '128kb' }));
app.use(session({
  name: 'panel.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const DEFAULT_CONFIG = {
  guildId: ALLOWED_GUILD_ID,
  channelId: '',
  welcomeEnabled: false,
  welcomeChannelId: '',
  welcomeMessage: 'Bienvenue {user} sur {server} ! 🎉',
};
const memberCache = new Map();
const botCache = new Map();
const statsCache = new Map();
const memberFetchInFlight = new Map();
const botFetchInFlight = new Map();
const statsFetchInFlight = new Map();
const events = new Set();
const guildsBeingRemoved = new Set();
let config = loadJson(CONFIG_PATH, DEFAULT_CONFIG);
let warnings = loadJson(WARNINGS_PATH, []);
let activityLogs = loadJson(ACTIVITY_LOG_PATH, []).slice(0, MAX_ACTIVITY_LOGS);
let activeVoiceConnection = null;
let audioPlayer = null;
let currentMusic = { title: '', playing: false };
let botLoginError = null;
let remoteBotSnapshot = { connected: false, guilds: [], lastSeen: 0 };

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function sendEvent(name, data) {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of events) {
    if (response.destroyed || response.writableEnded) {
      events.delete(response);
      continue;
    }
    response.write(payload);
  }
}

function recordActivity(type, message, details = {}) {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    message,
    details,
  };
  activityLogs = [entry, ...activityLogs].slice(0, MAX_ACTIVITY_LOGS);
  try {
    saveJson(ACTIVITY_LOG_PATH, activityLogs);
  } catch (error) {
    console.error('Impossible d’enregistrer le journal d’activité :', error);
  }
  sendEvent('activity-log', entry);
}

function configForUser() {
  return {
    ...config,
    guildId: ALLOWED_GUILD_ID,
    readOnly: BOT_SYNC_ONLY,
  };
}

async function fetchDiscordJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload.error_description
      || payload.message
      || `Le service externe a répondu ${response.status}.`
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyRequiredRole(req, res, next) {
  if (!req.session.discord?.accessToken) {
    if (!req.originalUrl.startsWith('/api/')) return res.redirect('/login');
    return res.status(401).json({ error: 'Connecte-toi avec Discord pour continuer.' });
  }

  const checkedAt = req.session.discord.roleCheckedAt || 0;
  if (Date.now() - checkedAt < 30000 && req.session.discord.hasRequiredRole) {
    return next();
  }

  try {
    const member = await fetchDiscordJson(
      `https://discord.com/api/users/@me/guilds/${ALLOWED_GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${req.session.discord.accessToken}` } }
    );
    const hasRequiredRole = Array.isArray(member.roles) && member.roles.includes(ALLOWED_ROLE_ID);
    if (!hasRequiredRole) {
      req.session.destroy(() => {});
      if (!req.originalUrl.startsWith('/api/')) return res.redirect('/login?denied=role');
      return res.status(403).json({ error: `Le rôle Discord requis (${ALLOWED_ROLE_ID}) est nécessaire.` });
    }

    req.session.discord.hasRequiredRole = true;
    req.session.discord.roleCheckedAt = Date.now();
    return next();
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      req.session.destroy(() => {});
      if (!req.originalUrl.startsWith('/api/')) return res.redirect('/login?denied=guild');
      return res.status(403).json({ error: 'Impossible de vérifier ton rôle sur le serveur Discord autorisé.' });
    }
    console.error('Discord role check failed:', error.message);
    return res.status(503).json({ error: 'Vérification Discord momentanément indisponible. Réessaie.' });
  }
}

app.get('/health', (req, res) => {
  const remoteConnected = BOT_SYNC_ONLY
    && remoteBotSnapshot.connected
    && Date.now() - remoteBotSnapshot.lastSeen < 120000;
  res.json({ ok: true, botConnected: BOT_SYNC_ONLY ? remoteConnected : client.isReady() });
});

app.post('/api/bot-sync', (req, res) => {
  if (!BOT_SYNC_SECRET) return res.sendStatus(404);
  const suppliedSecret = req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const expected = Buffer.from(BOT_SYNC_SECRET);
  const supplied = Buffer.from(suppliedSecret);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return res.sendStatus(401);
  }

  const { connected, guilds } = req.body || {};
  if (typeof connected !== 'boolean' || !Array.isArray(guilds) || guilds.length > 500) {
    return res.status(400).json({ error: 'Invalid bot snapshot.' });
  }
  const normalizedGuilds = [];
  for (const guild of guilds) {
    if (
      !guild || typeof guild.id !== 'string' || !/^\d{17,20}$/.test(guild.id)
      || typeof guild.name !== 'string' || guild.name.length > 100
    ) {
      return res.status(400).json({ error: 'Invalid guild entry.' });
    }
    normalizedGuilds.push({
      id: guild.id,
      name: guild.name,
      memberCount: Number.isInteger(guild.memberCount) && guild.memberCount >= 0
        ? guild.memberCount
        : 0,
    });
  }
  remoteBotSnapshot = {
    connected,
    guilds: normalizedGuilds,
    lastSeen: Date.now(),
  };
  return res.sendStatus(204);
});

app.get('/login', (req, res) => {
  if (req.session.discord?.accessToken) return res.redirect('/');
  const denied = req.query.denied === 'role'
    ? 'Ton compte n’a pas le rôle Discord requis.'
    : req.query.denied === 'guild'
      ? 'Impossible de vérifier ton appartenance au serveur autorisé.'
      : '';
  res.type('html').send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Panel Bot — Connexion</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121319;color:#e7e7ea;font:16px Inter,system-ui,sans-serif}
main{width:min(440px,calc(100% - 32px));padding:32px;border:1px solid #2a2d38;border-radius:16px;background:#1a1c24;text-align:center}
h1{margin:0 0 10px;font-size:28px}p{color:#aeb0bb;line-height:1.6}.error{color:#f77b82}
a{display:inline-block;margin-top:14px;padding:13px 20px;border-radius:8px;background:#5865f2;color:white;text-decoration:none;font-weight:700}
small{display:block;margin-top:20px;color:#8b8d98;line-height:1.5}
</style></head><body><main><h1>◈ Panel Bot</h1>
<p>Connecte-toi avec Discord. L’accès est réservé aux membres du serveur autorisé qui ont le rôle requis.</p>
${denied ? `<p class="error">${denied}</p>` : ''}
<a href="/auth/discord">Continuer avec Discord</a>
<small>Le site vérifie ton rôle Discord avant de donner accès au panel.</small></main></body></html>`);
});

app.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.regenerate((error) => {
    if (error) return res.status(500).send('Impossible de démarrer la connexion Discord.');
    req.session.oauthState = state;
    const authorization = new URL('https://discord.com/oauth2/authorize');
    authorization.search = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: `${APP_URL}/auth/callback`,
      scope: 'identify guilds.members.read',
      state,
      prompt: 'consent',
    });
    return res.redirect(authorization.toString());
  });
});

app.get('/auth/callback', async (req, res, next) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/login?denied=oauth');
  if (
    typeof code !== 'string'
    || typeof state !== 'string'
    || !req.session.oauthState
    || !safeEqual(state, req.session.oauthState)
  ) {
    return res.status(400).send('La vérification de connexion a échoué. Retourne à la page de connexion.');
  }
  delete req.session.oauthState;

  try {
    const token = await fetchDiscordJson('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${APP_URL}/auth/callback`,
      }),
    });
    if (!token.access_token) throw new Error('Discord n’a pas retourné de jeton OAuth.');
    const user = await fetchDiscordJson('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    await new Promise((resolve, reject) => {
      req.session.regenerate((sessionError) => sessionError ? reject(sessionError) : resolve());
    });
    req.session.discord = {
      id: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar,
      accessToken: token.access_token,
      tokenExpiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
      hasRequiredRole: false,
      roleCheckedAt: 0,
    };
    await new Promise((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
    return res.redirect('/');
  } catch (oauthError) {
    return next(oauthError);
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).send('Impossible de fermer la session.');
    res.clearCookie('panel.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return res.redirect('/login');
  });
});

app.get('/', verifyRequiredRole, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/renderer.js', verifyRequiredRole, (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'renderer.js'));
});

app.get('/web-bridge.js', verifyRequiredRole, (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'web-bridge.js'));
});

app.get('/style.css', verifyRequiredRole, (req, res) => {
  res.type('text/css').sendFile(path.join(__dirname, 'style.css'));
});

app.get('/api/session', verifyRequiredRole, (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({
    user: {
      id: req.session.discord.id,
      username: req.session.discord.username,
      avatar: req.session.discord.avatar,
    },
    csrfToken: req.session.csrfToken,
  });
});

app.use('/api', verifyRequiredRole, (req, res, next) => {
  if (req.method !== 'POST') return next();
  const csrfToken = req.get('x-csrf-token');
  if (!req.session.csrfToken || !csrfToken || !safeEqual(csrfToken, req.session.csrfToken)) {
    return res.status(403).json({ error: 'La vérification de sécurité a échoué. Recharge le site.' });
  }
  return next();
});

app.get('/api/events', verifyRequiredRole, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const initial = [
    ['bot-status', { connected: client.isReady(), tag: client.user?.tag, error: botLoginError }],
    ['voice-status', activeVoiceConnection
      ? { connected: true, guildId: activeVoiceConnection.joinConfig.guildId, channelId: activeVoiceConnection.joinConfig.channelId }
      : { connected: false }],
    ['music-status', currentMusic],
  ];
  for (const [name, data] of initial) {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  events.add(res);
  const heartbeat = setInterval(() => {
    if (Date.now() - (req.session.discord?.roleCheckedAt || 0) >= 30000) {
      clearInterval(heartbeat);
      events.delete(res);
      res.end();
      return;
    }
    res.write(': keep-alive\n\n');
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    events.delete(res);
  });
});

async function fetchGuildMembers(guildId, includeBots = false) {
  if (guildId !== ALLOWED_GUILD_ID) throw new Error('Serveur non autorisé.');
  const cache = includeBots ? botCache : memberCache;
  const inFlight = includeBots ? botFetchInFlight : memberFetchInFlight;
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.timestamp < 300000) return cached.members;
  if (inFlight.has(guildId)) return inFlight.get(guildId);

  const promise = (async () => {
    const guild = await client.guilds.fetch(ALLOWED_GUILD_ID);
    const members = await guild.members.fetch();
    const formatted = Array.from(members.values())
      .map((member) => ({
        id: member.id,
        tag: member.user.tag,
        nickname: member.nickname || member.user.displayName || member.user.username,
        username: member.user.username,
        displayName: member.user.displayName || member.user.username,
        isBot: member.user.bot,
      }))
      .filter((member) => member.isBot === includeBots)
      .sort((left, right) => left.username.localeCompare(right.username));
    cache.set(guildId, { timestamp: Date.now(), members: formatted });
    return formatted;
  })();

  inFlight.set(guildId, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(guildId);
  }
}

function requireAllowedGuild(guildId) {
  if (guildId !== ALLOWED_GUILD_ID) throw new Error('Cette action est limitée au serveur autorisé.');
  const guild = client.guilds.cache.get(ALLOWED_GUILD_ID);
  if (!guild) throw new Error('Le bot ne voit pas le serveur autorisé.');
  return guild;
}

async function fetchTextChannel(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.guildId !== ALLOWED_GUILD_ID || !channel.isTextBased()) {
    throw new Error('Salon textuel invalide ou non autorisé.');
  }
  return channel;
}

function getVoiceStatus(payload) {
  sendEvent('voice-status', payload);
}

function getMusicStatus(payload) {
  sendEvent('music-status', payload);
}

function broadcastBotStatus(payload) {
  sendEvent('bot-status', payload);
}

async function leaveGuild(guild) {
  if (guild.id === ALLOWED_GUILD_ID || guildsBeingRemoved.has(guild.id)) return false;
  guildsBeingRemoved.add(guild.id);
  try {
    await guild.leave();
    recordActivity('success', `Le bot a quitté le serveur « ${guild.name} ».`, { guildId: guild.id });
    return true;
  } catch (error) {
    recordActivity('error', `Impossible de quitter « ${guild.name} » : ${error.message}`, { guildId: guild.id });
    return false;
  } finally {
    guildsBeingRemoved.delete(guild.id);
  }
}

async function leaveOtherGuildsOnStartup() {
  if (!client.guilds.cache.has(ALLOWED_GUILD_ID)) {
    recordActivity(
      'error',
      `Serveur autorisé ${ALLOWED_GUILD_ID} introuvable. Aucun serveur ne sera quitté.`,
      { guildId: ALLOWED_GUILD_ID }
    );
    return;
  }

  for (const guild of client.guilds.cache.values()) {
    if (guild.id !== ALLOWED_GUILD_ID) await leaveGuild(guild);
  }
}

client.once('ready', async () => {
  botLoginError = null;
  recordActivity('success', `Bot connecté en tant que ${client.user.tag}.`);
  await leaveOtherGuildsOnStartup();
  broadcastBotStatus({ connected: true, tag: client.user.tag });
});

client.on('error', (error) => {
  recordActivity('error', `Erreur du bot : ${error.message}`);
  broadcastBotStatus({ connected: false, error: error.message });
});

client.on('guildCreate', (guild) => {
  if (guild.id === ALLOWED_GUILD_ID) return;
  recordActivity('warning', `Le bot a rejoint « ${guild.name} » et va le quitter.`, { guildId: guild.id });
  void leaveGuild(guild);
});

client.on('messageCreate', (message) => {
  if (message.guildId !== ALLOWED_GUILD_ID) return;
  const common = {
    id: message.id,
    authorId: message.author.id,
    author: message.author.username,
    tag: message.author.tag,
    avatar: message.author.displayAvatarURL({ size: 64 }),
    content: message.content,
    channel: message.channel?.name || 'Salon',
    channelId: message.channelId,
    timestamp: message.createdTimestamp,
  };
  if (message.author.bot) {
    sendEvent('bot-message', common);
  } else if (message.channelId === config.channelId) {
    sendEvent('new-message', {
      messageId: message.id,
      authorId: message.author.id,
      author: message.author.username,
      avatar: message.author.displayAvatarURL({ size: 64 }),
      content: message.content,
      timestamp: message.createdTimestamp,
    });
  }
});

client.on('guildMemberAdd', async (member) => {
  if (
    member.guild.id !== ALLOWED_GUILD_ID
    || !config.welcomeEnabled
    || config.guildId !== ALLOWED_GUILD_ID
    || !config.welcomeChannelId
  ) return;
  try {
    const channel = await fetchTextChannel(config.welcomeChannelId);
    const content = config.welcomeMessage
      .replaceAll('{user}', `<@${member.id}>`)
      .replaceAll('{username}', member.user.username)
      .replaceAll('{server}', member.guild.name)
      .replaceAll('{count}', String(member.guild.memberCount));
    await channel.send({ content, allowedMentions: { users: [member.id] } });
  } catch (error) {
    recordActivity('error', `Message de bienvenue impossible : ${error.message}`, {
      guildId: ALLOWED_GUILD_ID,
      userId: member.id,
    });
  }
});

function subscribeAudioPlayer(connection) {
  if (!audioPlayer || !connection) return;
  const subscription = connection.state.subscription;
  if (!subscription || subscription.player !== audioPlayer) connection.subscribe(audioPlayer);
}

async function ensureVoiceConnection(guildId, channelId) {
  const guild = requireAllowedGuild(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) throw new Error('Salon vocal invalide.');
  let connection = getVoiceConnection(guild.id);
  if (!connection || connection.joinConfig.channelId !== channel.id) {
    connection?.destroy();
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: false,
      selfDeaf: true,
    });
  }
  activeVoiceConnection = connection;
  subscribeAudioPlayer(connection);
  getVoiceStatus({ connected: true, guildId: guild.id, channelId: channel.id, channelName: channel.name });
  return connection;
}

async function getStats(guildId) {
  requireAllowedGuild(guildId);
  const cached = statsCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < 60000) return cached.stats;
  if (statsFetchInFlight.has(guildId)) return statsFetchInFlight.get(guildId);

  const promise = (async () => {
    const guild = await client.guilds.fetch(guildId);
    await guild.members.fetch();
    const stats = {
      guildName: guild.name,
      icon: guild.iconURL({ size: 64 }),
      totalMembers: guild.memberCount,
      onlineMembers: guild.members.cache.filter(
        (member) => member.presence?.status && member.presence.status !== 'offline'
      ).size,
      channelCount: guild.channels.cache.size,
      boostCount: guild.premiumSubscriptionCount || 0,
    };
    statsCache.set(guildId, { timestamp: Date.now(), stats });
    return stats;
  })();
  statsFetchInFlight.set(guildId, promise);
  try {
    return await promise;
  } finally {
    statsFetchInFlight.delete(guildId);
  }
}

async function executeCommand(name, args) {
  switch (name) {
    case 'getConfig':
      return configForUser();
    case 'saveConfig': {
      const input = args[0] || {};
      if (input.guildId !== ALLOWED_GUILD_ID) throw new Error('Serveur non autorisé.');
      const channel = await fetchTextChannel(String(input.channelId || ''));
      const welcomeEnabled = input.welcomeEnabled === true;
      const welcomeChannelId = String(input.welcomeChannelId || '');
      const welcomeMessage = String(input.welcomeMessage || '').trim();
      if (welcomeEnabled) {
        if (!welcomeChannelId || !welcomeMessage || welcomeMessage.length > 2000) {
          throw new Error('Choisis un salon et un message valide pour activer l’accueil.');
        }
        await fetchTextChannel(welcomeChannelId);
      }
      config = {
        ...config,
        guildId: ALLOWED_GUILD_ID,
        channelId: channel.id,
        welcomeEnabled,
        welcomeChannelId: welcomeEnabled ? welcomeChannelId : '',
        welcomeMessage: welcomeMessage || DEFAULT_CONFIG.welcomeMessage,
      };
      saveJson(CONFIG_PATH, config);
      return configForUser();
    }
    case 'getGuilds': {
      if (BOT_SYNC_ONLY) {
        return remoteBotSnapshot.connected && Date.now() - remoteBotSnapshot.lastSeen < 120000
          ? remoteBotSnapshot.guilds
          : [];
      }
      const guild = client.guilds.cache.get(ALLOWED_GUILD_ID);
      return guild ? [{ id: guild.id, name: guild.name }] : [];
    }
    case 'getChannels': {
      const guild = requireAllowedGuild(args[0]);
      const channels = await guild.channels.fetch();
      return channels
        .filter((channel) => channel?.isTextBased() && !channel.isThread())
        .map((channel) => ({ id: channel.id, name: channel.name }));
    }
    case 'getVoiceChannels': {
      const guild = requireAllowedGuild(args[0]);
      const channels = await guild.channels.fetch();
      return channels
        .filter((channel) => channel?.isVoiceBased() && !channel.isThread())
        .map((channel) => ({ id: channel.id, name: channel.name }));
    }
    case 'getMembers':
      return fetchGuildMembers(args[0], false);
    case 'getBots':
      return fetchGuildMembers(args[0], true);
    case 'getStats':
      return getStats(args[0]);
    case 'getServerOverview':
      if (BOT_SYNC_ONLY) {
        const connected = remoteBotSnapshot.connected
          && Date.now() - remoteBotSnapshot.lastSeen < 120000;
        return {
          connected,
          canManage: false,
          allowedGuildId: ALLOWED_GUILD_ID,
          allowedGuildName: remoteBotSnapshot.guilds.find((guild) => guild.id === ALLOWED_GUILD_ID)?.name || null,
          guilds: connected
            ? remoteBotSnapshot.guilds
              .map((guild) => ({
                ...guild,
                allowed: guild.id === ALLOWED_GUILD_ID,
              }))
              .sort((left, right) => Number(right.allowed) - Number(left.allowed) || left.name.localeCompare(right.name))
            : [],
        };
      }
      return {
        connected: client.isReady(),
        canManage: client.isReady(),
        allowedGuildId: ALLOWED_GUILD_ID,
        allowedGuildName: client.guilds.cache.get(ALLOWED_GUILD_ID)?.name || null,
        guilds: client.guilds.cache
          .map((guild) => ({
            id: guild.id,
            name: guild.name,
            memberCount: guild.memberCount,
            allowed: guild.id === ALLOWED_GUILD_ID,
          }))
          .sort((left, right) => Number(right.allowed) - Number(left.allowed) || left.name.localeCompare(right.name)),
      };
    case 'leaveOtherServers': {
      if (BOT_SYNC_ONLY) throw new Error('Le site est en lecture seule pour les serveurs du bot.');
      if (!client.isReady()) throw new Error('Le bot doit être connecté pour gérer ses serveurs.');
      if (!client.guilds.cache.has(ALLOWED_GUILD_ID)) {
        recordActivity('error', `Serveur autorisé ${ALLOWED_GUILD_ID} introuvable. Aucun serveur quitté.`);
        throw new Error('Le serveur à conserver est introuvable. Aucun serveur n’a été quitté.');
      }
      const otherGuilds = Array.from(client.guilds.cache.values())
        .filter((guild) => guild.id !== ALLOWED_GUILD_ID);
      recordActivity('info', `Nettoyage demandé : ${otherGuilds.length} autre(s) serveur(s).`);
      let leftCount = 0;
      for (const guild of otherGuilds) {
        if (await leaveGuild(guild)) leftCount += 1;
      }
      const failedCount = otherGuilds.length - leftCount;
      recordActivity(
        failedCount ? 'warning' : 'success',
        `Nettoyage terminé : ${leftCount} serveur(s) quitté(s), ${failedCount} échec(s).`,
        { leftCount, failedCount }
      );
      return {
        leftCount,
        failedCount,
        guilds: Array.from(client.guilds.cache.values())
          .filter((guild) => guild.id !== ALLOWED_GUILD_ID)
          .map((guild) => ({ id: guild.id, name: guild.name })),
      };
    }
    case 'getActivityLogs':
      return activityLogs;
    case 'sendMessage': {
      const input = args[0] || {};
      const channel = await fetchTextChannel(input.channelId);
      const content = String(input.content || '').trim();
      if (!content || content.length > 2000) throw new Error('Le message doit contenir entre 1 et 2 000 caractères.');
      const payload = input.replyToMessageId
        ? { content, reply: { messageReference: input.replyToMessageId } }
        : content;
      await channel.send(payload);
      recordActivity('info', `Message envoyé dans #${channel.name}.`, { guildId: ALLOWED_GUILD_ID });
      return true;
    }
    case 'searchGifs': {
      const query = String(args[0] || '').trim();
      if (!query || query.length > 100) throw new Error('Entre un mot ou une expression (100 caractères maximum).');
      if (!GIPHY_API_KEY) throw new Error('Configure GIPHY_API_KEY dans les variables d’environnement du site.');
      const url = new URL('https://api.giphy.com/v1/gifs/search');
      url.search = new URLSearchParams({
        q: query,
        api_key: GIPHY_API_KEY,
        limit: '8',
        rating: 'pg',
        lang: 'fr',
      });
      const response = await fetchDiscordJson(url);
      return (Array.isArray(response.data) ? response.data : [])
        .map((item) => {
          const images = item.images || {};
          const gifUrl = images.original?.url;
          const previewUrl = images.fixed_width_small?.url || images.downsized_medium?.url || gifUrl;
          if (!gifUrl || !previewUrl) return null;
          const isGiphy = (value) => {
            const hostname = new URL(value).hostname;
            return hostname === 'giphy.com' || hostname.endsWith('.giphy.com');
          };
          try {
            if (!isGiphy(gifUrl) || !isGiphy(previewUrl)) return null;
          } catch {
            return null;
          }
          return { id: item.id, title: item.title || 'GIF', url: gifUrl, previewUrl };
        })
        .filter(Boolean);
    }
    case 'sendGif': {
      const input = args[0] || {};
      const gifUrl = new URL(input.url);
      if (
        gifUrl.protocol !== 'https:'
        || (gifUrl.hostname !== 'giphy.com' && !gifUrl.hostname.endsWith('.giphy.com'))
      ) throw new Error('Seuls les GIFs GIPHY peuvent être envoyés.');
      const channel = await fetchTextChannel(input.channelId);
      const embed = new EmbedBuilder().setImage(gifUrl.toString()).setColor(0x5865f2).setFooter({ text: 'Powered by GIPHY' });
      await channel.send({ embeds: [embed] });
      recordActivity('info', `GIF envoyé dans #${channel.name}.`, { guildId: ALLOWED_GUILD_ID });
      return true;
    }
    case 'sendAnnouncement': {
      const input = args[0] || {};
      const channel = await fetchTextChannel(input.channelId);
      const title = String(input.title || '').trim();
      const description = String(input.description || '').trim();
      if (!title || !description) throw new Error('Le titre et le contenu de l’annonce sont obligatoires.');
      await channel.send({
        embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(0x5865f2).setTimestamp()],
      });
      recordActivity('info', `Annonce publiée dans #${channel.name}.`, { guildId: ALLOWED_GUILD_ID });
      return true;
    }
    case 'kickMember': {
      const input = args[0] || {};
      const guild = requireAllowedGuild(input.guildId);
      const member = await guild.members.fetch(input.userId);
      await member.kick(input.reason || 'Aucune raison fournie');
      recordActivity('warning', `${member.user.tag} expulsé de ${guild.name}.`, { guildId: guild.id, userId: member.id });
      return true;
    }
    case 'banMember': {
      const input = args[0] || {};
      const guild = requireAllowedGuild(input.guildId);
      const member = await guild.members.fetch(input.userId);
      await member.ban({ reason: input.reason || 'Aucune raison fournie' });
      recordActivity('warning', `${member.user.tag} banni de ${guild.name}.`, { guildId: guild.id, userId: member.id });
      return true;
    }
    case 'timeoutMember': {
      const input = args[0] || {};
      const guild = requireAllowedGuild(input.guildId);
      const member = await guild.members.fetch(input.userId);
      const durationMinutes = Number(input.durationMinutes || 10);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 40320) {
        throw new Error('La durée du mute doit être comprise entre 1 minute et 28 jours.');
      }
      const timeoutUntil = new Date(Date.now() + durationMinutes * 60 * 1000);
      await member.timeout(timeoutUntil, input.reason || 'Aucune raison fournie');
      recordActivity('warning', `${member.user.tag} mute ${durationMinutes} min sur ${guild.name}.`, {
        guildId: guild.id,
        userId: member.id,
      });
      return { durationMinutes, timeoutUntil: timeoutUntil.toISOString() };
    }
    case 'warnMember': {
      const input = args[0] || {};
      const guild = requireAllowedGuild(input.guildId);
      const member = await guild.members.fetch(input.userId);
      const warning = {
        id: Date.now(),
        guildId: guild.id,
        userId: member.id,
        username: member.user.tag,
        reason: input.reason || 'Aucune raison fournie',
        createdAt: new Date().toISOString(),
      };
      warnings = [...warnings, warning];
      saveJson(WARNINGS_PATH, warnings);
      const message = `⚠️ Avertissement de modération\nRaison : ${warning.reason}\nServeur : ${guild.name}.`;
      await member.send(message).catch((error) => {
        recordActivity('warning', `Avertissement enregistré, mais le MP à ${member.user.tag} n’a pas pu être envoyé.`, {
          guildId: guild.id,
          error: error.message,
        });
      });
      recordActivity('warning', `Avertissement donné à ${member.user.tag} sur ${guild.name}.`, {
        guildId: guild.id,
        userId: member.id,
      });
      return warning;
    }
    case 'setBotStatus': {
      if (!client.user) throw new Error('Bot non connecté.');
      const text = String(args[0] || '').trim() || 'Panel Bot';
      await client.user.setPresence({
        activities: [{ name: text, type: ActivityType.Custom }],
        status: 'online',
      });
      return true;
    }
    case 'joinVoice': {
      const input = args[0] || {};
      const guild = requireAllowedGuild(input.guildId);
      const channel = await guild.channels.fetch(input.channelId);
      if (!channel?.isVoiceBased()) throw new Error('Salon vocal invalide.');
      getVoiceConnection(guild.id)?.destroy();
      activeVoiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfMute: false,
        selfDeaf: true,
      });
      subscribeAudioPlayer(activeVoiceConnection);
      const result = { connected: true, guildId: guild.id, channelId: channel.id, channelName: channel.name };
      getVoiceStatus(result);
      return result;
    }
    case 'leaveVoice': {
      const guild = requireAllowedGuild(args[0]);
      getVoiceConnection(guild.id)?.destroy();
      activeVoiceConnection = null;
      getVoiceStatus({ connected: false, guildId: guild.id });
      return { connected: false, guildId: guild.id };
    }
    case 'disconnectVoice': {
      const guild = requireAllowedGuild(args[0]);
      getVoiceConnection(guild.id)?.destroy();
      activeVoiceConnection = null;
      getVoiceStatus({ connected: false, guildId: guild.id });
      return { connected: false, guildId: guild.id };
    }
    case 'playMusic': {
      const input = args[0] || {};
      const guild = requireAllowedGuild(input.guildId);
      if (!input.query?.trim()) throw new Error('La musique ou la recherche est invalide.');
      let sourceUrl = input.query.trim();
      let title = 'Musique';
      if (!/^https?:\/\//i.test(sourceUrl)) {
        const results = await play.search(sourceUrl, { limit: 1 });
        if (!results?.length) throw new Error('Aucune musique trouvée pour cette recherche.');
        sourceUrl = results[0].url;
        title = results[0].title || title;
      } else {
        const info = await play.video_basic_info(sourceUrl);
        title = info?.video_details?.title || title;
      }
      const connection = await ensureVoiceConnection(guild.id, input.channelId);
      if (!audioPlayer) {
        audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
        audioPlayer.on('error', (error) => {
          recordActivity('error', `Erreur audio : ${error.message}`);
          currentMusic = { title: '', playing: false };
          getMusicStatus(currentMusic);
        });
      }
      subscribeAudioPlayer(connection);
      const stream = await play.stream(sourceUrl, { quality: 1, discordPlayerCompatibility: true });
      const resource = createAudioResource(stream.stream, {
        inputType: stream.type === 'opus' ? StreamType.Opus : StreamType.Arbitrary,
        inlineVolume: true,
      });
      if (audioPlayer.state.status === AudioPlayerStatus.Playing) audioPlayer.stop();
      audioPlayer.play(resource);
      currentMusic = { title, playing: true };
      getMusicStatus(currentMusic);
      return currentMusic;
    }
    case 'pauseMusic':
      if (audioPlayer?.state.status === AudioPlayerStatus.Playing) audioPlayer.pause();
      currentMusic = { ...currentMusic, playing: false };
      getMusicStatus(currentMusic);
      return currentMusic;
    case 'resumeMusic':
      if (audioPlayer?.state.status === AudioPlayerStatus.Paused) audioPlayer.unpause();
      currentMusic = { ...currentMusic, playing: audioPlayer?.state.status === AudioPlayerStatus.Playing };
      getMusicStatus(currentMusic);
      return currentMusic;
    case 'stopMusic':
      audioPlayer?.stop();
      currentMusic = { title: '', playing: false };
      getMusicStatus(currentMusic);
      return currentMusic;
    default:
      throw new Error('Commande inconnue.');
  }
}

const allowedCommands = new Set([
  'getConfig', 'saveConfig', 'getGuilds', 'getChannels', 'getVoiceChannels',
  'getMembers', 'getBots', 'getStats', 'getServerOverview', 'leaveOtherServers',
  'getActivityLogs', 'sendMessage', 'searchGifs', 'sendGif', 'sendAnnouncement',
  'kickMember', 'banMember', 'timeoutMember', 'warnMember', 'setBotStatus',
  'joinVoice', 'leaveVoice', 'disconnectVoice', 'playMusic', 'pauseMusic',
  'resumeMusic', 'stopMusic',
]);

app.post('/api/command', async (req, res) => {
  const { name, args } = req.body || {};
  if (typeof name !== 'string' || !allowedCommands.has(name) || !Array.isArray(args)) {
    return res.status(400).json({ error: 'Commande invalide.' });
  }
  try {
    const result = await executeCommand(name, args);
    return res.json({ result });
  } catch (error) {
    recordActivity('error', `Erreur pendant « ${name} » : ${error.message}`);
    return res.status(400).json({ error: error.message });
  }
});

app.use((error, req, res, next) => {
  console.error('Web request failed:', error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Erreur interne du site. Consulte les logs du serveur.' });
});

const server = app.listen(PORT, () => {
  console.log(`Panel Bot web server listening on port ${PORT}`);
  if (!BOT_SYNC_ONLY) {
    client.login(DISCORD_TOKEN).catch((error) => {
      botLoginError = error.message;
      recordActivity('error', `Connexion du bot impossible : ${error.message}`);
      broadcastBotStatus({ connected: false, error: error.message });
    });
  }
});

function shutdown() {
  server.close();
  for (const response of events) response.end();
  events.clear();
  client.destroy();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
