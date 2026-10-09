(() => {
  if (window.api) return;

  const callbacks = new Map();
  let csrfToken = '';
  let sessionPromise = null;
  let eventSource = null;

  function startEventSource() {
    if (eventSource) return;
    eventSource = new EventSource('/api/events');
    for (const eventName of [
      'bot-status',
      'voice-status',
      'music-status',
      'new-message',
      'bot-message',
      'activity-log',
    ]) {
      eventSource.addEventListener(eventName, (event) => {
        const data = JSON.parse(event.data);
        for (const callback of callbacks.get(eventName) || []) callback(data);
      });
    }
  }

  async function getSession() {
    if (!sessionPromise) {
      sessionPromise = fetch('/api/session', { credentials: 'same-origin' })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Session Discord expirée.');
          csrfToken = data.csrfToken;
          const userName = document.getElementById('session-user-name');
          const avatar = document.getElementById('session-user-avatar');
          if (userName) userName.textContent = data.user.username;
          if (avatar && data.user.avatar) {
            avatar.src = `https://cdn.discordapp.com/avatars/${data.user.id}/${data.user.avatar}.png?size=64`;
            avatar.hidden = false;
          }
          startEventSource();
          return data;
        })
        .catch((error) => {
          sessionPromise = null;
          throw error;
        });
    }
    return sessionPromise;
  }

  async function command(name, ...args) {
    await getSession();
    const response = await fetch('/api/command', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ name, args }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      window.location.assign('/login?denied=role');
    }
    if (!response.ok) throw new Error(payload.error || 'La commande a échoué.');
    return payload.result;
  }

  function subscribe(eventName, callback) {
    const subscribers = callbacks.get(eventName) || new Set();
    subscribers.add(callback);
    callbacks.set(eventName, subscribers);
    return () => subscribers.delete(callback);
  }

  window.api = {
    getConfig: () => command('getConfig'),
    saveConfig: (config) => command('saveConfig', config),
    getGuilds: () => command('getGuilds'),
    getChannels: (guildId) => command('getChannels', guildId),
    getVoiceChannels: (guildId) => command('getVoiceChannels', guildId),
    getMembers: (guildId) => command('getMembers', guildId),
    getBots: (guildId) => command('getBots', guildId),
    sendMessage: (data) => command('sendMessage', data),
    searchGifs: (query) => command('searchGifs', query),
    sendGif: (data) => command('sendGif', data),
    sendAnnouncement: (data) => command('sendAnnouncement', data),
    kickMember: (data) => command('kickMember', data),
    banMember: (data) => command('banMember', data),
    timeoutMember: (data) => command('timeoutMember', data),
    warnMember: (data) => command('warnMember', data),
    joinVoice: (data) => command('joinVoice', data),
    leaveVoice: (guildId) => command('leaveVoice', guildId),
    disconnectVoice: (guildId) => command('disconnectVoice', guildId),
    playMusic: (data) => command('playMusic', data),
    stopMusic: (guildId) => command('stopMusic', guildId),
    pauseMusic: (guildId) => command('pauseMusic', guildId),
    resumeMusic: (guildId) => command('resumeMusic', guildId),
    setBotStatus: (text) => command('setBotStatus', text),
    getStats: (guildId) => command('getStats', guildId),
    getServerOverview: () => command('getServerOverview'),
    leaveOtherServers: () => command('leaveOtherServers'),
    getActivityLogs: () => command('getActivityLogs'),
    onBotStatus: (callback) => subscribe('bot-status', callback),
    onVoiceStatus: (callback) => subscribe('voice-status', callback),
    onMusicStatus: (callback) => subscribe('music-status', callback),
    onNewMessage: (callback) => subscribe('new-message', callback),
    onBotMessage: (callback) => subscribe('bot-message', callback),
    onActivityLog: (callback) => subscribe('activity-log', callback),
  };

  getSession().catch((error) => console.error('Discord session setup failed:', error));
})();
