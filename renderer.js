// ---------- Navigation ----------

const mobileLogoMotion = window.matchMedia(
  '(max-width: 760px) and (prefers-reduced-motion: no-preference)'
);

function playMobileLogoAnimation() {
  const shell = document.querySelector('.shell');
  if (!shell || !mobileLogoMotion.matches) return;

  shell.classList.remove('mobile-logo-animate');
  void shell.offsetWidth;
  shell.classList.add('mobile-logo-animate');
}

window.addEventListener('pageshow', playMobileLogoAnimation);

async function welcomeRobotAfterUpdate() {
  if (window.location.protocol === 'file:') return;

  try {
    const response = await fetch('/api/app-version', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Version du panel indisponible (${response.status}).`);
    const payload = await response.json();
    if (typeof payload.version !== 'string' || !payload.version) {
      throw new Error('Le serveur n’a pas retourné de version valide.');
    }

    const storageKey = 'panel-bot-seen-release';
    const previousVersion = localStorage.getItem(storageKey);
    localStorage.setItem(storageKey, payload.version);
    if (previousVersion === payload.version) return;

    const dialog = document.getElementById('update-greeting');
    const message = document.getElementById('update-greeting-message');
    const button = document.getElementById('update-greeting-button');
    if (!dialog || !message || !button) {
      throw new Error('La fenêtre du robot de mise à jour est introuvable.');
    }

    button.addEventListener('click', () => {
      if (dialog.classList.contains('is-replied')) {
        dialog.close();
        return;
      }

      dialog.classList.add('is-replied');
      message.textContent = 'Bonjour ! Ça me fait plaisir de te revoir. 😊';
      button.textContent = 'Fermer';
      button.focus();
    });
    dialog.showModal();
    button.focus();
  } catch (error) {
    console.error('Impossible de vérifier la mise à jour du petit robot :', error);
  }
}

welcomeRobotAfterUpdate();

const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
if (window.location.protocol === 'file:') {
  document.querySelector('.session-user')?.setAttribute('hidden', '');
}
let serverOverview = null;
let isLeavingOtherServers = false;
let activityEntries = [];
let panelUsageEntries = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    navItems.forEach((b) => b.classList.remove('active'));
    views.forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');

    if (btn.dataset.view === 'stats') loadStats();
    if (btn.dataset.view === 'logs') loadLogs();
    if (btn.dataset.view === 'members') loadMemberDirectory();
    if (btn.dataset.view === 'moderation') loadMembers();
    if (btn.dataset.view === 'bots') loadBots();
    if (btn.dataset.view === 'voice') loadVoiceChannels();
    if (btn.dataset.view === 'servers') loadServerManagement();
    if (btn.dataset.view === 'settings') loadSettings();
    if (btn.dataset.view === 'commands') loadSlashCommands();
  });
});

const slashCommandForm = document.getElementById('slash-command-form');
const slashCommandList = document.getElementById('slash-command-list');
const slashCommandStatus = document.getElementById('slash-command-status');

function setSlashCommandStatus(message, isError = false) {
  slashCommandStatus.textContent = message;
  slashCommandStatus.classList.toggle('is-error', isError);
}

async function loadSlashCommands() {
  slashCommandList.innerHTML = '<p class="empty-hint">Chargement des commandes…</p>';
  try {
    const commands = await window.api.getSlashCommands();
    if (!Array.isArray(commands)) throw new Error('La liste de commandes reçue est invalide.');
    if (!commands.length) {
      slashCommandList.innerHTML = '<p class="empty-hint">Aucune commande personnalisée pour le moment.</p>';
      return;
    }

    slashCommandList.innerHTML = commands.map((command) => `
      <article class="slash-command-row">
        <div class="slash-command-copy">
          <strong>/${escapeHtml(command.name)}</strong>
          <p>${escapeHtml(command.description)}</p>
          <small>${escapeHtml(command.response)}</small>
        </div>
        <button class="btn-danger slash-command-delete" type="button" data-command-name="${escapeHtml(command.name)}">Supprimer</button>
      </article>
    `).join('');

    slashCommandList.querySelectorAll('.slash-command-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        const name = button.dataset.commandName;
        if (!window.confirm(`Supprimer la commande /${name} du serveur Discord ?`)) return;
        button.disabled = true;
        try {
          await window.api.deleteSlashCommand(name);
          setSlashCommandStatus(`La commande /${name} a été supprimée.`);
          await loadSlashCommands();
        } catch (error) {
          button.disabled = false;
          setSlashCommandStatus(`Erreur : ${error.message}`, true);
        }
      });
    });
  } catch (error) {
    slashCommandList.innerHTML = '<p class="empty-hint">Impossible de charger les commandes.</p>';
    setSlashCommandStatus(`Erreur : ${error.message}`, true);
  }
}

slashCommandForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = slashCommandForm.querySelector('button[type="submit"]');
  const input = {
    name: slashCommandForm.elements.name.value.trim(),
    description: slashCommandForm.elements.description.value.trim(),
    response: slashCommandForm.elements.response.value.trim(),
  };
  submitButton.disabled = true;
  setSlashCommandStatus('Création et synchronisation de la commande avec Discord…');
  try {
    await window.api.createSlashCommand(input);
    slashCommandForm.reset();
    setSlashCommandStatus(`La commande /${input.name} est disponible dans Discord.`);
    await loadSlashCommands();
  } catch (error) {
    setSlashCommandStatus(`Erreur : ${error.message}`, true);
  } finally {
    submitButton.disabled = false;
  }
});

// ---------- Statut du bot ----------

window.api.onBotStatus((data) => {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (data.connected) {
    dot.className = 'dot online';
    text.textContent = data.tag;
  } else {
    dot.className = 'dot offline';
    text.textContent = 'Déconnecté';
  }
  if (document.getElementById('view-servers').classList.contains('active')) {
    loadServerManagement();
  }
});

window.api.onVoiceStatus((data) => {
  const voiceLabel = document.getElementById('voice-status-label');
  if (!voiceLabel) return;
  if (data.connected) {
    voiceLabel.textContent = `Connecté dans #${data.channelName || 'salon vocal'} (${data.channelId || '—'})`;
  } else {
    voiceLabel.textContent = 'Aucun salon vocal actif.';
  }
});

