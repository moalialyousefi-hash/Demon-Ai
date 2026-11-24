const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const emojis = require("./emojis.json");

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://groq.com'
});

function makeEmojiBar(done, total) {
  const segments = 12;
  const filled = Math.round((done / total) * segments);
  let bar = filled >= 1 ? emojis.left_full : emojis.left_empty;
  for (let i = 1; i < segments - 1; i++) {
    bar += i < filled ? emojis.mid_full : emojis.mid_empty;
  }
  bar += filled >= segments ? emojis.right_full : emojis.right_empty;
  return bar;
}

function buildProgressPayload(session, taskTitle, statusText, tasks, extraFiles = []) {
  const speedLabels = { quick: "Quick", normal: "Normal", slow: "Human" };
  const taskLines = tasks.map((t, idx) => "**Task " + (idx + 1) + "**\n" + makeEmojiBar(t.done, t.total)).join("\n\n");
  const embed = new EmbedBuilder()
    .setTitle("Demon AI • Maths")
    .setDescription(
      "**Account:** `Saved` | `" + speedLabels[session.speed] + "` | `" + session.studentName + "`\n" +
      "**Task:** `Homework`\n" +
      "**Status:** " + statusText + "\n\n" +
      "Page **1** of **1**\n" + taskLines
    )
    .setColor("#2B2D31");
  return { embeds: [embed], files: extraFiles };
}

async function dismissCookies(page) {
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const accept = btns.find(b => b.innerText && b.innerText.trim().toUpperCase().includes('ACCEPT'));
    if (accept) accept.click();
  });
}

async function loginToSparx(page, school, username, password, isMicrosoft) {
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

  await page.goto('https://sparxmaths.uk', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 500));
  await dismissCookies(page);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    const loginBtn = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'log in');
    if (loginBtn) loginBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  await page.waitForSelector('input', { timeout: 15000 });
  await page.click('input');
  await page.type('input', school, { delay: 10 });
  await new Promise(r => setTimeout(r, 500));

  await page.evaluate((schoolName) => {
    const cleanQuery = schoolName.toLowerCase().replace(/\s+/g, '');
    const items = Array.from(document.querySelectorAll('li, [role="option"], button, div'));
    const match = items.find(el => {
      if (!el.innerText || el.innerText.length > 150 || el.innerText.length < 4) return false;
      const cleanText = el.innerText.toLowerCase().replace(/\s+/g, '');
      return cleanText.includes(cleanQuery) && !el.querySelector('input');
    });
    if (match) match.click();
  }, school);
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 300));

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const contBtn = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'continue');
    if (contBtn) contBtn.click();
  });
  await new Promise(r => setTimeout(r, 700));
  await dismissCookies(page);

  if (isMicrosoft) {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const msBtn = buttons.find(b => b.innerText && b.innerText.toLowerCase().includes('microsoft'));
      if (msBtn) msBtn.click();
    });
    await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 15000 });
    await page.type('input[type="email"], input[name="loginfmt"]', username);
    await page.click('input[type="submit"], #idSIButton9');
    await new Promise(r => setTimeout(r, 900));
    await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 15000 });
    await page.type('input[type="password"], input[name="passwd"]', password);
    await page.click('input[type="submit"], #idSIButton9');
    await new Promise(r => setTimeout(r, 900));
    const stayBtn = await page.$('#idSIButton9');
    if (stayBtn) await stayBtn.click();
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  } else {
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    await dismissCookies(page);
    const inputs = await page.$$('input:not([type="hidden"])');
    await inputs.at(0).type(username);
    await inputs.at(1).type(password);
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  }

  await new Promise(r => setTimeout(r, 700));
  await dismissCookies(page);
}

