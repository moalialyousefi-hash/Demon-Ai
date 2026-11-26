const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const emojis = require('./emojis.json');

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://groq.com'
});

// Cache Sparx session cookies in memory per account so logins & task starts take ~2 seconds
const cookieJar = new Map();

async function getFastBrowser() {
  if (process.env.BROWSERLESS_TOKEN) {
    console.log("[STEP] Connecting to Browserless...");
    console.log("[STEP] Connecting to Browserless...");
    console.log("[STEP] Connecting to Browserless...");
    return await puppeteer.connect({
      browserWSEndpoint: "wss://chrome.browserless.io?token=" + process.env.BROWSERLESS_TOKEN.trim()
    });
  }
  return await puppeteer.launch({
    headless: true,
    protocolTimeout: 45000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote"]
  });
}

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
  const speedLabels = { quick: 'Quick', normal: 'Normal', slow: 'Human' };
  const taskLines = tasks
    .map((t, idx) => '**Task ' + (idx + 1) + '**\n' + makeEmojiBar(t.done, t.total))
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setTitle('Demon AI • Maths')
    .setDescription(
      '**Account:** `Saved` | `' + speedLabels[session.speed] + '` | `' + session.studentName + '`\n' +
      '**Task:** `Homework`\n' +
      '**Status:** ' + statusText + '\n\n' +
      'Page **1** of **1**\n' + taskLines
    )
    .setColor('#2B2D31');

  return { embeds: [embed], files: extraFiles };
}

async function dismissCookies(page) {
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const accept = btns.find(b => b.innerText && b.innerText.trim().toUpperCase().includes('ACCEPT'));
    if (accept) accept.click();
  }).catch(() => {});
}

async function loginToSparxCore(page, school, username, password, isMicrosoft, state) {
  let lightMode = true;
  const cacheKey = (school + ':' + username).toLowerCase();

  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

  // Block heavy stylesheets, images, fonts & analytics during login to cut Render CPU load by ~75%
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (url.includes('sentry') || url.includes('google-analytics') || url.includes('googletagmanager') || url.includes('hotjar')) {
      return req.abort().catch(() => {});
    }
    if (lightMode && ['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      return req.abort().catch(() => {});
    }
    req.continue().catch(() => {});
  });

  // 1. Fast path: try cached session cookies first (~2 seconds!)
  const savedCookies = cookieJar.get(cacheKey);
  if (savedCookies && savedCookies.length > 0) {
    state.step = 'Restoring saved session';
    await page.setCookie(...savedCookies).catch(() => {});
    await page.goto('https://sparxmaths.uk', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => document.body && document.body.innerText.includes('Homework'), { timeout: 5000 }).catch(() => {});
    const isLoggedIn = await page.evaluate(() => document.body && document.body.innerText.includes('Homework'));
    if (isLoggedIn) {
      lightMode = false;
      await dismissCookies(page);
      return;
    }
    cookieJar.delete(cacheKey);
  }

  // 2. Full lightweight login (runs only on first login or when cookies expire)
  state.step = 'Opening Sparx login'; console.log("[STEP]", state.step); console.log("[STEP]", state.step); console.log("[STEP]", state.step);
  await page.goto('https://sparxmaths.uk', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await dismissCookies(page);

  state.step = 'Typing school name'; console.log("[STEP]", state.step); console.log("[STEP]", state.step); console.log("[STEP]", state.step);
  await page.waitForSelector('input', { timeout: 12000 });
  await page.evaluate(() => {
    const inp = document.querySelector('input');
    if (inp) inp.focus();
  });
  await page.keyboard.type(school, { delay: 1 });
  await new Promise(r => setTimeout(r, 250));

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

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const contBtn = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'continue');
    if (contBtn) contBtn.click();
  });

  await dismissCookies(page);

  if (isMicrosoft) {
    state.step = 'Microsoft sign-in'; console.log("[STEP]", state.step); console.log("[STEP]", state.step); console.log("[STEP]", state.step);
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const msBtn = buttons.find(b => b.innerText && b.innerText.toLowerCase().includes('microsoft'));
      if (msBtn) msBtn.click();
    });
    await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 12000 });
    await page.type('input[type="email"], input[name="loginfmt"]', username);
    await page.click('input[type="submit"], #idSIButton9');
    await new Promise(r => setTimeout(r, 600));
    await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 12000 });
    await page.type('input[type="password"], input[name="passwd"]', password);
    await page.click('input[type="submit"], #idSIButton9');
    await new Promise(r => setTimeout(r, 600));
    const stayBtn = await page.$('#idSIButton9');
    if (stayBtn) await stayBtn.click();
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  } else {
    state.step = 'Entering username & password'; console.log("[STEP]", state.step); console.log("[STEP]", state.step); console.log("[STEP]", state.step);
    await page.waitForSelector('input[type="password"]', { timeout: 12000 });
    await dismissCookies(page);
    const inputs = await page.$$('input:not([type="hidden"])');
    if (inputs.at(0)) await inputs.at(0).type(username);
    if (inputs.at(1)) await inputs.at(1).type(password);
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  }

  state.step = 'Loading Homework dashboard'; console.log("[STEP]", state.step); console.log("[STEP]", state.step); console.log("[STEP]", state.step);
  await page.waitForFunction(() => document.body && document.body.innerText.includes('Homework'), { timeout: 5000 }).catch(() => {});
  await dismissCookies(page);

  // Save session cookies for instant ~2s future logins & task starts
  const freshCookies = await page.cookies().catch(() => []);
  if (freshCookies.length > 0) cookieJar.set(cacheKey, freshCookies);

  // Re-enable images & stylesheets so Groq AI can see math diagrams clearly
  lightMode = false;
  console.log("[STEP] Login finished!");
}