window.api.onMusicStatus((data) => {
  const musicLabel = document.getElementById('music-status-label');
  if (!musicLabel) return;
  if (data.playing) {
    musicLabel.textContent = `Lecture en cours : ${data.title || 'Musique'}`;
  } else {
    musicLabel.textContent = 'Aucune musique en cours.';
  }
});

// ---------- Chat ----------

const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('message-input');
const mentionSuggestions = document.getElementById('mention-suggestions');
const replyIndicator = document.getElementById('reply-indicator');
const replyTargetName = document.getElementById('reply-target-name');
const gifTools = document.getElementById('gif-tools');
const gifSearchForm = document.getElementById('gif-search-form');
const gifQuery = document.getElementById('gif-query');
const gifSearchStatus = document.getElementById('gif-search-status');
const gifResults = document.getElementById('gif-results');
const memberSearch = document.getElementById('member-search');
const botSearch = document.getElementById('bot-search');
let currentChannelId = null;
let replyTarget = null;
let allMembers = [];
let mentionMembersPromise = null;
let mentionMembersGuildId = null;
let activeMentionIndex = -1;
let allBots = [];
let selectedBotId = null;

function updateReplyIndicator() {
  if (!replyTarget) {
    replyIndicator.classList.add('hidden');
    replyTargetName.textContent = '';
    return;
  }

  replyIndicator.classList.remove('hidden');
  replyTargetName.textContent = replyTarget.author;
}

function setReplyTarget(messageData) {
  if (!messageData || !messageData.author || !messageData.messageId) return;
  replyTarget = {
    author: messageData.author,
    messageId: messageData.messageId,
    content: messageData.content,
  };
  updateReplyIndicator();
}

