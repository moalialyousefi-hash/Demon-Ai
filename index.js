const http = require('http');
http.createServer((req, res) => res.end('Demon AI is online!')).listen(process.env.PORT || 3000, '0.0.0.0');

require('dotenv').config();
const {
  Client, GatewayIntentBits, AttachmentBuilder, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder
} = require('discord.js');
const { loginToSparx, runHomeworkInDM, getFastBrowser } = require('./solver');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const savedAccounts = new Map();
const userSessions = new Map();

client.on('error', err => console.error('[DISCORD CLIENT ERROR]', err));

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
    .setTitle('Demon AI • Sparx Maths')
    .setDescription(
      'Welcome back, **' + session.studentName + '**!\n' +
      'School: `' + session.school + '`\n' +
      'Selected Task: **' + (selectedHw ? selectedHw.title : 'None selected') + '**\n\n' +
      'Pick a homework and speed below, then click **▶ Start Selected**.'
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
    new ButtonBuilder().setCustomId('run_selected_hw_btn').setLabel('▶ Start Selected').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('toggle_completed_btn').setLabel(session.showCompleted ? 'Hide Completed' : 'Show Completed').setStyle(ButtonStyle.Secondary)
  );

  return { content: '', embeds: [embed], components: [hwRow, speedRow, btnRow] };
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
      const embed = new EmbedBuilder()
        .setTitle('Demon ai')
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription(
          'Choose your login method below to open your Sparx Maths dashboard.\n\n' +
          '• **▶ Sparx Login** — For standard Sparx username & password\n' +
          '• **🪟 Microsoft Login** — For school Microsoft 365 email & password\n' +
          '• **Live DM Progress** — Sends task progress bars directly to your DMs'
        )
        .setFooter({ text: 'Demon AI • Automated Homework Assistant', iconURL: client.user.displayAvatarURL() })
        .setColor('#1DB954');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_sparx_modal').setLabel('▶ Sparx Login').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('open_ms_modal').setLabel('🪟 Microsoft Login').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('saved_account_btn').setLabel('Saved Account').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_btn').setLabel('Help').setStyle(ButtonStyle.Secondary)
      );

      return await interaction.reply({ embeds: [embed], components: [row] });
    }

    if (interaction.isButton()) {
      if (interaction.customId.includes('sparx') || interaction.customId.includes('ms')) {
        const isMs = interaction.customId.includes('ms');
        const saved = savedAccounts.get(interaction.user.id) || { school: '', username: '', password: '' };
        const modal = new ModalBuilder()
          .setCustomId(isMs ? 'ms_login_modal' : 'sparx_login_modal')
          .setTitle(isMs ? 'Microsoft Sparx Login' : 'Sparx Maths Login');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('school_input').setLabel('School Name').setStyle(TextInputStyle.Short).setValue(saved.school).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('username_input').setLabel('Username or Email').setStyle(TextInputStyle.Short).setValue(saved.username).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('password_input').setLabel('Password').setStyle(TextInputStyle.Short).setValue(saved.password).setRequired(true)
          )
        );
        return await interaction.showModal(modal);
      }

      if (interaction.customId === 'saved_account_btn') {
        const saved = savedAccounts.get(interaction.user.id);
        return await interaction.reply({ content: saved ? 'Saved login: **' + saved.school + '** (' + saved.username + ')' : 'No saved login yet.', ephemeral: true });
      }

      if (interaction.customId === 'help_btn') {
        return await interaction.reply({ content: '1. Click **▶ Sparx Login** or **🪟 Microsoft Login**.\n2. Pick a homework and click **▶ Start Selected**.\n3. Check your **Direct Messages** for live progress bars!', ephemeral: true });
      }

      if (interaction.customId === 'toggle_completed_btn') {
        const session = userSessions.get(interaction.user.id);
        if (!session) return await interaction.reply({ content: 'Session expired. Log in again!', ephemeral: true });
        session.showCompleted = !session.showCompleted;
        session.selectedHwId = null;
        return await interaction.update(buildSparxDashboard(session));
      }

      if (interaction.customId === 'run_selected_hw_btn') {
        const session = userSessions.get(interaction.user.id);
        if (!session || !session.selectedHwId) return await interaction.reply({ content: 'Select a homework first!', ephemeral: true });

        const targetHw = session.homeworks.find(h => h.id === session.selectedHwId);
        await interaction.update({
          content: 'Your task has started in **Direct Messages** 💬',
          embeds: [],
          components: []
        });

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
      if (!session) return await interaction.reply({ content: 'Session expired. Log in again!', ephemeral: true });

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
      console.log("[M1] deferReply start"); await interaction.deferReply({ flags: 64 }); console.log("[M2] deferReply done");
      const isMicrosoft = interaction.customId === 'ms_login_modal';
      const school = interaction.fields.getTextInputValue('school_input');
      const username = interaction.fields.getTextInputValue('username_input');
      const password = interaction.fields.getTextInputValue('password_input');

      savedAccounts.set(interaction.user.id, { school, username, password });

      let browser;
      let page;
      let statusTicker;
      let seconds = 0;

      try {
        await interaction.editReply('Step 1/3: Connecting to browser (0s)...');
        statusTicker = setInterval(() => {
          seconds += 5;
          interaction.editReply('Logging into Sparx Maths (' + seconds + 's elapsed)...').catch(() => {});
        }, 5000);

        console.log("[M3] getFastBrowser start"); console.log("[M3] browser"); browser = await getFastBrowser(); console.log("[M4] page"); console.log("[M4] getFastBrowser done");
        page = await browser.newPage();
        console.log("[M5] loginToSparx start"); console.log("[M5] login"); await loginToSparx(page, school, username, password, isMicrosoft); console.log("[M6] loginToSparx done");

        clearInterval(statusTicker);
        await interaction.editReply('Step 3/3: Reading your homework list...');

        await page.waitForFunction(() => document.body && document.body.innerText.includes('Homework'), { timeout: 3000 }).catch(() => {});
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
clearInterval(statusTicker);
console.error('[LOGIN ERROR]', err);
const files = err.screenshot ? [new AttachmentBuilder(err.screenshot, { name: 'login_stuck.png' })] : [];
await interaction.editReply({ content: 'Stopped early: ' + err.message, files });
} finally {
clearInterval(statusTicker);
if (page) await page.close().catch(() => {});
if (browser) await (browser.disconnect ? browser.disconnect() : browser.close()).catch(() => {});
}
}
} catch (err) {
console.error('[INTERACTION ERROR]', err);
}
});
client.login(process.env.DISCORD_TOKEN);
