// discordBot.js
// Runs alongside the Express server (same process) if DISCORD_BOT_TOKEN is
// set. Almost everything here is two persistent panels, not commands:
//   - Corex Hosting Panel  (DISCORD_PANEL_CHANNEL_ID) — deploy/manage bots
//   - Corex Admin Panel    (DISCORD_ADMIN_CHANNEL_ID) — accounts, bans,
//     premium, AI site-edit, and the general support buttons
// The only real slash command left is /deploy — Discord simply doesn't
// allow file attachments through buttons or modals, only slash command
// options, so that one has no button-based equivalent.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');
const bm = require('./botManager');
const accountsTracking = require('./accountsTracking');
const premium = require('./premium');

const DATA_DIR = path.join(__dirname, 'data');
const CONTENT_FILE = path.join(DATA_DIR, 'site-content.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'discord-activity.json');
const PANEL_STATE_FILE = path.join(DATA_DIR, 'discord-panels.json');
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// The ONLY fields an AI edit is allowed to touch. Adding more surface here
// should be a deliberate choice, not something a prompt can expand.
const EDITABLE_FIELDS = {
  heroHeading: 'Deploy it. Then watch it.',
  heroSubheading: '24/7 support',
  heroTagline: 'upload ur bots and let it do its magic',
};

function loadContent() {
  try { return { ...EDITABLE_FIELDS, ...JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8')) }; }
  catch (e) { return { ...EDITABLE_FIELDS }; }
}
function saveContent(partial) {
  const current = loadContent();
  const next = { ...current };
  for (const key of Object.keys(partial)) {
    if (Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, key)) next[key] = String(partial[key]);
  }
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(next, null, 2));
  return next;
}

function loadActivity() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); }
  catch (e) { return []; }
}
function logActivity(entry) {
  const log = loadActivity();
  log.unshift({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(log.slice(0, 500), null, 2));
}

function loadPanelState() {
  try { return JSON.parse(fs.readFileSync(PANEL_STATE_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function savePanelState(state) { fs.writeFileSync(PANEL_STATE_FILE, JSON.stringify(state, null, 2)); }

const MODLOG_FILE = path.join(DATA_DIR, 'mod-log.json');
function loadModLog() {
  try { return JSON.parse(fs.readFileSync(MODLOG_FILE, 'utf8')); }
  catch (e) { return []; }
}
function logModAction(entry) {
  const log = loadModLog();
  log.unshift({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(MODLOG_FILE, JSON.stringify(log.slice(0, 1000), null, 2));
}

// Turns "10m", "2h", "1d" into milliseconds. Returns null if it doesn't
// look like a duration at all.
function parseDuration(str) {
  const match = /^(\d+)(s|m|h|d)$/i.exec((str || '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return n * mult;
}

function startDiscordBot() {
  // Trims trailing whitespace/newlines (very common when a token gets pasted
  // into Railway's variable box or a .env line) and strips an accidentally
  // included "Bot " prefix — both produce exactly this "invalid token" error
  // even though the token "looks right" at a glance.
  let TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();
  if (/^bot\s+/i.test(TOKEN)) TOKEN = TOKEN.replace(/^bot\s+/i, '');

  if (!TOKEN) {
    console.log('[corex] DISCORD_BOT_TOKEN not set — Discord bot not started.');
    return;
  }
  if (TOKEN.split('.').length !== 3) {
    console.error(
      '[corex] DISCORD_BOT_TOKEN doesn\'t look like a real bot token (expected 3 dot-separated parts). ' +
      'Double check you copied the token from the "Bot" tab, not the Client Secret or Client ID from ' +
      '"OAuth2". Also confirm this exact value is set in your host\'s env vars (e.g. Railway\'s Variables ' +
      'tab) — your local .env file never reaches a deployed server.'
    );
  }

  const {
    Client, GatewayIntentBits, Events, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    SlashCommandBuilder, REST, Routes, PermissionsBitField,
  } = require('discord.js');

  const OWNER_ID = process.env.DISCORD_OWNER_ID || '';
  const LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID || '';
  // Hardcoded fallback so the panel reliably shows up even if the env var
  // setup is wrong somewhere — still overridable via DISCORD_PANEL_CHANNEL_ID.
  const PANEL_CHANNEL_ID = process.env.DISCORD_PANEL_CHANNEL_ID || '1525250080108445869';
  const ADMIN_CHANNEL_ID = process.env.DISCORD_ADMIN_CHANNEL_ID || '1525250195204603924';
  const SITE_URL = process.env.SITE_URL || 'https://example.com';
  const BRAND_COLOR = 0x8ff0c0;

  if (!PANEL_CHANNEL_ID) {
    console.warn('[corex] DISCORD_PANEL_CHANNEL_ID is not set — the Hosting Panel will not be posted anywhere. Set it to a real channel ID in .env / your host\'s env vars.');
  }
  if (!ADMIN_CHANNEL_ID) {
    console.warn('[corex] Neither DISCORD_ADMIN_CHANNEL_ID nor DISCORD_PANEL_CHANNEL_ID is set — the Admin Panel will not be posted anywhere.');
  }
  if (!OWNER_ID) {
    console.warn('[corex] DISCORD_OWNER_ID is not set — every owner-only button will refuse everyone until this is set.');
  }

  let anthropic = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } catch (e) { console.warn('[corex] @anthropic-ai/sdk not installed — run npm install.'); }
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const pendingEdits = new Map(); // messageId -> proposed content object

  // ---------------------------------------------------------------------
  // HOSTING PANEL
  // ---------------------------------------------------------------------
  function buildHostingPanelEmbed() {
    const bots = bm.loadDb();
    const online = bots.filter(b => bm.getStatus(b.id) === 'online').length;
    const embed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle('Corex Hosting')
      .setDescription(
        `[Help ↗](${SITE_URL})\n\n` +
        '**Your gateway to hosting Discord bots, 24/7.**\n' +
        '**We keep your bot online, restart it if it crashes, and stream its logs straight here.**\n' +
        '**Press the** `My Bots` **button below to deploy, manage, or check on anything you host.**'
      )
      .addFields({
        name: '__Notes__',
        value:
          '**• Get your bot online in under a minute**\n' +
          '**• Automatic restarts if it ever crashes**\n' +
          `**• Currently hosting ${bots.length} bot${bots.length === 1 ? '' : 's'} — ${online} online**\n` +
          '**• Every action below replies privately, only you see it**',
      })
      .setFooter({ text: 'corex hosting' });
    if (client.user) embed.setThumbnail(client.user.displayAvatarURL());
    return embed;
  }
  function buildHostingPanelRows() {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('control_my_bots').setLabel('My Bots').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('control_deploy_info').setLabel('Deploy').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('control_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('control_status').setLabel('Status').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('control_help').setLabel('Help').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setLabel('Open Website').setStyle(ButtonStyle.Link).setURL(SITE_URL),
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('control_feedback').setLabel('Feedback & Suggestions').setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2, row3];
  }

  // ---------------------------------------------------------------------
  // ADMIN PANEL
  // ---------------------------------------------------------------------
  function buildAdminPanelEmbed() {
    const accounts = accountsTracking.listAccounts();
    return new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle('Corex Admin Panel')
      .setDescription(
        '**Support for anyone, admin tools for the owner.**\n\n' +
        `**${accounts.length} website account${accounts.length === 1 ? '' : 's'} registered so far.**`
      )
      .addFields(
        { name: 'For everyone', value: '**• Support — get help fast**\n**• Bug Report — send it straight to the team**\n**• Site Content — see the current live page text**' },
        { name: 'Owner only', value: '**• Accounts — list every website account and its status**\n**• AI Site Edit — propose a text change, review, then apply**\n**• Ban / Unban / Grant / Revoke Premium — one click, a quick form, done**' },
      )
      .setFooter({ text: 'corex hosting' });
  }
  function buildAdminPanelRows() {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('corex_support').setLabel('Support').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('corex_bug').setLabel('Bug Report').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_site_content').setLabel('Site Content').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_accounts').setLabel('Accounts').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_site_edit').setLabel('AI Site Edit').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_ban').setLabel('Ban Account').setStyle(ButtonStyle.Danger),
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_unban').setLabel('Unban Account').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_grant_premium').setLabel('Grant Premium').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('admin_revoke_premium').setLabel('Revoke Premium').setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2, row3];
  }

  // ---------------------------------------------------------------------
  // Post/refresh both panels, with real logging so "it doesn't auto send"
  // has a visible reason in the console instead of failing silently.
  // ---------------------------------------------------------------------
  async function postOrUpdatePanel(kind, channelId, embed, components) {
    if (!channelId) return; // already warned about this at startup
    const state = loadPanelState();
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) {
        console.error(`[corex] ${kind}: channel ${channelId} was not found. Double check DISCORD_${kind === 'hosting' ? 'PANEL' : 'ADMIN'}_CHANNEL_ID and that the bot is actually in that server.`);
        return;
      }
      const key = `${kind}MessageId`;
      if (state[key]) {
        try {
          const existing = await channel.messages.fetch(state[key]);
          await existing.edit({ embeds: [embed], components });
          console.log(`[corex] ${kind} panel updated in #${channel.name}`);
          return;
        } catch (e) { /* message got deleted — fall through and post fresh */ }
      }
      const sent = await channel.send({ embeds: [embed], components });
      savePanelState({ ...state, [key]: sent.id });
      console.log(`[corex] ${kind} panel posted in #${channel.name}`);
    } catch (e) {
      // This is almost always a permissions problem — the bot can't see or
      // post in the channel — or a wrong/mistyped channel ID.
      console.error(`[corex] failed to post the ${kind} panel:`, e.message);
      console.error(`[corex] checklist: is ${channelId} a real channel ID (not a category)? Does the bot have "View Channel" and "Send Messages" there? Was it actually invited to that server?`);
    }
  }
  async function refreshHostingPanel() { await postOrUpdatePanel('hosting', PANEL_CHANNEL_ID, buildHostingPanelEmbed(), buildHostingPanelRows()); }
  async function refreshAdminPanel() { await postOrUpdatePanel('admin', ADMIN_CHANNEL_ID, buildAdminPanelEmbed(), buildAdminPanelRows()); }

  async function postToLogChannel(embed) {
    if (!LOG_CHANNEL_ID) return;
    try {
      const channel = await client.channels.fetch(LOG_CHANNEL_ID);
      if (channel) await channel.send({ embeds: [embed] });
    } catch (e) { console.error('[corex] could not post to log channel:', e.message); }
  }

  function requireOwner(interaction) {
    if (interaction.user.id !== OWNER_ID) {
      interaction.reply({ content: '**This is owner-only.**', ephemeral: true });
      return false;
    }
    return true;
  }
  function findBot(idOrName) {
    const bots = bm.loadDb();
    return bots.find(b => b.id === idOrName) || bots.find(b => b.name.toLowerCase() === idOrName.toLowerCase());
  }

  client.once(Events.ClientReady, async () => {
    console.log(`[corex] Discord bot logged in as ${client.user.tag}`);

    // /deploy is the one command that has to remain a command — file
    // attachments only work as slash command options in Discord's API,
    // never through buttons or modals.
    const commands = [
      new SlashCommandBuilder().setName('deploy').setDescription('Owner only — deploy a bot from a zip file')
        .addAttachmentOption(o => o.setName('file').setDescription('Your bot, zipped').setRequired(true))
        .addStringOption(o => o.setName('name').setDescription('Name for this bot').setRequired(true))
        .addStringOption(o => o.setName('runtime').setDescription('Runtime').setRequired(true)
          .addChoices({ name: 'Node.js', value: 'node' }, { name: 'Python', value: 'python' }))
        .addStringOption(o => o.setName('env').setDescription('Env vars as KEY=VALUE, comma-separated (e.g. DISCORD_TOKEN=abc,FOO=bar)')),
    ].map(c => c.toJSON());

    try {
      const rest = new REST({ version: '10' }).setToken(TOKEN);
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('[corex] slash commands registered (/deploy only — everything else lives on the panels)');
    } catch (e) { console.error('[corex] failed to register slash commands:', e.message); }

    await refreshHostingPanel();
    await refreshAdminPanel();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // ---------------- BUTTONS ----------------
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === 'corex_support') {
        return interaction.reply({ content: "**Thanks for reaching out — describe what you need and someone from the team will be with you shortly.**", ephemeral: true });
      }
      if (id === 'corex_bug') {
        return interaction.reply({ content: "**Please describe the bug, steps to reproduce it, and your bot's name — a team member will pick it up.**", ephemeral: true });
      }
      if (id.startsWith('confirm_edit_')) {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '**Only the site owner can confirm this.**', ephemeral: true });
        const pending = pendingEdits.get(interaction.message.id);
        if (!pending) return interaction.update({ content: '**This proposal expired.**', embeds: [], components: [] });
        saveContent(pending);
        pendingEdits.delete(interaction.message.id);
        return interaction.update({ content: '**Applied — live on the site now.**', embeds: [], components: [] });
      }
      if (id.startsWith('cancel_edit_')) {
        pendingEdits.delete(interaction.message.id);
        return interaction.update({ content: '**Cancelled — nothing was changed.**', embeds: [], components: [] });
      }

      // --- Hosting Panel ---
      if (id === 'control_deploy_info') {
        return interaction.reply({
          content: "**Discord doesn't let buttons carry file uploads — that only works through a slash command. Run /deploy with your zip attached, a name, and a runtime.**",
          ephemeral: true,
        });
      }
      if (id === 'control_refresh') {
        await refreshHostingPanel();
        return interaction.reply({ content: '**Panel refreshed.**', ephemeral: true });
      }
      if (id === 'control_status') {
        const bots = bm.loadDb();
        const counts = bots.reduce((acc, b) => { const s = bm.getStatus(b.id); acc[s] = (acc[s] || 0) + 1; return acc; }, {});
        const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('Corex Status').setDescription(
          `**${bots.length} bot${bots.length === 1 ? '' : 's'} hosted total**\n` +
          `**Online: ${counts.online || 0}**\n` +
          `**Offline: ${counts.offline || 0}**\n` +
          `**Installing/Restarting: ${(counts.installing || 0) + (counts.restarting || 0)}**\n` +
          `**Crashed: ${counts.crashed || 0}**`
        );
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      if (id === 'control_help') {
        const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('How Corex Hosting works').setDescription(
          '**My Bots — deploy, start, stop, restart, or check logs for anything you host**\n' +
          '**Deploy — use /deploy with a zipped bot attached (Discord only allows file uploads through commands)**\n' +
          '**Status — a quick look at how many bots are online right now**\n' +
          '**Feedback & Suggestions — tell us what to build or fix next**\n\n' +
          '**Everything above replies privately — only you see your own responses.**'
        );
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      if (id === 'control_feedback') {
        const modal = new ModalBuilder().setCustomId('modal_feedback').setTitle('Feedback & Suggestions');
        const input = new TextInputBuilder().setCustomId('feedback').setLabel('What should we know?')
          .setStyle(TextInputStyle.Paragraph).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (id === 'control_my_bots') {
        const bots = bm.loadDb();
        if (!bots.length) return interaction.reply({ content: '**No bots hosted yet — deploy one with /deploy.**', ephemeral: true });
        const menu = new StringSelectMenuBuilder()
          .setCustomId('select_bot')
          .setPlaceholder('Choose a bot to manage')
          .addOptions(bots.slice(0, 25).map(b => ({
            label: b.name,
            description: `${b.runtime} — ${bm.getStatus(b.id)}`,
            value: b.id,
          })));
        return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }
      if (/^(bstart|bstop|brestart|bdelete|blogs)_/.test(id)) {
        const [action, botId] = id.split('_');
        const bot = findBot(botId);
        if (!bot) return interaction.reply({ content: '**That bot no longer exists.**', ephemeral: true });

        if (action === 'blogs') {
          const lines = bm.getLogs(bot.id).slice(-25).map(l => l.line).join('').slice(-1800) || 'No logs yet.';
          return interaction.reply({ content: `**${bot.name} — recent logs:**\n\`\`\`\n${lines}\n\`\`\``, ephemeral: true });
        }
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '**Starting, stopping, restarting, and deleting are owner-only. Anyone can check logs.**', ephemeral: true });
        }
        if (action === 'bstart') { await bm.startBot(bot.id); refreshHostingPanel(); return interaction.reply({ content: `**Starting ${bot.name}.**`, ephemeral: true }); }
        if (action === 'bstop') { bm.stopBot(bot.id); refreshHostingPanel(); return interaction.reply({ content: `**Stopping ${bot.name}.**`, ephemeral: true }); }
        if (action === 'brestart') { await bm.restartBot(bot.id); refreshHostingPanel(); return interaction.reply({ content: `**Restarting ${bot.name}.**`, ephemeral: true }); }
        if (action === 'bdelete') {
          bm.stopBot(bot.id);
          bm.saveDb(bm.loadDb().filter(b => b.id !== bot.id));
          fs.rm(path.join(bm.BOTS_DIR, bot.id), { recursive: true, force: true }, () => {});
          refreshHostingPanel();
          return interaction.reply({ content: `**Deleted ${bot.name}.**`, ephemeral: true });
        }
      }

      // --- Admin Panel ---
      if (id === 'admin_site_content') {
        const content = loadContent();
        const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('Current site text')
          .setDescription(Object.entries(content).map(([k, v]) => `**${k}: ${v}**`).join('\n'));
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      if (id === 'admin_accounts') {
        if (!requireOwner(interaction)) return;
        const accounts = accountsTracking.listAccounts();
        if (!accounts.length) return interaction.reply({ content: '**No accounts yet.**', ephemeral: true });
        const lines = accounts.slice(0, 25).map(a =>
          `${a.banned ? '' : premium.isPremium(a.username) ? '' : '•'} **${a.username} — ${a.ip}${premium.isPremium(a.username) ? ' — premium' : ''}${a.banned ? ' — BANNED' : ''}**`
        ).join('\n');
        const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle(`Accounts (${accounts.length})`).setDescription(lines);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      if (id === 'admin_site_edit') {
        if (!requireOwner(interaction)) return;
        if (!anthropic) return interaction.reply({ content: "**AI editing isn't set up yet — add ANTHROPIC_API_KEY to .env.**", ephemeral: true });
        const modal = new ModalBuilder().setCustomId('modal_site_edit').setTitle('AI Site Edit');
        const input = new TextInputBuilder().setCustomId('prompt').setLabel('Describe the change')
          .setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. make the tagline punchier').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
      if (id === 'admin_ban' || id === 'admin_unban' || id === 'admin_grant_premium' || id === 'admin_revoke_premium') {
        if (!requireOwner(interaction)) return;
        const titles = { admin_ban: 'Ban Account', admin_unban: 'Unban Account', admin_grant_premium: 'Grant Premium', admin_revoke_premium: 'Revoke Premium' };
        const modal = new ModalBuilder().setCustomId(`modal_${id}`).setTitle(titles[id]);
        const input = new TextInputBuilder().setCustomId('username').setLabel('Website username')
          .setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
    }

    // ---------------- MODAL SUBMITS ----------------
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_site_edit') {
        if (!anthropic) return interaction.reply({ content: "**AI editing isn't set up.**", ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const current = loadContent();
        const prompt = interaction.fields.getTextInputValue('prompt');
        try {
          const msg = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system:
              `You edit specific short text fields on a website called "corex hosting". ` +
              `You may ONLY return a JSON object using a subset of these exact keys: ${Object.keys(EDITABLE_FIELDS).join(', ')}. ` +
              `Never invent new keys, never return anything except the JSON object — no prose, no markdown fences. ` +
              `Keep changes short (these render as a page heading/tagline) and keep a similar casual tone unless asked otherwise.`,
            messages: [{ role: 'user', content: `Current values: ${JSON.stringify(current)}\n\nRequested change: ${prompt}` }],
          });
          const raw = msg.content.find(b => b.type === 'text')?.text || '{}';
          let proposed;
          try { proposed = JSON.parse(raw.trim()); }
          catch (e) { return interaction.editReply('**The AI response wasn\'t valid — try rephrasing the request.**'); }

          const safeProposed = {};
          for (const key of Object.keys(proposed)) {
            if (Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, key)) safeProposed[key] = String(proposed[key]);
          }
          if (!Object.keys(safeProposed).length) return interaction.editReply("**The AI didn't propose any change to an editable field.**");

          const diffText = Object.keys(safeProposed).map(k => `**${k}**\n~~${current[k]}~~ → **${safeProposed[k]}**`).join('\n\n');
          const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('Proposed site change').setDescription(diffText);
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirm_edit_x').setLabel('Apply').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('cancel_edit_x').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          );
          const sent = await interaction.editReply({ embeds: [embed], components: [row] });
          pendingEdits.set(sent.id, safeProposed);
          setTimeout(() => pendingEdits.delete(sent.id), 10 * 60 * 1000);
        } catch (e) {
          console.error('[corex] site-edit failed:', e);
          await interaction.editReply('**Something went wrong asking the AI — check the server console.**');
        }
        return;
      }

      if (interaction.customId === 'modal_feedback') {
        const feedback = interaction.fields.getTextInputValue('feedback');
        postToLogChannel(new EmbedBuilder().setColor(BRAND_COLOR).setTitle('New feedback').setDescription(`**${feedback}**`).setFooter({ text: `from ${interaction.user.tag}` }));
        return interaction.reply({ content: '**Thanks — that\'s been sent to the team.**', ephemeral: true });
      }

      if (interaction.customId === 'modal_admin_ban') {
        const username = interaction.fields.getTextInputValue('username');
        accountsTracking.banUsername(username);
        refreshAdminPanel();
        return interaction.reply({ content: `**Banned ${username} (and their IP).**`, ephemeral: true });
      }
      if (interaction.customId === 'modal_admin_unban') {
        const username = interaction.fields.getTextInputValue('username');
        accountsTracking.unbanUsername(username);
        refreshAdminPanel();
        return interaction.reply({ content: `**Unbanned ${username}.**`, ephemeral: true });
      }
      if (interaction.customId === 'modal_admin_grant_premium') {
        const username = interaction.fields.getTextInputValue('username');
        premium.setPremium(username, true);
        return interaction.reply({ content: `**Granted premium for ${username}.**`, ephemeral: true });
      }
      if (interaction.customId === 'modal_admin_revoke_premium') {
        const username = interaction.fields.getTextInputValue('username');
        premium.setPremium(username, false);
        return interaction.reply({ content: `**Revoked premium for ${username}.**`, ephemeral: true });
      }
    }

    // ---------------- SELECT MENUS ----------------
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_bot') {
      const bot = findBot(interaction.values[0]);
      if (!bot) return interaction.update({ content: '**That bot no longer exists.**', components: [] });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bstart_${bot.id}`).setLabel('Start').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`bstop_${bot.id}`).setLabel('Stop').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`brestart_${bot.id}`).setLabel('Restart').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`blogs_${bot.id}`).setLabel('Logs').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bdelete_${bot.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger),
      );
      return interaction.update({
        content: `**${bot.name} — ${bot.runtime} — \`${bm.getStatus(bot.id)}\`**`,
        components: [row],
      });
    }

    // ---------------- /deploy (the one remaining command) ----------------
    if (interaction.isChatInputCommand() && interaction.commandName === 'deploy') {
      if (!requireOwner(interaction)) return;
      await interaction.deferReply({ ephemeral: true });

      const attachment = interaction.options.getAttachment('file');
      const name = interaction.options.getString('name');
      const runtime = interaction.options.getString('runtime');
      const envRaw = interaction.options.getString('env');

      if (!attachment.name.toLowerCase().endsWith('.zip')) return interaction.editReply('**Please attach a .zip file.**');
      const MAX_DISCORD_DEPLOY_BYTES = 24 * 1024 * 1024;
      if (attachment.size > MAX_DISCORD_DEPLOY_BYTES) {
        return interaction.editReply("**That file's too big for Discord to carry — use the website's upload for anything over ~24MB.**");
      }

      try {
        const res = await fetch(attachment.url);
        const buf = Buffer.from(await res.arrayBuffer());
        const tmpZipPath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`);
        fs.writeFileSync(tmpZipPath, buf);

        const id = crypto.randomBytes(6).toString('hex');
        const botDir = path.join(bm.BOTS_DIR, id);
        fs.mkdirSync(botDir, { recursive: true });

        const directory = await unzipper.Open.file(tmpZipPath);
        await directory.extract({ path: botDir, concurrency: 4 });
        fs.unlink(tmpZipPath, () => {});

        if (envRaw) {
          const envVars = {};
          envRaw.split(',').forEach(pair => {
            const [k, ...rest] = pair.split('=');
            if (k && rest.length) envVars[k.trim()] = rest.join('=').trim();
          });
          fs.writeFileSync(path.join(botDir, '.env.json'), JSON.stringify(envVars, null, 2));
        }

        const bots = bm.loadDb();
        bots.push({ id, name, runtime, status: 'offline', createdAt: new Date().toISOString() });
        bm.saveDb(bots);

        const panelMention = PANEL_CHANNEL_ID ? `<#${PANEL_CHANNEL_ID}>` : 'the Hosting Panel';
        await interaction.editReply(`**Deployed ${name} — starting it up now. Open ${panelMention} and hit My Bots to check on it.**`);
        refreshHostingPanel();
        await bm.startBot(id);
      } catch (e) {
        console.error('[corex] Discord deploy failed:', e);
        await interaction.editReply('**Deploy failed — ' + e.message + '**');
      }
    }
  });

  // --- member / ban tracking ---
  client.on(Events.GuildMemberAdd, (member) => {
    logActivity({ type: 'join', username: member.user.tag, id: member.id });
    postToLogChannel(new EmbedBuilder().setColor(0x8ff0c0).setDescription(`**${member.user.tag} joined**`));
  });
  client.on(Events.GuildMemberRemove, (member) => {
    logActivity({ type: 'leave', username: member.user.tag, id: member.id });
    postToLogChannel(new EmbedBuilder().setColor(0xf0c96b).setDescription(`**${member.user.tag} left**`));
  });
  client.on(Events.GuildBanAdd, (ban) => {
    logActivity({ type: 'ban', username: ban.user.tag, id: ban.user.id });
    postToLogChannel(new EmbedBuilder().setColor(0xff8f8f).setDescription(`**${ban.user.tag} was banned**`));
  });
  client.on(Events.GuildBanRemove, (ban) => {
    logActivity({ type: 'unban', username: ban.user.tag, id: ban.user.id });
    postToLogChannel(new EmbedBuilder().setColor(0x8ff0c0).setDescription(`**${ban.user.tag} was unbanned**`));
  });

  // --- moderation commands (prefix-based, e.g. "?kick @user reason") ------
  const PREFIX = process.env.MOD_PREFIX || '?';

  function modResultEmbed(action, target, reason) {
    return new EmbedBuilder()
      .setTitle(`✓ User ${action}`)
      .setDescription(
        `***${target.tag || target.username}*** was ${action.toLowerCase()}\n` +
        `**Reason:** ${reason || 'No reason provided'}`
      );
  }

  async function recordAndAnnounce(message, action, target, reason) {
    logModAction({ action, target: target.tag || target.username, targetId: target.id, moderator: message.author.tag, reason: reason || null });
    const embed = modResultEmbed(action, target, reason);
    await message.reply({ embeds: [embed] });
    postToLogChannel(embed);
  }

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() || '').toLowerCase();
    const modCommands = ['kick', 'ban', 'unban', 'purge', 'timeout', 'untimeout', 'warn', 'modlogs'];
    if (!modCommands.includes(cmd)) return;

    const me = message.guild.members.me;

    if (cmd === 'kick') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply('**You need the Kick Members permission to do that.**');
      }
      const target = message.mentions.members.first();
      if (!target) return message.reply(`**Usage: ${PREFIX}kick @user [reason]**`);
      if (!target.kickable || !me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply("**I can't kick that member — check my role is above theirs and I have Kick Members permission.**");
      }
      const reason = args.slice(1).join(' ');
      try {
        await target.kick(reason || 'No reason provided');
        await recordAndAnnounce(message, 'Kicked', target.user, reason);
      } catch (e) { message.reply(`**Kick failed: ${e.message}**`); }
      return;
    }

    if (cmd === 'ban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply('**You need the Ban Members permission to do that.**');
      }
      const target = message.mentions.members.first();
      if (!target) return message.reply(`**Usage: ${PREFIX}ban @user [reason]**`);
      if (!target.bannable || !me.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply("**I can't ban that member — check my role is above theirs and I have Ban Members permission.**");
      }
      const reason = args.slice(1).join(' ');
      try {
        await target.ban({ reason: reason || 'No reason provided' });
        await recordAndAnnounce(message, 'Banned', target.user, reason);
      } catch (e) { message.reply(`**Ban failed: ${e.message}**`); }
      return;
    }

    if (cmd === 'unban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply('**You need the Ban Members permission to do that.**');
      }
      const userId = args[0];
      if (!userId) return message.reply(`**Usage: ${PREFIX}unban <user ID>**`);
      try {
        const user = await client.users.fetch(userId);
        await message.guild.bans.remove(userId, args.slice(1).join(' ') || 'No reason provided');
        await recordAndAnnounce(message, 'Unbanned', user, args.slice(1).join(' '));
      } catch (e) { message.reply(`**Unban failed: ${e.message}** — check the user ID and that they're actually banned.`); }
      return;
    }

    if (cmd === 'purge') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return message.reply('**You need the Manage Messages permission to do that.**');
      }
      const count = parseInt(args[0], 10);
      if (!count || count < 1 || count > 100) {
        return message.reply(`**Usage: ${PREFIX}purge <1-100>**`);
      }
      try {
        const deleted = await message.channel.bulkDelete(count + 1, true); // +1 for the command message itself, true = skip messages older than 14 days
        const confirm = await message.channel.send({
          embeds: [new EmbedBuilder().setTitle('✓ Messages Purged').setDescription(`**Deleted ${deleted.size - 1} message${deleted.size - 1 === 1 ? '' : 's'}.**`)],
        });
        logModAction({ action: 'Purged', target: message.channel.name, targetId: message.channel.id, moderator: message.author.tag, reason: `${deleted.size - 1} messages` });
        setTimeout(() => confirm.delete().catch(() => {}), 5000);
      } catch (e) {
        message.reply(`**Purge failed: ${e.message}** — Discord can't bulk-delete messages older than 14 days.`);
      }
      return;
    }

    if (cmd === 'timeout') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply('**You need the Moderate Members permission to do that.**');
      }
      const target = message.mentions.members.first();
      const ms = parseDuration(args[1]);
      if (!target || !ms) return message.reply(`**Usage: ${PREFIX}timeout @user <duration e.g. 10m, 2h, 1d> [reason]**`);
      if (!target.moderatable) return message.reply("**I can't timeout that member — check my role is above theirs.**");
      const reason = args.slice(2).join(' ');
      try {
        await target.timeout(ms, reason || 'No reason provided');
        await recordAndAnnounce(message, 'Timed out', target.user, `${args[1]} — ${reason || 'No reason provided'}`);
      } catch (e) { message.reply(`**Timeout failed: ${e.message}**`); }
      return;
    }

    if (cmd === 'untimeout') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply('**You need the Moderate Members permission to do that.**');
      }
      const target = message.mentions.members.first();
      if (!target) return message.reply(`**Usage: ${PREFIX}untimeout @user**`);
      try {
        await target.timeout(null);
        await recordAndAnnounce(message, 'Timeout removed for', target.user, null);
      } catch (e) { message.reply(`**Failed: ${e.message}**`); }
      return;
    }

    if (cmd === 'warn') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply('**You need the Moderate Members permission to do that.**');
      }
      const target = message.mentions.members.first();
      if (!target) return message.reply(`**Usage: ${PREFIX}warn @user [reason]**`);
      const reason = args.slice(1).join(' ');
      await recordAndAnnounce(message, 'Warned', target.user, reason);
      try { await target.send(`**You were warned in ${message.guild.name}.**\n**Reason: ${reason || 'No reason provided'}**`); } catch (e) { /* DMs closed — fine */ }
      return;
    }

    if (cmd === 'modlogs') {
      const target = message.mentions.users.first();
      const log = loadModLog();
      const filtered = target ? log.filter(l => l.targetId === target.id) : log;
      if (!filtered.length) return message.reply('**No moderation actions logged yet.**');
      const lines = filtered.slice(0, 15).map(l => `**${l.action} — ${l.target}${l.reason ? ` — ${l.reason}` : ''} (by ${l.moderator})**`).join('\n');
      const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle(target ? `Mod log — ${target.tag}` : 'Recent mod log').setDescription(lines);
      return message.reply({ embeds: [embed] });
    }
  });

  const maskedToken = TOKEN.length > 12 ? `${TOKEN.slice(0, 6)}...${TOKEN.slice(-4)} (${TOKEN.length} chars)` : '(too short to be real)';

  client.login(TOKEN).catch(e => {
    console.error('[corex] Discord bot failed to log in:', e.message);
    console.error(`[corex] token being used: ${maskedToken}`);
    console.error(
      '[corex] "invalid token" checklist:\n' +
      '  1. Is this EXACTLY the token from Discord Developer Portal → your app → Bot tab → Token?\n' +
      '  2. Did you click "Reset Token" since copying it? That invalidates the old one instantly.\n' +
      '  3. Is DISCORD_BOT_TOKEN actually set in your host\'s env vars (not just your local .env)?\n' +
      '  4. Any stray space or line break from copy-pasting?'
    );
  });
}

module.exports = { startDiscordBot, loadContent, loadActivity };