function renderMessage(data) {
  if (messagesEl.querySelector('.empty-hint')) messagesEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  wrap.dataset.messageId = data.messageId || '';
  wrap.dataset.author = data.author || '';
  wrap.addEventListener('click', () => setReplyTarget(data));

  if (data.avatar) {
    const avatar = document.createElement('img');
    avatar.src = data.avatar;
    wrap.appendChild(avatar);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  const author = document.createElement('div');
  author.className = 'msg-author';
  author.textContent = data.author;
  body.appendChild(author);

  const content = document.createElement('div');
  content.className = 'msg-content';
  content.textContent = data.content;
  body.appendChild(content);

  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

window.api.onNewMessage(renderMessage);

function getActiveMention() {
  const cursor = messageInput.selectionStart;
  const textBeforeCursor = messageInput.value.slice(0, cursor);
  const match = textBeforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;

  return {
    query: match[1].toLocaleLowerCase(),
    start: cursor - match[1].length - 1,
    end: cursor,
  };
}

function closeMentionSuggestions() {
  mentionSuggestions.hidden = true;
  mentionSuggestions.replaceChildren();
  activeMentionIndex = -1;
  messageInput.removeAttribute('aria-activedescendant');
}

async function loadMentionMembers() {
  const config = await window.api.getConfig();
  if (!config.guildId) {
    throw new Error('Choisis d’abord un serveur dans Réglages.');
  }

  if (mentionMembersGuildId !== config.guildId) {
    mentionMembersGuildId = config.guildId;
    mentionMembersPromise = null;
  }
  if (!mentionMembersPromise) {
    mentionMembersPromise = window.api.getMembers(config.guildId)
      .then((members) => {
        allMembers = members;
        return members;
      })
      .catch((error) => {
        mentionMembersPromise = null;
        throw error;
      });
  }

  return mentionMembersPromise;
}

function setActiveMentionOption(index) {
  const options = mentionSuggestions.querySelectorAll('.mention-option');
  if (!options.length) return;

  activeMentionIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => {
    const isActive = optionIndex === activeMentionIndex;
    option.classList.toggle('active', isActive);
    option.setAttribute('aria-selected', String(isActive));
  });
  messageInput.setAttribute('aria-activedescendant', options[activeMentionIndex].id);
  options[activeMentionIndex].scrollIntoView({ block: 'nearest' });
}

function selectMention(member, range) {
  const mention = `<@${member.id}>`;
  const before = messageInput.value.slice(0, range.start);
  const after = messageInput.value.slice(range.end);
  const separator = after && !/^\s/.test(after) ? ' ' : '';
  const insertion = `${mention}${separator}`;
  messageInput.value = `${before}${insertion}${after}`;
  const cursor = before.length + insertion.length;
  messageInput.focus();
  messageInput.setSelectionRange(cursor, cursor);
  closeMentionSuggestions();
}

async function updateMentionSuggestions() {
  const range = getActiveMention();
  if (!range) {
    closeMentionSuggestions();
    return;
  }

  mentionSuggestions.hidden = false;
  mentionSuggestions.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'mention-empty';
  loading.textContent = 'Recherche des membres…';
  mentionSuggestions.appendChild(loading);

  try {
    const members = await loadMentionMembers();
    const currentRange = getActiveMention();
    if (!currentRange || currentRange.start !== range.start || currentRange.query !== range.query) return;

    const matchingMembers = members
      .filter((member) => {
        const labels = `${member.nickname || ''} ${member.username || ''} ${member.tag || ''} ${member.id}`.toLocaleLowerCase();
        return labels.includes(range.query);
      })
      .slice(0, 8);
    mentionSuggestions.replaceChildren();

    if (!matchingMembers.length) {
      const empty = document.createElement('p');
      empty.className = 'mention-empty';
      empty.textContent = 'Aucun membre trouvé.';
      mentionSuggestions.appendChild(empty);
      return;
    }

    matchingMembers.forEach((member, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = `mention-option-${index}`;
      option.className = 'mention-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');

      const name = document.createElement('span');
      name.className = 'mention-option-name';
      name.textContent = member.nickname || member.username || member.tag;
      option.appendChild(name);

      const username = document.createElement('span');
      username.className = 'mention-option-tag';
      username.textContent = member.tag || member.username || member.id;
      option.appendChild(username);

      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => selectMention(member, range));
      mentionSuggestions.appendChild(option);
    });
  } catch (error) {
    const currentRange = getActiveMention();
    if (!currentRange || currentRange.start !== range.start || currentRange.query !== range.query) return;
    const errorMessage = document.createElement('p');
    errorMessage.className = 'mention-empty';
    errorMessage.textContent = `Impossible de charger les membres : ${error.message}`;
    mentionSuggestions.replaceChildren(errorMessage);
  }
}

messageInput.addEventListener('input', updateMentionSuggestions);
messageInput.addEventListener('click', updateMentionSuggestions);
messageInput.addEventListener('keyup', (event) => {
  if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
  updateMentionSuggestions();
});
messageInput.addEventListener('keydown', (event) => {
  if (mentionSuggestions.hidden) return;
  const options = mentionSuggestions.querySelectorAll('.mention-option');
  if (event.key === 'ArrowDown' && options.length) {
    event.preventDefault();
    setActiveMentionOption(activeMentionIndex + 1);
  } else if (event.key === 'ArrowUp' && options.length) {
    event.preventDefault();
    setActiveMentionOption(activeMentionIndex < 0 ? options.length - 1 : activeMentionIndex - 1);
  } else if (event.key === 'Enter' && activeMentionIndex >= 0) {
    event.preventDefault();
    options[activeMentionIndex].click();
  } else if (event.key === 'Escape') {
    closeMentionSuggestions();
  }
});
messageInput.addEventListener('blur', () => {
  setTimeout(closeMentionSuggestions, 100);
});

document.getElementById('toggle-gif-search').addEventListener('click', (event) => {
  const isOpening = gifTools.hidden;
  gifTools.hidden = !isOpening;
  event.currentTarget.setAttribute('aria-expanded', String(isOpening));
  if (isOpening) gifQuery.focus();
});

gifSearchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = gifQuery.value.trim();
  if (!query) {
    gifSearchStatus.textContent = 'Entre un mot pour chercher un GIF.';
    gifResults.replaceChildren();
    return;
  }

  const searchButton = gifSearchForm.querySelector('button[type="submit"]');
  searchButton.disabled = true;
  gifSearchStatus.textContent = 'Recherche des GIFs…';
  gifResults.replaceChildren();
  try {
    const gifs = await window.api.searchGifs(query);
    if (!gifs.length) {
      gifSearchStatus.textContent = 'Aucun GIF trouvé pour cette recherche.';
      return;
    }

    gifSearchStatus.textContent = `${gifs.length} GIF(s) trouvé(s).`;
    gifs.forEach((gif) => {
      const card = document.createElement('article');
      card.className = 'gif-result';

      const preview = document.createElement('img');
      preview.src = gif.previewUrl;
      preview.alt = gif.title;
      preview.loading = 'lazy';
      card.appendChild(preview);

      const sendButton = document.createElement('button');
      sendButton.type = 'button';
      sendButton.className = 'btn-primary';
      sendButton.textContent = 'Envoyer';
      sendButton.addEventListener('click', async () => {
        if (!currentChannelId) {
          gifSearchStatus.textContent = 'Choisis d’abord un salon dans Réglages.';
          return;
        }

        sendButton.disabled = true;
        gifSearchStatus.textContent = 'Envoi du GIF…';
        try {
          await window.api.sendGif({ channelId: currentChannelId, url: gif.url });
          gifSearchStatus.textContent = 'GIF envoyé dans le salon Discord ✅';
        } catch (error) {
          gifSearchStatus.textContent = `Erreur : ${error.message}`;
          sendButton.disabled = false;
        }
      });
      card.appendChild(sendButton);
      gifResults.appendChild(card);
    });
  } catch (error) {
    gifSearchStatus.textContent = `Erreur : ${error.message}`;
  } finally {
    searchButton.disabled = false;
  }
});

