const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
app.setName('Discord Bot App');
const DATA_PATH = app.isPackaged ? app.getPath('userData') : __dirname;
fs.mkdirSync(DATA_PATH, { recursive: true });
const ENV_PATH = path.join(DATA_PATH, '.env');
if (app.isPackaged && !fs.existsSync(ENV_PATH)) {
  fs.copyFileSync(path.join(process.resourcesPath, '.env.example'), ENV_PATH);
}
require('dotenv').config({ path: ENV_PATH });
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
  REST,
  Routes,
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
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');

if (ffmpegPath) {
  process.env.FFMPEG_PATH = app.isPackaged
    ? ffmpegPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    : ffmpegPath;
}

const CONFIG_PATH = path.join(DATA_PATH, 'config.json');
const WARNINGS_PATH = path.join(DATA_PATH, 'warnings.json');
const ACTIVITY_LOG_PATH = path.join(DATA_PATH, 'activity-logs.json');
const SLASH_COMMANDS_PATH = path.join(DATA_PATH, 'slash-commands.json');
const ALLOWED_GUILD_ID = '1508431497433190420';
const MAX_ACTIVITY_LOGS = 200;
const DEFAULT_CONFIG = {
  guildId: '',
  channelId: '',
  welcomeEnabled: false,
  welcomeChannelId: '',
  welcomeMessage: 'Bienvenue {user} sur {server} ! 🎉',
};

