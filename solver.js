const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const emojis = require('./emojis.json');

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://groq.com'
});

const cookieJar = new Map();

async function getFastBrowser() {
  if (process.env.BROWSERLESS_TOKEN) {
    const token = process.env.BROWSERLESS_TOKEN.trim();
    const endpoints = [
      'wss://production-sfo.browserless.io?token=' + token,
      'wss://production-lon.browserless.io?token=' + token
    ];
    for (const ep of endpoints) {
      try {
        console.log('[STEP] Connecting to Browserless:', ep.split('?')[0]);
        return await Promise.race([
          puppeteer.connect({ browserWSEndpoint: ep }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('4s timeout')), 4000))
        ]);
      } catch (e) {
        console.log('[BROWSERLESS SKIP]', ep.split('?')[0], e.message);
      }
    }
  }
  console.log('[STEP] Launching local Chrome...');
  return await puppeteer.launch({
    headless: true,
    protocolTimeout: 30000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--renderer-process-limit=1']
  });
}

async function realMouseClick(page, x, y) {
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
}

async function scanAndClick(page, matcherFn, arg = null) {
  const box = await page.evaluate((fnStr, passedArg) => {
    const fn = new Function('el', 'arg', 'return (' + fnStr + ')(el, arg);');
    const candidates = Array.from(document.querySelectorAll('button, a, input, li, [role="option"], [role="button"], div, span'));
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (fn(el, passedArg)) {
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  }, matcherFn.toString(), arg);

  if (box) {
    await realMouseClick(page, box.x, box.y);
    return true;
  }
  return false;
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
  await scanAndClick(page, (el) => {
    if (!['BUTTON', 'A'].includes(el.tagName) && el.getAttribute('role') !== 'button') return false;
    const t = (el.innerText || '').trim().toLowerCase();
    return ['accept all', 'accept cookies', 'accept', 'allow all', 'i agree'].some(w => t.includes(w));
  }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]').forEach(el => {
      if (el.offsetHeight > 40 && el.innerText && el.innerText.toLowerCase().includes('cookie')) el.remove();
    });
  }).catch(() => {});
}

async function loginToSparxCore(page, school, username, password, isMicrosoft, state) {
  const cacheKey = (school + ':' + username).toLowerCase();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

  const savedCookies = cookieJar.get(cacheKey);
  if (savedCookies && savedCookies.length > 0) {
    state.step = 'Restoring saved session';
    console.log('[STEP]', state.step);
    await page.setCookie(...savedCookies).catch(() => {});
    await page.goto('https://sparxmaths.uk', { waitUntil: 'domcontentloaded', timeout: 12000 });
    await page.waitForFunction(() => document.body && document.body.innerText.includes('Homework'), { timeout: 3000 }).catch(() => {});
    const isLoggedIn = await page.evaluate(() => document.body && document.body.innerText.includes('Homework'));
    if (isLoggedIn) {
      await dismissCookies(page);
      console.log('[STEP] Restored session in ~2s!');
      return;
    }
    cookieJar.delete(cacheKey);
  }

  state.step = 'Opening Sparx student login';
  console.log('[STEP]', state.step);
  await page.goto('https://sparxmaths.uk', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 400));
  await dismissCookies(page);

  state.step = 'Typing school name';
  console.log('[STEP]', state.step);
  await page.waitForSelector('input', { timeout: 10000 });
  await scanAndClick(page, (el) => el.tagName === 'INPUT' && el.type !== 'hidden');
  await page.keyboard.type(school, { delay: 10 });
  await new Promise(r => setTimeout(r, 500));

  state.step = 'Selecting school from dropdown';
  console.log('[STEP]', state.step);
  const clickedSchool = await scanAndClick(page, (el, schoolName) => {
    if (el.tagName === 'INPUT' || el.querySelector('input')) return false;
    const txt = (el.innerText || '').trim();
    if (txt.length < 4 || txt.length > 140) return false;
    return txt.toLowerCase().replace(/\s+/g, '').includes(schoolName.toLowerCase().replace(/\s+/g, ''));
  }, school);

  if (!clickedSchool) {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
  await new Promise(r => setTimeout(r, 200));

  await scanAndClick(page, (el) => {
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
    return (el.innerText || '').trim().toLowerCase() === 'continue';
  });

  await new Promise(r => setTimeout(r, 400));
  await dismissCookies(page);

  if (isMicrosoft) {
    state.step = 'Microsoft sign-in';
    console.log('[STEP]', state.step);
    await scanAndClick(page, (el) => {
      if (!['BUTTON', 'A'].includes(el.tagName) && el.getAttribute('role') !== 'button') return false;
      return (el.innerText || '').toLowerCase().includes('microsoft');
    });
    await page.waitForSelector('input[type="email"], input[name="loginfmt"]', { timeout: 10000 });
    await scanAndClick(page, (el) => el.tagName === 'INPUT' && (el.type === 'email' || el.name === 'loginfmt'));
    await page.keyboard.type(username, { delay: 10 });
    await page.click('input[type="submit"], #idSIButton9');
    await new Promise(r => setTimeout(r, 500));
    await page.waitForSelector('input[type="password"], input[name="passwd"]', { timeout: 10000 });
    await scanAndClick(page, (el) => el.tagName === 'INPUT' && el.type === 'password');
    await page.keyboard.type(password, { delay: 10 });
    await page.click('input[type="submit"], #idSIButton9');
    await new Promise(r => setTimeout(r, 500));
    const stayBtn = await page.$('#idSIButton9');
    if (stayBtn) await stayBtn.click();
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  } else {
    state.step = 'Typing username & password';
    console.log('[STEP]', state.step);
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await dismissCookies(page);
    await new Promise(r => setTimeout(r, 300));
    const boxes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input:not([type=hidden])"))
        .map(el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })
        .filter(b => b.w > 20);
    });
    if (boxes.length >= 2) {
      await realMouseClick(page, boxes.at(0).x, boxes.at(0).y);
      await new Promise(r => setTimeout(r, 150));
      await page.keyboard.type(username, { delay: 15 });
      await realMouseClick(page, boxes.at(1).x, boxes.at(1).y);
      await new Promise(r => setTimeout(r, 150));
      await page.keyboard.type(password, { delay: 15 });
    }
    const clickedLogin = await scanAndClick(page, (el) => {
      if (el.tagName !== 'BUTTON' && el.type !== 'submit') return false;
      const t = (el.innerText || el.value || '').trim().toLowerCase();
      return t === 'log in' || t === 'login' || t === 'sign in';
    });
    if (!clickedLogin) await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  }

  state.step = 'Loading Homework dashboard';
  console.log('[STEP]', state.step);
  await page.waitForFunction(() => document.body && document.body.innerText.includes('Homework'), { timeout: 5000 }).catch(() => {});
  await dismissCookies(page);

  const freshCookies = await page.cookies().catch(() => []);
  if (freshCookies.length > 0) cookieJar.set(cacheKey, freshCookies);
  console.log('[STEP] Login finished!');
}