function renderBotFeed(items) {
  const feed = document.getElementById('bot-feed');
  if (!feed) return;

  if (!items.length) {
    feed.innerHTML = '<p class="empty-hint">Aucun message de bot reçu pour le moment.</p>';
    return;
  }

  const html = items
    .slice()
    .reverse()
    .map((item) => `
      <div class="bot-item">
        <div class="bot-item-top">
      <strong>${escapeHtml(item.author)}</strong>
      <span>${escapeHtml(item.tag)}</span>
        </div>
    <div class="bot-item-meta">#${escapeHtml(item.channel)} · ${escapeHtml(item.id)}</div>
    <div class="bot-item-content">${escapeHtml(item.content)}</div>
      </div>
    `)
    .join('');

  feed.innerHTML = html;
}

const botMessageBuffer = [];
window.api.onBotMessage((data) => {
  botMessageBuffer.push(data);
  const filtered = selectedBotId ? botMessageBuffer.filter((msg) => msg.authorId === selectedBotId || msg.id === selectedBotId) : botMessageBuffer;
  renderBotFeed(filtered);
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = messageInput.value.trim();
  if (!content) return;
  if (!currentChannelId) {
    renderMessage({ author: 'Erreur', avatar: '', content: 'Choisis un salon dans Réglages avant d’envoyer un message.' });
    return;
  }

  const sendButton = composer.querySelector('button[type="submit"]');
  if (sendButton) sendButton.disabled = true;
  try {
    await window.api.sendMessage({
      channelId: currentChannelId,
      content,
      replyToMessageId: replyTarget?.messageId || null,
    });

    messageInput.value = '';
    renderMessage({ author: 'Toi', avatar: '', content });
    if (messagesEl.lastElementChild && messagesEl.lastElementChild.querySelector('img')) {
      messagesEl.lastElementChild.querySelector('img').remove();
    }
    replyTarget = null;
    updateReplyIndicator();
  } catch (err) {
    renderMessage({ author: 'Erreur', avatar: '', content: err.message });
    messageInput.focus();
  } finally {
    if (sendButton) sendButton.disabled = false;
  }
});

// ---------- Réglages ----------

function createOption(label, value) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

async function loadSettings() {
  const [config, guilds] = await Promise.all([window.api.getConfig(), window.api.getGuilds()]);

  const guildSelect = document.getElementById('guild-select');
  guildSelect.replaceChildren(...guilds.map((guild) => createOption(guild.name, guild.id)));
  if (config.guildId) guildSelect.value = config.guildId;

  const channelSelect = document.getElementById('channel-select');
  const welcomeChannelSelect = document.getElementById('welcome-channel-select');
  const welcomeEnabled = document.getElementById('welcome-enabled');
  const welcomeMessage = document.getElementById('welcome-message');
  const saveButton = document.getElementById('save-settings-btn');
  const modeNote = document.getElementById('settings-mode-note');
  if (config.readOnly) {
    channelSelect.replaceChildren(createOption('Les salons ne sont pas synchronisés', ''));
    welcomeChannelSelect.replaceChildren(createOption('Les salons ne sont pas synchronisés', ''));
    channelSelect.disabled = true;
    welcomeChannelSelect.disabled = true;
    welcomeEnabled.disabled = true;
    welcomeMessage.disabled = true;
    saveButton.disabled = true;
    modeNote.hidden = false;
    modeNote.textContent = 'Le bot est hébergé séparément : le serveur est affiché, mais ses réglages ne sont pas modifiables depuis ce site.';
    return;
  }

  channelSelect.disabled = false;
  welcomeChannelSelect.disabled = false;
  welcomeEnabled.disabled = false;
  welcomeMessage.disabled = false;
  saveButton.disabled = false;
  modeNote.hidden = true;
  await populateChannels(guildSelect.value);
  if (config.channelId) channelSelect.value = config.channelId;
  if (config.welcomeChannelId) welcomeChannelSelect.value = config.welcomeChannelId;
  welcomeEnabled.checked = Boolean(config.welcomeEnabled);
  welcomeMessage.value = config.welcomeMessage || 'Bienvenue {user} sur {server} ! 🎉';

  guildSelect.onchange = () => populateChannels(guildSelect.value);
}

