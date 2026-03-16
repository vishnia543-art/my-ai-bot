import "dotenv/config";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import JSZip from "jszip";
import { createServer } from "http";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!GROQ_KEY) throw new Error("GROQ_API_KEY is required");

// Groq - бесплатный мощный AI (llama 3.3 70b)
const openai = new OpenAI({
  apiKey: GROQ_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const bot = new Telegraf(TOKEN);
const history = new Map();

const CREATE_KEYWORDS = [
  "создай","сделай","напиши","разработай","сгенерируй","построй",
  "create","make","build","generate","develop",
  "хочу приложение","хочу сайт","нужен сайт","нужно приложение",
  "есть идея","моя идея","хочу лендинг","придумай",
];

function isCreate(text) {
  const l = text.toLowerCase();
  return CREATE_KEYWORDS.some(k => l.includes(k));
}

function getHist(id) {
  if (!history.has(id)) history.set(id, []);
  return history.get(id);
}

async function searchWeb(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const results = [];
    if (data.Answer) results.push(`Ответ: ${data.Answer}`);
    if (data.AbstractText) results.push(`${data.AbstractSource}: ${data.AbstractText}`);
    if (data.RelatedTopics) {
      for (const t of data.RelatedTopics.slice(0, 5)) {
        if (t.Text) results.push(t.Text);
      }
    }
    return results.join("\n\n") || "Ничего не найдено по этому запросу";
  } catch(e) {
    return `Ошибка поиска: ${e.message}`;
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Поиск актуальной информации в интернете. Используй для погоды, курсов валют, новостей, цен и любых актуальных данных.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "поисковый запрос" } },
        required: ["query"],
      },
    },
  },
];

const SYSTEM = `Ты умный AI ассистент с доступом в интернет. 
- Для погоды, курсов валют, новостей — используй search_web
- Отвечай подробно и полезно
- Используй форматирование (списки, жирный текст)
- Отвечай на языке пользователя (русский/английский)
- Ты можешь помочь с кодом, объяснениями, переводом, анализом`;

const GEN_SYSTEM = `Ты генератор кода. Отвечай ТОЛЬКО JSON, без markdown блоков.
Формат ответа:
{"projectName":"название-через-дефис","description":"что создано (1-2 предложения)","stack":"технологии","files":[{"path":"index.html","content":"весь код файла"}],"instructions":"как запустить (2-3 шага)"}

Правила:
- Полный рабочий код, без TODO и заглушек
- Для сайтов/лендингов — всё в один index.html со встроенными CSS и JS
- Красивый современный дизайн с анимациями
- Для React проектов — создай package.json и src/ файлы
- Отвечай ТОЛЬКО JSON`;

async function chat(userId, message) {
  const hist = getHist(userId);
  hist.push({ role: "user", content: message });
  if (hist.length > 30) hist.splice(0, hist.length - 30);

  const messages = [{ role: "system", content: SYSTEM }, ...hist];
  let iters = 0;

  while (iters++ < 4) {
    const res = await openai.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 4096,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });

    const msg = res.choices[0].message;
    messages.push(msg);

    if (res.choices[0].finish_reason === "tool_calls" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let result = "";
        try {
          const args = JSON.parse(tc.function.arguments);
          if (tc.function.name === "search_web") result = await searchWeb(args.query);
        } catch(e) { result = `Ошибка: ${e.message}`; }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      continue;
    }

    const reply = msg.content || "Не смог ответить";
    hist.push({ role: "assistant", content: reply });
    return reply;
  }
  return "Ошибка. Попробуй ещё раз.";
}

async function generateProject(idea) {
  const res = await openai.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 8192,
    messages: [
      { role: "system", content: GEN_SYSTEM },
      { role: "user", content: `Создай проект: ${idea}` },
    ],
  });
  const raw = res.choices[0].message.content
    .replace(/```json\n?/g,"").replace(/```\n?/g,"").trim();
  return JSON.parse(raw);
}

