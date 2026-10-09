// Utilisation :
//   npm run send -- "Ton message ici"
//   npm run send -- "Ton message" 123456789012345678   (channelId optionnel)
//
// Si aucun channelId n'est passé, celui enregistré dans config.json est utilisé.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { guildId: '', channelId: '' };
  }
}

const args = process.argv.slice(2);
const message = args[0];
const channelIdArg = args[1];

if (!message) {
  console.error('❌ Il manque le message. Exemple : npm run send -- "Salut tout le monde !"');
  process.exit(1);
}

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN manquant. Copie .env.example en .env et renseigne ton token.');
  process.exit(1);
}

const config = loadConfig();
const channelId = channelIdArg || config.channelId;

if (!channelId) {
  console.error('❌ Aucun salon défini. Lance l\'appli une fois pour en choisir un, ou passe un channelId en 2e argument.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once('ready', async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(message);
    console.log(`✅ Message envoyé dans #${channel.name || channelId}`);
  } catch (err) {
    console.error('❌ Erreur lors de l\'envoi :', err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