async function runHomeworkInDM(user, session, targetHw) {
  const delayMs = session.speed === 'quick' ? 12000 : session.speed === 'normal' ? 30000 : 60000;
  const tasks = [
    { done: 0, total: 6 },
    { done: 0, total: 6 },
    { done: 0, total: 6 },
    { done: 0, total: 6 }
  ];

  const dmMsg = await user.send(
    buildProgressPayload(session, targetHw.title, 'Connecting to Sparx Maths...', tasks)
  );

  let browser;
  let page;
  const bookworkLog = {};

  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();

    await loginToSparx(page, session.school, session.username, session.password, session.isMicrosoft);

    await dmMsg.edit(
      buildProgressPayload(session, targetHw.title, 'Opening ' + targetHw.title + '...', tasks)
    );

    // Expand selected homework accordion
    await page.evaluate((hwTitle) => {
      const rows = Array.from(document.querySelectorAll('div, button, a, span'));
      const target = rows.find(el => el.innerText && el.innerText.includes(hwTitle) && el.innerText.length < 150);
      if (target) target.click();
    }, targetHw.title);
    await new Promise(r => setTimeout(r, 700));

    // Click first task item inside it
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button, div'));
      const taskItem = links.find(el =>
        el.innerText && (el.innerText.includes('1A') || el.innerText.includes('Task 1') || el.getAttribute('href')?.includes('/task/'))
      );
      if (taskItem) taskItem.click();
    });
    await new Promise(r => setTimeout(r, 900));

    for (let i = 0; i < 6; i++) {
      tasks.done = i;
      const qCode = '1' + String.fromCharCode(65 + i);

      await dmMsg.edit(
        buildProgressPayload(session, targetHw.title, 'Solving ' + qCode + ' in Task 1...', tasks)
      );

      const isBookwork = await page.evaluate(() => document.body.innerText.includes('Bookwork check'));
      if (isBookwork) {
        const codeNeeded = await page.evaluate(() => {
          const m = document.body.innerText.match(/Bookwork code:\s*([A-Z0-9]+)/i);
          return m ? m : null;
        });
        if (codeNeeded && bookworkLog[codeNeeded]) {
          await page.evaluate((ans) => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes(ans));
            if (btn) btn.click();
          }, bookworkLog[codeNeeded]);
          await new Promise(r => setTimeout(r, 700));
          continue;
        }
      }

      const shot = await page.screenshot({ encoding: 'base64' });
      const currentCode = await page.evaluate(() => {
        const m = document.body.innerText.match(/Bookwork code:\s*([A-Z0-9]+)/i);
        return m ? m : null;
      });

      const res = await groq.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Solve this Sparx Maths question. Reply with ONLY the exact final number, expression, or option text to type into the answer box. No explanations.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + shot } }
          ]
        }],
        max_tokens: 100
      });

      const answer = res.choices.message.content.trim();
      if (currentCode) bookworkLog[currentCode] = answer;

      await new Promise(r => setTimeout(r, delayMs));

      const inputSel = 'input[type="text"], input[type="number"]';
      if (await page.$(inputSel)) {
        await page.click(inputSel, { clickCount: 3 });
        await page.type(inputSel, answer);
        await page.keyboard.press('Enter');
      } else {
        await page.evaluate((ans) => {
const match = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => el.innerText.trim() === ans);
if (match) match.click();
}, answer);
}
await new Promise(r => setTimeout(r, 700));
await page.evaluate(() => {
const nextBtn = Array.from(document.querySelectorAll('button')).find(b =>
b.innerText && (b.innerText.includes('Next') || b.innerText.includes('Continue') || b.innerText.includes('Submit'))
);
if (nextBtn) nextBtn.click();
});
await new Promise(r => setTimeout(r, 700));
}
tasks.done = 6;
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Completed ✅', tasks)
);
} catch (err) {
console.error(err);
const debugShot = page ? await page.screenshot().catch(() => null) : null;
await dmMsg.edit(
buildProgressPayload(
session,
targetHw.title,
'Stopped: ' + err.message,
tasks,
debugShot ? [new AttachmentBuilder(debugShot, { name: 'debug.png' })] : []
)
);
} finally {
if (browser) await browser.close();
}
}
module.exports = { loginToSparx, runHomeworkInDM };
