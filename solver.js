const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const emojis = require('./emojis.json');

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

const cookieJar = new Map();

let sharedBrowser = null;
async function getFastBrowser() {
  if (sharedBrowser && sharedBrowser.connected) {
    return sharedBrowser;
  }
  console.log("[STEP] Launching warm Chromium...");
  sharedBrowser = await puppeteer.launch({
    headless: true,
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
page = await browser.newPage();
await loginToSparx(page, session.school, session.username, session.password, session.isMicrosoft);
await dmMsg.edit(
buildProgressPayload(session, targetHw.title, 'Opening ' + targetHw.title + '...', tasks)
);
const sysPrompt = "You are an expert UK GCSE & KS3 Maths solver for Sparx Maths. Carefully read all numbers, fractions, units, and rounding instructions. Always write fractions as numerator/denominator like 13/24 (never just the top number). Always write fractions as numerator/denominator like 13/24 (never just the top number). Always write fractions as numerator/denominator like 13/24 (never just the top number). Solve step-by-step internally, then output ONLY the exact final value or exact multiple-choice button label to enter—never include working, units unless asked, or extra words.";

    for (let taskIdx = 0; taskIdx < 6; taskIdx++) {
      const taskNum = taskIdx + 1;
      if (taskIdx >= tasks.length) tasks.push({ done: 0, total: 6 });

      const onQuestionAlready = await page.evaluate((n) => {
        const t = document.body ? document.body.innerText : "";
        return t.includes(n + "A") && (t.includes("Answer") || t.includes("Watch video"));
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
        const qCode = realQ || (taskNum + String.fromCharCode(65 + i));
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

        const isBookwork = await page.evaluate(() => document.body.innerText.includes("Bookwork check")).catch(() => false);
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

        await scanAndClick(page, (el) => el.tagName === "BUTTON" && (el.innerText || "").trim().toLowerCase() === "answer");
        await new Promise(r => setTimeout(r, 600));
        const numBoxes = await page.evaluate(() => Array.from(document.querySelectorAll("input")).filter(el => { const r = el.getBoundingClientRect(); return el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio" && r.width > 30 && r.height > 12; }).length).catch(() => 1);
        const boxHint = numBoxes >= 2 ? " CRITICAL: The answer box has TWO fields (top numerator and bottom denominator). You MUST output a fraction in the exact form numerator/denominator (e.g. 13/24), NEVER a single integer." : "";
        const shot = await page.screenshot({ encoding: "base64" }).catch(() => null);
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
          try {
            res = await groq.chat.completions.create({
              model: "qwen/qwen3.8-27b",
              messages: [
                { role: "system", content: sysPrompt + boxHint },
                { role: "user", content: [{ type: "text", text: "Solve this Sparx Maths question accurately. Output ONLY the exact answer to enter or click." }, { type: "image_url", image_url: { url: "data:image/png;base64," + shot } }] }
              ],
              temperature: 0.1,
              max_tokens: 120
            });
          } catch (visionErr) {
            const qText = await page.evaluate(() => {
              const raw = document.body ? document.body.innerText : "";
              return raw.replace(/(\d+)\n(\d+)/g, "$1/$2").slice(0, 1500);
            }).catch(() => "");
            try {
              res = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: [
                  { role: "system", content: sysPrompt + boxHint },
                  { role: "user", content: "Solve this Sparx Maths question from the page text and output ONLY the exact final answer:\n\n" + qText }
                ],
                temperature: 0.1,
                max_tokens: 120
              });
            } catch (apiErr) {
              throw new Error("Groq AI (" + (apiErr.status || "ERR") + "): " + apiErr.message);
            }
          }
          answer = res.choices.at(0).message.content.trim();
        }

        answer = answer.replace(/^[`"']+|[`"'.]+$/g, "").trim();
        if (currentCode) bookworkLog[currentCode] = answer;
        await dmMsg.edit(buildProgressPayload(session, targetHw.title, "Entering " + qCode + " (" + answer.slice(0, 25) + ")...", tasks)).catch(() => {});
        await new Promise(r => setTimeout(r, delayMs));

        await scanAndClick(page, (el) => el.tagName === "BUTTON" && (el.innerText || "").trim().toLowerCase() === "answer");
        await new Promise(r => setTimeout(r, 700));

        const visInputs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll("input")).filter(el => {
            const r = el.getBoundingClientRect();
            return el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio" && r.width > 30 && r.height > 12;
          }).map(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
        }).catch(() => []);

        if (visInputs.length >= 2 && answer.includes("/")) {
          const [num, den] = answer.split("/");
          await realMouseClick(page, visInputs.at(0).x, visInputs.at(0).y);
          await new Promise(r => setTimeout(r, 120));
          await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          await page.keyboard.type(num.trim(), { delay: 30 });

          await realMouseClick(page, visInputs.at(1).x, visInputs.at(1).y);
          await new Promise(r => setTimeout(r, 120));
          await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          await page.keyboard.type(den.trim(), { delay: 30 });
          await page.keyboard.press("Enter");
        } else if (visInputs.length >= 1) {
          await realMouseClick(page, visInputs.at(0).x, visInputs.at(0).y);
          await new Promise(r => setTimeout(r, 150));
          await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          await page.keyboard.type(answer, { delay: 30 });
          await page.keyboard.press("Enter");
        } else {
          const clickedExact = await scanAndClick(page, (el, ans) => {
            if (el.tagName !== "BUTTON" && el.getAttribute("role") !== "button") return false;
            return (el.innerText || "").trim().toLowerCase() === ans.toLowerCase();
          }, answer);
          if (!clickedExact) {
            const parts = answer.includes(" ") ? answer.split(/\s+/) : answer.split("");
            for (const part of parts) {
              await scanAndClick(page, (el, p) => {
                if (el.tagName !== "BUTTON" && el.getAttribute("role") !== "button") return false;
                return (el.innerText || "").trim().toLowerCase() === p.toLowerCase();
              }, part);
              await new Promise(r => setTimeout(r, 200));
            }
          }
        }

        await new Promise(r => setTimeout(r, 300));
        await scanAndClick(page, (el) => {
          if (el.tagName !== "BUTTON") return false;
          const t = (el.innerText || "").trim().toLowerCase();
          return t === "submit" || t === "submit answer" || t === "check";
        });
        await new Promise(r => setTimeout(r, 1300));

        await scanAndClick(page, (el) => {
          if (el.tagName !== "BUTTON") return false;
          const t = (el.innerText || "").trim().toLowerCase();
          return t === "next" || t === "continue" || t === "next question";
        });
        await new Promise(r => setTimeout(r, 1000));
      }

      const onFirstQStill = await page.evaluate((n) => {
        const t = document.body ? document.body.innerText : "";
        return t.includes(n + "A") && !t.includes("Task complete") && !t.includes("Well done");
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
        return t === "continue" || t === "back to homework" || t === "sparx maths" || t === "< sparx maths";
      });
      await new Promise(r => setTimeout(r, 1200));
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
