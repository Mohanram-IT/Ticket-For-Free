const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const { MongoClient } = require("mongodb");

// ---------------- ENV ----------------
const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.PORT || 8000;
const PUBLIC_DOMAIN = process.env.KOYEB_PUBLIC_DOMAIN;
const MONGO_URI = process.env.MONGO_URI;

const AUTO_DELETE_MS = 1 * 60 * 1000;

// ---------------- VALIDATION ----------------
if (!token) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error("ADMIN_ID missing");
  process.exit(1);
}

if (!PUBLIC_DOMAIN) {
  console.error("KOYEB_PUBLIC_DOMAIN missing");
  process.exit(1);
}

if (!MONGO_URI) {
  console.error("MONGO_URI missing");
  process.exit(1);
}

// ---------------- WEBHOOK ----------------
const WEBHOOK_PATH = `/telegram/${token}`;
const WEBHOOK_URL = `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`;

const bot = new TelegramBot(token);

// ---------------- MONGODB ----------------
const client = new MongoClient(MONGO_URI);

let ticketsCollection;

async function connectDB() {
  await client.connect();
  const db = client.db("ticket_bot");
  ticketsCollection = db.collection("tickets");
  console.log("MongoDB connected ✅");
}

connectDB();

// ---------------- HELPERS ----------------
async function loadTickets() {
  return await ticketsCollection.find().toArray();
}

async function getValidTickets() {
  const tickets = await loadTickets();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return tickets
    .filter((t) => new Date(t.date) >= today)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function scheduleDelete(chatId, messageId) {
  setTimeout(() => {
    bot.deleteMessage(chatId, String(messageId)).catch(() => {});
  }, AUTO_DELETE_MS);
}

function scheduleDeleteUserMessage(msg) {
  if (!msg?.chat?.id) return;

  setTimeout(() => {
    bot.deleteMessage(msg.chat.id, String(msg.message_id)).catch(() => {});
  }, AUTO_DELETE_MS);
}

async function sendAutoDeleteMessage(chatId, text, options = {}) {
  const sent = await bot.sendMessage(chatId, text, options);
  scheduleDelete(chatId, sent.message_id);
}

async function sendAutoDeleteDocument(chatId, fileId) {
  const sent = await bot.sendDocument(chatId, fileId);
  scheduleDelete(chatId, sent.message_id);
}

// ---------------- COMMANDS ----------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  const tickets = await getValidTickets();

  if (tickets.length === 0) {
    return sendAutoDeleteMessage(chatId, "No tickets available right now.");
  }

  const buttons = tickets.map((t) => [
    { text: t.date, callback_data: t.date },
  ]);

  buttons.push([{ text: "📥 Download All Tickets", callback_data: "download_all" }]);

  const sent = await bot.sendMessage(
    chatId,
    "Hello 👋\nSelect your travel date:",
    {
      reply_markup: { inline_keyboard: buttons },
    }
  );

  scheduleDelete(chatId, sent.message_id);
});

// ---------------- CALLBACK ----------------
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "download_all") {
    const tickets = await getValidTickets();

    for (const t of tickets) {
      await sendAutoDeleteDocument(chatId, t.file_id);
    }

    return bot.answerCallbackQuery(query.id);
  }

  const ticket = await ticketsCollection.findOne({ date: data });

  if (!ticket) {
    return sendAutoDeleteMessage(chatId, "Ticket not found.");
  }

  await sendAutoDeleteDocument(chatId, ticket.file_id);

  bot.answerCallbackQuery(query.id);
});

// ---------------- UPLOAD ----------------
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) {
    return sendAutoDeleteMessage(chatId, "Not authorized.");
  }

  const file = msg.document;
  const fileName = file.file_name;

  if (!fileName.endsWith(".pdf")) {
    return sendAutoDeleteMessage(chatId, "Upload PDF only.");
  }

  const date = fileName.replace(".pdf", "");

  const exists = await ticketsCollection.findOne({ date });

  if (exists) {
    return sendAutoDeleteMessage(chatId, "Ticket already exists.");
  }

  await ticketsCollection.insertOne({
    date,
    file_id: file.file_id,
  });

  sendAutoDeleteMessage(chatId, "Uploaded ✅");
});

// ---------------- ADMIN ----------------
bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) {
    return sendAutoDeleteMessage(chatId, "Not authorized.");
  }

  const tickets = await loadTickets();

  if (tickets.length === 0) {
    return sendAutoDeleteMessage(chatId, "No tickets found.");
  }

  const text = tickets.map((t, i) => `${i + 1}. ${t.date}`).join("\n");

  sendAutoDeleteMessage(chatId, text);
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) {
    return sendAutoDeleteMessage(chatId, "Not authorized.");
  }

  const date = match[1];

  const result = await ticketsCollection.deleteOne({ date });

  if (result.deletedCount === 0) {
    return sendAutoDeleteMessage(chatId, "Not found.");
  }

  sendAutoDeleteMessage(chatId, "Deleted ✅");
});

// ---------------- SERVER ----------------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";

    req.on("data", (c) => (body += c));

    req.on("end", () => {
      bot.processUpdate(JSON.parse(body));
      res.end("OK");
    });

    return;
  }

  res.end("Running");
});

// ---------------- START ----------------
server.listen(PORT, async () => {
  console.log("Server running");

  await bot.setWebHook(WEBHOOK_URL);
  console.log("Webhook set");
});
