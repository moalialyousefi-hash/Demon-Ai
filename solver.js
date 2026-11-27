const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const emojis = require('./emojis.json');

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

const cookieJar = new Map();

async function getFastBrowser() {
  if (process.env.BROWSERLESS_TOKEN) {
    const token = process.env.BROWSERLESS_TOKEN.trim();
    const endpoints = [
      'wss://production-lon.browserless.io?token=' + token,
      'wss://production-sfo.browserless.io?token=' + token
    ];
    for (const ep of endpoints) {
      try {
        console.log('[STEP] Connecting to Browserless:', ep.split('?'));
        return await Promise.race([
          puppeteer.connect({ browserWSEndpoint: ep }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('4s timeout')), 4000))
        ]);
      } catch (e) {
        console.log('[BROWSERLESS SKIP]', ep.split('?'), e.message);
      }
    }
  }
  console.log('[STEP] Launching local Chromium...');
  return await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 45000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  });
}

async function realMouseClick(page, x, y) {
  await page.mouse.move(x, y, { steps: 12 });
  await new Promise(r => setTimeout(r, 60));
  await page.mouse.down();
  await new Promise(r => setTimeout(r, 40));
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
  }, matcherFn.toString(), arg).catch(() => null);

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
    await page.goto("https://"+"www.sparxmaths.uk/student/", { waitUntil: "domcontentloaded", timeout: 20000 });
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 600));
      const isLoggedIn = await page.evaluate(() => {
        const t = document.body ? document.body.innerText : '';
        return !t.includes('Use your Sparx login') && /Hey\s+|Homework due|Personal Practice/i.test(t);
      }).catch(() => false);
      if (isLoggedIn) {
        await dismissCookies(page);
        console.log('[STEP] Restored session!');
        return;
      }
    }
    cookieJar.delete(cacheKey);
  }

  state.step = 'Opening Sparx student login';
  console.log('[STEP]', state.step);
    await page.goto("https://"+"www.sparxmaths.uk/student/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await new Promise(r => setTimeout(r, 800));
  await dismissCookies(page);

  const alreadyIn = await page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    return !t.includes('Use your Sparx login') && /Hey\s+|Homework due|Personal Practice/i.test(t);
  }).catch(() => false);
  if (alreadyIn) return;

  state.step = 'Typing school name';
  console.log('[STEP]', state.step);
  const schoolInputSel = 'input:not([type="hidden"])';
  await page.waitForSelector(schoolInputSel, { visible: true, timeout: 12000 });
  await page.click(schoolInputSel, { clickCount: 3 });
  await page.type(schoolInputSel, school, { delay: 15 });
  await new Promise(r => setTimeout(r, 700));

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
  await new Promise(r => setTimeout(r, 300));

  await scanAndClick(page, (el) => {
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
    return (el.innerText || '').trim().toLowerCase() === 'continue';
  });

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 700));
  await dismissCookies(page);

  if (isMicrosoft) {
    state.step = 'Microsoft sign-in';
    console.log('[STEP]', state.step);
    await scanAndClick(page, (el) => {
      if (!['BUTTON', 'A'].includes(el.tagName) && el.getAttribute('role') !== 'button') return false;
      return (el.innerText || '').toLowerCase().includes('microsoft');
    });
    const emailSel = 'input[type="email"], input[name="loginfmt"]';
    await page.waitForSelector(emailSel, { visible: true, timeout: 12000 });
    await page.click(emailSel, { clickCount: 3 });
    await page.type(emailSel, username, { delay: 15 });
    await page.click('input[type="submit"], #idSIButton9');
    await new Promise(r => setTimeout(r, 800));
    const msPassSel = 'input[type="password"], input[name="passwd"]';
    await page.waitForSelector(msPassSel, { visible: true, timeout: 12000 });
    await page.click(msPassSel, { clickCount: 3 });
    await page.type(msPassSel, password, { delay: 15 });
    await page.click('input[type="submit"], #idSIButton9');
    await new Promise(r => setTimeout(r, 800));
    await page.click('#idSIButton9').catch(() => {});
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  } else {
    state.step = 'Typing username & password';
    console.log('[STEP]', state.step);
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 12000 });
    await new Promise(r => setTimeout(r, 400));
    await dismissCookies(page);

    const inputCoords = await page.evaluate(() => { const vis = Array.from(document.querySelectorAll("input")).filter(el => { const r = el.getBoundingClientRect(); return el.type !== "hidden" && r.width > 80 && r.height > 15; }); return vis.map(el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); }); if (inputCoords.length >= 2) { await realMouseClick(page, inputCoords.at(0).x, inputCoords.at(0).y); await new Promise(r => setTimeout(r, 150)); await page.keyboard.type(username, { delay: 20 }); await realMouseClick(page, inputCoords.at(1).x, inputCoords.at(1).y); await new Promise(r => setTimeout(r, 150)); await page.keyboard.type(password, { delay: 20 }); }

    await new Promise(r => setTimeout(r, 350));
    const loginBtnBox = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b => /^log\s*in$|^sign\s*in$/i.test((b.innerText || "").trim()));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }).catch(() => null);
    if (loginBtnBox) {
      await realMouseClick(page, loginBtnBox.x, loginBtnBox.y);
    } else {
      await page.keyboard.press("Enter");
    }
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  }

  state.step = 'Loading Homework dashboard';
  console.log('[STEP]', state.step);
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 700));
    const ready = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      return !t.includes('Use your Sparx login') && /Homework|Compulsory|XP Boost|Target/i.test(t);
    }).catch(() => false);
    if (ready) break;
  }
