const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const { MongoClient } = require("mongodb");

// ---------------- ENV ----------------
const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.PORT || 8000;
const PUBLIC_DOMAIN = process.env.KOYEB_PUBLIC_DOMAIN;
const MONGO_URI = process.env.MONGO_URI;

// ---------------- VALIDATION ----------------
if (!token) { console.error("BOT_TOKEN missing"); process.exit(1); }
if (!ADMIN_ID) { console.error("ADMIN_ID missing"); process.exit(1); }
if (!PUBLIC_DOMAIN) { console.error("KOYEB_PUBLIC_DOMAIN missing"); process.exit(1); }
if (!MONGO_URI) { console.error("MONGO_URI missing"); process.exit(1); }

// ---------------- WEBHOOK ----------------
const WEBHOOK_PATH = `/telegram/${token}`;
const WEBHOOK_URL = `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`;

// ---------------- TELEGRAM BOT ----------------
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

// ---------------- SCHEDULE DELETION ----------------
function scheduleDeleteNextMidnight(chatId, messageId) {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setDate(now.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  const msUntilMidnight = nextMidnight - now;

  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, String(messageId));
      console.log(`Deleted message ${messageId} from chat ${chatId} at next midnight`);
    } catch (error) {
      console.log(`Could not delete message ${messageId}: ${error.message}`);
    }
  }, msUntilMidnight);
}

function scheduleDeleteUserMessage(msg) {
  if (!msg?.chat?.id) return;
  scheduleDeleteNextMidnight(msg.chat.id, msg.message_id);
}

async function sendAutoDeleteMessage(chatId, text, options = {}) {
  const sent = await bot.sendMessage(chatId, text, options);
  scheduleDeleteNextMidnight(chatId, sent.message_id);
  return sent;
}

async function sendAutoDeleteDocument(chatId, fileId, options = {}) {
  const sent = await bot.sendDocument(chatId, fileId, options);
  scheduleDeleteNextMidnight(chatId, sent.message_id);
  return sent;
}

// ---------------- COMMANDS ----------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  const tickets = await getValidTickets();
  if (tickets.length === 0) {
    return sendAutoDeleteMessage(chatId, "No tickets available right now.");
  }

  const buttons = tickets.map((t) => [{ text: t.date, callback_data: t.date }]);
  buttons.push([{ text: "📥 Download All Tickets", callback_data: "download_all" }]);

  const sent = await bot.sendMessage(chatId, "Hello 👋\nSelect your travel date:", {
    reply_markup: { inline_keyboard: buttons },
  });

  scheduleDeleteNextMidnight(chatId, sent.message_id);
});

// ---------------- CALLBACK ----------------
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    if (data === "download_all") {
      const tickets = await getValidTickets();
      if (tickets.length === 0) {
        await sendAutoDeleteMessage(chatId, "No tickets available to download.");
        return bot.answerCallbackQuery(query.id);
      }
      for (const t of tickets) await sendAutoDeleteDocument(chatId, t.file_id);
      return bot.answerCallbackQuery(query.id, { text: "All tickets sent." });
    }

    const ticket = await ticketsCollection.findOne({ date: data });
    if (!ticket) {
      await sendAutoDeleteMessage(chatId, "Ticket not found.");
      return bot.answerCallbackQuery(query.id);
    }

    await sendAutoDeleteDocument(chatId, ticket.file_id);
    bot.answerCallbackQuery(query.id, { text: `Ticket for ${ticket.date} sent.` });
  } catch (error) {
    console.error(error);
    await sendAutoDeleteMessage(chatId, "Something went wrong.");
    bot.answerCallbackQuery(query.id);
  }
});

// ---------------- UPLOAD ----------------
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) return sendAutoDeleteMessage(chatId, "Not authorized.");

  const file = msg.document;
  const fileName = file.file_name;
  if (!fileName.toLowerCase().endsWith(".pdf")) return sendAutoDeleteMessage(chatId, "Upload PDF only.");

  const date = fileName.replace(/\.pdf$/i, "").trim();
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) return sendAutoDeleteMessage(chatId, "Filename must be YYYY-MM-DD.pdf");

  const exists = await ticketsCollection.findOne({ date });
  if (exists) return sendAutoDeleteMessage(chatId, "Ticket already exists.");

  await ticketsCollection.insertOne({ date, file_id: file.file_id });
  sendAutoDeleteMessage(chatId, `Ticket "${fileName}" uploaded successfully ✅`);
});

// ---------------- ADMIN COMMANDS ----------------
bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) return sendAutoDeleteMessage(chatId, "Not authorized.");
  const tickets = await loadTickets();
  if (tickets.length === 0) return sendAutoDeleteMessage(chatId, "No tickets found.");

  const text = tickets.sort((a,b)=> new Date(a.date) - new Date(b.date))
                      .map((t,i)=> `${i+1}. ${t.date}`).join("\n");
  sendAutoDeleteMessage(chatId, text);
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) return sendAutoDeleteMessage(chatId, "Not authorized.");
  const date = match[1].trim();
  const result = await ticketsCollection.deleteOne({ date });

  if (result.deletedCount === 0) return sendAutoDeleteMessage(chatId, "Ticket not found.");
  sendAutoDeleteMessage(chatId, `Ticket for ${date} deleted ✅`);
});

// ---------------- DEFAULT MESSAGE ----------------
bot.on("message", async (msg) => {
  if (msg.text && !msg.text.startsWith("/") && !msg.document) {
    scheduleDeleteUserMessage(msg);
    await sendAutoDeleteMessage(msg.chat.id, "Hello 👋\nUse /start to view available tickets.");
  }
});

// ---------------- HTTP SERVER ----------------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      bot.processUpdate(JSON.parse(body));
      res.writeHead(200);
      res.end("OK");
    });
    return;
  }

  res.writeHead(200);
  res.end("Ticket bot running");
});

// ---------------- START SERVER ----------------
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await bot.setWebHook(WEBHOOK_URL);
    console.log(`Webhook set at ${WEBHOOK_URL}`);
  } catch (error) {
    console.error("Failed to set webhook:", error.message);
  }
});

// ---------------- ERROR HANDLING ----------------
process.on("uncaughtException", (error) => console.error("Uncaught Exception:", error));
process.on("unhandledRejection", (error) => console.error("Unhandled Rejection:", error));
