require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
  PermissionFlagsBits,
} = require('discord.js');
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
const ALLOWED_GUILD_NAME = 'ZEFYXX COMMUNAUTÉ !';
const ALLOWED_ROLE_IDS = new Set([
  '1549853790742646856',
  '1549293460345851922',
  '1552764819222954006',
  '1524502220023005234',
]);
const ROLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ACTIVITY_LOGS = 200;
const MAX_PANEL_USAGE_LOGS = 500;
const DATA_PATH = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_PATH, 'config.json');
const WARNINGS_PATH = path.join(DATA_PATH, 'warnings.json');
const ACTIVITY_LOG_PATH = path.join(DATA_PATH, 'activity-logs.json');
const PANEL_USAGE_LOG_PATH = path.join(DATA_PATH, 'panel-usage-logs.json');

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
app.use(express.json({ limit: '2mb' }));
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
let panelUsageLogs = loadJson(PANEL_USAGE_LOG_PATH, []).slice(0, MAX_PANEL_USAGE_LOGS);
let activeVoiceConnection = null;
let audioPlayer = null;
let currentMusic = { title: '', playing: false };
let botLoginError = null;
let remoteBotSnapshot = {
  connected: false,
  guilds: [],
  config: null,
  logs: [],
  tag: null,
  voiceStatus: { connected: false },
  musicStatus: { title: '', playing: false },
  lastSeen: 0,
};
const pendingBotCommands = [];
const waitingBotCommands = new Map();
let botPollWaiter = null;

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

function recordPanelUsage(user, action, status = 'success') {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    userId: String(user.id),
    username: String(user.username || 'Utilisateur Discord').slice(0, 100),
    action,
    status,
  };
  panelUsageLogs = [entry, ...panelUsageLogs].slice(0, MAX_PANEL_USAGE_LOGS);
  try {
    saveJson(PANEL_USAGE_LOG_PATH, panelUsageLogs);
  } catch (error) {
    console.error('Impossible d’enregistrer les logs d’utilisation du panel :', error);
  }
  sendEvent('panel-usage-log', entry);
}

function configForUser() {
  return {
    ...(remoteBotSnapshot.config || config),
    guildId: ALLOWED_GUILD_ID,
    readOnly: false,
  };
}

async function fetchDiscordJson(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if (method !== 'GET' || attempt > 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;

    const error = new Error(
      payload.error_description
      || payload.message
      || `Le service externe a répondu ${response.status}.`
    );
    error.status = response.status;
    if (method !== 'GET' || attempt > 0 || (response.status !== 429 && response.status < 500)) {
      throw error;
    }

    const retryAfter = Number(response.headers.get('retry-after') || payload.retry_after);
    const delay = Number.isFinite(retryAfter)
      ? Math.min(1500, Math.max(300, retryAfter * 1000))
      : 500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error('La requête Discord a échoué après une nouvelle tentative.');
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
  if (Date.now() - checkedAt < ROLE_CHECK_INTERVAL_MS && req.session.discord.hasRequiredRole) {
    return next();
  }

  try {
    const member = await fetchDiscordJson(
      `https://discord.com/api/users/@me/guilds/${ALLOWED_GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${req.session.discord.accessToken}` } }
    );
    const hasRequiredRole = Array.isArray(member.roles)
      && member.roles.some((roleId) => ALLOWED_ROLE_IDS.has(roleId));
    if (!hasRequiredRole) {
      req.session.destroy(() => {});
      if (!req.originalUrl.startsWith('/api/')) return res.redirect('/login?denied=role');
      return res.status(403).json({ error: 'Un des quatre rôles Discord autorisés est nécessaire.' });
    }

    req.session.discord.hasRequiredRole = true;
    req.session.discord.roleCheckedAt = Date.now();
    if (!req.session.discord.usageLogged) {
      recordPanelUsage(req.session.discord, 'Connexion au panel', 'success');
      req.session.discord.usageLogged = true;
    }
    return next();
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      req.session.destroy(() => {});
      if (!req.originalUrl.startsWith('/api/')) return res.redirect('/login?denied=guild');
      return res.status(403).json({ error: 'Impossible de vérifier ton rôle sur le serveur Discord autorisé.' });
    }
    console.error('Discord role check failed:', error.message);
    if (!req.originalUrl.startsWith('/api/')) return res.redirect('/login?denied=discord-check');
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
    ...remoteBotSnapshot,
    connected,
    guilds: normalizedGuilds,
    lastSeen: Date.now(),
  };
  return res.sendStatus(204);
});