function loadConfig() {
  const configPaths = [CONFIG_PATH];
  if (app.isPackaged) configPaths.push(path.join(app.getAppPath(), 'config.json'));

  for (const configPath of configPaths) {
    try {
      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (configPath !== CONFIG_PATH) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(savedConfig, null, 2));
      }
      return { ...DEFAULT_CONFIG, ...savedConfig };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function loadWarnings() {
  const warningsPaths = [WARNINGS_PATH];
  if (app.isPackaged) warningsPaths.push(path.join(app.getAppPath(), 'warnings.json'));

  for (const warningsPath of warningsPaths) {
    try {
      const warnings = JSON.parse(fs.readFileSync(warningsPath, 'utf-8'));
      if (warningsPath !== WARNINGS_PATH) {
        fs.writeFileSync(WARNINGS_PATH, JSON.stringify(warnings, null, 2));
      }
      return warnings;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return [];
}

function saveWarnings(warnings) {
  fs.writeFileSync(WARNINGS_PATH, JSON.stringify(warnings, null, 2));
}

function loadSlashCommands() {
  try {
    const commands = JSON.parse(fs.readFileSync(SLASH_COMMANDS_PATH, 'utf-8'));
    if (!Array.isArray(commands)) throw new Error('Le fichier des commandes slash doit contenir une liste.');
    if (commands.some((command) =>
      !command
      || typeof command.name !== 'string'
      || typeof command.description !== 'string'
      || typeof command.response !== 'string'
      || typeof command.commandId !== 'string'
    )) {
      throw new Error('Le fichier des commandes slash contient une entrée invalide.');
    }
    return commands;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function saveSlashCommands(commands) {
  fs.writeFileSync(SLASH_COMMANDS_PATH, JSON.stringify(commands, null, 2));
}

let mainWindow;
let config = loadConfig();
let activityLogs = loadActivityLogs();
let slashCommands = loadSlashCommands();
const memberCache = new Map();
const botCache = new Map();
const statsCache = new Map();
const memberFetchInFlight = new Map();
const botFetchInFlight = new Map();
const statsFetchInFlight = new Map();

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

let activeVoiceConnection = null;
let audioPlayer = null;
let currentMusic = { title: '', playing: false };
const guildsBeingRemoved = new Set();

function loadActivityLogs() {
  try {
    const logs = JSON.parse(fs.readFileSync(ACTIVITY_LOG_PATH, 'utf-8'));
    if (!Array.isArray(logs)) {
      throw new Error('Le fichier des logs doit contenir une liste.');
    }
    return logs.slice(0, MAX_ACTIVITY_LOGS);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
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
    fs.writeFileSync(ACTIVITY_LOG_PATH, JSON.stringify(activityLogs, null, 2));
  } catch (error) {
    console.error('Impossible d’enregistrer le journal d’activité :', error);
  }

  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('activity-log', entry);
  }
}

function subscribeAudioPlayer(connection) {
  if (!audioPlayer || !connection) return;
  const existingSubscription = connection.state.subscription;
  if (!existingSubscription || existingSubscription.player !== audioPlayer) {
    connection.subscribe(audioPlayer);
  }
}

function emitVoiceStatus(payload = { connected: false }) {
  mainWindow?.webContents.send('voice-status', payload);
}

function emitMusicStatus(payload = { playing: false, title: '' }) {
  mainWindow?.webContents.send('music-status', payload);
}

async function leaveUnapprovedGuild(guild) {
  if (guild.id === ALLOWED_GUILD_ID || guildsBeingRemoved.has(guild.id)) return false;

  guildsBeingRemoved.add(guild.id);
  try {
    await guild.leave();
    recordActivity('success', `Le bot a quitté le serveur « ${guild.name} ».`, {
      guildId: guild.id,
      guildName: guild.name,
    });
    return true;
  } catch (error) {
    recordActivity('error', `Impossible de quitter le serveur « ${guild.name} ».`, {
      guildId: guild.id,
      error: error.message,
    });
    return false;
  } finally {
    guildsBeingRemoved.delete(guild.id);
  }
}

function getOtherGuilds() {
  return client.guilds.cache.filter((guild) => guild.id !== ALLOWED_GUILD_ID);
}

async function checkAllowedGuild() {
  const allowedGuild = client.guilds.cache.get(ALLOWED_GUILD_ID);
  if (!allowedGuild) {
    recordActivity(
      'error',
      `Le serveur à conserver (${ALLOWED_GUILD_ID}) est introuvable. Aucun autre serveur n’a été quitté.`,
      { guildId: ALLOWED_GUILD_ID }
    );
    return false;
  }

  if (config.guildId !== ALLOWED_GUILD_ID) {
    config.guildId = ALLOWED_GUILD_ID;
    saveConfig(config);
  }
  return true;
}

client.on('guildCreate', (guild) => {
  if (guild.id !== ALLOWED_GUILD_ID) {
    recordActivity('warning', `Le bot a été ajouté à « ${guild.name} »; il va le quitter.`, {
      guildId: guild.id,
      guildName: guild.name,
    });
    void leaveUnapprovedGuild(guild);
  }
});

client.once('ready', async () => {
  console.log(`Bot connecté en tant que ${client.user.tag}`);
  recordActivity('success', `Bot connecté en tant que ${client.user.tag}.`);
  try {
    await checkAllowedGuild();
  } catch (error) {
    recordActivity('error', `Impossible de vérifier le serveur à conserver : ${error.message}`, {
      guildId: ALLOWED_GUILD_ID,
    });
  }
  mainWindow?.webContents.send('bot-status', { connected: true, tag: client.user.tag });
  emitVoiceStatus(activeVoiceConnection ? {
    connected: true,
    guildId: activeVoiceConnection.joinConfig.guildId,
    channelId: activeVoiceConnection.joinConfig.channelId,
  } : { connected: false });
});

client.on('error', (err) => {
  recordActivity('error', `Erreur du bot : ${err.message}`);
  mainWindow?.webContents.send('bot-status', { connected: false, error: err.message });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = slashCommands.find((entry) => entry.name === interaction.commandName);
  if (!command) return;

  try {
    if (interaction.guildId !== ALLOWED_GUILD_ID) {
      await interaction.reply({
        content: 'Cette commande est réservée au serveur autorisé.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: command.response,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    recordActivity('error', `Impossible de répondre avec /${command.name} : ${error.message}`);
  }
});

client.on('messageCreate', (message) => {
  if (message.author.bot) {
    if (config.guildId && message.guildId === config.guildId) {
      mainWindow?.webContents.send('bot-message', {
        id: message.id,
        authorId: message.author.id,
        author: message.author.username,
        tag: message.author.tag,
        avatar: message.author.displayAvatarURL({ size: 64 }),
        content: message.content,
        channel: message.channel?.name || 'Salon',
        channelId: message.channelId,
        timestamp: message.createdTimestamp,
      });
    }
    return;
  }

  if (!config.channelId || message.channelId !== config.channelId) return;
  mainWindow?.webContents.send('new-message', {
    messageId: message.id,
    authorId: message.author.id,
    author: message.author.username,
    avatar: message.author.displayAvatarURL({ size: 64 }),
    content: message.content,
    timestamp: message.createdTimestamp,
  });
});

client.on('guildMemberAdd', async (member) => {
  if (
    !config.welcomeEnabled
    || config.guildId !== member.guild.id
    || !config.welcomeChannelId
  ) {
    return;
  }

  try {
    const channel = await member.guild.channels.fetch(config.welcomeChannelId);
    if (!channel || !channel.isTextBased() || !channel.send) {
      throw new Error('Le salon de bienvenue n’est plus disponible.');
    }

    const content = config.welcomeMessage
      .replaceAll('{user}', `<@${member.id}>`)
      .replaceAll('{username}', member.user.username)
      .replaceAll('{server}', member.guild.name)
      .replaceAll('{count}', String(member.guild.memberCount));

    await channel.send({
      content,
      allowedMentions: { users: [member.id] },
    });
  } catch (error) {
    console.error('Impossible d’envoyer le message de bienvenue :', error.message);
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#15161c',
    icon: path.join(__dirname, 'app-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  if (!process.env.DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN manquant. Copie .env.example en .env et renseigne ton token.');
    return;
  }
  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error('Erreur de connexion au bot :', err.message);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------

ipcMain.handle('get-config', () => config);

ipcMain.handle('get-server-overview', async () => {
  const allowedGuild = client.guilds.cache.get(ALLOWED_GUILD_ID);
  return {
    connected: client.isReady(),
    allowedGuildId: ALLOWED_GUILD_ID,
    allowedGuildName: allowedGuild?.name || null,
    guilds: client.guilds.cache
      .map((guild) => ({
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount,
        allowed: guild.id === ALLOWED_GUILD_ID,
      }))
      .sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.name.localeCompare(b.name)),
  };
});

ipcMain.handle('leave-other-servers', async () => {
  if (!client.isReady()) {
    throw new Error('Le bot doit être connecté avant de gérer ses serveurs.');
  }
  if (!(await checkAllowedGuild())) {
    throw new Error(`Le serveur à conserver (${ALLOWED_GUILD_ID}) est introuvable. Aucun serveur n’a été quitté.`);
  }

  const otherGuilds = Array.from(getOtherGuilds().values());
  recordActivity('info', `Nettoyage demandé : ${otherGuilds.length} autre(s) serveur(s) à quitter.`, {
    guildIds: otherGuilds.map((guild) => guild.id),
  });
  let leftCount = 0;
  for (const guild of otherGuilds) {
    if (await leaveUnapprovedGuild(guild)) leftCount += 1;
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
    guilds: Array.from(getOtherGuilds().values()).map((guild) => ({
      id: guild.id,
      name: guild.name,
    })),
  };
});

ipcMain.handle('get-activity-logs', () => activityLogs);
ipcMain.handle('get-slash-commands', () => (
  slashCommands.map(({ name, description, response }) => ({ name, description, response }))
));

ipcMain.handle('create-slash-command', async (event, input = {}) => {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const response = typeof input.response === 'string' ? input.response.trim() : '';
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
    throw new Error('Le nom doit contenir 1 à 32 caractères minuscules, chiffres, tirets ou tirets bas.');
  }
  if (!description || description.length > 100) {
    throw new Error('La description doit contenir entre 1 et 100 caractères.');
  }
  if (!response || response.length > 2000) {
    throw new Error('La réponse doit contenir entre 1 et 2 000 caractères.');
  }
  if (!client.isReady() || !client.user) {
    throw new Error('Le bot doit être connecté pour gérer les commandes slash.');
  }
  if (slashCommands.some((command) => command.name === name)) {
    throw new Error(`La commande /${name} existe déjà.`);
  }

  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  const route = Routes.applicationGuildCommands(client.user.id, ALLOWED_GUILD_ID);
  const registeredCommands = await rest.get(route);
  if (registeredCommands.some((command) => command.name === name)) {
    throw new Error(`Le nom /${name} est déjà utilisé par une commande Discord.`);
  }
  if (registeredCommands.length >= 100) {
    throw new Error('Discord limite à 100 le nombre de commandes sur ce serveur.');
  }

  const registered = await rest.post(route, {
    body: { name, description, type: 1 },
  });
  const updatedCommands = [...slashCommands, {
    commandId: registered.id,
    name,
    description,
    response,
  }];
  try {
    saveSlashCommands(updatedCommands);
  } catch (error) {
    try {
      await rest.delete(Routes.applicationGuildCommand(client.user.id, ALLOWED_GUILD_ID, registered.id));
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `L’enregistrement de /${name} a échoué et Discord n’a pas pu annuler la commande créée.`
      );
    }
    throw error;
  }
  slashCommands = updatedCommands;
  recordActivity('info', `Commande slash /${name} créée.`, { guildId: ALLOWED_GUILD_ID });
  return { name, description, response };
});

ipcMain.handle('delete-slash-command', async (event, name) => {
  if (typeof name !== 'string') throw new Error('Nom de commande invalide.');
  if (!client.isReady() || !client.user) {
    throw new Error('Le bot doit être connecté pour gérer les commandes slash.');
  }
  const command = slashCommands.find((entry) => entry.name === name);
  if (!command) throw new Error(`La commande /${name} est introuvable.`);

  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  const route = Routes.applicationGuildCommand(client.user.id, ALLOWED_GUILD_ID, command.commandId);
  await rest.delete(route);
  const updatedCommands = slashCommands.filter((entry) => entry.name !== name);
  try {
    saveSlashCommands(updatedCommands);
  } catch (error) {
    const restored = await rest.post(Routes.applicationGuildCommands(client.user.id, ALLOWED_GUILD_ID), {
      body: { name: command.name, description: command.description, type: 1 },
    });
    const restoredCommands = slashCommands.map((entry) => (
      entry.name === name ? { ...entry, commandId: restored.id } : entry
    ));
    try {
      saveSlashCommands(restoredCommands);
      slashCommands = restoredCommands;
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `La commande /${name} a été rétablie sur Discord, mais son fichier local n’a pas pu être mis à jour.`
      );
    }
    throw error;
  }
  slashCommands = updatedCommands;
  recordActivity('info', `Commande slash /${name} supprimée.`, { guildId: ALLOWED_GUILD_ID });
  return true;
});

ipcMain.handle('save-config', async (event, newConfig) => {
  const guildId = String(newConfig.guildId || '');
  if (guildId !== ALLOWED_GUILD_ID) {
    throw new Error(`Ce bot est réservé au serveur ${ALLOWED_GUILD_ID}.`);
  }

  const channelId = String(newConfig.channelId || '');
  const welcomeEnabled = newConfig.welcomeEnabled === true;
  const welcomeChannelId = String(newConfig.welcomeChannelId || '');
  const welcomeMessage = String(newConfig.welcomeMessage || '').trim();

  if (welcomeEnabled) {
    if (!guildId || !welcomeChannelId || !welcomeMessage) {
      throw new Error('Choisis un salon et un message pour activer l’accueil.');
    }
    if (welcomeMessage.length > 2000) {
      throw new Error('Le message de bienvenue ne peut pas dépasser 2 000 caractères.');
    }
    const guild = await client.guilds.fetch(guildId);
    const welcomeChannel = await guild.channels.fetch(welcomeChannelId);
    if (
      !welcomeChannel
      || welcomeChannel.guildId !== guild.id
      || !welcomeChannel.isTextBased()
    ) {
      throw new Error('Choisis un salon textuel valide sur le serveur sélectionné.');
    }
  }

  config = {
    ...config,
    guildId,
    channelId,
    welcomeEnabled,
    welcomeChannelId: welcomeEnabled ? welcomeChannelId : '',
    welcomeMessage: welcomeMessage || DEFAULT_CONFIG.welcomeMessage,
  };
  saveConfig(config);
  return config;
});

ipcMain.handle('get-guilds', () => {
  return client.guilds.cache
    .filter((guild) => guild.id === ALLOWED_GUILD_ID)
    .map((guild) => ({ id: guild.id, name: guild.name }));
});

ipcMain.handle('get-channels', async (event, guildId) => {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  return channels
    .filter((c) => c && c.isTextBased() && !c.isThread())
    .map((c) => ({ id: c.id, name: c.name }));
});

ipcMain.handle('get-guild-emojis', async () => {
  const guild = await client.guilds.fetch(ALLOWED_GUILD_ID);
  const emojis = await guild.emojis.fetch();
  return Array.from(emojis.values())
    .filter((emoji) => emoji.available !== false)
    .map((emoji) => ({
      id: emoji.id,
      name: emoji.name,
      animated: emoji.animated,
      url: emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png', size: 32 }),
    }));
});

ipcMain.handle('get-voice-channels', async (event, guildId) => {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  return channels
    .filter((c) => c && c.isVoiceBased() && !c.isThread())
    .map((c) => ({ id: c.id, name: c.name }));
});

ipcMain.handle('join-voice', async (event, { guildId, channelId }) => {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error('Salon vocal invalide');
  }

  const existingConnection = getVoiceConnection(guildId);
  if (existingConnection) {
    existingConnection.destroy();
  }

  activeVoiceConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfMute: false,
    selfDeaf: true,
  });

  subscribeAudioPlayer(activeVoiceConnection);

  const payload = {
    connected: true,
    guildId: guild.id,
    channelId: channel.id,
    channelName: channel.name,
  };
  emitVoiceStatus(payload);
  return payload;
});

ipcMain.handle('leave-voice', async (event, guildId) => {
  const connection = getVoiceConnection(guildId);
  if (!connection) {
    return { connected: false, guildId };
  }

  connection.destroy();
  activeVoiceConnection = null;
  emitVoiceStatus({ connected: false, guildId });
  return { connected: false, guildId };
});

ipcMain.handle('set-bot-status', async (event, { text }) => {
  if (!client.user) {
    throw new Error('Bot non connecté');
  }

  const statusText = text && text.trim() ? text.trim() : 'Panel Bot';
  await client.user.setPresence({
    activities: [{ name: statusText, type: ActivityType.Custom }],
    status: 'online',
  });

  return { text: statusText };
});

async function ensureGuildVoiceConnection(guildId, channelId) {
  const guild = await client.guilds.fetch(guildId);
  const connection = getVoiceConnection(guildId);
  if (connection) return connection;

  const channel = await guild.channels.fetch(channelId || guild.channels.cache.find((c) => c.isVoiceBased())?.id);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error('Aucun salon vocal disponible pour ce serveur');
  }

  const newConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfMute: false,
    selfDeaf: true,
  });

  activeVoiceConnection = newConnection;
  emitVoiceStatus({
    connected: true,
    guildId: guild.id,
    channelId: channel.id,
    channelName: channel.name,
  });

  return newConnection;
}

