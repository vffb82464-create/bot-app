# Panel Bot — appli de bureau connectée à ton bot Discord

Une appli Electron qui utilise le token de ton bot pour :
- discuter dans l'appli (les messages sont envoyés dans le salon Discord choisi, et les messages du salon apparaissent dans l'appli)
- choisir/changer le serveur et le salon cible
- publier des annonces, kick/ban un membre
- accueillir automatiquement les nouveaux membres avec un message personnalisable
- afficher des statistiques du serveur (membres, en ligne, salons, boosts)
- envoyer un message en une commande depuis le terminal (`npm run send`)

## 1. Récupérer ton token de bot

Si tu n'as pas encore configuré les permissions nécessaires :
1. Va sur https://discord.com/developers/applications → ton application → **Bot**.
2. Active les intents **SERVER MEMBERS INTENT** et **MESSAGE CONTENT INTENT** (obligatoires pour lire les messages et les membres). Active aussi **PRESENCE INTENT** pour afficher les statistiques des membres en ligne.
3. Copie le token (bouton **Reset Token** si besoin).
4. Vérifie que le bot est bien invité sur ton serveur avec les permissions : Lire/Envoyer les messages, Gérer les membres (pour kick/ban), Voir les salons.

## 2. Installation

```bash
cd discord-bot-app
npm install
cp .env.example .env
```

Ouvre `.env` et colle ton token :
```
DISCORD_TOKEN=le_vrai_token_de_ton_bot
GIPHY_API_KEY=ta_cle_api_giphy
```

Pour obtenir `GIPHY_API_KEY`, crée une application dans le portail développeur GIPHY : https://developers.giphy.com/dashboard/. Dans l’onglet **Chat**, clique sur **GIF**, saisis un mot-clé, puis clique sur **Envoyer** sous le GIF choisi. L’image sera publiée dans le salon cible configuré. Garde cette clé dans `.env`, jamais dans le code.

## 3. Lancer l'appli

```bash
npm start
```

Au premier lancement, va dans **Réglages** pour choisir le serveur et le salon que le bot doit utiliser. Une fois enregistré, l'onglet **Chat** s'active automatiquement sur ce salon.

Dans le chat, tape `@` puis quelques lettres pour rechercher un membre du serveur. Choisis-le dans la liste avec la souris ou les flèches du clavier et Entrée : sa mention Discord est insérée dans le message.

La catégorie **Serveurs** affiche les serveurs où le bot se trouve. Le bouton **Quitter tous les autres serveurs** affiche une confirmation, puis retire le bot de tous les serveurs sauf `1508431497433190420`. Si le serveur à conserver n’est pas trouvé, aucun serveur ne sera quitté. Une nouvelle invitation sur un autre serveur sera aussi refusée automatiquement.

La catégorie **Logs** conserve dans l’application les connexions, les départs de serveurs, les messages/annonces et les actions de modération. Les 200 entrées les plus récentes sont gardées dans les données locales de l’application.

Dans **Réglages > Accueil automatique**, active la fonctionnalité, choisis le salon et personnalise le message. Tu peux utiliser `{user}` pour mentionner le nouveau membre, `{username}` pour son pseudo, `{server}` pour le nom du serveur et `{count}` pour le nombre de membres.

## 4. Installer sur Mac (Intel et Apple Silicon)

Pour créer les installateurs, utilise un Mac avec Node.js 18 ou plus récent :

```bash
npm install
npm run dist:mac
```

Les fichiers `.dmg` et `.zip` sont créés dans `dist/`, en versions Intel (`x64`) et Apple Silicon (`arm64`). Ouvre le `.dmg`, puis glisse **Discord Bot App** dans **Applications**. La première ouverture peut demander une confirmation dans **Réglages Système > Confidentialité et sécurité**, car l'application n'est pas signée ni notariée.

La version Mac minimale visée est macOS Catalina 10.15 sur Intel. Sur Apple Silicon, macOS 11 Big Sur ou plus récent est nécessaire. Les versions antérieures à ces limites ne sont pas prises en charge par Electron. Attention : Electron 32 est conservé pour cette compatibilité avec Catalina, mais ne reçoit plus de correctifs de sécurité. Pour un bot sensible, préfère une version récente de macOS et d'Electron.

Après installation, renseigne le token Discord et la clé GIPHY dans le fichier `.env` situé dans `~/Library/Application Support/Discord Bot App/`. L'application crée ce fichier au premier lancement. Si tu avais déjà installé l'application, remplace l'ancienne ligne `TENOR_API_KEY` par `GIPHY_API_KEY=ta_cle_api_giphy`. Les réglages, avertissements et logs d’activité sont également enregistrés dans ce dossier, afin qu'ils restent accessibles en écriture dans l'application installée. Ne mets jamais de vrai token dans le projet avant de créer les installateurs. Avec npm 11, si l'installation bloque les scripts d'Electron ou de ffmpeg, approuve uniquement ceux-ci puis relance l'installation :

```bash
npm approve-scripts electron ffmpeg-static
npm install
```

## 5. Mettre le panel en ligne sur Render

