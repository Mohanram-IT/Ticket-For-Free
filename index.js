const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

// Environment variables
const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.PORT || 8000;
const PUBLIC_DOMAIN = process.env.KOYEB_PUBLIC_DOMAIN;

// Change this for testing:
// 1 minute = 1 * 60 * 1000
// later for 30 minutes use: 30 * 60 * 1000
const AUTO_DELETE_MS = 1 * 60 * 1000;

// Validate environment variables
if (!token) {
  console.error("Error: BOT_TOKEN is missing in environment variables.");
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error("Error: ADMIN_ID is missing or invalid in environment variables.");
  process.exit(1);
}

if (!PUBLIC_DOMAIN) {
  console.error("Error: KOYEB_PUBLIC_DOMAIN is missing.");
  process.exit(1);
}

const WEBHOOK_PATH = `/telegram/${token}`;
const WEBHOOK_URL = `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`;

// Create bot in webhook mode
const bot = new TelegramBot(token);

// ---------------- Paths ----------------
const ticketsFolder = path.join(__dirname, "tickets");
const ticketsFile = path.join(__dirname, "tickets.json");

// Ensure tickets folder exists
if (!fs.existsSync(ticketsFolder)) {
  fs.mkdirSync(ticketsFolder, { recursive: true });
}

// Ensure tickets.json exists
if (!fs.existsSync(ticketsFile)) {
  fs.writeFileSync(ticketsFile, JSON.stringify([], null, 2));
}

// ---------------- Helper Functions ----------------
function loadTickets() {
  try {
    const data = fs.readFileSync(ticketsFile, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading tickets.json:", error.message);
    return [];
  }
}

function saveTickets(tickets) {
  try {
    fs.writeFileSync(ticketsFile, JSON.stringify(tickets, null, 2));
  } catch (error) {
    console.error("Error writing tickets.json:", error.message);
  }
}

function getValidTickets() {
  const tickets = loadTickets();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return tickets
    .filter((ticket) => {
      const ticketDate = new Date(ticket.date);
      return !isNaN(ticketDate.getTime()) && ticketDate >= today;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function scheduleDelete(chatId, messageId) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, String(messageId));
      console.log(`Deleted message ${messageId} from chat ${chatId}`);
    } catch (error) {
      console.log(`Could not delete message ${messageId}: ${error.message}`);
    }
  }, AUTO_DELETE_MS);
}

function scheduleDeleteUserMessage(msg) {
  if (!msg || !msg.chat || !msg.message_id) return;

  setTimeout(async () => {
    try {
      await bot.deleteMessage(msg.chat.id, String(msg.message_id));
      console.log(`Deleted user message ${msg.message_id} from chat ${msg.chat.id}`);
    } catch (error) {
      console.log(`Could not delete user message ${msg.message_id}: ${error.message}`);
    }
  }, AUTO_DELETE_MS);
}

async function sendAutoDeleteMessage(chatId, text, options = {}) {
  const sent = await bot.sendMessage(chatId, text, options);
  scheduleDelete(chatId, sent.message_id);
  return sent;
}

async function sendAutoDeleteDocument(chatId, fileId, options = {}) {
  const sent = await bot.sendDocument(chatId, fileId, options);
  scheduleDelete(chatId, sent.message_id);
  return sent;
}

// ---------------- Commands ----------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const validTickets = getValidTickets();

  // Optional: also delete the user's /start message after 1 minute
  scheduleDeleteUserMessage(msg);

  if (validTickets.length === 0) {
    await sendAutoDeleteMessage(chatId, "No tickets available right now.");
    return;
  }

  const buttons = validTickets.map((ticket) => [
    {
      text: ticket.date,
      callback_data: ticket.date,
    },
  ]);

  buttons.push([
    {
      text: "📥 Download All Tickets",
      callback_data: "download_all",
    },
  ]);

  const sent = await bot.sendMessage(
    chatId,
    "Hello 👋\nPlease select your travel date:\n\n⏳ This message will be deleted automatically.",
    {
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );

  scheduleDelete(chatId, sent.message_id);
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  await sendAutoDeleteMessage(
    chatId,
    `Available commands:

/start - View available tickets
/help - Show help message
/list - View saved tickets (admin only)
/delete YYYY-MM-DD - Delete a ticket by date (admin only)

Admin only:
Upload a PDF file with filename as date.
Example: 2026-03-20.pdf

⏳ This message will be deleted automatically.`
  );
});