ipcMain.handle('play-music', async (event, { guildId, channelId, query }) => {
  if (!guildId || !query || !query.trim()) {
    throw new Error('La musique ou le serveur est invalide.');
  }

  const trimmedQuery = query.trim();
  let sourceUrl = trimmedQuery;
  let title = 'Musique';

  try {
    if (!/^https?:\/\//i.test(trimmedQuery)) {
      const result = await play.search(trimmedQuery, { limit: 1 });
      if (!result || !result.length) {
        throw new Error('Aucune musique trouvée pour cette recherche.');
      }
      sourceUrl = result[0].url;
      title = result[0].title || title;
    } else {
      const info = await play.video_basic_info(trimmedQuery);
      title = info?.video_details?.title || title;
    }

    const connection = await ensureGuildVoiceConnection(guildId, channelId);
    if (!audioPlayer) {
      audioPlayer = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      });
      audioPlayer.on('error', (error) => {
        console.error('Erreur audio player:', error);
        currentMusic = { title: '', playing: false };
        emitMusicStatus({ playing: false, title: '' });
      });
    }

    subscribeAudioPlayer(connection);

    const stream = await play.stream(sourceUrl, {
      quality: 1,
      discordPlayerCompatibility: true,
    });
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type === 'opus' ? StreamType.Opus : StreamType.Arbitrary,
      inlineVolume: true,
    });

    if (audioPlayer.state.status === AudioPlayerStatus.Playing) {
      audioPlayer.stop();
    }

    audioPlayer.play(resource);
    currentMusic = { title, playing: true };
    emitMusicStatus({ playing: true, title });
    return { playing: true, title };
  } catch (error) {
    currentMusic = { title: '', playing: false };
    emitMusicStatus({ playing: false, title: '' });
    throw new Error(error.message || 'Impossible de lire cette musique.');
  }
});

