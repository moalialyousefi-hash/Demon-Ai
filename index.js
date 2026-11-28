const http = require('http');
http.createServer((req, res) => res.end('Demon AI is online!')).listen(process.env.PORT || 3000, '0.0.0.0');

require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, AttachmentBuilder, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, SeparatorBuilder, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, LabelBuilder
} = require('discord.js');
const { loginToSparx, runHomeworkInDM, getFastBrowser } = require('./solver');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const savedAccounts = new Map();
const userSessions = new Map();

function saveState() {
  try {
    fs.writeFileSync('sessions.json', JSON.stringify({
      saved: Array.from(savedAccounts.entries()),
      sessions: Array.from(userSessions.entries())
    }));
  } catch (e) {}
}

try {
  if (fs.existsSync('sessions.json')) {
    const raw = JSON.parse(fs.readFileSync('sessions.json', 'utf8'));
    (raw.saved || []).forEach(([k, v]) => savedAccounts.set(k, Array.isArray(v) ? v : [v]));
    (raw.sessions || []).forEach(([k, v]) => userSessions.set(k, v));
  }
} catch (e) {}

client.on('error', err => console.error('[DISCORD CLIENT ERROR]', err));
function getSavedList(userId){const local=savedAccounts.get(userId);if(local&&local.length>0)return local;if(process.env.DEFAULT_SAVED_ACCOUNTS){try{return JSON.parse(process.env.DEFAULT_SAVED_ACCOUNTS);}catch(e){}}return[];}

function upsertSavedAccount(userId, account) {
  const list = getSavedList(userId);
  const idx = list.findIndex(a => a.username.toLowerCase() === account.username.toLowerCase() && !!a.isMicrosoft === !!account.isMicrosoft);
  if (idx >= 0) list[idx] = account;
  else list.push(account);
  savedAccounts.set(userId, list);
  saveState();
}

function buildSavedAccountsMenu(userId, selectedIdx = null) {
  const list = getSavedList(userId);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "### 💾 Saved Accounts\n" +
        (list.length > 0
          ? "Choose a saved login below to manage or sign in immediately."
          : "No saved logins yet. Press **▶ Join Queue** first!")
      )
    );

  if (list.length === 0) {
    return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('manage_saved_account_menu')
    .setPlaceholder('Choose an account')
    .addOptions(
      list.slice(0, 25).map((acc, i) => ({
        label: (acc.isMicrosoft ? 'Microsoft' : 'Sparx') + ' - ' + acc.username,
        description: acc.isMicrosoft ? 'Microsoft • ' + acc.school : acc.school,
        value: String(i),
        emoji: acc.isMicrosoft ? '1525932056025235496' : '❄️',
        default: selectedIdx === i
      }))
    );

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(menu));

  return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