async function populateChannels(guildId) {
  const channels = guildId ? await window.api.getChannels(guildId) : [];
  const channelSelect = document.getElementById('channel-select');
  const welcomeChannelSelect = document.getElementById('welcome-channel-select');
  const previousWelcomeChannelId = welcomeChannelSelect.value;
  channelSelect.replaceChildren(...channels.map((channel) => createOption(`#${channel.name}`, channel.id)));
  welcomeChannelSelect.replaceChildren(
    createOption('Choisir un salon', ''),
    ...channels.map((channel) => createOption(`#${channel.name}`, channel.id))
  );
  if (channels.some((channel) => channel.id === previousWelcomeChannelId)) {
    welcomeChannelSelect.value = previousWelcomeChannelId;
  }
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const guildId = document.getElementById('guild-select').value;
  const channelId = document.getElementById('channel-select').value;
  const settingsLog = document.getElementById('settings-log');
  try {
    const config = await window.api.saveConfig({
      guildId,
      channelId,
      welcomeEnabled: document.getElementById('welcome-enabled').checked,
      welcomeChannelId: document.getElementById('welcome-channel-select').value,
      welcomeMessage: document.getElementById('welcome-message').value,
    });
    currentChannelId = config.channelId;
    if (mentionMembersGuildId !== guildId) {
      mentionMembersGuildId = null;
      mentionMembersPromise = null;
      allMembers = [];
    }
    closeMentionSuggestions();

    const channelName = document.getElementById('channel-select').selectedOptions[0]?.textContent || '';
    document.getElementById('chat-target-label').textContent = `Connecté à ${channelName}`;
    settingsLog.textContent = 'Réglages enregistrés ✅';
  } catch (err) {
    settingsLog.textContent = `Erreur : ${err.message}`;
    return;
  }
  setTimeout(() => (settingsLog.textContent = ''), 2500);
});

// ---------- Logs / accès rapide ----------

async function loadLogs() {
  const config = await window.api.getConfig();
  if (config.guildId) {
    const stats = await window.api.getStats(config.guildId).catch(() => null);
    if (stats) {
      document.getElementById('log-members').textContent = stats.totalMembers || 0;
      document.getElementById('log-online').textContent = stats.onlineMembers || 0;
      document.getElementById('log-channels').textContent = stats.channelCount || 0;
      document.getElementById('log-bots').textContent = Math.max(0, Number(stats.totalMembers || 0) - 1);
    }
  }

  [activityEntries, panelUsageEntries] = await Promise.all([
    window.api.getActivityLogs(),
    window.api.getPanelUsageLogs(),
  ]);
  renderActivityLogs();
  renderPanelUsageLogs();
}

