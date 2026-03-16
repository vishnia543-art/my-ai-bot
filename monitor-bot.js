import "dotenv/config";
import OpenAI from "openai";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || "@Light_Water_Tbilisi";
const GROQ_KEY = process.env.GROQ_API_KEY;
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 минут
const SEEN_FILE = "./seen_notifications.json";

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!GROQ_KEY) throw new Error("GROQ_API_KEY is required");

const openai = new OpenAI({
  apiKey: GROQ_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// --- Хранилище уже отправленных уведомлений ---
function loadSeen() {
  try {
    if (existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf8")));
    }
  } catch {}
  return new Set();
}

function saveSeen(set) {
  const arr = [...set];
  // Держим только последние 500
  const trimmed = arr.slice(-500);
  writeFileSync(SEEN_FILE, JSON.stringify(trimmed), "utf8");
}

const seenIds = loadSeen();

// --- Отправка в Telegram ---
async function sendToChannel(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHANNEL_ID,
      text,
      parse_mode: "HTML",
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram error:", data.description);
  }
  return data.ok;
}

// --- Получение HTML страницы ---
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ka,en-US;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// --- Очистка HTML ---
function cleanHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

// --- AI извлечение и перевод уведомлений ---
async function extractNotifications(pageText, sourceType) {
  const prompt = sourceType === "water"
    ? `Это текст со страницы грузинской компании водоснабжения GWP. 
Найди ВСЕ уведомления об отключении воды (плановых и внеплановых).
Для каждого уведомления верни JSON массив объектов:
[{
  "id": "уникальный_id на основе адреса+даты",
  "type": "плановое" или "внеплановое",
  "date": "дата и время",
  "area": "район/адрес",
  "reason": "причина если указана",
  "duration": "продолжительность если указана"
}]
Если уведомлений нет — верни пустой массив [].
Отвечай ТОЛЬКО JSON без пояснений.

Текст страницы:
${pageText.slice(0, 6000)}`
    : `Это текст со страницы грузинской компании Telasi (электроснабжение).
Найди ВСЕ уведомления об отключении электричества (плановых и внеплановых).
Для каждого уведомления верни JSON массив объектов:
[{
  "id": "уникальный_id на основе адреса+даты",
  "type": "плановое" или "внеплановое",
  "date": "дата и время",
  "area": "район/адрес",
  "reason": "причина если указана",
  "duration": "продолжительность если указана"
}]
Если уведомлений нет — верни пустой массив [].
Отвечай ТОЛЬКО JSON без пояснений.

Текст страницы:
${pageText.slice(0, 6000)}`;

  const res = await openai.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
  });

  const raw = res.choices[0].message.content
    .replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// --- Форматирование сообщения для канала ---
function formatMessage(notification, sourceType) {
  const emoji = sourceType === "water" ? "💧" : "⚡";
  const service = sourceType === "water" ? "Водоснабжение (GWP)" : "Электроснабжение (Telasi)";
  const typeEmoji = notification.type?.includes("внеплан") ? "🚨" : "📋";

  let msg = `${emoji} <b>${service}</b>\n`;
  msg += `${typeEmoji} <b>${notification.type?.toUpperCase() || "УВЕДОМЛЕНИЕ"}</b>\n\n`;

  if (notification.date) msg += `🕐 <b>Дата/время:</b> ${notification.date}\n`;
  if (notification.area) msg += `📍 <b>Район/адрес:</b> ${notification.area}\n`;
  if (notification.reason) msg += `ℹ️ <b>Причина:</b> ${notification.reason}\n`;
  if (notification.duration) msg += `⏱ <b>Продолжительность:</b> ${notification.duration}\n`;

  msg += `\n<i>Источник: ${sourceType === "water" ? "gwp.ge" : "telasi.ge"}</i>`;
  return msg;
}

// --- Основная проверка одного источника ---
async function checkSource(url, sourceType) {
  console.log(`[${new Date().toISOString()}] Checking ${sourceType}: ${url}`);
  let newCount = 0;

  try {
    const html = await fetchPage(url);
    const text = cleanHtml(html);

    if (text.length < 100) {
      console.log(`Empty or blocked page for ${sourceType}`);
      return 0;
    }

    const notifications = await extractNotifications(text, sourceType);
    console.log(`Found ${notifications.length} notifications from ${sourceType}`);

    for (const notif of notifications) {
      if (!notif.id) continue;

      const uniqueId = `${sourceType}_${notif.id}`;

      if (seenIds.has(uniqueId)) {
        console.log(`Already sent: ${uniqueId}`);
        continue;
      }

      const message = formatMessage(notif, sourceType);
      const sent = await sendToChannel(message);

      if (sent) {
        seenIds.add(uniqueId);
        newCount++;
        console.log(`✅ Sent: ${uniqueId}`);
        // Пауза между сообщениями
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    saveSeen(seenIds);
  } catch (err) {
    console.error(`Error checking ${sourceType}:`, err.message);
  }

  return newCount;
}

// --- Главная функция проверки ---
async function checkAll() {
  console.log(`\n🔍 [${new Date().toLocaleString("ru-RU")}] Checking sources...`);

  let total = 0;
  total += await checkSource("https://gwp.ge/ka/news/nonscheduled-works", "water");

  // Пауза между источниками
  await new Promise(r => setTimeout(r, 3000));

  total += await checkSource("https://www.telasi.ge/", "electricity");

  if (total > 0) {
    console.log(`✅ Sent ${total} new notifications`);
  } else {
    console.log(`ℹ️ No new notifications`);
  }
}

// --- Запуск ---
async function main() {
  console.log("🤖 Light & Water Monitor Bot started!");
  console.log(`📢 Channel: ${CHANNEL_ID}`);
  console.log(`⏱ Check interval: ${CHECK_INTERVAL_MS / 60000} minutes`);

  // Отправить приветствие при старте
  await sendToChannel(
    `🤖 <b>Бот мониторинга запущен!</b>\n\n` +
    `Я буду проверять уведомления об отключениях каждые 10 минут и переводить их на русский язык.\n\n` +
    `💧 Источник воды: gwp.ge\n` +
    `⚡ Источник света: telasi.ge`
  ).catch(console.error);

  // Первая проверка сразу
  await checkAll();

  // Затем каждые N минут
  setInterval(checkAll, CHECK_INTERVAL_MS);
}

main().catch(console.error);

// Keep-alive HTTP сервер для Render
const port = process.env.PORT || 3000;
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Bot is running. Seen: ${seenIds.size} notifications.`);
}).listen(port, () => {
  console.log(`Health check: http://localhost:${port}`);
});
