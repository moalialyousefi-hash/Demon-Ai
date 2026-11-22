const http = require("http"); http.createServer((req, res) => res.end("Demon AI is online!")).listen(process.env.PORT || 3000);
require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder
} = require('discord.js');
const puppeteer = require('puppeteer-core');
const { loginToSparx, runHomeworkInDM } = require('./solver');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });
const savedAccounts = new Map();
const userSessions = new Map();

const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Post the Demon AI control panel in this channel')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('Dashboard /setup command registered!');
})();

function buildSparxDashboard(session) {
  const visible = session.showCompleted ? session.homeworks : session.homeworks.filter(h => !h.completed);
  const selectedHw = visible.find(h => h.id === session.selectedHwId);
  const estTime = selectedHw ? (session.speed === 'quick' ? '~2 mins' : session.speed === 'normal' ? '~5 mins' : '~10 mins') : 'Select a homework';
  const speedLabels = { quick: 'Quick • 10-20s', normal: 'Normal • 30-45s', slow: 'Human • 1-2m' };

  const embed = new EmbedBuilder()
    .setTitle('Sparx Maths')
    .setDescription(
      'Welcome, **' + session.studentName + '**!\n' +
      'Select a homework below and it will be completed for you automatically.\n\n' +
      '📄 **PDF:** Answers ✅ • Questions ❌ • Working Out ❌\n' +
      '🎯 **Bookwork Accuracy:** `100%`\n' +
      '⏱️ **Time Per Question:** `' + speedLabels[session.speed] + '`\n' +
      '⏳ **Estimated Time:** `' + estTime + '`'
    )
    .setColor('#2B2D31');

  const hwOptions = visible.length > 0
    ? visible.slice(0, 25).map(h => ({
        label: h.title.slice(0, 100),
        description: h.completed ? 'Status: Completed' : 'Status: Incomplete — Click to start!',
        value: h.id,
        emoji: h.completed ? '✅' : '📝',
        default: h.id === session.selectedHwId
      }))
    : [{ label: 'All homeworks completed ✅', description: 'Click "Show Completed" below', value: 'none_completed', default: true }];

  const hwMenu = new StringSelectMenuBuilder().setCustomId('select_homework_menu').setPlaceholder('Select a homework...').addOptions(hwOptions);
  const speedMenu = new StringSelectMenuBuilder().setCustomId('select_speed_menu').setPlaceholder('Select speed...').addOptions([
    { label: 'Quick (10-20s)', value: 'quick', default: session.speed === 'quick' },
    { label: 'Normal (30-45s)', value: 'normal', default: session.speed === 'normal' },
    { label: 'Human (1-2m)', value: 'slow', default: session.speed === 'slow' }
  ]);

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('run_selected_hw_btn').setLabel('▶ Start Selected').setStyle(ButtonStyle.Success).setDisabled(!selectedHw),
    new ButtonBuilder().setCustomId('toggle_completed_btn').setLabel(session.showCompleted ? 'Hide Completed' : 'Show Completed').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('indep_learning_btn').setLabel('Independent Learning').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('xp_farmer_btn').setLabel('XP Farmer').setStyle(ButtonStyle.Secondary)
  );

  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(hwMenu),
      new ActionRowBuilder().addComponents(speedMenu),
      actionRow
    ]
  };
}

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    const botAvatar = client.user.displayAvatarURL({ extension: 'png', size: 256 });
    const embed = new EmbedBuilder()
      .setTitle(client.user.username)
      .setDescription(
        'Choose your login method below to open your Sparx Maths dashboard.\n\n' +
        '• **▶ Sparx Login** — For standard Sparx username & password\n' +
        '• **🪟 Microsoft Login** — For school Microsoft 365 email & password\n' +
        '• **Live DM Progress** — Sends task progress bars directly to your DMs'
      )
      .setColor('#00B4D8')
      .setThumbnail(botAvatar)
      .setFooter({ text: 'Demon AI • Automated Homework Assistant', iconURL: botAvatar });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('start_sparx_btn').setLabel('▶ Sparx Login').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('start_ms_btn').setLabel('🪟 Microsoft Login').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('saved_account_btn').setLabel('Saved Account').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('help_btn').setLabel('Help').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ content: 'Control panel created!', ephemeral: true });
    await interaction.channel.send({ embeds: [embed], components: [row] });
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'start_sparx_btn' || interaction.customId === 'start_ms_btn') {
      const isMs = interaction.customId === 'start_ms_btn';
      const saved = savedAccounts.get(interaction.user.id) || { school: '', username: '', password: '' };
      const modal = new ModalBuilder().setCustomId(isMs ? 'ms_login_modal' : 'sparx_login_modal').setTitle(isMs ? 'Microsoft School Login' : 'Sparx Account Login');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('school_input').setLabel('School Name').setStyle(TextInputStyle.Short).setValue(saved.school).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username_input').setLabel(isMs ? 'School Microsoft Email' : 'Sparx Username').setStyle(TextInputStyle.Short).setValue(saved.username).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('password_input').setLabel(isMs ? 'Microsoft Password' : 'Sparx Password').setStyle(TextInputStyle.Short).setValue(saved.password).setRequired(true))
      );
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'saved_account_btn') {
      const saved = savedAccounts.get(interaction.user.id);
      return interaction.reply({ content: saved ? 'Saved login: **' + saved.school + '** (' + saved.username + ')' : 'No saved login yet.', ephemeral: true });
    }

    if (interaction.customId === 'help_btn') {
      return interaction.reply({ content: '1. Click **▶ Sparx Login** or **🪟 Microsoft Login**.\n2. Pick a homework and click **▶ Start Selected**.\n3. Check your **Direct Messages** for live progress bars!', ephemeral: true });
    }

    if (interaction.customId === 'toggle_completed_btn') {
      const session = userSessions.get(interaction.user.id);
      if (!session) return interaction.reply({ content: 'Session expired. Log in again!', ephemeral: true });
      session.showCompleted = !session.showCompleted;
      session.selectedHwId = null;
      return interaction.update(buildSparxDashboard(session));
    }

    if (interaction.customId === 'indep_learning_btn' || interaction.customId === 'xp_farmer_btn') {
      const session = userSessions.get(interaction.user.id);
      if (!session) return interaction.reply({ content: 'Session expired. Log in again!', ephemeral: true });
      session.selectedHwId = session.homeworks[0] ? session.homeworks[0].id : null;
      return interaction.update(buildSparxDashboard(session));
    }

    // Start in DMs!
    if (interaction.customId === 'run_selected_hw_btn') {
      const session = userSessions.get(interaction.user.id);
      if (!session || !session.selectedHwId) return interaction.reply({ content: 'Select a homework first!', ephemeral: true });

      const targetHw = session.homeworks.find(h => h.id === session.selectedHwId);

      // Update channel ephemeral message to say "Your task has started in DMs" (like Lumen!)
      await interaction.update({
        content: 'Your task has started in **Direct Messages** 💬',
        embeds: [],
        components: []
      });

      // Run the live progress bar tracker inside the user's DMs
      runHomeworkInDM(interaction.user, session, targetHw).catch(async () => {
        await interaction.followUp({
          content: 'I could not send you a DM! Please enable **Direct Messages** from server members in your Discord Privacy Settings.',
          ephemeral: true
        });
      });
      return;
    }
  }

  if (interaction.isStringSelectMenu()) {
    const session = userSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: 'Session expired. Log in again!', ephemeral: true });

    if (interaction.customId === 'select_homework_menu') {
      const val = interaction.values[0];
      session.selectedHwId = val === 'none_completed' ? null : val;
      return interaction.update(buildSparxDashboard(session));
    }
    if (interaction.customId === 'select_speed_menu') {
      session.speed = interaction.values[0];
      return interaction.update(buildSparxDashboard(session));
    }
  }

  if (interaction.isModalSubmit() && (interaction.customId === 'sparx_login_modal' || interaction.customId === 'ms_login_modal')) {
    await interaction.deferReply({ ephemeral: true });
    const isMicrosoft = interaction.customId === 'ms_login_modal';
    const school = interaction.fields.getTextInputValue('school_input');
    const username = interaction.fields.getTextInputValue('username_input');
    const password = interaction.fields.getTextInputValue('password_input');

    savedAccounts.set(interaction.user.id, { school, username, password });

    let browser;
try {
await interaction.editReply('Logging into Sparx and loading your homework list...');
browser = await puppeteer.connect({ browserWSEndpoint: 'wss://production-sfo.browserless.io?token=' + process.env.BROWSERLESS_TOKEN });
const page = await browser.newPage();
await loginToSparx(page, school, username, password, isMicrosoft);
const scraped = await page.evaluate(() => {
const h = document.querySelector('h1, h2');
const name = (h && h.innerText.includes('Hey ')) ? h.innerText.replace('Hey ', '').replace(',', '').trim() : 'Student';
const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
const homeworks = [];
for (let i = 0; i < lines.length; i++) {
if (lines[i].startsWith('Homework due ')) {
const nearby = lines.slice(i, i + 4).join(' ');
homeworks.push({ id: 'hw_' + homeworks.length, title: lines[i], completed: nearby.includes('Completed') });
}
}
return { name, homeworks };
});
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
await interaction.editReply(buildSparxDashboard(session));
} catch (err) {
await interaction.editReply('Stopped early: ' + err.message);
} finally {
if (browser) await browser.close();
}
}
});
client.login(process.env.DISCORD_TOKEN);