function authenticateHostedBot(req, res) {
  const suppliedSecret = req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const expected = Buffer.from(BOT_SYNC_SECRET || '');
  const supplied = Buffer.from(suppliedSecret);
  if (!BOT_SYNC_SECRET || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    res.sendStatus(401);
    return false;
  }
  return true;
}

function updateHostedBotSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.connected !== 'boolean' || !Array.isArray(snapshot.guilds)
      || snapshot.guilds.length > 500) {
    throw new Error('Invalid bot snapshot.');
  }
  const guilds = snapshot.guilds.map((guild) => {
    if (!guild || typeof guild.id !== 'string' || !/^\d{17,20}$/.test(guild.id)
        || typeof guild.name !== 'string' || guild.name.length > 100) {
      throw new Error('Invalid guild entry.');
    }
    return {
      id: guild.id,
      name: guild.name,
      memberCount: Number.isInteger(guild.memberCount) && guild.memberCount >= 0 ? guild.memberCount : 0,
    };
  });
  const incomingLogs = Array.isArray(snapshot.logs)
    ? snapshot.logs.filter((entry) => entry && typeof entry.message === 'string').slice(0, MAX_ACTIVITY_LOGS)
    : remoteBotSnapshot.logs;
  const now = Date.now();
  remoteBotSnapshot = {
    ...remoteBotSnapshot,
    connected: snapshot.connected,
    guilds,
    config: snapshot.config && typeof snapshot.config === 'object' ? snapshot.config : remoteBotSnapshot.config,
    logs: incomingLogs,
    tag: typeof snapshot.tag === 'string' ? snapshot.tag : remoteBotSnapshot.tag,
    voiceStatus: snapshot.voiceStatus && typeof snapshot.voiceStatus === 'object'
      ? snapshot.voiceStatus
      : remoteBotSnapshot.voiceStatus,
    musicStatus: snapshot.musicStatus && typeof snapshot.musicStatus === 'object'
      ? snapshot.musicStatus
      : remoteBotSnapshot.musicStatus,
    lastSeen: now,
  };
  if (Array.isArray(snapshot.events)) {
    for (const entry of snapshot.events.slice(0, 100)) {
      if (!entry || typeof entry.name !== 'string' || !entry.data || typeof entry.data !== 'object') continue;
      if (['new-message', 'bot-message', 'activity-log', 'voice-status', 'music-status'].includes(entry.name)) {
        sendEvent(entry.name, entry.data);
      }
    }
  }
  broadcastBotStatus({
    connected: snapshot.connected,
    tag: typeof snapshot.tag === 'string' ? snapshot.tag : undefined,
  });
  if (snapshot.voiceStatus) getVoiceStatus(snapshot.voiceStatus);
  if (snapshot.musicStatus) getMusicStatus(snapshot.musicStatus);
}

function deliverNextBotCommand() {
  if (!botPollWaiter || !pendingBotCommands.length) return;
  const command = pendingBotCommands.shift();
  const respond = botPollWaiter;
  botPollWaiter = null;
  respond(command);
}

app.post('/api/bot-poll', (req, res) => {
  if (!authenticateHostedBot(req, res)) return;
  try {
    updateHostedBotSnapshot(req.body?.snapshot);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (pendingBotCommands.length) {
    return res.json({ command: pendingBotCommands.shift() });
  }
  if (botPollWaiter) return res.status(409).json({ error: 'A bot poll is already waiting.' });

  let finished = false;
  const finish = (payload) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    botPollWaiter = null;
    if (!res.destroyed && !res.writableEnded) res.json({ command: payload });
  };
  const timeout = setTimeout(() => finish(null), 20000);
  botPollWaiter = finish;
  res.on('close', () => {
    if (!res.writableEnded) finish(null);
  });
});

app.post('/api/bot-result', (req, res) => {
  if (!authenticateHostedBot(req, res)) return;
  const { requestId, result, error } = req.body || {};
  if (typeof requestId !== 'string' || requestId.length > 100) {
    return res.status(400).json({ error: 'Invalid command result.' });
  }
  const pending = waitingBotCommands.get(requestId);
  if (!pending) return res.sendStatus(404);
  waitingBotCommands.delete(requestId);
  clearTimeout(pending.timeout);
  if (error && typeof error === 'string') pending.reject(new Error(error.slice(0, 1000)));
  else pending.resolve(result);
  return res.sendStatus(204);
});

