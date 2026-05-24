require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { channels: [], adminRoleId: null, embedsEnabled: false };
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();

//Auth

function isAdmin(member) {
  // Server owner always has access
  if (member.guild.ownerId === member.id) return true;
  // If no admin role is set yet, only the server owner can use commands
  if (!config.adminRoleId) return false;
  return member.roles.cache.has(config.adminRoleId);
}

//Scryfall

async function searchScryfall(name, fuzzy = false) {
  const param = fuzzy ? "fuzzy" : "exact";
  const url = `https://api.scryfall.com/cards/named?${param}=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "MTG-Discord-Bot/1.0" },
  });
  if (!res.ok) return null;
  return res.json();
}

function normalizeCardName(name) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/['']/g, "'")
    .replace(/[^\w\s\-']/g, "")
    .trim();
}

function extractCardNames(content) {
  const matches = [];
  const regex = /\[\[(.+?)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1].trim();
    if (name.length > 0) matches.push(name);
  }
  return matches;
}

async function lookupCard(rawName) {
  let card = await searchScryfall(rawName, false);
  if (card) return card;

  const normalized = normalizeCardName(rawName);
  if (normalized !== rawName) {
    card = await searchScryfall(normalized, false);
    if (card) return card;
  }

  card = await searchScryfall(normalized || rawName, true);
  return card || null;
}

//Bot

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📋 Watching ${config.channels.length} channel(s)`);
  console.log(`🖼️  Embeds: ${config.embedsEnabled ? "on" : "off"}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const prefix = "!mtg";

  //Admin commands
  if (message.content.startsWith(prefix)) {
    if (!isAdmin(message.member)) {
      return message.reply("❌ You don't have permission to use MTG bot commands.");
    }

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const sub = args[0]?.toLowerCase();

    // !mtg setrole @role  — set which role can use admin commands
    // Only the server owner can do this
    if (sub === "setrole") {
      if (message.guild.ownerId !== message.member.id) {
        return message.reply("❌ Only the server owner can set the admin role.");
      }
      const role = message.mentions.roles.first();
      if (!role) return message.reply("Usage: `!mtg setrole @role`");
      config.adminRoleId = role.id;
      saveConfig(config);
      return message.reply(`✅ Admin role set to **${role.name}**. Members with this role can now manage the MTG bot.`);
    }

    // !mtg add #channell
    if (sub === "add") {
      const channelId = message.mentions.channels.first()?.id || args[1];
      if (!channelId) return message.reply("Usage: `!mtg add #channel`");
      if (config.channels.includes(channelId)) {
        return message.reply("That channel is already enabled.");
      }
      config.channels.push(channelId);
      saveConfig(config);
      return message.reply(`✅ MTG card lookup enabled in <#${channelId}>`);
    }

    // !mtg remove #channel
    if (sub === "remove") {
      const channelId = message.mentions.channels.first()?.id || args[1];
      if (!channelId) return message.reply("Usage: `!mtg remove #channel`");
      if (!config.channels.includes(channelId)) {
        return message.reply("That channel isn't enabled.");
      }
      config.channels = config.channels.filter((id) => id !== channelId);
      saveConfig(config);
      return message.reply(`✅ MTG card lookup disabled in <#${channelId}>`);
    }

    // !mtg list
    if (sub === "list") {
      const channelList = config.channels.length
        ? config.channels.map((id) => `<#${id}>`).join(", ")
        : "None";
      const adminRole = config.adminRoleId ? `<@&${config.adminRoleId}>` : "Server owner only";
      return message.reply(
        `📋 **MTG Bot Status**\n` +
        `Channels: ${channelList}\n` +
        `Embeds: ${config.embedsEnabled ? "✅ on" : "❌ off"}\n` +
        `Admin role: ${adminRole}`
      );
    }

    // !mtg embeds on|off
    if (sub === "embeds") {
      const toggle = args[1]?.toLowerCase();
      if (toggle !== "on" && toggle !== "off") {
        return message.reply("Usage: `!mtg embeds on` or `!mtg embeds off`");
      }
      config.embedsEnabled = toggle === "on";
      saveConfig(config);
      return message.reply(`✅ Link embeds turned **${toggle}**.`);
    }

    return message.reply(
      "**Commands:**\n" +
      "`!mtg add #channel` — enable lookup in a channel\n" +
      "`!mtg remove #channel` — disable lookup in a channel\n" +
      "`!mtg list` — show current settings\n" +
      "`!mtg embeds on|off` — toggle link previews (off by default)\n" +
      "`!mtg setrole @role` — set admin role (server owner only)"
    );
  }

  //Card lookup
  if (!config.channels.includes(message.channelId)) return;

  const cardNames = extractCardNames(message.content);
  if (cardNames.length === 0) return;

  const uniqueNames = [...new Set(cardNames)];
  const results = [];

  for (const name of uniqueNames) {
    const card = await lookupCard(name);
    if (card?.scryfall_uri) {
      // Wrap in <> to suppress Discord's embed/preview (unless embeds are enabled)
      const url = config.embedsEnabled
        ? card.scryfall_uri
        : `<${card.scryfall_uri}>`;
      results.push(url);
    }
  }

  if (results.length > 0) {
    await message.reply(results.join("\n"));
  }
});

client.login(process.env.DISCORD_TOKEN);