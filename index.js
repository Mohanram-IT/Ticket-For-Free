const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

// Environment variables
const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.PORT || 8000;

// Validate environment variables
if (!token) {
  console.error("Error: BOT_TOKEN is missing in environment variables.");
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error("Error: ADMIN_ID is missing or invalid in environment variables.");
  process.exit(1);
}

// Health check server for Koyeb
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running");
  })
  .listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
  });

// Create bot instance
const bot = new TelegramBot(token, { polling: true });

console.log("Telegram bot is running...");

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

// ---------------- /start Command ----------------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const validTickets = getValidTickets();

  if (validTickets.length === 0) {
    return bot.sendMessage(chatId, "No tickets available right now.");
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

  bot.sendMessage(chatId, "Hello 👋\nPlease select your travel date:", {
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
});

// ---------------- /help Command ----------------
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(
    chatId,
    `Available commands:

/start - View available tickets
/help - Show help message

Admin only:
Upload a PDF file with filename as date.
Example: 2026-03-20.pdf`
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
        await bot.sendMessage(chatId, "No tickets available to download.");
        return bot.answerCallbackQuery(query.id);
      }

      for (const ticket of validTickets) {
        await bot.sendDocument(chatId, ticket.file_id);
      }

      return bot.answerCallbackQuery(query.id, {
        text: "All available tickets sent.",
      });
    }

    const ticket = loadTickets().find((t) => t.date === data);

    if (!ticket) {
      await bot.sendMessage(chatId, "Ticket not found.");
      return bot.answerCallbackQuery(query.id);
    }

    await bot.sendDocument(chatId, ticket.file_id);
    await bot.answerCallbackQuery(query.id, {
      text: `Ticket for ${ticket.date} sent.`,
    });
  } catch (error) {
    console.error("Callback query error:", error.message);
    await bot.sendMessage(chatId, "Something went wrong while sending the ticket.");
    await bot.answerCallbackQuery(query.id);
  }
});

// ---------------- Admin File Upload ----------------
bot.on("document", (msg) => {
  const chatId = msg.chat.id;

  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "You are not authorized to upload tickets.");
  }

  const file = msg.document;
  const fileName = file.file_name || "";

  if (!fileName.toLowerCase().endsWith(".pdf")) {
    return bot.sendMessage(chatId, "Please upload a PDF file.");
  }

  const date = fileName.replace(/\.pdf$/i, "").trim();

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return bot.sendMessage(
      chatId,
      "Invalid file name format.\nPlease upload file as YYYY-MM-DD.pdf\nExample: 2026-03-20.pdf"
    );
  }

  const tickets = loadTickets();
  const existing = tickets.find((t) => t.date === date);

  if (existing) {
    return bot.sendMessage(chatId, `Ticket for ${date} already exists.`);
  }

  tickets.push({
    date: date,
    file_id: file.file_id,
  });

  saveTickets(tickets);

  bot.sendMessage(chatId, `Ticket "${fileName}" uploaded successfully ✅`);
});

// ---------------- Admin Commands ----------------
bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;

  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "You are not authorized to use this command.");
  }

  const tickets = loadTickets();

  if (tickets.length === 0) {
    return bot.sendMessage(chatId, "No tickets found.");
  }

  const message = tickets
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((ticket, index) => `${index + 1}. ${ticket.date}`)
    .join("\n");

  bot.sendMessage(chatId, `Saved tickets:\n\n${message}`);
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  const chatId = msg.chat.id;

  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "You are not authorized to use this command.");
  }

  const date = match[1].trim();
  const tickets = loadTickets();
  const filteredTickets = tickets.filter((ticket) => ticket.date !== date);

  if (tickets.length === filteredTickets.length) {
    return bot.sendMessage(chatId, `No ticket found for date ${date}.`);
  }

  saveTickets(filteredTickets);
  bot.sendMessage(chatId, `Ticket for ${date} deleted successfully ✅`);
});

// ---------------- Message Handler ----------------
bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  if (msg.text && !msg.text.startsWith("/") && !msg.document) {
    bot.sendMessage(
      chatId,
      "Hello 👋\nWelcome to Ticket Counter Bot.\n\nType /start to view available tickets."
    );
  }
});

// ---------------- Error Handling ----------------
bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
});