async function send(ctx, text) {
  const lines = text.split("\n");
  let chunk = "";
  const chunks = [];
  for (const line of lines) {
    if ((chunk + "\n" + line).length > 4000) {
      if (chunk.trim()) chunks.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk.trim()) chunks.push(chunk);

  for (const c of chunks) {
    try { await ctx.reply(c, { parse_mode: "Markdown" }); }
    catch { await ctx.reply(c); }
  }
}

bot.start(ctx => {
  const name = ctx.from?.first_name || "друг";
  ctx.reply(
    `👋 Привет, ${name}!\n\n` +
    `Я AI ассистент — умный, с доступом в интернет.\n\n` +
    `🌐 *Умею:*\n` +
    `• Искать актуальную информацию в интернете\n` +
    `• Узнавать погоду, курсы валют, новости\n` +
    `• Создавать сайты и приложения (ZIP файл)\n` +
    `• Помогать с кодом, переводом, объяснениями\n` +
    `• Отвечать на любые вопросы\n\n` +
    `💡 *Попробуй написать:*\n` +
    `• "Погода в Тбилиси"\n` +
    `• "Курс доллара к лари"\n` +
    `• "Создай лендинг для кафе"\n` +
    `• "Объясни как работает ChatGPT"\n\n` +
    `Спрашивай всё что хочешь! 👇`,
    { parse_mode: "Markdown" }
  );
});

bot.command("new", ctx => {
  if (ctx.from?.id) history.set(ctx.from.id, []);
  ctx.reply("✨ Новый диалог! О чём поговорим?");
});

bot.command("help", ctx => {
  ctx.reply(
    `🤖 *Как пользоваться:*\n\n` +
    `Просто пиши любой вопрос!\n\n` +
    `*Для создания проекта:*\n` +
    `"Создай сайт для..."\n` +
    `"Сделай приложение для..."\n` +
    `"Напиши лендинг для..."\n\n` +
    `*Команды:*\n` +
    `/new — начать новый диалог\n` +
    `/help — эта справка`,
    { parse_mode: "Markdown" }
  );
});

bot.on("text", async ctx => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!userId || !text || text.startsWith("/")) return;

  try {
    if (isCreate(text)) {
      await ctx.sendChatAction("upload_document");
      await ctx.reply("⚙️ *Генерирую проект...*\n\n🧠 Пишу код...\n📦 Собираю файлы...\n_~20-30 сек_", { parse_mode: "Markdown" });

      const project = await generateProject(text);
      const zip = new JSZip();
      for (const f of project.files) zip.file(f.path, f.content);
      const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

      await ctx.replyWithDocument(
        { source: buf, filename: `${project.projectName}.zip` },
        {
          caption:
            `✅ *Готово!*\n\n` +
            `📁 *${project.projectName}*\n` +
            `${project.description}\n\n` +
            `🛠 *Стек:* ${project.stack}\n` +
            `📄 *Файлов:* ${project.files.length}\n\n` +
            `▶️ *Как запустить:*\n${project.instructions}\n\n` +
            `_Напиши что изменить — доработаю!_`,
          parse_mode: "Markdown",
        }
      );
    } else {
      await ctx.sendChatAction("typing");
      const interval = setInterval(() => ctx.sendChatAction("typing").catch(() => {}), 4000);
      const reply = await chat(userId, text);
      clearInterval(interval);
      await send(ctx, reply);
    }
  } catch(e) {
    console.error("Error:", e.message);
    await ctx.reply("😔 Ошибка. Попробуй ещё раз или напиши /new");
  }
});

bot.catch((err, ctx) => console.error(`Error [${ctx.updateType}]:`, err));

bot.launch({ allowedUpdates: ["message"] });
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
console.log("🤖 Bot started on Groq AI (free)!");

// Keep-alive HTTP сервер для Render
const port = process.env.PORT || 3000;
createServer((_, res) => res.writeHead(200).end("Bot is running!")).listen(port);
console.log(`Health check: http://localhost:${port}`);
