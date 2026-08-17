// Đọc Google Sheet kế hoạch, tính việc chậm / sắp trễ, gửi một tin nhắn Telegram.
// Chạy bởi .github/workflows/nhac-viec.yml — không cần cài thêm thư viện.

const SHEET_ID = process.env.SHEET_ID;
const SHEET_GID = process.env.SHEET_GID || '0';
const WEB_URL = process.env.WEB_URL || '';
const SOON_DAYS = Number(process.env.SOON_DAYS || 3);
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const dd = n => String(n).padStart(2, '0');
const diff = (a, b) => Math.round((b - a) / 86400000);
const isCode = s => /^[A-Z]{1,3}$|^[IVX]{1,4}$/.test(String(s).trim());

function parseD(s) {
  if (!s) return null;
  const m = String(s).trim().match(/(\d{1,4})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!m) return null;
  return m[1].length === 4 ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(+m[3], +m[2] - 1, +m[1]);
}

async function loadSheet() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${SHEET_GID}&headers=0&tqx=out:json`;
  const raw = await (await fetch(url)).text();
  const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  return json.table;
}

function parseTable(table) {
  const cell = c => (!c ? '' : String(c.f != null ? c.f : c.v == null ? '' : c.v).trim());
  const grid = (table.rows || []).map(r => (r.c || []).map(cell));
  const norm = s => String(s || '').toLowerCase();
  let h = -1, head = null;
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    if (grid[i].some(c => norm(c).includes('công việc')) && grid[i].some(c => norm(c).includes('phụ trách'))) {
      h = i; head = grid[i].map(norm); break;
    }
  }
  if (h < 0) return [];
  const col = (...keys) => { for (const k of keys) { const i = head.findIndex(c => c.includes(k)); if (i >= 0) return i; } return -1; };
  const dateCols = (table.cols || []).map((c, i) => (c.type === 'date' || c.type === 'datetime' ? i : -1)).filter(i => i >= 0);
  const pick = (labelled, nth) => (labelled >= 0 ? labelled : (dateCols[nth] != null ? dateCols[nth] : -1));
  const C = {
    tt: col('tt'), name: col('công việc'), note: col('ghi chú/ tiến độ', 'ghi chú/tiến độ', 'tiến độ'),
    person: col('phụ trách'), warn: col('cảnh báo'),
    review: pick(col('thẩm định'), 0), start: pick(col('bắt đầu'), 1),
    end: pick(col('kết thúc'), 2), done: pick(col('hoàn thành'), 3)
  };
  const g = (r, i) => (i >= 0 && r[i] ? r[i] : '');
  const out = [];
  for (let i = h + 1; i < grid.length; i++) {
    const r = grid[i], tt = g(r, C.tt), name = g(r, C.name);
    if (!name || isCode(tt)) continue;
    // Chỉ lấy công việc cấp 1: cột TT là số nguyên (1, 2, 3…).
    // Cấp 2 (3.1 / a / b) và cấp 3 (TT trống) bỏ qua cho tin nhắn gọn.
    if (!/^\d+(\.0+)?$/.test(tt)) continue;
    // Chặn thêm: trong Sheet việc con luôn viết mở đầu bằng dấu gạch ngang.
    if (/^[-–•]/.test(name)) continue;
    out.push({
      name, person: g(r, C.person), note: g(r, C.note),
      start: g(r, C.start), end: g(r, C.end),
      done: g(r, C.done) || (/hoàn thành/i.test(g(r, C.warn)) ? 'x' : '')
    });
  }
  return out;
}

function esc(s) { return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function buildMessage(tasks, today) {
  const late = [], soon = [];
  for (const t of tasks) {
    if (String(t.done || '').trim()) continue;
    const end = parseD(t.end);
    if (!end) continue;
    const d = diff(end, today);
    if (d > 0) late.push({ ...t, d });
    else if (-d <= SOON_DAYS) soon.push({ ...t, d: -d });
  }
  late.sort((a, b) => b.d - a.d);
  soon.sort((a, b) => a.d - b.d);

  const line = (t, tail) => `• <b>${esc(t.name)}</b>\n   ${esc(t.person || 'chưa giao')} — ${tail}`;
  const head = `<b>Cảnh báo công việc ${dd(today.getDate())}/${dd(today.getMonth() + 1)}/${today.getFullYear()}</b>`;
  const parts = [head, `Chậm: <b>${late.length}</b> · Sắp trễ: <b>${soon.length}</b>`];

  if (late.length) parts.push('\n<b>CHẬM DEADLINE</b>\n' + late.slice(0, 12).map(t => line(t, `chậm ${t.d} ngày (hạn ${t.end})`)).join('\n')
    + (late.length > 12 ? `\n… và ${late.length - 12} việc nữa` : ''));
  if (soon.length) parts.push('\n<b>SẮP ĐẾN HẠN</b>\n' + soon.slice(0, 12).map(t => line(t, t.d === 0 ? `hạn hôm nay` : `còn ${t.d} ngày (hạn ${t.end})`)).join('\n'));
  if (!late.length && !soon.length) parts.push('\nKhông có việc nào chậm hay sắp trễ hôm nay.');
  if (WEB_URL) parts.push(`\n<a href="${WEB_URL}">Xem chi tiết từng đầu mục con trên web</a>`);
  return parts.join('\n');
}

async function send(text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const j = await res.json();
  if (!j.ok) throw new Error('Telegram lỗi: ' + JSON.stringify(j));
}

(async () => {
  if (!TOKEN || !CHAT_ID) throw new Error('Thiếu TELEGRAM_TOKEN hoặc TELEGRAM_CHAT_ID trong Secrets của repo');
  const tasks = parseTable(await loadSheet());
  if (!tasks.length) throw new Error('Không đọc được dòng công việc nào — kiểm tra quyền chia sẻ Sheet');
  // Giờ Việt Nam
  const today = new Date(Date.now() + 7 * 3600 * 1000);
  today.setUTCHours(0, 0, 0, 0);
  const vn = new Date(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  await send(buildMessage(tasks, vn));
  console.log('Đã gửi. Tổng số việc đọc được:', tasks.length);
})();