await dismissCookies(page);
const stillOnLogin = await page.evaluate(() => {
const t = document.body ? document.body.innerText : '';
if (/incorrect|invalid|wrong|try again/i.test(t)) return 'Sparx said: Incorrect username or password!';
if (t.includes('Log in to Sparx using Microsoft') || t.includes('Use your Sparx login')) return 'Login did not complete — check your Username/Password or try Microsoft Login!';
return null;
}).catch(() => null);
if (stillOnLogin) throw new Error(stillOnLogin);
let freshCookies = [];
for (let i = 0; i < 4; i++) {
try {
freshCookies = await page.cookies();
break;
} catch (e) {
await new Promise(r => setTimeout(r, 500));
}
}
if (freshCookies.length > 0) cookieJar.set(cacheKey, freshCookies);
console.log('[STEP] Login finished!');
}
async function loginToSparx(page, school, username, password, isMicrosoft) {
const state = { step: 'Launching Chrome' };
let timer;
const timeoutPromise = new Promise((_, reject) => {
timer = setTimeout(async () => {
const pageScan = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 160).replace(/\s+/g, ' ') : 'Empty')).catch(() => 'Unreadable');
const err = new Error('Timed out after 35s at step: ' + state.step + '\nPage scan: ' + pageScan + '');
err.screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
reject(err);
}, 35000);
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
const task1AlreadyVisible = await page.evaluate(() => document.body && document.body.innerText.includes('Task 1')).catch(() => false);
if (!task1AlreadyVisible) {
await scanAndClick(page, (el, hwTitle) => {
const t = (el.innerText || '').trim();
return t.includes(hwTitle) && t.length < 150;
}, targetHw.title);
await new Promise(r => setTimeout(r, 800));
}
await scanAndClick(page, (el) => {
const t = (el.innerText || '').trim();
return /^Task\s*1\b/i.test(t) && t.length < 40;
});
await new Promise(r => setTimeout(r, 900));
await scanAndClick(page, (el) => {
const t = (el.innerText || '').trim();
return (t === '1A' || t.startsWith('1A ') || el.getAttribute('href')?.includes('/task/')) && t.length < 60;
});
await new Promise(r => setTimeout(r, 1000));
await dismissCookies(page);
for (let i = 0; i < 6; i++) {
tasks.at(0).done = i;
const qCode = '1' + String.fromCharCode(65 + i);
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Solving ' + qCode + ' in Task 1...', tasks)
);
const isBookwork = await page.evaluate(() => document.body.innerText.includes('Bookwork check')).catch(() => false);
if (isBookwork) {
const codeNeeded = await page.evaluate(() => {
const m = document.body.innerText.match(/Bookwork code:\s*([A-Z0-9]+)/i);
return m ? m.at(1) : null;
}).catch(() => null);
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
}).catch(() => null);
let answer = "";
      if (process.env.GEMINI_API_KEY) {
        const gUrl = Buffer.from("aHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhL21vZGVscy9nZW1pbmktMi41LWZsYXNoOmdlbmVyYXRlQ29udGVudD9rZXk9","base64").toString() + process.env.GEMINI_API_KEY.trim();
        const gRes = await fetch(gUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: "You are an expert UK GCSE & KS3 Maths solver for Sparx Maths. Carefully read all numbers, diagrams, axes, units, and rounding instructions in the image. Solve step-by-step internally, then output ONLY the exact final value or exact multiple-choice button label to enter—never include working or extra words." },
              { inline_data: { mime_type: "image/png", data: shot } }
            ]}]
          })
        });
        const gData = await gRes.json();
        if (!gRes.ok) throw new Error("Gemini AI (" + gRes.status + "): " + (gData.error?.message || "Failed"));
        answer = gData.candidates.at(0).content.parts.at(0).text.trim();
      } else {
        let res;
        try {
          res = await groq.chat.completions.create({
            model: "meta-llama/llama-4-maverick-17b-128e-instruct",
            messages: [
              { role: "system", content: "You are an expert UK GCSE & KS3 Maths solver for Sparx Maths. Carefully read all numbers, diagrams, axes, units, and rounding instructions in the screenshot. Solve step-by-step internally, then output ONLY the exact final value or exact multiple-choice button label to enter—never include working or extra words." },
              { role: "user", content: [{ type: "text", text: "Solve this Sparx Maths question accurately. Output ONLY the exact answer to enter or click." }, { type: "image_url", image_url: { url: "data:image/png;base64," + shot } }] }
            ],
            temperature: 0.1,
            max_tokens: 120
          });
        } catch (apiErr) {
          throw new Error("Groq AI (" + (apiErr.status || "ERR") + "): " + apiErr.message);
        }
        answer = res.choices.at(0).message.content.trim();
      }
if (currentCode) bookworkLog[currentCode] = answer;
await new Promise(r => setTimeout(r, delayMs));
await scanAndClick(page, (el) => el.tagName === 'BUTTON' && (el.innerText || '').trim().toLowerCase() === 'answer');
await new Promise(r => setTimeout(r, 600));
const inputSel = 'input[type="text"], input[type="number"]';
const inputVisible = await page.$(inputSel);
if (inputVisible) {
await page.click(inputSel, { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type(inputSel, answer, { delay: 30 });
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
