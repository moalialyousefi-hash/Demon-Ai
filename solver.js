const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const emojis = require('./emojis.json');

const aiProvider = (process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_KEY || Object.values(process.env).find(v => typeof v === "string" && v.trim().startsWith("sk-or-")))
  ? new OpenAI({ apiKey: (process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_KEY || Object.values(process.env).find(v => typeof v === "string" && v.trim().startsWith("sk-or-"))).trim(), baseURL: "https://openrouter.ai" })
  : new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://groq.com" });

const cookieJar = new Map();

let sharedBrowser = null;
async function getFastBrowser() {
  if (sharedBrowser && sharedBrowser.connected) {
    return sharedBrowser;
  }
  console.log("[STEP] Launching warm Chromium...");
  sharedBrowser = await puppeteer.launch({
    headless: true,
    userDataDir: "/tmp/sparx_chrome_cache",
    userDataDir: "/tmp/sparx_chrome_cache",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 45000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--disable-extensions",
      "--disable-background-networking",
      "--renderer-process-limit=2"
    ]
  });
  sharedBrowser.on("disconnected", () => { sharedBrowser = null; });
  return sharedBrowser;
}

let lastCursorX = 640;
let lastCursorY = 360;

async function hardenPage(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-GB", "en"] });
    window.chrome = window.chrome || { runtime: {} };
  }).catch(() => {});
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" }).catch(() => {});
  page.on("dialog", d => d.accept().catch(() => {}));
  await page.setRequestInterception(true).catch(() => {});
  page.on("request", req => {
    const url = req.url();
    const type = req.resourceType();
    if (type === "media" || /google-analytics|doubleclick|sentry|hotjar|segment/i.test(url)) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

async function smoothMoveCursor(page, targetX, targetY) {
  const steps = 18;
  const startX = lastCursorX;
  const startY = lastCursorY;
  const ctrlX = (startX + targetX) / 2 + (Math.random() * 60 - 30);
  const ctrlY = (startY + targetY) / 2 + (Math.random() * 40 - 20);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const bx = Math.pow(1 - ease, 2) * startX + 2 * (1 - ease) * ease * ctrlX + Math.pow(ease, 2) * targetX;
    const by = Math.pow(1 - ease, 2) * startY + 2 * (1 - ease) * ease * ctrlY + Math.pow(ease, 2) * targetY;
    await page.mouse.move(bx, by).catch(() => {});
    await new Promise(r => setTimeout(r, 12));
  }
  lastCursorX = targetX;
  lastCursorY = targetY;
}

async function humanType(page, text) {
  for (const ch of String(text)) {
    await page.keyboard.type(ch, { delay: 25 + Math.floor(Math.random() * 65) });
  }
}

async function fillReactInput(page, box, value) {
  await realMouseClick(page, box.x, box.y);
  await new Promise(r => setTimeout(r, 90 + Math.floor(Math.random() * 90)));
  await page.evaluate((x, y, val) => {
    const el = document.elementFromPoint(x, y)?.closest("input") || document.activeElement;
    if (el && el.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el, "");
      else el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, box.x, box.y, value).catch(() => {});
  await humanType(page, value);
}



async function realMouseClick(page, x, y) {
  await smoothMoveCursor(page, x, y);
  await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 110)));
  await page.mouse.down().catch(() => {});
  await new Promise(r => setTimeout(r, 30 + Math.floor(Math.random() * 40)));
  await page.mouse.up().catch(() => {});
  await new Promise(r => setTimeout(r, 85 + Math.floor(Math.random() * 75)));
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
  let clickedSchool = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    clickedSchool = await scanAndClick(page, (el, schoolName) => {
      if (el.tagName === "INPUT" || el.querySelector("input")) return false;
      const txt = (el.innerText || "").trim();
      if (txt.length < 4 || txt.length > 140) return false;
      const normTxt = txt.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normSchool = schoolName.toLowerCase().replace(/[^a-z0-9]/g, "");
      return normTxt.includes(normSchool);
    }, school);
    if (clickedSchool) break;
    await new Promise(r => setTimeout(r, 400));
  }
  if (!clickedSchool) {
    throw new Error("Could not find school matching: " + school + " — try typing the full school name with spaces (e.g. Ernest Bevin Academy)");
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
    await new Promise(r => setTimeout(r, 1000));
    const alreadyIn = await page.evaluate(() => document.body && (document.body.innerText.includes("Hey ") || document.body.innerText.includes("Homework due"))).catch(() => false);
    if (alreadyIn) return;
    for (let w = 0; w < 4; w++) {
      try {
        await page.waitForSelector('input[type="password"]', { visible: true, timeout: 4000 });
        break;
      } catch (e) {
        if (w === 3) throw e;
        await new Promise(r => setTimeout(r, 600));
      }
    }
    await new Promise(r => setTimeout(r, 400));
    await dismissCookies(page);

    const passRect = await page.evaluate(() => {
      const passEl = document.querySelector("input[type=password]");
      if (!passEl) return null;
      const r = passEl.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }).catch(() => null);

    if (passRect) {
      await realMouseClick(page, passRect.x, passRect.y - 72);
      await page.evaluate((x, y) => {
        const el = document.elementFromPoint(x, y);
        if (el && el.focus) el.focus();
      }, passRect.x, passRect.y - 72);
      await new Promise(r => setTimeout(r, 150));
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(username, { delay: 20 });

      await realMouseClick(page, passRect.x, passRect.y);
      await new Promise(r => setTimeout(r, 150));
      await page.keyboard.type(password, { delay: 20 });
    }

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
  let lastQCode = "";
  let qAttemptTracker = {};
  let totalSolvedCount = 0;
      let sameQCount = 0;
       
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
  await hardenPage(page);
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
  const qAttemptTracker = {};
  let totalSolvedCount = 0;
  let answer = "";
  answer = "";
  let lastQCode = "";
  let sameQCount = 0;
const delayMs = session.speed === 'quick' ? 2500 : session.speed === 'normal' ? 15000 : 40000;
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
const ctx = browser.createBrowserContext ? await browser.createBrowserContext() : browser;
    page = await ctx.newPage();
await loginToSparx(page, session.school, session.username, session.password, session.isMicrosoft);
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Opening ' + targetHw.title + '...', tasks)
);
const sysPrompt = "You are an expert UK GCSE & KS3 Maths solver for Sparx Maths. Carefully read all numbers, fractions, units, and rounding instructions. Always write fractions as numerator/denominator like 13/24 (never just the top number). Always write fractions as numerator/denominator like 13/24 (never just the top number). Always write fractions as numerator/denominator like 13/24 (never just the top number). Solve step-by-step internally, then output ONLY the exact final value or exact multiple-choice button label to enter—never include working, units unless asked, or extra words.";

    for (let taskIdx = 0; taskIdx < 6; taskIdx++) {
      let taskNum = taskIdx + 1;
      if (taskIdx >= tasks.length) tasks.push({ done: 0, total: 6 });

      const onQuestionAlready = await page.evaluate((n) => {
        const t = document.body ? document.body.innerText : "";
        return new RegExp("\\b" + n + "[A-Z]\\b").test(t) && (t.includes("Answer") || t.includes("Submit") || t.includes("Bookwork"));
      }, taskNum).catch(() => false);

      if (!onQuestionAlready) {
        let taskVisible = await page.evaluate((n) => document.body && new RegExp("Task\\s*" + n + "\\b", "i").test(document.body.innerText), taskNum).catch(() => false);
        if (!taskVisible) {
          await scanAndClick(page, (el) => {
            const t = (el.innerText || "").trim();
            return t === "Sparx Maths" || t === "< Sparx Maths" || el.getAttribute("href") === "/student/";
          });
          await new Promise(r => setTimeout(r, 1000));
          taskVisible = await page.evaluate((n) => document.body && new RegExp("Task\\s*" + n + "\\b", "i").test(document.body.innerText), taskNum).catch(() => false);
        }

        if (!taskVisible) {
          await scanAndClick(page, (el, hwTitle) => {
            const t = (el.innerText || "").trim();
            return t.includes(hwTitle) && t.length < 150;
          }, targetHw.title);
          await new Promise(r => setTimeout(r, 900));
        }

        const foundTask = await scanAndClick(page, (el, n) => {
          const t = (el.innerText || "").trim();
          return new RegExp("^Task\\s*" + n + "\\b", "i").test(t) && t.length < 40;
        }, taskNum);
        if (!foundTask && taskIdx > 0) break;

        await new Promise(r => setTimeout(r, 900));
        await scanAndClick(page, (el, n) => {
          const t = (el.innerText || "").trim();
          return (t === n + "A" || t.startsWith(n + "A ") || el.getAttribute("href")?.includes("/task/")) && t.length < 60;
        }, taskNum);
        await new Promise(r => setTimeout(r, 1100));
        await dismissCookies(page);
      }

      
      for (let i = 0; i < 10; i++) {
        const taskFinished = await page.evaluate(() => {
          const t = document.body ? document.body.innerText : "";
          const hasAnswerBtn = Array.from(document.querySelectorAll("button")).some(b => /^answer$|^submit$/i.test((b.innerText || "").trim()));
          return !hasAnswerBtn && /Task complete|Well done!|You have completed this task|Back to homework/i.test(t);
        }).catch(() => false);
        if (taskFinished) break;

        const realQ = await page.evaluate((n) => {
          const m = (document.body ? document.body.innerText : "").match(new RegExp("\\b(" + n + "[A-Z])\\b"));
          return m ? m.at(1) : null;
        }, taskNum).catch(() => null);
        const detectedTab = await page.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll("a, button, div, span")).filter(el => {
            const r = el.getBoundingClientRect();
            const t = (el.innerText || "").trim();
            return r.top < 140 && r.width > 24 && r.width < 110 && /^\d+[A-Z]$/.test(t);
          });
          const active = tabs.find(el => {
            const bg = window.getComputedStyle(el).backgroundColor;
            return bg && (bg.includes("26, 54") || bg.includes("30, 58") || bg.includes("23, 37") || bg.includes("15, 23") || bg.includes("31, 41"));
          });
          return active ? (active.innerText || "").trim() : null;
        }).catch(() => null);
        const liveTab = await page.evaluate(() => {
          const sel = document.querySelector('a[class*="_Selected_"], [class*="_TaskItemLink_"][class*="_Selected_"]');
          if (sel && sel.innerText) return sel.innerText.trim();
          const unattempted = document.querySelector('a[class*="_Unattempted_"]');
          return unattempted && unattempted.innerText ? unattempted.innerText.trim() : null;
        }).catch(() => null);
        const qCode = liveTab || (taskNum + String.fromCharCode(65 + (sameQCount || 0)));
        if (liveTab && /^\d+/.test(liveTab)) {
          taskNum = Number(liveTab.match(/^(\d+)/).at(1));
        }
        if (qCode === lastQCode) {
          sameQCount++;
          if (sameQCount >= 2) {
            throw new Error("Stuck on " + qCode + " (AI entered: " + answer + ") — see screenshot");
          }
        } else {
          lastQCode = qCode;
          sameQCount = 0;
        }
        const letterIdx = qCode.charCodeAt(qCode.length - 1) - 65;
        if (letterIdx >= 0 && letterIdx < 12) {
          tasks.at(taskIdx).done = Math.min(letterIdx, tasks.at(taskIdx).total - 1);
        }

        await dmMsg.edit(
          buildProgressPayload(session, targetHw.title, "Solving " + qCode + " in Task " + taskNum + "...", tasks)
        );

        await scanAndClick(page, (el) => el.tagName === "BUTTON" && (el.innerText || "").trim().toLowerCase() === "try again");
        const isBookwork = await page.evaluate(() => document.body.innerText.includes("Bookwork check")).catch(() => false);
        // If already on the Answer entry screen (< Back visible), go back once so AI can scan the full question first!
        const onAnswerScreen = await page.evaluate(() => Array.from(document.querySelectorAll("button")).some(b => (b.innerText || "").trim() === "Back" || (b.innerText || "").trim() === "< Back")).catch(() => false);
        if (onAnswerScreen) {
          await scanAndClick(page, (el) => el.tagName === "BUTTON" && ((el.innerText || "").trim() === "Back" || (el.innerText || "").trim() === "< Back"));
          await new Promise(r => setTimeout(r, 700));
        }
        if (isBookwork) {
          const codeNeeded = await page.evaluate(() => {
            const m = document.body.innerText.match(/Bookwork code:\s*([A-Z0-9]+)/i);
            return m ? m.at(1) : null;
          }).catch(() => null);
          if (codeNeeded && bookworkLog[codeNeeded]) {
            await scanAndClick(page, (el, ans) => el.tagName === "BUTTON" && (el.innerText || "").includes(ans), bookworkLog[codeNeeded]);
            await new Promise(r => setTimeout(r, 800));
            continue;
          }
        }

        const alreadyCorrect = await page.evaluate(() => {
          if (!document.body) return false;
          const txt = document.body.innerText || "";
          if (txt.includes("already got this question correct")) return true;
          return Array.from(document.querySelectorAll("button, a, div, span")).some(el => {
            const r = el.getBoundingClientRect();
            return r.width > 60 && r.height > 20 && (el.innerText || "").trim().toLowerCase() === "keep going" && el.children.length <= 2;
          });
        }).catch(() => false);
        if (alreadyCorrect) {
          await scanAndClick(page, (el) => {
          const t = (el.innerText || "").trim().toLowerCase();
          return t === "keep going" && el.children.length <= 2;
        });
          await new Promise(r => setTimeout(r, 900));
          continue;
        }
        qAttemptTracker[qCode] = (qAttemptTracker[qCode] || 0) + 1;
        if (qAttemptTracker[qCode] > 2) {
          const nextTab = qCode.replace(/([A-Z])$/, (_, ch) => String.fromCharCode(ch.charCodeAt(0) + 1));
          const skipped = await scanAndClick(page, (el, target) => {
            const r = el.getBoundingClientRect();
            return r.top < 140 && (el.innerText || "").trim().startsWith(target);
          }, nextTab);
          if (skipped) {
            await dmMsg.edit(buildProgressPayload(session, targetHw.title, "Skipped " + qCode + " -> " + nextTab + "...", tasks)).catch(() => {});
            await new Promise(r => setTimeout(r, 900));
            continue;
          }
        }
        qAttemptTracker[qCode] = (qAttemptTracker[qCode] || 0) + 1;
        if (qAttemptTracker[qCode] > 2) {
          const nextTab = qCode.replace(/([A-Z])$/, (_, ch) => String.fromCharCode(ch.charCodeAt(0) + 1));
          const skipped = await scanAndClick(page, (el, target) => {
            const r = el.getBoundingClientRect();
            return r.top < 140 && (el.innerText || "").trim().startsWith(target);
          }, nextTab);
          if (skipped) {
            await dmMsg.edit(buildProgressPayload(session, targetHw.title, "Skipped " + qCode + " -> " + nextTab + "...", tasks)).catch(() => {});
            await new Promise(r => setTimeout(r, 900));
            continue;
          }
        }
        const shot = await page.screenshot({ encoding: "base64" }).catch(() => null);
        if (!shot) { await new Promise(r => setTimeout(r, 1000)); continue; }
          const qText = await page.evaluate(() => {
            const clone = document.body.cloneNode(true);
            clone.querySelectorAll("img[alt]").forEach(img => { if (img.alt) img.replaceWith(" " + img.alt + " "); });
            return (clone.innerText || "").replace(/(\d+)\s*\n\s*(\d+)/g, "$1/$2").slice(0, 1800);
          }).catch(() => "");
        await scanAndClick(page, (el) => {
          const r = el.getBoundingClientRect();
          const t = (el.innerText || "").trim().toLowerCase();
          return t === "answer" && r.top > 200 && el.children.length <= 2;
        });
        await new Promise(r => setTimeout(r, 600));
        var numBoxes = await page.evaluate(() => Array.from(document.querySelectorAll("input, [role=\"textbox\"]")).filter(el => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 12; }).length + ((document.body?.innerText || "").match(/Enter number/g) || []).length).catch(() => 1);
        var boxHint = numBoxes >= 2 ? " CRITICAL: This question has a fraction answer box (top numerator and bottom denominator). Return a fraction in the form numerator/denominator (e.g. 13/24)." : "";
        if (!shot) { await new Promise(r => setTimeout(r, 1000)); continue; }
        const currentCode = await page.evaluate(() => {
          const m = document.body.innerText.match(/Bookwork code:\s*([A-Z0-9]+)/i);
          return m ? m.at(1) : null;
        }).catch(() => null);

        if (process.env.GEMINI_API_KEY) {
          const gUrl = Buffer.from("aHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhL21vZGVscy9nZW1pbmktMi41LWZsYXNoOmdlbmVyYXRlQ29udGVudD9rZXk9","base64").toString() + process.env.GEMINI_API_KEY.trim();
          const gRes = await fetch(gUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [
                { text: sysPrompt + boxHint },
                { inline_data: { mime_type: "image/png", data: shot } }
              ]}]
            })
          });
          const gData = await gRes.json();
          if (!gRes.ok) throw new Error("Gemini AI (" + gRes.status + "): " + (gData.error?.message || "Failed"));
          answer = gData.candidates.at(0).content.parts.at(0).text.trim();
        } else {
          let res;





          const promptText = "You are an expert UK GCSE/KS3 Sparx Maths solver. Read the question image and text carefully. Always simplify fractions to simplest form (e.g. 6/28 -> 3/14). Show 2 short lines of working, then end with FINAL: <exact answer> (e.g. FINAL: 3/14). " + boxHint + "\n\nQuestion text: " + qText;
          let rawContent = "";

          if (process.env.GEMINI_API_KEY) {
            const gemRes = await fetch("https://googleapis.com" + process.env.GEMINI_API_KEY.trim(), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{
                  parts: [
                    { text: promptText },
                    { inline_data: { mime_type: "image/png", data: shot } }
                  ]
                }],
                generationConfig: { temperature: 0.0, maxOutputTokens: 300 }
              })
            });
            const gemJson = await gemRes.json();
            if (!gemRes.ok) throw new Error("Gemini (" + gemRes.status + "): " + (gemJson.error?.message || JSON.stringify(gemJson)));
            rawContent = gemJson.candidates?.at(0)?.content?.parts?.map(p => p.text).join("\n") || "";
          } else if ((process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_KEY || Object.values(process.env).find(v => typeof v === "string" && v.trim().startsWith("sk-or-")))) {
            const orRes = await fetch("https://openrouter.ai" + "/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + (process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_KEY || Object.values(process.env).find(v => typeof v === "string" && v.trim().startsWith("sk-or-"))).trim(),
                "HTTP-Referer": "https://github.com",
                "X-Title": "Demon-Ai"
              },
              body: JSON.stringify({
                models: ["qwen/qwen2.5-vl-72b-instruct:free", "meta-llama/llama-3.2-11b-vision-instruct:free", "openrouter/free"],
                messages: [{
                  role: "user",
                  content: [
                    { type: "text", text: promptText },
                    { type: "image_url", image_url: { url: "data:image/png;base64," + shot } }
                  ]
                }],
                temperature: 0.0,
                max_tokens: 900
              })
            });
            const orJson = await orRes.json();
            if (!orRes.ok) throw new Error("OpenRouter (" + orRes.status + "): " + (orJson.error?.message || JSON.stringify(orJson)));
            const msgObj = orJson.choices?.at(0)?.message || {}; rawContent = msgObj.content || msgObj.reasoning || "";
          } else {
            throw new Error("Missing GEMINI_API_KEY or OPENROUTER_API_KEY in Railway Variables!");
          }

          const m = rawContent.match(/FINAL:\s*([^\r\n]+)/i);
          answer = (m ? m.at(1) : rawContent.split(/\r?\n/).pop()).replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1/$2").replace(/\s*\/\s*/g, "/").replace(/^[\`"\x27]+|[\`"\x27.]+$/g, "").trim();
        }

        answer = answer.replace(/^[\`"\x27]+|[\`"\x27.]+$/g, "").trim();
          if (!answer) {
              console.log("EMPTY AI RAW:", rawContent);
            const nextTab = qCode.replace(/([A-Z])$/, (_, ch) => String.fromCharCode(ch.charCodeAt(0) + 1));
            const skipped = await scanAndClick(page, (el, target) => {
              const r = el.getBoundingClientRect();
              return r.top < 140 && (el.innerText || "").trim().startsWith(target);
            }, nextTab);
            if (skipped) {
              await dmMsg.edit(buildProgressPayload(session, targetHw.title, "Skipped " + qCode + " -> " + nextTab + "...", tasks)).catch(() => {});
              await new Promise(r => setTimeout(r, 900));
              continue;
            }
          }
        if (currentCode) bookworkLog[currentCode] = answer;
        await scanAndClick(page, (el) => {
            const r = el.getBoundingClientRect();
            const t = (el.innerText || "").trim().toLowerCase();
            return t === "answer" && r.top > 200 && el.children.length <= 2;
          });
          await new Promise(r => setTimeout(r, 700));
          await scanAndClick(page, (el) => {
            const r = el.getBoundingClientRect();
            const t = (el.innerText || "").trim().toLowerCase();
            return t === "answer" && r.top > 200 && el.children.length <= 2;
          });
          await new Promise(r => setTimeout(r, 700));
          await scanAndClick(page, (el) => {
            const r = el.getBoundingClientRect();
            const t = (el.innerText || "").trim().toLowerCase();
            return t === "answer" && r.top > 200 && el.children.length <= 2;
          });
          await new Promise(r => setTimeout(r, 700));
          await dmMsg.edit({ ...buildProgressPayload(session, targetHw.title, "Entering " + qCode + " (" + answer.slice(0, 25) + ")...", tasks), files: [{ attachment: Buffer.from(shot, "base64"), name: qCode + ".png" }] }).catch(() => {});
        await new Promise(r => setTimeout(r, delayMs));


        await new Promise(r => setTimeout(r, 700));

        const visInputs = await page.evaluate(() => {
          const raw = Array.from(document.querySelectorAll("input")).filter(el => {
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio" &&
                   style.visibility !== "hidden" && style.display !== "none" &&
                   r.width > 30 && r.height > 12;
          }).map(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }).sort((a, b) => a.y - b.y);

          const unique = [];
          for (const box of raw) {
            if (!unique.some(u => Math.abs(u.y - box.y) < 15 && Math.abs(u.x - box.x) < 15)) {
              unique.push(box);
            }
          }
          return unique;
        }).catch(() => []);

        const numericInputs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('input[class*="_TextFieldNumeric_"], input[placeholder="Enter number"], input[type="text"], input[type="number"], input:not([type])'))
            .filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 30 && r.height > 15 && el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio";
            })
            .map(el => {
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })
            .sort((a, b) => a.y - b.y);
        }).catch(() => []);

        const fillNumericBox = async (box, val) => {
          const str = String(val).trim();
          if (box) {
            await page.mouse.click(box.x, box.y);
            await new Promise(r => setTimeout(r, 140));
            await page.evaluate((coords, text) => {
              const el = document.elementFromPoint(coords.x, coords.y);
              const inp = el && (el.tagName === "INPUT" ? el : el.querySelector("input"));
              if (inp) {
                inp.focus();
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                if (setter) setter.call(inp, "");
                inp.dispatchEvent(new Event("input", { bubbles: true }));
              }
            }, box, str);
            await new Promise(r => setTimeout(r, 100));
          }
          await page.keyboard.type(str, { delay: 75 });
          await page.evaluate((coords) => {
            const el = document.elementFromPoint(coords.x, coords.y);
            const inp = el && (el.tagName === "INPUT" ? el : el.querySelector("input"));
            if (inp) {
              inp.dispatchEvent(new Event("input", { bubbles: true }));
              inp.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }, box || { x: 0, y: 0 });
          await new Promise(r => setTimeout(r, 180));
        };

        if (answer.includes("/") && numericInputs.length >= 2) {
          const [num, den] = answer.split("/").map(p => p.trim());
          await fillNumericBox(numericInputs.at(0), num);
          await fillNumericBox(numericInputs.at(1), den);
        } else if (numericInputs.length >= 1) {
          await fillNumericBox(numericInputs.at(0), answer);
        } else {
          await page.keyboard.type(String(answer).trim(), { delay: 55 });
        }

        await page.waitForFunction(() => {
          const btn = Array.from(document.querySelectorAll("button")).find(b => /submit|check/i.test((b.innerText || "").trim()));
          return btn && !btn.disabled;
        }, { timeout: 2500 }).catch(() => {});
        const clickedSubmit = await scanAndClick(page, (el) => {
          if (el.tagName !== "BUTTON") return false;
          const t = (el.innerText || "").trim().toLowerCase();
          return t === "submit answer" || t === "submit" || t === "check";
        });
        if (!clickedSubmit) {
          await page.click('button[class*="_ButtonPrimary_"]').catch(() => {});
        }
        await new Promise(r => setTimeout(r, 1300));

        await scanAndClick(page, (el) => {
          if (el.children.length > 2) return false;
          const t = (el.innerText || "").trim().toLowerCase();
          return t === "next" || t === "continue" || t === "keep going" || t === "next question" || t === "try again";
        });
        await new Promise(r => setTimeout(r, 1000));
        totalSolvedCount++;
      }

      const onFirstQStill = await page.evaluate((n) => {
        const t = document.body ? document.body.innerText : "";
        return false;
      }, taskNum).catch(() => false);
      if (onFirstQStill) {
        throw new Error("Stuck on " + taskNum + "A — see screenshot to check why Answer/Submit did not advance");
      }
      tasks.at(taskIdx).done = tasks.at(taskIdx).total;
      await dmMsg.edit(
        buildProgressPayload(session, targetHw.title, "Completed Task " + taskNum + "! Moving to next task...", tasks)
      );

      await scanAndClick(page, (el) => {
        const t = (el.innerText || "").trim().toLowerCase();
        return t === "continue" || t === "back to task list" || t === "back to homework" || t === "sparx maths" || t === "< sparx maths";
      });
      await new Promise(r => setTimeout(r, 1200));
    }

    if (totalSolvedCount === 0) {
      throw new Error("0 questions were solved — see screenshot of what Sparx showed");
    }
    await dmMsg.edit(
      buildProgressPayload(session, targetHw.title, "Completed ✅", tasks)
    );
} catch (err) {
const errShot = page ? await page.screenshot().catch(() => null) : null;
const files = errShot ? [new AttachmentBuilder(Buffer.from(errShot), { name: 'error.png' })] : [];
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Stopped: ' + err.message, tasks, files)
);
} finally {
if (page) await page.close().catch(() => {});
// keep sharedBrowser warm for instant next tab
}
}
module.exports = { loginToSparx, runHomeworkInDM, getFastBrowser };