function renderPanelUsageLogs() {
  const container = document.getElementById('panel-usage-list');
  if (!container) return;

  if (!panelUsageEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Aucune connexion ou action enregistrée pour le moment.';
    container.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  panelUsageEntries.forEach((entry) => {
    const row = document.createElement('article');
    row.className = `activity-entry panel-usage-entry ${entry.status === 'error' ? 'error' : 'success'}`;

    const mark = document.createElement('span');
    mark.className = 'activity-entry-mark';
    mark.textContent = entry.status === 'error' ? '×' : '●';
    row.appendChild(mark);

    const content = document.createElement('div');
    content.className = 'activity-entry-content';
    const actor = document.createElement('strong');
    actor.className = 'panel-usage-actor';
    actor.textContent = entry.username || 'Utilisateur Discord';
    content.appendChild(actor);

    const userId = document.createElement('small');
    userId.textContent = `ID Discord : ${entry.userId}`;
    content.appendChild(userId);

    const action = document.createElement('span');
    action.textContent = entry.action;
    content.appendChild(action);
    if (entry.status === 'error') {
      const result = document.createElement('small');
      result.className = 'panel-usage-result error';
      result.textContent = 'Action échouée';
      content.appendChild(result);
    }
    row.appendChild(content);

    const time = document.createElement('time');
    time.dateTime = entry.timestamp;
    const timestamp = new Date(entry.timestamp);
    time.textContent = Number.isNaN(timestamp.getTime())
      ? ''
      : timestamp.toLocaleString('fr-FR');
    row.appendChild(time);
    fragment.appendChild(row);
  });
  container.replaceChildren(fragment);
}

function renderActivityLogs() {
  const container = document.getElementById('activity-list');
  if (!container) return;

  if (!activityEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Aucune activité enregistrée pour le moment.';
    container.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  activityEntries.forEach((entry) => {
    const row = document.createElement('article');
    row.className = `activity-entry ${entry.type || 'info'}`;

    const mark = document.createElement('span');
    mark.className = 'activity-entry-mark';
    mark.textContent = entry.type === 'success'
      ? '●'
      : entry.type === 'warning'
        ? '!'
        : entry.type === 'error'
          ? '×'
          : '•';
    row.appendChild(mark);

    const content = document.createElement('div');
    content.className = 'activity-entry-content';
    const message = document.createElement('span');
    message.textContent = entry.message;
    content.appendChild(message);
    if (entry.details?.guildId) {
      const guildId = document.createElement('small');
      guildId.textContent = `Serveur : ${entry.details.guildId}`;
      content.appendChild(guildId);
    }
    row.appendChild(content);

    const time = document.createElement('time');
    time.dateTime = entry.timestamp;
    const timestamp = new Date(entry.timestamp);
    time.textContent = Number.isNaN(timestamp.getTime())
      ? ''
      : timestamp.toLocaleString('fr-FR');
    row.appendChild(time);
    fragment.appendChild(row);
  });

  container.replaceChildren(fragment);
}

window.api.onActivityLog((entry) => {
  activityEntries = [entry, ...activityEntries.filter((item) => item.id !== entry.id)].slice(0, 200);
  renderActivityLogs();
  if (
    entry.details?.guildId
    && document.getElementById('view-servers').classList.contains('active')
  ) {
    loadServerManagement();
  }
});

window.api.onPanelUsageLog((entry) => {
  panelUsageEntries = [entry, ...panelUsageEntries.filter((item) => item.id !== entry.id)].slice(0, 500);
  renderPanelUsageLogs();
});

function renderServerManagement() {
  const status = document.getElementById('server-protection-status');
  const protectedName = document.getElementById('protected-server-name');
  const list = document.getElementById('managed-server-list');
  const leaveButton = document.getElementById('leave-other-servers-btn');
  if (!status || !protectedName || !list || !leaveButton) return;

  const overview = serverOverview;
  const allowedGuild = overview?.guilds.find((guild) => guild.allowed);
  protectedName.textContent = allowedGuild?.name || 'Serveur introuvable';
  status.textContent = !overview?.connected
    ? 'Bot hors ligne : connecte-le pour gérer ses serveurs.'
    : !overview.canManage
      ? `${overview.guilds.length} serveur(s) du bot. Affichage en lecture seule.`
    : allowedGuild
      ? `${overview.guilds.length} serveur(s) accessible(s) au bot.`
      : `Le bot ne voit pas le serveur à conserver (${overview?.allowedGuildId || 'ID inconnu'}). Aucun nettoyage ne sera effectué.`;

  list.replaceChildren();
  const guilds = overview?.guilds || [];
  const otherGuilds = guilds.filter((guild) => !guild.allowed);
  if (!guilds.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Aucun serveur visible. Vérifie la connexion du bot.';
    list.appendChild(empty);
  } else if (!otherGuilds.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Aucun autre serveur : le bot ne se trouve que sur le serveur autorisé.';
    list.appendChild(empty);
  } else {
    guilds.forEach((guild) => {
      const row = document.createElement('div');
      row.className = `managed-server-row${guild.allowed ? ' allowed' : ''}`;
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = guild.name;
      const id = document.createElement('code');
      id.className = 'managed-server-id';
      id.textContent = guild.id;
      identity.append(name, id);
      row.appendChild(identity);

      const label = document.createElement('small');
      label.textContent = guild.allowed ? 'À conserver' : `${guild.memberCount || 0} membres`;
      row.appendChild(label);
      list.appendChild(row);
    });
  }

  leaveButton.disabled = isLeavingOtherServers
    || !overview?.connected
    || !overview?.canManage
    || !allowedGuild
    || !otherGuilds.length;
}

async function loadServerManagement() {
  const status = document.getElementById('server-protection-status');
  status.textContent = 'Actualisation des serveurs…';
  try {
    serverOverview = await window.api.getServerOverview();
    renderServerManagement();
  } catch (error) {
    status.textContent = `Impossible de charger les serveurs : ${error.message}`;
  }
}

document.getElementById('refresh-servers-btn').addEventListener('click', loadServerManagement);
document.getElementById('leave-other-servers-btn').addEventListener('click', async () => {
  if (isLeavingOtherServers) return;
  const others = serverOverview?.guilds.filter((guild) => !guild.allowed) || [];
  if (!others.length) {
    renderServerManagement();
    return;
  }

  const serverNames = others.slice(0, 8).map((guild) => `• ${guild.name}`).join('\n');
  const moreServers = others.length > 8 ? `\n• et ${others.length - 8} autre(s)` : '';
  const confirmed = window.confirm(
    `Le bot va quitter ${others.length} serveur(s), et ne pourra plus y revenir sans nouvelle invitation.\n\n`
    + `${serverNames}${moreServers}\n\nContinuer ?`
  );
  if (!confirmed) return;

  isLeavingOtherServers = true;
  const actionStatus = document.getElementById('server-action-status');
  actionStatus.textContent = 'Le bot quitte les autres serveurs…';
  renderServerManagement();
  try {
    const result = await window.api.leaveOtherServers();
    actionStatus.textContent = result.failedCount
      ? `Terminé : ${result.leftCount} quitté(s), ${result.failedCount} échec(s). Consulte les Logs.`
      : `Terminé : ${result.leftCount} serveur(s) quitté(s). Consulte les Logs.`;
    await loadServerManagement();
  } catch (error) {
    actionStatus.textContent = `Erreur : ${error.message}`;
  } finally {
    isLeavingOtherServers = false;
    renderServerManagement();
  }
});

document.getElementById('announce-quick-btn')?.addEventListener('click', () => {
  document.querySelector('.nav-item[data-view="moderation"]').click();
  setTimeout(() => {
    document.getElementById('announce-title')?.focus();
  }, 100);
});

document.querySelectorAll('.quick-link').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const navBtn = document.querySelector(`.nav-item[data-view="${target}"]`);
    navBtn?.click();
  });
});