async function loginToSparx(page, school, username, password, isMicrosoft) {
  const state = { step: 'Launching Chrome' };
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      const pageScan = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 160).replace(/\s+/g, ' ') : 'Empty')).catch(() => 'Unreadable');
      const err = new Error('Timed out after 30s at step: `' + state.step + '`\nPage scan: `' + pageScan + '`');
err.screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
reject(err);
}, 30000);
});
try {
await Promise.race([
loginToSparxCore(page, school, username, password, isMicrosoft, state),
timeoutPromise
]);
} catch (err) {
if (!err.screenshot) {
err.screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
}
throw err;
} finally {
clearTimeout(timer);
}
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
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Opening ' + targetHw.title + '...', tasks)
);
await scanAndClick(page, (el, hwTitle) => {
const t = (el.innerText || '').trim();
return t.includes(hwTitle) && t.length < 150;
}, targetHw.title);
await new Promise(r => setTimeout(r, 700));
await scanAndClick(page, (el) => {
const t = (el.innerText || '').trim();
return (t.includes('1A') || t.includes('Task 1') || el.getAttribute('href')?.includes('/task/')) && t.length < 100;
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
await scanAndClick(page, (el, ans) => el.tagName === 'BUTTON' && (el.innerText || '').includes(ans), bookworkLog[codeNeeded]);
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
const inputEl = await page.$(inputSel);
if (inputEl) {
const box = await inputEl.boundingBox();
if (box) await realMouseClick(page, box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.down('Control');
await page.keyboard.press('A');
await page.keyboard.up('Control');
await page.keyboard.press('Backspace');
await page.keyboard.type(answer, { delay: 30 });
} else {
await scanAndClick(page, (el, ans) => {
if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
return (el.innerText || '').trim().toLowerCase() === ans.toLowerCase();
}, answer);
}
await scanAndClick(page, (el) => {
if (el.tagName !== 'BUTTON') return false;
const t = (el.innerText || '').toLowerCase();
return ['submit', 'check', 'answer'].some(w => t.includes(w));
});
await new Promise(r => setTimeout(r, 1200));
await scanAndClick(page, (el) => {
if (el.tagName !== 'BUTTON') return false;
const t = (el.innerText || '').toLowerCase();
return ['next', 'continue'].some(w => t.includes(w));
});
await new Promise(r => setTimeout(r, 1000));
}
tasks.at(0).done = 6;
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Completed ✅', tasks)
);
} catch (err) {
const errShot = page ? await page.screenshot().catch(() => null) : null;
const files = errShot ? [new AttachmentBuilder(Buffer.from(errShot), { name: 'error.png' })] : [];
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Stopped: ' + err.message, tasks, files)
);
} finally {
if (page) await page.close().catch(() => {});
if (browser) await (browser.disconnect ? browser.disconnect() : browser.close()).catch(() => {});
}
}
module.exports = { loginToSparx, runHomeworkInDM, getFastBrowser };