ipcMain.handle('pause-music', async (event, guildId) => {
  if (!audioPlayer || !guildId) return { playing: false };
  if (audioPlayer.state.status === AudioPlayerStatus.Playing) {
    audioPlayer.pause();
  }
  emitMusicStatus({ playing: false, title: currentMusic.title || '' });
  return { playing: false, title: currentMusic.title || '' };
});

ipcMain.handle('resume-music', async (event, guildId) => {
  if (!audioPlayer || !guildId) return { playing: currentMusic.playing };
  if (audioPlayer.state.status === AudioPlayerStatus.Paused) {
    audioPlayer.unpause();
    emitMusicStatus({ playing: true, title: currentMusic.title || '' });
    return { playing: true, title: currentMusic.title || '' };
  }
  return { playing: currentMusic.playing, title: currentMusic.title || '' };
});

ipcMain.handle('stop-music', async (event, guildId) => {
  if (!audioPlayer) {
    return { playing: false };
  }
  audioPlayer.stop();
  currentMusic = { title: '', playing: false };
  emitMusicStatus({ playing: false, title: '' });
  return { playing: false };
});

ipcMain.handle('disconnect-voice', async (event, guildId) => {
  if (!guildId) return { connected: false };
  const connection = getVoiceConnection(guildId);
  if (connection) {
    connection.destroy();
  }
  activeVoiceConnection = null;
  emitVoiceStatus({ connected: false, guildId });
  return { connected: false, guildId };
});