// ---------- Modération ----------

function renderMemberList(members) {
  const select = document.getElementById('member-select');
  const query = memberSearch.value.trim().toLowerCase();
  const filteredMembers = !query
    ? members
    : members.filter((member) => {
        const label = `${member.nickname || member.tag || ''} ${member.username || ''} ${member.tag || ''} ${member.id || ''}`.toLowerCase();
        return label.includes(query);
      });

  if (!filteredMembers.length) {
    select.innerHTML = '<option value="">Aucun membre trouvé</option>';
    return;
  }

  select.innerHTML = filteredMembers
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.nickname || m.tag)} — ${escapeHtml(m.id)}${m.isBot ? ' • BOT' : ''}</option>`)
    .join('');
}

async function loadMembers() {
  const config = await window.api.getConfig();
  if (!config.guildId) return;
  const members = await window.api.getMembers(config.guildId);
  allMembers = members;
  renderMemberList(members);
}

function renderMemberDirectory(members) {
  const container = document.getElementById('members-list');
  const query = (document.getElementById('member-directory-search')?.value || '').trim().toLowerCase();
  const filtered = !query
    ? members
    : members.filter((member) => {
        const labels = `${member.username || ''} ${member.tag || ''} ${member.nickname || ''} ${member.id || ''}`.toLowerCase();
        return labels.includes(query);
      });

  container.innerHTML = filtered.length
    ? filtered
        .map(
          (member) => `
            <div class="member-row">
              <div>
                <strong>${escapeHtml(member.nickname || member.username || member.tag)}</strong>
                <small>${escapeHtml(member.tag || member.username || 'Membre')}</small>
              </div>
              <span>${escapeHtml(member.id)}</span>
            </div>
          `
        )
        .join('')
    : '<p class="empty-hint">Aucun membre trouvé.</p>';
}

async function loadMemberDirectory() {
  const config = await window.api.getConfig();
  if (!config.guildId) return;
  const members = await window.api.getMembers(config.guildId);
  renderMemberDirectory(members);
}

memberSearch.addEventListener('input', () => {
  renderMemberList(allMembers);
});

document.getElementById('member-directory-search')?.addEventListener('input', async () => {
  const config = await window.api.getConfig();
  if (!config.guildId) return;
  const members = await window.api.getMembers(config.guildId);
  renderMemberDirectory(members);
});

async function loadBots() {
  const config = await window.api.getConfig();
  if (!config.guildId) return;

  const bots = await window.api.getBots(config.guildId);
  allBots = bots;

  const container = document.getElementById('bots-list');
  const query = (botSearch?.value || '').trim().toLowerCase();
  const filtered = !query
    ? bots
    : bots.filter((bot) => `${bot.username} ${bot.tag}`.toLowerCase().includes(query));

  container.innerHTML = filtered.length
    ? filtered
        .map(
          (bot) => `
            <button class="bot-row ${selectedBotId === bot.id ? 'active' : ''}" data-bot-id="${escapeHtml(bot.id)}">
              <span>${escapeHtml(bot.username)}</span>
              <small>${escapeHtml(bot.id)}</small>
            </button>
          `
        )
        .join('')
    : '<p class="empty-hint">Aucun bot trouvé.</p>';

  container.querySelectorAll('.bot-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedBotId = btn.dataset.botId;
      loadBots();
      const filteredMessages = selectedBotId
        ? botMessageBuffer.filter((item) => item.authorId === selectedBotId)
        : botMessageBuffer;
      renderBotFeed(filteredMessages);
    });
  });
}

if (botSearch) {
  botSearch.addEventListener('input', () => loadBots());
}

document.getElementById('announce-btn').addEventListener('click', async () => {
  const config = await window.api.getConfig();
  const title = document.getElementById('announce-title').value.trim();
  const description = document.getElementById('announce-body').value.trim();
  if (!title || !description || !config.channelId) return;
  try {
    await window.api.sendAnnouncement({ channelId: config.channelId, title, description });
    document.getElementById('mod-log').textContent = 'Annonce publiée ✅';
    document.getElementById('announce-title').value = '';
    document.getElementById('announce-body').value = '';
  } catch (err) {
    document.getElementById('mod-log').textContent = `Erreur : ${err.message}`;
  }
});

document.getElementById('warn-btn').addEventListener('click', () => modAction('warnMember'));
document.getElementById('mute-5m-btn').addEventListener('click', () => modAction('timeoutMember', 5));
document.getElementById('mute-1h-btn').addEventListener('click', () => modAction('timeoutMember', 60));
document.getElementById('kick-btn').addEventListener('click', () => modAction('kickMember'));
document.getElementById('ban-btn').addEventListener('click', () => modAction('banMember'));

async function modAction(method, durationMinutes = null) {
  const config = await window.api.getConfig();
  const userId = document.getElementById('member-select').value;
  const reason = document.getElementById('action-reason').value.trim();
  if (!userId || !config.guildId) return;

  const selectedMember = allMembers.find((member) => member.id === userId);
  if (selectedMember?.isBot) {
    document.getElementById('mod-log').textContent = 'Tu ne peux pas modérer un bot depuis cette liste.';
    return;
  }

  try {
    const payload = { guildId: config.guildId, userId, reason: reason || 'Aucune raison fournie' };
    if (method === 'timeoutMember') {
      payload.durationMinutes = durationMinutes;
    }

    await window.api[method](payload);

    const label = method === 'warnMember'
      ? 'Avertissement envoyé ✅'
      : method === 'timeoutMember'
        ? `Mute ${durationMinutes} min ✅`
        : 'Action effectuée ✅';

    document.getElementById('mod-log').textContent = label;
    loadMembers();
  } catch (err) {
    document.getElementById('mod-log').textContent = `Erreur : ${err.message}`;
  }
}

// ---------- Stats ----------

async function loadStats() {
  const config = await window.api.getConfig();
  if (!config.guildId) return;
  const stats = await window.api.getStats(config.guildId);
  document.getElementById('stats-guild-name').textContent = stats.guildName;
  document.getElementById('stat-members').textContent = stats.totalMembers;
  document.getElementById('stat-online').textContent = stats.onlineMembers;
  document.getElementById('stat-channels').textContent = stats.channelCount;
  document.getElementById('stat-boosts').textContent = stats.boostCount;
}

document.getElementById('refresh-stats').addEventListener('click', loadStats);

async function loadVoiceChannels() {
  const config = await window.api.getConfig();
  const select = document.getElementById('voice-channel-select');
  if (!config.guildId || !select) return;

  const channels = await window.api.getVoiceChannels(config.guildId).catch(() => []);
  select.innerHTML = channels.length
    ? channels.map((channel) => `<option value="${escapeHtml(channel.id)}">#${escapeHtml(channel.name)}</option>`).join('')
    : '<option value="">Aucun salon vocal</option>';
}