// ---------------- Callback Query ----------------
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    if (data === "download_all") {
      const validTickets = getValidTickets();

      if (validTickets.length === 0) {
        await sendAutoDeleteMessage(chatId, "No tickets available to download.");
        await bot.answerCallbackQuery(query.id);
        return;
      }

      for (const ticket of validTickets) {
        await sendAutoDeleteDocument(chatId, ticket.file_id);
      }

      await bot.answerCallbackQuery(query.id, {
        text: "All available tickets sent.",
      });

      return;
    }

    const ticket = loadTickets().find((t) => t.date === data);

    if (!ticket) {
      await sendAutoDeleteMessage(chatId, "Ticket not found.");
      await bot.answerCallbackQuery(query.id);
      return;
    }

    await sendAutoDeleteDocument(chatId, ticket.file_id);

    await bot.answerCallbackQuery(query.id, {
      text: `Ticket for ${ticket.date} sent.`,
    });
  } catch (error) {
    console.error("Callback query error:", error.message);
    await sendAutoDeleteMessage(chatId, "Something went wrong while sending the ticket.");
    await bot.answerCallbackQuery(query.id);
  }
});

// ---------------- Admin File Upload ----------------
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;

  // Optional: delete uploaded document message after 1 minute
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) {
    await sendAutoDeleteMessage(chatId, "You are not authorized to upload tickets.");
    return;
  }

  const file = msg.document;
  const fileName = file.file_name || "";

  if (!fileName.toLowerCase().endsWith(".pdf")) {
    await sendAutoDeleteMessage(chatId, "Please upload a PDF file.");
    return;
  }

  const date = fileName.replace(/\.pdf$/i, "").trim();

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    await sendAutoDeleteMessage(
      chatId,
      "Invalid file name format.\nPlease upload file as YYYY-MM-DD.pdf\nExample: 2026-03-20.pdf"
    );
    return;
  }

  const tickets = loadTickets();
  const existing = tickets.find((t) => t.date === date);

  if (existing) {
    await sendAutoDeleteMessage(chatId, `Ticket for ${date} already exists.`);
    return;
  }

  tickets.push({
    date: date,
    file_id: file.file_id,
  });

  saveTickets(tickets);

  await sendAutoDeleteMessage(chatId, `Ticket "${fileName}" uploaded successfully ✅`);
});

// ---------------- Admin Commands ----------------
bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) {
    await sendAutoDeleteMessage(chatId, "You are not authorized to use this command.");
    return;
  }

  const tickets = loadTickets();

  if (tickets.length === 0) {
    await sendAutoDeleteMessage(chatId, "No tickets found.");
    return;
  }

  const message = tickets
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((ticket, index) => `${index + 1}. ${ticket.date}`)
    .join("\n");

  await sendAutoDeleteMessage(chatId, `Saved tickets:\n\n${message}`);
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  scheduleDeleteUserMessage(msg);

  if (chatId !== ADMIN_ID) {
    await sendAutoDeleteMessage(chatId, "You are not authorized to use this command.");
    return;
  }

  const date = match[1].trim();
  const tickets = loadTickets();
  const filteredTickets = tickets.filter((ticket) => ticket.date !== date);

  if (tickets.length === filteredTickets.length) {
    await sendAutoDeleteMessage(chatId, `No ticket found for date ${date}.`);
    return;
  }

  saveTickets(filteredTickets);
  await sendAutoDeleteMessage(chatId, `Ticket for ${date} deleted successfully ✅`);
});

// ---------------- Default Message ----------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  if (msg.text && !msg.text.startsWith("/") && !msg.document) {
    scheduleDeleteUserMessage(msg);

    await sendAutoDeleteMessage(
      chatId,
      "Hello 👋\nWelcome to Ticket Counter Bot.\n\nType /start to view available tickets."
    );
  }
});

// ---------------- HTTP Server ----------------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        bot.processUpdate(update);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      } catch (error) {
        console.error("Webhook processing error:", error.message);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error");
      }
    });

    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Ticket bot webhook is running");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// ---------------- Start Server and Set Webhook ----------------
server.listen(PORT, async () => {
  console.log(`Server is listening on port ${PORT}`);
  console.log(`Webhook path: ${WEBHOOK_PATH}`);
  console.log(`Webhook URL: ${WEBHOOK_URL}`);

  try {
    await bot.setWebHook(WEBHOOK_URL);
    console.log("Webhook set successfully");
  } catch (error) {
    console.error("Failed to set webhook:", error.message);
  }
});

// ---------------- Error Handling ----------------
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
});