async function fetchGuildMembers(guildId, includeBots = true) {
  const cache = includeBots ? botCache : memberCache;
  const inFlightMap = includeBots ? botFetchInFlight : memberFetchInFlight;
  const cached = cache.get(guildId);
  const now = Date.now();

  if (cached && now - cached.timestamp < 300000) {
    return cached.members;
  }

  if (inFlightMap.has(guildId)) {
    return inFlightMap.get(guildId);
  }

  const fetchPromise = (async () => {
    const guild = await client.guilds.fetch(guildId);
    let members = guild.members.cache;

    if (members.size === 0) {
      members = await guild.members.fetch().catch(() => guild.members.cache);
    }

    const formatted = Array.from(members.values())
      .map((m) => ({
        id: m.id,
        tag: m.user.tag,
        nickname: m.nickname || m.user.displayName || m.user.username,
        username: m.user.username,
        displayName: m.user.displayName || m.user.username,
        isBot: m.user.bot,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));

    const result = includeBots ? formatted.filter((m) => m.isBot) : formatted;
    cache.set(guildId, { timestamp: Date.now(), members: result });
    return result;
  })();

  inFlightMap.set(guildId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightMap.delete(guildId);
  }
}

ipcMain.handle('get-members', async (event, guildId) => fetchGuildMembers(guildId, false));

ipcMain.handle('get-bots', async (event, guildId) => fetchGuildMembers(guildId, true));

ipcMain.handle('send-message', async (event, { channelId, content, replyToMessageId }) => {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) throw new Error('Salon invalide');

  const payload = replyToMessageId
    ? { content, reply: { messageReference: replyToMessageId } }
    : content;

  await channel.send(payload);
  recordActivity('info', `Message envoyé dans #${channel.name || channelId}.`, {
    guildId: channel.guildId,
  });
  return true;
});