1. Publie le dossier du projet sur un dépôt GitHub **sans `.env`, token, secret ni fichier `config.json`**.
2. Dans [Discord Developer Portal](https://discord.com/developers/applications), ouvre la même application que le bot. Dans **OAuth2 > General**, ajoute l’URI de redirection fournie par Render sous la forme `https://TON-SERVICE.onrender.com/auth/callback`. Active **SERVER MEMBERS INTENT** et **MESSAGE CONTENT INTENT** dans **Bot**; active aussi **PRESENCE INTENT** pour afficher le nombre de membres en ligne.
3. Sur Render, choisis **New > Blueprint**, connecte le dépôt et déploie `render.yaml`. Le service demande les valeurs secrètes manquantes.
4. Dans **Environment** sur Render, renseigne `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` et `DISCORD_REDIRECT_URI` (l’URL exacte ajoutée au portail Discord). Garde la valeur générée de `SESSION_SECRET`. Pour afficher les serveurs d’un bot déjà hébergé ailleurs, le Blueprint utilise `BOT_SYNC_ONLY=true` et demande `BOT_SYNC_SECRET`.
5. Attends le déploiement, ouvre l’adresse Render du service, puis connecte-toi avec le compte Discord auquel appartient le rôle `1540132253097664572` dans le serveur `1508431497433190420`.

Le site refuse les comptes sans ce rôle et revérifie le rôle périodiquement ainsi qu’avant les actions. Le bot doit être membre du serveur autorisé et y disposer des permissions correspondant aux fonctions utilisées. Les clés restent dans **Environment** sur Render, jamais dans GitHub. Le service gratuit n’offre pas de disque persistant : ses journaux locaux peuvent être effacés lorsque Render redémarre ou redéploie le service. Pour conserver les journaux, configure un disque persistant Render et `DATA_DIR=/var/data`.

### Bot déjà hébergé ailleurs : affichage des serveurs en lecture seule

Le site Render ne doit pas démarrer une seconde connexion avec le token du bot. Crée une valeur secrète aléatoire d’au moins 32 caractères et ajoute-la sous `BOT_SYNC_SECRET` dans **Environment** sur Render et dans l’environnement du bot hébergé. Garde la même valeur privée des deux côtés. Dans le `index.js` du bot, ajoute après la création de `client` ce relais HTTPS :

```js
const PANEL_SYNC_URL = 'https://panel-bot-discord.onrender.com/api/bot-sync';

async function syncPanelGuilds() {
  const secret = process.env.BOT_SYNC_SECRET;
  if (!secret) {
    console.error('BOT_SYNC_SECRET manque : les serveurs ne seront pas envoyés au panel.');
    return;
  }

  try {
    const response = await fetch(PANEL_SYNC_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connected: client.isReady(),
        guilds: client.guilds.cache.map((guild) => ({
          id: guild.id,
          name: guild.name,
          memberCount: guild.memberCount,
        })),
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error('Envoi de la liste des serveurs au panel impossible :', error.message);
  }
}

client.on(Events.GuildCreate, () => { void syncPanelGuilds(); });
client.on(Events.GuildDelete, () => { void syncPanelGuilds(); });
```

Dans le gestionnaire `client.once(Events.ClientReady, ...)`, ajoute à la fin :

```js
await syncPanelGuilds();
setInterval(() => { void syncPanelGuilds(); }, 60_000).unref();
```

Redémarre ensuite le bot. L’onglet **Serveurs** affichera la liste actualisée en lecture seule; les commandes de gestion nécessitent que le panel soit relié au processus du bot.

## 6. Envoyer un message depuis le terminal

Sans ouvrir l'appli, une fois le salon configuré une première fois :

```bash
npm run send -- "Salut tout le monde !"
```

Tu peux aussi préciser un autre salon en 2e argument :

```bash
npm run send -- "Message pour un autre salon" 123456789012345678
```

## 7. Structure du projet

```
discord-bot-app/
├── main.js         → process principal Electron + client discord.js (le "bot")
├── preload.js       → pont sécurisé entre l'interface et le bot
├── web-server.js    → serveur web, OAuth Discord et vérification du rôle requis
├── web-bridge.js    → pont sécurisé entre l'interface et les routes web
├── render.yaml      → configuration de déploiement Render
├── send.js          → script CLI pour "npm run send"
├── web-server.js    → serveur web, OAuth Discord et vérification du rôle
├── web-bridge.js    → pont entre l'interface et les API du site
├── render.yaml      → configuration de déploiement Render
├── index.html        → interface (Chat / Modération / Stats / Réglages)
├── style.css
├── renderer.js       → logique de l'interface
├── config.json       → serveur/salon sélectionnés
└── .env               → token (jamais à partager ; dossier utilisateur pour l'app installée)
```

## Aller plus loin

Des idées faciles à ajouter ensuite si tu veux : notifications de bureau à chaque nouveau message, plusieurs salons suivis en même temps, historique des messages sauvegardé, rôles/permissions par utilisateur de l'appli, thèmes clair/sombre.

⚠️ Ne partage jamais ton fichier `.env` ni ton token : quiconque le possède peut contrôler ton bot.