document.getElementById('join-voice-btn')?.addEventListener('click', async () => {
  const config = await window.api.getConfig();
  const channelId = document.getElementById('voice-channel-select').value;
  if (!config.guildId || !channelId) return;

  try {
    const result = await window.api.joinVoice({ guildId: config.guildId, channelId });
    document.getElementById('voice-status-label').textContent = `Connecté dans #${result.channelName}`;
  } catch (err) {
    document.getElementById('voice-status-label').textContent = `Erreur : ${err.message}`;
  }
});

document.getElementById('leave-voice-btn')?.addEventListener('click', async () => {
  const config = await window.api.getConfig();
  if (!config.guildId) return;

  try {
    await window.api.leaveVoice(config.guildId);
    document.getElementById('voice-status-label').textContent = 'Déconnecté du salon vocal.';
  } catch (err) {
    document.getElementById('voice-status-label').textContent = `Erreur : ${err.message}`;
  }
});

document.getElementById('set-status-btn')?.addEventListener('click', async () => {
  const value = document.getElementById('bot-status-text').value.trim();
  if (!value) return;

  try {
    await window.api.setBotStatus(value);
    document.getElementById('bot-status-text').value = '';
  } catch (err) {
    document.getElementById('voice-status-label').textContent = `Erreur statut : ${err.message}`;
  }
});

document.getElementById('play-music-btn')?.addEventListener('click', async () => {
  const config = await window.api.getConfig();
  const query = document.getElementById('music-query').value.trim();
  const voiceChannel = document.getElementById('voice-channel-select').value;
  if (!config.guildId || !query) return;

  try {
    await window.api.playMusic({
      guildId: config.guildId,
      channelId: voiceChannel || null,
      query,
    });
    document.getElementById('music-query').value = '';
  } catch (err) {
    document.getElementById('music-status-label').textContent = `Erreur musique : ${err.message}`;
  }
});

document.getElementById('pause-music-btn')?.addEventListener('click', async () => {
  const config = await window.api.getConfig();
  if (!config.guildId) return;
  try {
    await window.api.pauseMusic(config.guildId);
  } catch (err) {
    document.getElementById('music-status-label').textContent = `Erreur : ${err.message}`;
  }
});

document.getElementById('resume-music-btn')?.addEventListener('click', async () => {
  const config = await window.api.getConfig();
  if (!config.guildId) return;
  try {
    await window.api.resumeMusic(config.guildId);
  } catch (err) {
    document.getElementById('music-status-label').textContent = `Erreur : ${err.message}`;
  }
});

document.getElementById('stop-music-btn')?.addEventListener('click', async () => {
  const config = await window.api.getConfig();
  if (!config.guildId) return;
  try {
    await window.api.stopMusic(config.guildId);
  } catch (err) {
    document.getElementById('music-status-label').textContent = `Erreur : ${err.message}`;
  }
});

// ---------- Démarrage ----------

(async function init() {
  const config = await window.api.getConfig();
  currentChannelId = config.channelId || null;
  if (currentChannelId) {
    document.getElementById('chat-target-label').textContent = 'Salon connecté ✅';
  } else {
    messagesEl.innerHTML = '<p class="empty-hint">Va dans Réglages pour choisir un serveur et un salon.</p>';
  }

  loadVoiceChannels();
})();