function isGiphyUrl(url) {
  const hostname = new URL(url).hostname;
  return hostname === 'giphy.com' || hostname.endsWith('.giphy.com');
}

ipcMain.handle('search-gifs', async (event, query) => {
  const searchTerm = typeof query === 'string' ? query.trim() : '';
  if (!searchTerm || searchTerm.length > 100) {
    throw new Error('Entre un mot ou une expression (100 caractères maximum).');
  }

  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    throw new Error('Configure GIPHY_API_KEY dans le fichier .env pour rechercher des GIFs.');
  }

  const searchUrl = new URL('https://api.giphy.com/v1/gifs/search');
  searchUrl.search = new URLSearchParams({
    q: searchTerm,
    api_key: apiKey,
    limit: '8',
    rating: 'pg',
    lang: 'fr',
  });

  const response = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const detail = response.status === 429
      ? 'Limite de recherche atteinte, réessaie dans un instant.'
      : `La recherche GIPHY a échoué (erreur ${response.status}). Vérifie la clé API.`;
    throw new Error(detail);
  }

  const payload = await response.json();
  return (Array.isArray(payload?.data) ? payload.data : [])
    .map((result) => {
      const images = result.images || {};
      const gifUrl = images.original?.url;
      const previewUrl = images.fixed_width_small?.url || images.downsized_medium?.url || gifUrl;
      if (!gifUrl || !previewUrl) return null;

      try {
        if (!isGiphyUrl(gifUrl) || !isGiphyUrl(previewUrl)) {
          return null;
        }
      } catch {
        return null;
      }

      return {
        id: result.id,
        title: result.title || 'GIF',
        url: gifUrl,
        previewUrl,
      };
    })
    .filter(Boolean);
});