function buildSparxDashboard(session) {
  const visibleHomeworks = session.showCompleted
    ? session.homeworks
    : session.homeworks.filter(h => !h.completed);

  const options = visibleHomeworks.length > 0
    ? visibleHomeworks.slice(0, 25).map(hw => ({
        label: hw.title.slice(0, 100),
        description: hw.completed ? 'Completed' : 'Due soon — ready to solve',
        value: hw.id,
        default: hw.id === session.selectedHwId
      }))
    : [{ label: 'All caught up! Click Show Completed below', value: 'none_completed', default: true }];

  const selectedHw = session.homeworks.find(h => h.id === session.selectedHwId);

  const embed = new EmbedBuilder()
    .setTitle('Demon AI • Sparx')
    .setDescription(
      'Welcome back, **' + session.studentName + '**!\n' +
      'School: `' + session.school + '`\n' +
      'Selected Task: **' + (selectedHw ? selectedHw.title : 'None selected') + '**\n\n' +
      'Pick a homework and speed below, then click **▶ Start Task**.'
    )
    .setColor('#1DB954');

  const hwRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_homework_menu')
      .setPlaceholder('Choose a homework task...')
      .addOptions(options)
  );

  const speedRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_speed_menu')
      .setPlaceholder('Select solving speed...')
      .addOptions([
        { label: 'Quick (~12s per question)', value: 'quick', default: session.speed === 'quick' },
        { label: 'Normal (~30s per question)', value: 'normal', default: session.speed === 'normal' },
        { label: 'Human (~60s per question)', value: 'slow', default: session.speed === 'slow' }
      ])
  );

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('run_selected_hw_btn').setLabel('▶ Start Task').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('toggle_completed_btn').setLabel(session.showCompleted ? 'Hide Completed' : 'Show Completed').setStyle(ButtonStyle.Secondary)
  );

  const dashContainer = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 📚 ${session.studentName ? session.studentName + "'s " : ""}Sparx Dashboard\n` +
        (embed.data.description || "Select your homework and speed below, then press **▶ Start Task**.")
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(hwRow, speedRow, btnRow);
  return { flags: MessageFlags.IsComponentsV2, components: [dashContainer] };
}

async function performSparxLogin(interaction, { school, username, password, isMicrosoft }) {
  upsertSavedAccount(interaction.user.id, { school, username, password, isMicrosoft });

  let browser;
  let page;
  let statusTicker;
  let seconds = 0;

  try {
    await interaction.editReply('Step 1/3: Connecting to browser (0s)...');
    statusTicker = setInterval(() => {
      seconds += 5;
      interaction.editReply('Logging into Sparx (' + seconds + 's elapsed)...').catch(() => {});
    }, 5000);

    browser = await getFastBrowser();
    page = await browser.newPage();
    await loginToSparx(page, school, username, password, isMicrosoft);

    clearInterval(statusTicker);
    await interaction.editReply('Step 3/3: Reading your homework list...');

    let scraped = { name: 'Student', homeworks: [] };
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 800));
      try {
        scraped = await page.evaluate(() => {
          const text = document.body ? document.body.innerText : "";
          const nameMatch = text.match(/Hey\s+([A-Za-z0-9_-]+)/i);
          const name = nameMatch ? nameMatch.at(1) : "Student";
          const rawLines = text.split("\n").map(l => l.trim()).filter(Boolean);
          const homeworks = [];
          const seen = new Set();

          for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines.at(i);
            if (/^(Homework due|Compulsory|XP Boost|Target)/i.test(line)) {
              if (!seen.has(line)) {
                seen.add(line);
                const nearby = rawLines.slice(i, i + 4).join(" ");
                const isDone = /100%|Completed/i.test(nearby);
                homeworks.push({ id: "hw_" + homeworks.length, title: line.slice(0, 95), completed: isDone });
              }
            }
          }
          return { name, homeworks };
        });
        if (scraped.name !== "Student" && scraped.homeworks.length > 0) break;
      } catch (e) {}
    }

    if (scraped.homeworks.length === 0 && scraped.name === "Student") {
      return await interaction.editReply({ content: "Could not load your Sparx dashboard — if your school uses Microsoft 365 (like Dean Trust), click the green **Microsoft Login** button instead of Sparx Login!" });
    }
    const firstIncomplete = scraped.homeworks.find(h => !h.completed);
    const session = {
      school, username, password, isMicrosoft,
      studentName: scraped.name,
      homeworks: scraped.homeworks,
      selectedHwId: firstIncomplete ? firstIncomplete.id : null,
      showCompleted: !firstIncomplete,
      speed: 'quick'
    };
    userSessions.set(interaction.user.id, session);
    saveState();
    await interaction.editReply(buildSparxDashboard(session));
  } catch (err) {
    clearInterval(statusTicker);
    console.error('[LOGIN ERROR]', err);
    const files = err.screenshot ? [new AttachmentBuilder(Buffer.from(err.screenshot), { name: 'login_stuck.png' })] : [];
    await interaction.editReply({ content: 'Stopped early: ' + err.message, files });
  } finally {
    clearInterval(statusTicker);
    if (page) await page.close().catch(() => {});
    // keep sharedBrowser warm
  }
}

client.once('clientReady', async () => {
  console.log('[BOT ONLINE] Logged in as ' + client.user.tag);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const cmd = new SlashCommandBuilder().setName('setup').setDescription('Post the Demon AI dashboard');
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [cmd.toJSON()] });
  console.log('Dashboard /setup command registered!');
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      const avatarUrl = client.user.displayAvatarURL();
      const setupContainer = new ContainerBuilder()
        .setAccentColor(0xED4245)
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                "## 🔥 `Demon AI` Learning Platform\n" +
                "Fast, automated homework solver for **Sparx Reader & Science**.\n" +
                "Press `Join Queue` below to connect your account and start.\n\n" +
                "__**Notes**__\n" +
                "> • Accurate AI solving across all tasks & checks\n" +
                "> • Live progress tracking sent directly to your DMs\n" +
                "> • Supports standard Sparx & Microsoft 365 logins"
              )
            )
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl))
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('join_queue_btn').setLabel('Join Queue').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('saved_account_btn').setLabel('Saved Login').setStyle(ButtonStyle.Danger)
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('help_btn').setLabel('Help & FAQ').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('saved_account_btn_manage').setLabel('Manage Accounts').setStyle(ButtonStyle.Danger)
          )
        );

      await interaction.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [setupContainer]
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'join_queue_btn') {
      const methodContainer = new ContainerBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "### Choose Login Method\nSelect how you sign in to Sparx:"
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('open_sparx_modal').setLabel('▷ Sparx Login').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('open_ms_modal').setLabel('Microsoft Login').setEmoji('1525932056025235496').setStyle(ButtonStyle.Success)
          )
        );
      await interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [methodContainer]
      });
      return;
    }

    if (interaction.isButton()) {
if (interaction.customId === 'open_sparx_modal' || interaction.customId === 'open_ms_modal') {
        const isMs = interaction.customId === 'open_ms_modal';
        const list = getSavedList(interaction.user.id);
        const saved = list.find(a => !!a.isMicrosoft === isMs) || { school: '', username: '', password: '', platform: 'maths' };
        const modal = new ModalBuilder()
          .setCustomId(isMs ? 'ms_login_modal' : 'sparx_login_modal')
          .setTitle('Select Platform');

        const platformSelect = new StringSelectMenuBuilder()
          .setCustomId('platform_input')
          .setPlaceholder('— none from this list —')
          .addOptions([
            { label: 'Sparx Maths', value: 'maths', emoji: '🇲', default: (saved.platform || 'maths') === 'maths' },
            { label: 'Sparx Reader', value: 'reader', emoji: '🇷', default: saved.platform === 'reader' },
            { label: 'Sparx Science', value: 'science', emoji: '🇸', default: saved.platform === 'science' }
          ]);

        if (typeof LabelBuilder === "function" && typeof modal.addLabelComponents === "function") {
          modal.addLabelComponents(
            new LabelBuilder().setLabel("Platform").setStringSelectMenuComponent(platformSelect),
            new LabelBuilder().setLabel("School Name").setTextInputComponent(
              new TextInputBuilder().setCustomId("school_input").setStyle(TextInputStyle.Short).setValue(saved.school).setRequired(true)
            ),
            new LabelBuilder().setLabel("Username or Email").setTextInputComponent(
              new TextInputBuilder().setCustomId("username_input").setStyle(TextInputStyle.Short).setValue(saved.username).setRequired(true)
            ),
            new LabelBuilder().setLabel("Password").setTextInputComponent(
              new TextInputBuilder().setCustomId("password_input").setStyle(TextInputStyle.Short).setValue(saved.password).setRequired(true)
            )
          );
        } else {
          modal.setTitle(isMs ? "Microsoft Sparx Login" : "Sparx Login");
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("school_input").setLabel("School Name").setStyle(TextInputStyle.Short).setValue(saved.school).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("username_input").setLabel("Username or Email").setStyle(TextInputStyle.Short).setValue(saved.username).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("password_input").setLabel("Password").setStyle(TextInputStyle.Short).setValue(saved.password).setRequired(true))
          );
        }
        return await interaction.showModal(modal);
      }
if (interaction.customId === 'saved_account_btn' || interaction.customId === 'saved_account_btn_manage') {
return await interaction.reply(buildSavedAccountsMenu(interaction.user.id));
}
if (interaction.customId.startsWith('quick_login_saved_')) {
const idx = Number(interaction.customId.replace('quick_login_saved_', ''));
const list = getSavedList(interaction.user.id);
const acc = list[idx];
if (!acc) return await interaction.reply({ content: 'Saved account not found.', flags: 64 });
await interaction.deferUpdate();
return await performSparxLogin(interaction, acc);
}
if (interaction.customId.startsWith('delete_saved_')) {
const idx = Number(interaction.customId.replace('delete_saved_', ''));
const list = getSavedList(interaction.user.id);
list.splice(idx, 1);
savedAccounts.set(interaction.user.id, list);
saveState();
return await interaction.update({ ...buildSavedAccountsMenu(interaction.user.id), embeds: [] });
}
if (interaction.customId === 'help_btn') {
      const helpContainer = new ContainerBuilder()
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                "## ❓ Demon AI • Help & Guide\n" +
                "**1. Join Queue**\nClick **▶ Join Queue** and choose **Sparx Login** or **Microsoft Login**, then enter your school details.\n\n" +
                "**2. Choose Homework & Speed**\nPick your due homework from the dropdown, select Quick, Normal, or Human speed, and click **▶ Start Task**.\n\n" +
                "**3. Live DM Progress**\nKeep your Direct Messages open so Demon AI can send live task progress bars as it solves each question."
              )
            )
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(client.user.displayAvatarURL()))
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# Demon AI • Sparx Assistant")
        );
      return await interaction.reply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, components: [helpContainer] });
    }
    if (interaction.customId === 'toggle_completed_btn') {
const session = userSessions.get(interaction.user.id);
if (!session) return await interaction.reply({ content: 'Session expired. Log in again!', flags: 64 });
session.showCompleted = !session.showCompleted;
session.selectedHwId = null;
return await interaction.update(buildSparxDashboard(session));
}
if (interaction.customId === 'run_selected_hw_btn') {
const session = userSessions.get(interaction.user.id);
if (!session) return await interaction.reply({ content: 'Session expired — click Sparx Login once to refresh!', flags: 64 });
if (!session.selectedHwId && session.homeworks && session.homeworks.length > 0) {
const fallback = session.homeworks.find(h => !h.completed) || session.homeworks.at(0);
session.selectedHwId = fallback.id;
}
if (!session.selectedHwId) return await interaction.reply({ content: 'Select a homework first!', flags: 64 });
const targetHw = session.homeworks.find(h => h.id === session.selectedHwId);
const startedContainer = new ContainerBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("### 💬 Your task has started in Direct Messages!")
        );
      await interaction.update({
        flags: MessageFlags.IsComponentsV2,
        components: [startedContainer]
      });
runHomeworkInDM(interaction.user, session, targetHw).catch(async () => {
await interaction.followUp({
content: 'I could not send you a DM! Please enable Direct Messages from server members in your Discord Privacy Settings.',
flags: 64
});
});
return;
}
}
if (interaction.isStringSelectMenu()) {
if (interaction.customId === 'manage_saved_account_menu') {
      const idx = Number(interaction.values[0]);
      const list = getSavedList(interaction.user.id);
      const acc = list[idx];
      if (!acc) return await interaction.update({ ...buildSavedAccountsMenu(interaction.user.id), embeds: [] });

      const baseMenu = buildSavedAccountsMenu(interaction.user.id, idx);
      const container = baseMenu.components[0];
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**Selected:** ${acc.isMicrosoft ? 'Microsoft' : 'Sparx'} — **${acc.username}** (${acc.school})`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('quick_login_saved_' + idx).setLabel('▶ Sign In').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('delete_saved_' + idx).setLabel('🗑 Delete').setStyle(ButtonStyle.Danger)
          )
        );

      return await interaction.update({
        flags: MessageFlags.IsComponentsV2,
        embeds: [],
        components: [container]
      });
    }

    if (interaction.customId === 'select_homework_menu') {
const val = interaction.values.at(0);
session.selectedHwId = val === 'none_completed' ? null : val;
return await interaction.update(buildSparxDashboard(session));
}
if (interaction.customId === 'select_speed_menu') {
session.speed = interaction.values.at(0);
return await interaction.update(buildSparxDashboard(session));
}
}
if (interaction.isModalSubmit() && (interaction.customId === 'sparx_login_modal' || interaction.customId === 'ms_login_modal')) {
await interaction.deferReply({ flags: 64 });
const isMicrosoft = interaction.customId === 'ms_login_modal';
const school = interaction.fields.getTextInputValue('school_input');
const username = interaction.fields.getTextInputValue('username_input');
const password = interaction.fields.getTextInputValue('password_input');
      const platform = (interaction.fields.getStringSelectValues ? interaction.fields.getStringSelectValues('platform_input')?.at(0) : null) || 'maths';
await performSparxLogin(interaction, { school, username, password, isMicrosoft, platform });
}
} catch (err) {
console.error('[INTERACTION ERROR]', err);
}
});
client.login(process.env.DISCORD_TOKEN);
