import "dotenv/config";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import JSZip from "jszip";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_KEY = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is required");

const openai = new OpenAI({
  apiKey: OPENAI_KEY,
  ...(OPENAI_BASE ? { baseURL: OPENAI_BASE } : {}),
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
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const data = await res.json();
  const results = [];
  if (data.AbstractText) results.push(`${data.AbstractSource}: ${data.AbstractText}`);
  if (data.RelatedTopics) {
    for (const t of data.RelatedTopics.slice(0, 4)) {
      if (t.Text) results.push(t.Text);
    }
  }
  return results.join("\n\n") || "Ничего не найдено";
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Поиск в интернете — для актуальных данных, новостей, погоды, курсов валют",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
];

const SYSTEM = `Ты умный AI ассистент с доступом в интернет. 
Используй search_web для актуальных данных (погода, курсы, новости).
Отвечай подробно на языке пользователя.`;

const GEN_SYSTEM = `Ты генератор кода. Отвечай ТОЛЬКО JSON без markdown.
Формат:
{
  "projectName": "название",
  "description": "что создано",
  "stack": "технологии",
  "files": [{"path": "index.html", "content": "весь код"}],
  "instructions": "как запустить"
}
Создавай ПОЛНЫЙ рабочий код. Для сайтов — всё в один index.html.`;

async function chat(userId, message) {
  const hist = getHist(userId);
  hist.push({ role: "user", content: message });
  if (hist.length > 40) hist.splice(0, hist.length - 40);

  const messages = [{ role: "system", content: SYSTEM }, ...hist];
  let iters = 0;

  while (iters++ < 5) {
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });

    const msg = res.choices[0].message;
    messages.push(msg);

    if (res.choices[0].finish_reason === "tool_calls" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        let result = "";
        try {
          if (tc.function.name === "search_web") result = await searchWeb(args.query);
        } catch (e) { result = `Ошибка: ${e.message}`; }
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
    model: "gpt-4o",
    max_tokens: 8192,
    messages: [
      { role: "system", content: GEN_SYSTEM },
      { role: "user", content: `Создай: ${idea}` },
    ],
  });
  const raw = res.choices[0].message.content.replace(/```json\n?/g,"").replace(/```\n?/g,"").trim();
  return JSON.parse(raw);
}

async function send(ctx, text) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [];
  for (const chunk of chunks) {
    try { await ctx.reply(chunk, { parse_mode: "Markdown" }); }
    catch { await ctx.reply(chunk); }
  }
}

bot.start(ctx => {
  const name = ctx.from?.first_name || "друг";
  ctx.reply(
    `👋 Привет, ${name}!\n\n` +
    `Я AI ассистент с доступом в интернет.\n\n` +
    `🌐 Умею:\n` +
    `• Искать информацию в интернете\n` +
    `• Узнавать погоду, курсы, новости\n` +
    `• Создавать сайты и приложения (ZIP)\n` +
    `• Отвечать на любые вопросы\n\n` +
    `Попробуй:\n` +
    `• "Погода в Тбилиси"\n` +
    `• "Курс доллара"\n` +
    `• "Создай сайт для кафе"\n\n` +
    `Спрашивай! 👇`
  );
});

bot.command("new", ctx => {
  if (ctx.from?.id) history.set(ctx.from.id, []);
  ctx.reply("✨ Новый диалог! О чём поговорим?");
});

bot.command("help", ctx => {
  ctx.reply(
    `🤖 Помощь:\n\n` +
    `/new — новый диалог\n\n` +
    `Просто пиши — я отвечу!\n` +
    `Для создания проекта напиши "создай..." или "сделай..."`
  );
});

bot.on("text", async ctx => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!userId || !text || text.startsWith("/")) return;

  try {
    if (isCreate(text)) {
      await ctx.sendChatAction("upload_document");
      await ctx.reply("⚙️ Генерирую проект... (~20 сек)");

      const project = await generateProject(text);
      const zip = new JSZip();
      for (const f of project.files) zip.file(f.path, f.content);
      const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

      await ctx.replyWithDocument(
        { source: buf, filename: `${project.projectName}.zip` },
        {
          caption:
            `✅ Готово!\n\n📁 ${project.projectName}\n${project.description}\n\n` +
            `🛠 ${project.stack}\n📄 ${project.files.length} файлов\n\n` +
            `▶️ ${project.instructions}`,
        }
      );
    } else {
      await ctx.sendChatAction("typing");
      const interval = setInterval(() => ctx.sendChatAction("typing").catch(()=>{}), 4000);
      const reply = await chat(userId, text);
      clearInterval(interval);
      await send(ctx, reply);
    }
  } catch (e) {
    console.error(e);
    await ctx.reply("😔 Ошибка. Попробуй /new и снова.");
  }
});

bot.launch({ allowedUpdates: ["message"] });
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
console.log("🤖 Bot started!");

// Keep-alive для Render
import { createServer } from "http";
const port = process.env.PORT || 3000;
createServer((_, res) => res.end("OK")).listen(port, () => {
  console.log(`Health check on port ${port}`);
});