ipcMain.handle('send-gif', async (event, { channelId, url }) => {
  if (typeof url !== 'string') {
    throw new Error('GIF invalide.');
  }

  let gifUrl;
  try {
    gifUrl = new URL(url);
  } catch {
    throw new Error('GIF invalide.');
  }
  if (
    gifUrl.protocol !== 'https:'
    || (gifUrl.hostname !== 'giphy.com' && !gifUrl.hostname.endsWith('.giphy.com'))
  ) {
    throw new Error('Seuls les GIFs provenant de GIPHY peuvent être envoyés.');
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) throw new Error('Salon invalide');

  const embed = new EmbedBuilder()
    .setImage(gifUrl.toString())
    .setColor(0x5865f2)
    .setFooter({ text: 'Powered by GIPHY' });
  await channel.send({ embeds: [embed] });
  recordActivity('info', `GIF envoyé dans #${channel.name || channelId}.`, {
    guildId: channel.guildId,
  });
  return true;
});

ipcMain.handle('send-announcement', async (event, { channelId, title, description }) => {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) throw new Error('Salon invalide');
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865f2)
    .setTimestamp();
  await channel.send({ embeds: [embed] });
  recordActivity('info', `Annonce publiée dans #${channel.name || channelId}.`, {
    guildId: channel.guildId,
  });
  return true;
});

ipcMain.handle('kick-member', async (event, { guildId, userId, reason }) => {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  await member.kick(reason || 'Aucune raison fournie');
  recordActivity('warning', `${member.user.tag} a été expulsé du serveur ${guild.name}.`, {
    guildId,
    userId,
  });
  return true;
});

ipcMain.handle('ban-member', async (event, { guildId, userId, reason }) => {
  const guild = await client.guilds.fetch(guildId);
  await guild.members.ban(userId, { reason: reason || 'Aucune raison fournie' });
  recordActivity('warning', `Un membre a été banni du serveur ${guild.name}.`, {
    guildId,
    userId,
  });
  return true;
});

ipcMain.handle('timeout-member', async (event, { guildId, userId, durationMinutes, reason }) => {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  const durationMs = Number(durationMinutes || 10) * 60 * 1000;
  const timeoutUntil = new Date(Date.now() + durationMs);
  await member.timeout(timeoutUntil, reason || 'Aucune raison fournie');
  recordActivity('warning', `${member.user.tag} a été mis en sourdine ${Number(durationMinutes || 10)} min sur ${guild.name}.`, {
    guildId,
    userId,
  });
  return { durationMinutes: Number(durationMinutes || 10), timeoutUntil: timeoutUntil.toISOString() };
});

ipcMain.handle('warn-member', async (event, { guildId, userId, reason }) => {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  const warning = {
    id: Date.now(),
    guildId,
    userId,
    username: member.user.tag,
    reason: reason || 'Aucune raison fournie',
    createdAt: new Date().toISOString(),
  };

  const warnings = loadWarnings();
  warnings.push(warning);
  saveWarnings(warnings);

  const message = `⚠️ Avertissement de modération\nRaison : ${warning.reason}\nTu as reçu cet avertissement sur le serveur ${guild.name}.`;
  await member.send(message).catch(() => {});
  recordActivity('warning', `${member.user.tag} a reçu un avertissement sur ${guild.name}.`, {
    guildId,
    userId,
  });
  return warning;
});

ipcMain.handle('get-stats', async (event, guildId) => {
  const cached = statsCache.get(guildId);
  const now = Date.now();

  if (cached && now - cached.timestamp < 60000) {
    return cached.stats;
  }

  if (statsFetchInFlight.has(guildId)) {
    return statsFetchInFlight.get(guildId);
  }

  const fetchPromise = (async () => {
    const guild = await client.guilds.fetch(guildId);
    if (guild.members.cache.size === 0) {
      await guild.members.fetch().catch(() => {});
    }
    const totalMembers = guild.memberCount;
    const onlineMembers = guild.members.cache.filter(
      (m) => m.presence && m.presence.status && m.presence.status !== 'offline'
    ).size;
    const channelCount = guild.channels.cache.size;
    const boostCount = guild.premiumSubscriptionCount || 0;
    const stats = {
      guildName: guild.name,
      icon: guild.iconURL({ size: 64 }),
      totalMembers,
      onlineMembers,
      channelCount,
      boostCount,
    };

    statsCache.set(guildId, { timestamp: Date.now(), stats });
    return stats;
  })();

  statsFetchInFlight.set(guildId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    statsFetchInFlight.delete(guildId);
  }
});