async function loginToSparx(page, school, username, password, isMicrosoft) {
  const state = { step: 'Launching Chrome' };
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timed out at step: ' + state.step)), 50000)
  );
  await Promise.race([
    loginToSparxCore(page, school, username, password, isMicrosoft, state),
    timeoutPromise
  ]);
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
    browser = await getFastBrowser();
    page = await browser.newPage();

    await loginToSparx(page, session.school, session.username, session.password, session.isMicrosoft);

    // Reload with full CSS & images enabled before taking screenshots for Groq AI
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    await dismissCookies(page);

    await dmMsg.edit(
      buildProgressPayload(session, targetHw.title, 'Opening ' + targetHw.title + '...', tasks)
    );

    await page.evaluate((hwTitle) => {
      const rows = Array.from(document.querySelectorAll('div, button, a, span'));
      const target = rows.find(el => el.innerText && el.innerText.includes(hwTitle) && el.innerText.length < 150);
      if (target) target.click();
    }, targetHw.title);
    await new Promise(r => setTimeout(r, 700));

    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button, div'));
      const taskItem = links.find(el =>
        el.innerText && (el.innerText.includes('1A') || el.innerText.includes('Task 1') || el.getAttribute('href')?.includes('/task/'))
      );
      if (taskItem) taskItem.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    await dismissCookies(page);

    for (let i = 0; i < 6; i++) {
      tasks.at(0).done = i;
      const qCode = '1' + String.fromCharCode(65 + i);

      await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Solving ' + qCode + ' in Task 1...', tasks)
);
const isBookwork = await page.evaluate(() => document.body.innerText.includes('Bookwork check'));
if (isBookwork) {
const codeNeeded = await page.evaluate(() => {
const m = document.body.innerText.match(/Bookwork code:\s*([A-Z0-9]+)/i);
return m ? m.at(1) : null;
});
if (codeNeeded && bookworkLog[codeNeeded]) {
await page.evaluate((ans) => {
const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes(ans));
if (btn) btn.click();
}, bookworkLog[codeNeeded]);
await new Promise(r => setTimeout(r, 800));
continue;
}
}
const shot = await page.screenshot({ encoding: 'base64' });
const currentCode = await page.evaluate(() => {
const m = document.body.innerText.match(/Bookwork code:\s*([A-Z0-9]+)/i);
return m ? m.at(1) : null;
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
const answer = res.choices.at(0).message.content.trim();
if (currentCode) bookworkLog[currentCode] = answer;
await new Promise(r => setTimeout(r, delayMs));
const inputSel = 'input[type="text"], input[type="number"]';
if (await page.$(inputSel)) {
await page.click(inputSel, { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type(inputSel, answer, { delay: 30 });
} else {
await page.evaluate((ans) => {
const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
const opt = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === ans.toLowerCase());
if (opt) opt.click();
}, answer);
}
await page.evaluate(() => {
const btns = Array.from(document.querySelectorAll('button'));
const sub = btns.find(b => b.innerText && ['submit', 'check', 'answer'].some(w => b.innerText.toLowerCase().includes(w)));
if (sub) sub.click();
});
await new Promise(r => setTimeout(r, 1200));
await page.evaluate(() => {
const btns = Array.from(document.querySelectorAll('button'));
const next = btns.find(b => b.innerText && ['next', 'continue'].some(w => b.innerText.toLowerCase().includes(w)));
if (next) next.click();
});
await new Promise(r => setTimeout(r, 1000));
}
tasks.at(0).done = 6;
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Completed ✅', tasks)
);
} catch (err) {
const errShot = page ? await page.screenshot().catch(() => null) : null;
const files = errShot ? [new AttachmentBuilder(errShot, { name: 'error.png' })] : [];
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Stopped: ' + err.message, tasks, files)
);
} finally {
if (page) await page.close().catch(() => {});
if (browser) await (browser.disconnect ? browser.disconnect() : browser.close()).catch(() => {});
}
}
module.exports = { loginToSparx, runHomeworkInDM, getFastBrowser };
