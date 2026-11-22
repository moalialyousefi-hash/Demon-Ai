require('dotenv').config();
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');

function makePiece(type) {
  const size = 64, canvas = createCanvas(size, size), ctx = canvas.getContext('2d');
  const green = '#1DB954', y = 14, h = 36, pad = 8, r = 14;
  ctx.strokeStyle = green; ctx.fillStyle = green; ctx.lineWidth = 6;

  if (type.startsWith('left')) {
    ctx.beginPath(); ctx.moveTo(size, y); ctx.lineTo(r + 4, y);
    ctx.arcTo(4, y, 4, y + r, r); ctx.lineTo(4, y + h - r);
    ctx.arcTo(4, y + h, r + 4, y + h, r); ctx.lineTo(size, y + h); ctx.stroke();
    if (type === 'left_full') { ctx.beginPath(); ctx.roundRect(4 + pad, y + pad, size - 4 - pad, h - pad * 2, 6); ctx.fill(); }
  } else if (type.startsWith('mid')) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.moveTo(0, y + h); ctx.lineTo(size, y + h); ctx.stroke();
    if (type === 'mid_full') ctx.fillRect(0, y + pad, size, h - pad * 2);
  } else {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size - r - 4, y);
    ctx.arcTo(size - 4, y, size - 4, y + r, r); ctx.lineTo(size - 4, y + h - r);
    ctx.arcTo(size - 4, y + h, size - r - 4, y + h, r); ctx.lineTo(0, y + h); ctx.stroke();
    if (type === 'right_full') { ctx.beginPath(); ctx.roundRect(0, y + pad, size - 4 - pad, h - pad * 2, 6); ctx.fill(); }
  }
  return 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64');
}

(async () => {
  const names = ['left_empty', 'left_full', 'mid_empty', 'mid_full', 'right_empty', 'right_full'];
  const url = ['https:', '', 'discord.com', 'api', 'v10', 'applications', process.env.CLIENT_ID, 'emojis'].join('/');
  const headers = { Authorization: 'Bot ' + process.env.DISCORD_TOKEN, 'Content-Type': 'application/json' };
  const existing = await (await fetch(url, { headers })).json();
  const emojiMap = {};

  for (const name of names) {
    const found = (existing.items || []).find(e => e.name === name);
    if (found) {
      emojiMap[name] = '<:' + name + ':' + found.id + '>';
    } else {
      const created = await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name, image: makePiece(name) }) })).json();
      emojiMap[name] = '<:' + name + ':' + created.id + '>';
    }
  }
  fs.writeFileSync('emojis.json', JSON.stringify(emojiMap, null, 2));
  console.log('Uploaded all 6 custom green bar emojis!', emojiMap);
})();