app.get('/login', (req, res) => {
  if (req.session.discord?.accessToken && req.query.denied !== 'discord-check') return res.redirect('/');
  const denied = req.query.denied === 'role'
    ? 'Ton compte n’a pas le rôle Discord requis.'
    : req.query.denied === 'guild'
      ? 'Impossible de vérifier ton appartenance au serveur autorisé.'
      : req.query.denied === 'discord-check'
        ? 'Discord ne répond pas pour le moment. Ta session est conservée : réessaie la vérification dans quelques instants.'
        : req.query.denied === 'oauth-cancelled'
          ? 'Tu as annulé la connexion Discord. Tu peux réessayer.'
          : req.query.denied === 'oauth-failed'
            ? 'Discord a accepté la connexion, mais le retour vers le panel a échoué. Vérifie la configuration OAuth du panel.'
            : '';
  res.type('html').send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#121319"><link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="/icons/panel-192.png?v=3"><link rel="apple-touch-icon" href="/icons/panel-192.png?v=3"><link rel="stylesheet" href="/style.css?v=slash-command-options-2">
<script src="/pwa.js?v=slash-commands-2" defer></script>
<title>Connexion Discord — Panel Bot</title><style>
*{box-sizing:border-box}
html{min-height:100%;background:#101117}
body{height:auto;min-height:100vh;min-height:100svh;overflow:auto;margin:0;display:grid;place-items:center;padding:32px 20px;color:#f2f3fa;font:16px Inter,system-ui,sans-serif;background:radial-gradient(ellipse at 18% 18%,rgba(108,108,245,.2),transparent 38%),radial-gradient(ellipse at 85% 82%,rgba(76,113,255,.1),transparent 35%),#101117}
.login-layout{width:min(1040px,100%);display:grid;grid-template-columns:minmax(0,1.1fr) minmax(340px,.9fr);align-items:center;gap:clamp(40px,8vw,100px)}
.intro{padding:20px 0}
.brand{display:flex;align-items:center;gap:12px;font-family:'Space Grotesk',Inter,system-ui,sans-serif;font-size:20px;font-weight:700;letter-spacing:-.03em}
.brand-mark{display:grid;width:42px;height:42px;place-items:center;border:1px solid rgba(143,145,255,.35);border-radius:14px;background:rgba(108,108,245,.16);color:#aaaaff;font-size:24px}
.brand-mark img{width:42px;height:42px;object-fit:contain}
.brand-mark .logo-eye{fill:#20222c}
.brand-mark .logo-antenna{fill:#f3f3ff}
.eyebrow{margin:40px 0 14px;color:#b2b3ff;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}
h1{max-width:600px;margin:0;font-family:'Space Grotesk',Inter,system-ui,sans-serif;font-size:clamp(38px,5vw,58px);line-height:1.04;letter-spacing:-.055em}
.lead{max-width:510px;margin:20px 0 0;color:#b4b6c5;font-size:17px;line-height:1.7}
.features{display:grid;gap:14px;margin:34px 0 0;padding:0;list-style:none}
.features li{display:flex;align-items:center;gap:12px;color:#d8d9e5}
.feature-icon{display:grid;width:34px;height:34px;flex:0 0 auto;place-items:center;border:1px solid #303343;border-radius:11px;background:#1b1d27;color:#a4a4ff;font-weight:700}
.login-card{padding:clamp(25px,4vw,38px);border:1px solid rgba(142,145,171,.2);border-radius:22px;background:linear-gradient(155deg,rgba(31,33,45,.97),rgba(23,24,33,.97));box-shadow:0 28px 100px rgba(0,0,0,.38)}
.card-kicker{margin:0 0 8px;color:#9d9eff;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
h2{margin:0;font-family:'Space Grotesk',Inter,system-ui,sans-serif;font-size:26px;letter-spacing:-.03em}
.card-copy{margin:12px 0 22px;color:#aeb0bf;font-size:14px;line-height:1.65}
.error{margin:0 0 18px;padding:12px 14px;border:1px solid rgba(242,84,91,.32);border-radius:12px;background:rgba(242,84,91,.1);color:#ffb1b5;font-size:14px;line-height:1.5}
.discord-button,.install-app-btn,.retry-button{display:flex;width:100%;min-height:50px;align-items:center;justify-content:center;gap:10px;border-radius:12px;font:600 15px Inter,system-ui,sans-serif;text-decoration:none;transition:transform .16s ease,background .16s ease,border-color .16s ease}
.discord-button{border:1px solid #6974ff;background:#5865f2;color:#fff;box-shadow:0 8px 24px rgba(88,101,242,.22)}
.discord-button:hover{transform:translateY(-1px);background:#6875ff}
.retry-button{margin:0 0 10px;border:1px solid #363949;background:#22242f;color:#e2e3ee}
.retry-button:hover{border-color:#6e70c9;background:#292b38}
.discord-icon{width:21px;height:21px;fill:currentColor}
.install-app-btn{display:flex;margin:10px 0 0;border:1px solid #363949;background:#22242f;color:#e2e3ee}
.install-app-btn:hover{border-color:#6e70c9;background:#292b38}
.install-app-status{margin:10px 0 0;color:#bfc0d0;font-size:13px;line-height:1.5;text-align:center}
.role-note{display:flex;gap:11px;margin:22px 0 0;padding:14px;border:1px solid #303343;border-radius:13px;background:rgba(13,14,20,.28)}
.role-note-icon{color:#a5a6ff}
.role-note strong{display:block;margin-bottom:3px;color:#e5e6f1;font-size:13px}
.role-note span{display:block;color:#9fa1b2;font-size:12px;line-height:1.5}
.server-badge{display:flex;align-items:center;gap:12px;margin:21px 0;padding:13px;border:1px solid rgba(108,108,245,.2);border-radius:13px;background:linear-gradient(120deg,rgba(108,108,245,.12),rgba(108,108,245,.035))}
.server-badge-icon{display:grid;width:38px;height:38px;flex:0 0 auto;place-items:center;border:1px solid rgba(108,108,245,.26);border-radius:11px;background:rgba(108,108,245,.16);color:#b1b2ff}
.server-badge-icon svg{width:21px;height:21px;fill:currentColor}
.server-badge-icon circle{fill:#20222c}
.server-badge-copy{min-width:0}
.server-badge-copy small{display:block;margin:0 0 4px;color:#9b9dac;font-size:10px;letter-spacing:.1em;text-transform:uppercase}
.server-badge-copy strong{display:block;overflow-wrap:anywhere;color:#eff0fa;font-size:13px}
.privacy-note{margin:18px 0 0;color:#828493;font-size:11px;line-height:1.6;text-align:center}
@media(max-width:760px){body{padding:max(24px,env(safe-area-inset-top)) 18px max(24px,env(safe-area-inset-bottom))}.login-layout{max-width:460px;grid-template-columns:1fr;gap:25px}.intro{padding:0}.eyebrow{margin:23px 0 10px}h1{font-size:clamp(34px,10vw,46px)}.lead{margin-top:12px;font-size:15px;line-height:1.55}.features{grid-template-columns:1fr;gap:9px;margin-top:19px}.features li{font-size:13px}.feature-icon{width:30px;height:30px}.login-card{padding:23px;border-radius:19px}.card-copy{margin-bottom:18px}}
@media(max-width:380px){html,body{width:100%;min-width:0}body{padding-right:13px;padding-left:13px}.features{display:none}.login-card{padding:20px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
.login-scroll-cue{display:none}
@media(max-width:760px){
html,body{min-width:0;overscroll-behavior-y:contain}
body{display:block;padding:calc(24px + env(safe-area-inset-top)) 18px calc(28px + env(safe-area-inset-bottom));touch-action:pan-y}
.login-layout{margin:0 auto;gap:18px}
.intro{padding:0}
.eyebrow{margin-top:24px}
.features{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:18px}
.features li{align-items:flex-start;gap:7px;font-size:11px;line-height:1.35}
.feature-icon{width:24px;height:24px;border-radius:8px}
.server-badge{margin:16px 0 0;padding:10px}
.login-scroll-cue{display:flex;min-height:38px;align-items:center;justify-content:center;gap:8px;color:#aaaaff;font-size:12px;text-decoration:none}
.login-scroll-cue span:last-child{font-size:18px;line-height:1}
.login-card{padding:20px}
.role-note{margin-top:16px;padding:11px}
.privacy-note{margin-top:13px}
}
@media(max-width:380px){
.features{display:grid}
.features li{font-size:10px}
}
</style></head><body><div class="login-layout">
<section class="intro" aria-labelledby="welcome-title">
<div class="brand"><span class="brand-mark" aria-hidden="true"><img src="/panel-icon.svg?v=3" alt=""></span><span>Panel Bot</span></div>
<p class="eyebrow">Le contrôle de ton serveur, en un seul endroit</p>
<h1 id="welcome-title">Ton serveur Discord, plus simple à gérer.</h1>
<p class="lead">Un espace clair pour suivre ton bot et retrouver les outils essentiels sur ordinateur comme sur téléphone.</p>
<ul class="features">
<li><span class="feature-icon" aria-hidden="true">✓</span>Chat, membres et activité du serveur</li>
<li><span class="feature-icon" aria-hidden="true">✓</span>Modération et réglages du bot</li>
<li><span class="feature-icon" aria-hidden="true">✓</span>Interface adaptée au mobile</li>
</ul>
<div class="server-badge"><span class="server-badge-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-5.9l-4.8 3.2c-.8.5-1.8 0-1.8-.9V17A2.5 2.5 0 0 1 4 14.5z"/><circle cx="9" cy="10" r="1.2"/><circle cx="15" cy="10" r="1.2"/></svg></span><span class="server-badge-copy"><small>Serveur Discord connecté au panel</small><strong>${ALLOWED_GUILD_NAME}</strong></span></div>
</section>
<a class="login-scroll-cue" href="#login-panel" aria-label="Faire défiler jusqu’à la connexion"><span>Glisse vers le bas pour te connecter</span><span aria-hidden="true">↓</span></a>
<main class="login-card" id="login-panel">
<p class="card-kicker">Espace sécurisé</p><h2>Connecte-toi</h2>
<p class="card-copy">Utilise Discord pour ouvrir ta session. Nous vérifions que tu es membre du serveur et que tu possèdes au moins un des quatre rôles autorisés.</p>
${denied ? `<p class="error" role="alert">${denied}</p>` : ''}
${req.query.denied === 'discord-check' ? '<a class="retry-button" href="/">Réessayer maintenant</a>' : ''}
<a class="discord-button" href="/auth/discord"><svg class="discord-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.73 5.36A19.4 19.4 0 0 0 14.94 3.9l-.23.47a18 18 0 0 0-5.42 0l-.24-.47a19.3 19.3 0 0 0-4.78 1.46C1.24 9.02.42 12.6.83 16.14a19.5 19.5 0 0 0 5.86 2.96l1.27-2.06a12.7 12.7 0 0 1-2-.96l.49-.38a13.9 13.9 0 0 0 11.1 0l.5.38a12.8 12.8 0 0 1-2.02.96l1.27 2.06a19.4 19.4 0 0 0 5.86-2.96c.49-4.1-.83-7.64-3.43-10.78ZM8.54 14.5c-1.08 0-1.96-.99-1.96-2.2s.86-2.2 1.96-2.2 1.98.99 1.96 2.2c0 1.21-.86 2.2-1.96 2.2Zm6.92 0c-1.08 0-1.96-.99-1.96-2.2s.86-2.2 1.96-2.2 1.98.99 1.96 2.2c0 1.21-.86 2.2-1.96 2.2Z"/></svg>Continuer avec Discord</a>
<button class="install-app-btn" id="install-app-btn" type="button">Installer l’application</button>
<p class="install-app-status" id="install-app-status" role="status" aria-live="polite"></p>
<div class="role-note"><span class="role-note-icon" aria-hidden="true">ⓘ</span><div><strong>Accès réservé</strong><span>Ton compte doit être membre du serveur et avoir au moins un des quatre rôles autorisés.</span></div></div>
<p class="privacy-note">La connexion passe par Discord. Ton mot de passe Discord n’est jamais demandé par ce site.</p>
</main></div><script>
let loginTouchStart = null;
document.addEventListener('touchstart', (event) => {
  if (event.touches.length === 1) loginTouchStart = { y: event.touches[0].clientY, scrollY: window.scrollY };
}, { passive: true });
document.addEventListener('touchend', (event) => {
  if (!loginTouchStart || !window.matchMedia('(max-width: 760px)').matches) return;
  const delta = event.changedTouches[0].clientY - loginTouchStart.y;
  if (delta > 55 && loginTouchStart.scrollY < 24) {
    document.getElementById('login-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  loginTouchStart = null;
}, { passive: true });
</script></body></html>`);
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
    });
    return res.redirect(authorization.toString());
  });
});

app.get('/auth/callback', async (req, res, next) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/login?denied=oauth-cancelled');
  if (
    typeof code !== 'string'
    || typeof state !== 'string'
    || !req.session.oauthState
    || !safeEqual(state, req.session.oauthState)
  ) {
    return res.status(400).send('La vérification de connexion a échoué. Retourne à la page de connexion.');
  }
  delete req.session.oauthState;

  let oauthStage = 'échange du code';
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
    oauthStage = 'chargement du profil Discord';
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
    console.error(`Connexion OAuth Discord impossible (${oauthStage}):`, oauthError.message);
    return res.redirect('/login?denied=oauth-failed');
  }
});

app.get('/auth/logout', (req, res) => {
  if (req.session.discord?.usageLogged) {
    recordPanelUsage(req.session.discord, 'Déconnexion du panel', 'success');
  }
  req.session.destroy((error) => {
    if (error) return res.status(500).send('Impossible de fermer la session.');
    res.clearCookie('panel.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return res.redirect('/login');
  });
});

app.get('/', verifyRequiredRole, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/manifest.webmanifest', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'manifest.webmanifest'));
});

app.get('/service-worker.js', (req, res) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Service-Worker-Allowed': '/',
  });
  res.type('application/javascript').sendFile(path.join(__dirname, 'service-worker.js'));
});

app.get('/pwa.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(__dirname, 'pwa.js'));
});

const appIcons = {
  '/icons/panel-192.png': path.join(__dirname, 'app-192.png'),
  '/icons/panel-512.png': path.join(__dirname, 'app-512.png'),
};

app.get(Object.keys(appIcons), (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('image/png').sendFile(appIcons[req.path]);
});

app.get('/panel-icon.svg', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'panel-icon.svg'));
});

app.get('/renderer.js', verifyRequiredRole, (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'renderer.js'));
});

app.get('/web-bridge.js', verifyRequiredRole, (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'web-bridge.js'));
});

app.get('/style.css', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/css').sendFile(path.join(__dirname, 'style.css'));
});

app.get('/api/app-version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION || 'development' });
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

app.get('/api/panel-usage-logs', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ entries: panelUsageLogs });
});

function requestHostedBotCommand(name, args) {
  if (!BOT_SYNC_ONLY) throw new Error('Le relais vers le bot hébergé est désactivé.');
  const connected = remoteBotSnapshot.connected && Date.now() - remoteBotSnapshot.lastSeen < 120000;
  if (!connected) throw new Error('Le bot hébergé est hors ligne ou ne répond pas.');
  if (pendingBotCommands.length >= 100) throw new Error('Trop de commandes sont en attente. Réessaie dans un instant.');

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      waitingBotCommands.delete(requestId);
      reject(new Error('Le bot ne répond pas à temps. Réessaie dans un instant.'));
    }, 120000);
    waitingBotCommands.set(requestId, { resolve, reject, timeout });
    pendingBotCommands.push({ requestId, name, args });
    deliverNextBotCommand();
  });
}

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
    ['bot-status', BOT_SYNC_ONLY
      ? {
        connected: remoteBotSnapshot.connected && Date.now() - remoteBotSnapshot.lastSeen < 120000,
        tag: remoteBotSnapshot.tag,
      }
      : { connected: client.isReady(), tag: client.user?.tag, error: botLoginError }],
    ['voice-status', BOT_SYNC_ONLY
      ? remoteBotSnapshot.voiceStatus || { connected: false }
      : activeVoiceConnection
      ? { connected: true, guildId: activeVoiceConnection.joinConfig.guildId, channelId: activeVoiceConnection.joinConfig.channelId }
      : { connected: false }],
    ['music-status', BOT_SYNC_ONLY ? remoteBotSnapshot.musicStatus || currentMusic : currentMusic],
  ];
  for (const [name, data] of initial) {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  events.add(res);
  const heartbeat = setInterval(() => {
    if (Date.now() - (req.session.discord?.roleCheckedAt || 0) >= ROLE_CHECK_INTERVAL_MS) {
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

async function fetchBotTextChannel(channelId) {
  const channel = await client.channels.fetch(String(channelId || ''));
  if (!channel || !channel.guildId || !channel.isTextBased() || channel.isThread()) {
    throw new Error('Choisis un salon textuel valide.');
  }
  if (!client.guilds.cache.has(channel.guildId)) {
    throw new Error('Le bot ne se trouve pas sur le serveur de ce salon.');
  }
  if (!channel.permissionsFor(client.user)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ])) {
    throw new Error('Le bot ne peut pas voir ou envoyer de messages dans ce salon.');
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

client.once('ready', async () => {
  botLoginError = null;
  recordActivity('success', `Bot connecté en tant que ${client.user.tag}.`);
  broadcastBotStatus({ connected: true, tag: client.user.tag });
});

client.on('error', (error) => {
  recordActivity('error', `Erreur du bot : ${error.message}`);
  broadcastBotStatus({ connected: false, error: error.message });
});

function getMessageMedia(message) {
  const media = [];
  for (const attachment of message.attachments.values()) {
    if (
      attachment.contentType?.toLowerCase().includes('image/gif')
      || attachment.name?.toLowerCase().endsWith('.gif')
      || /\.gif(?:$|[?#])/i.test(attachment.url)
    ) {
      media.push({ type: 'image', url: attachment.url, alt: attachment.name || 'GIF' });
    }
  }

  for (const embed of message.embeds) {
    const sourceUrl = embed.url || '';
    if (embed.video?.url) {
      media.push({ type: 'video', url: embed.video.url, sourceUrl, alt: embed.title || 'GIF' });
    }
    for (const image of [embed.image, embed.thumbnail]) {
      if (image?.url) {
        media.push({ type: 'image', url: image.url, sourceUrl, alt: embed.title || 'GIF' });
      }
    }
  }
  return media;
}

client.on('messageCreate', (message) => {
  if (message.guildId !== ALLOWED_GUILD_ID) return;
  const common = {
    id: message.id,
    authorId: message.author.id,
    author: message.author.username,
    tag: message.author.tag,
    avatar: message.author.displayAvatarURL({ size: 64 }),
    content: message.content,
    media: getMessageMedia(message),
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
      media: getMessageMedia(message),
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
          ? remoteBotSnapshot.guilds.filter((guild) => guild.id === ALLOWED_GUILD_ID)
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
    case 'getMessageGuilds': {
      if (BOT_SYNC_ONLY) {
        const connected = remoteBotSnapshot.connected
          && Date.now() - remoteBotSnapshot.lastSeen < 120000;
        return connected ? remoteBotSnapshot.guilds : [];
      }
      return client.guilds.cache
        .map((guild) => ({ id: guild.id, name: guild.name }))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
    case 'getMessageChannels': {
      const guildId = String(args[0] || '');
      if (BOT_SYNC_ONLY) return requestHostedBotCommand(name, [guildId]);
      const guild = client.guilds.cache.get(guildId);
      if (!guild) throw new Error('Le bot ne se trouve pas sur ce serveur.');
      const channels = await guild.channels.fetch();
      return channels
        .filter((channel) => (
          channel
          && channel.isTextBased()
          && !channel.isThread()
          && channel.permissionsFor(client.user)?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ])
        ))
        .map((channel) => ({ id: channel.id, name: channel.name }));
    }
    case 'getGuildEmojis': {
      const guild = requireAllowedGuild(ALLOWED_GUILD_ID);
      const emojis = await guild.emojis.fetch();
      return Array.from(emojis.values())
        .filter((emoji) => emoji.available !== false)
        .map((emoji) => ({
          id: emoji.id,
          name: emoji.name,
          animated: emoji.animated,
          url: emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png', size: 32 }),
        }));
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
          canManage: connected,
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
      return BOT_SYNC_ONLY ? remoteBotSnapshot.logs : activityLogs;
    case 'getWarnings': {
      const input = args[0] || {};
      const guild = requireAllowedGuild(input.guildId);
      if (typeof input.userId !== 'string' || !input.userId) {
        throw new Error('Choisis un membre pour consulter les avertissements.');
      }
      if (BOT_SYNC_ONLY) return requestHostedBotCommand(name, args);
      return warnings
        .filter((warning) => warning.guildId === guild.id && warning.userId === input.userId)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    }
    case 'sendMessage': {
      if (BOT_SYNC_ONLY) return requestHostedBotCommand(name, args);
      const input = args[0] || {};
      const channel = await fetchBotTextChannel(input.channelId);
      const content = String(input.content || '').trim();
      if (!content || content.length > 2000) throw new Error('Le message doit contenir entre 1 et 2 000 caractères.');
      const payload = input.replyToMessageId
        ? { content, reply: { messageReference: input.replyToMessageId } }
        : content;
      await channel.send(payload);
      recordActivity('info', `Message envoyé dans #${channel.name}.`, { guildId: channel.guildId });
      return true;
    }
    case 'searchGifs': {
      const query = String(args[0] || '').trim();
      if (!query || query.length > 100) throw new Error('Entre un mot ou une expression (100 caractères maximum).');
      if (!GIPHY_API_KEY) throw new Error('La recherche GIF nécessite GIPHY_API_KEY dans les variables Render. Tu peux aussi coller un lien direct GIPHY se terminant par .gif.');
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
      if (BOT_SYNC_ONLY) return requestHostedBotCommand(name, args);
      const input = args[0] || {};
      let gifUrl;
      try {
        gifUrl = new URL(input.url);
      } catch {
        throw new Error('GIF invalide.');
      }
      if (
        gifUrl.protocol !== 'https:'
        || (gifUrl.hostname !== 'giphy.com' && !gifUrl.hostname.endsWith('.giphy.com'))
        || !/\.gif$/i.test(gifUrl.pathname)
      ) throw new Error('Colle un lien direct vers un fichier GIF GIPHY se terminant par .gif.');
      const channel = await fetchBotTextChannel(input.channelId);
      const embed = new EmbedBuilder().setImage(gifUrl.toString()).setColor(0x5865f2).setFooter({ text: 'Powered by GIPHY' });
      await channel.send({ embeds: [embed] });
      recordActivity('info', `GIF envoyé dans #${channel.name}.`, { guildId: channel.guildId });
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
      const input = args[0] || {};
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      const activityTypes = {
        playing: ActivityType.Playing,
        listening: ActivityType.Listening,
        watching: ActivityType.Watching,
        competing: ActivityType.Competing,
        custom: ActivityType.Custom,
      };
      const presenceStatuses = new Set(['online', 'idle', 'dnd', 'invisible']);
      if (!text || text.length > 128) {
        throw new Error('Le texte du statut doit contenir entre 1 et 128 caractères.');
      }
      if (!Object.hasOwn(activityTypes, input.type)) {
        throw new Error('Choisis un type d’activité valide.');
      }
      if (!presenceStatuses.has(input.status)) {
        throw new Error('Choisis un état de présence valide.');
      }
      const activity = input.type === 'custom'
        ? { name: 'Custom Status', state: text, type: ActivityType.Custom }
        : { name: text, type: activityTypes[input.type] };
      await client.user.setPresence({
        activities: [activity],
        status: input.status,
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
  'getConfig', 'saveConfig', 'getGuilds', 'getChannels', 'getGuildEmojis', 'getVoiceChannels',
  'getMessageGuilds', 'getMessageChannels',
  'getMembers', 'getBots', 'getStats', 'getServerOverview', 'leaveOtherServers',
  'getActivityLogs', 'getWarnings', 'sendMessage', 'searchGifs', 'sendGif', 'sendAnnouncement',
  'getSlashCommands', 'createSlashCommand', 'deleteSlashCommand',
  'kickMember', 'banMember', 'timeoutMember', 'warnMember', 'setBotStatus',
  'joinVoice', 'leaveVoice', 'disconnectVoice', 'playMusic', 'pauseMusic',
  'resumeMusic', 'stopMusic',
]);

const panelUsageActions = {
  saveConfig: 'Modification des réglages du bot',
  sendMessage: 'Envoi d’un message Discord',
  sendGif: 'Envoi d’un GIF',
  sendAnnouncement: 'Publication d’une annonce',
  kickMember: 'Expulsion d’un membre',
  banMember: 'Bannissement d’un membre',
  timeoutMember: 'Timeout d’un membre',
  warnMember: 'Avertissement d’un membre',
  setBotStatus: 'Modification du statut du bot',
  joinVoice: 'Connexion à un salon vocal',
  leaveVoice: 'Déconnexion du salon vocal',
  disconnectVoice: 'Déconnexion du salon vocal',
  playMusic: 'Lancement de musique',
  pauseMusic: 'Pause de la musique',
  resumeMusic: 'Reprise de la musique',
  stopMusic: 'Arrêt de la musique',
  createSlashCommand: 'Création d’une commande slash',
  deleteSlashCommand: 'Suppression d’une commande slash',
  leaveOtherServers: 'Nettoyage des autres serveurs',
};

app.post('/api/command', async (req, res) => {
  const { name, args } = req.body || {};
  if (typeof name !== 'string' || !allowedCommands.has(name) || !Array.isArray(args)) {
    return res.status(400).json({ error: 'Commande invalide.' });
  }
  const action = panelUsageActions[name];
  try {
    if (BOT_SYNC_ONLY && name !== 'searchGifs' && name !== 'getServerOverview') {
      const result = await requestHostedBotCommand(name, args);
      if (action) recordPanelUsage(req.session.discord, action, 'success');
      return res.json({ result });
    }
    const result = await executeCommand(name, args);
    if (action) recordPanelUsage(req.session.discord, action, 'success');
    return res.json({ result });
  } catch (error) {
    if (action && req.session.discord) {
      recordPanelUsage(req.session.discord, action, 'error');
    }
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
