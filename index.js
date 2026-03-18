const express = require("express");
const session = require("express-session");
const TelegramBot = require("node-telegram-bot-api");
const { MongoClient } = require("mongodb");
const cron = require("node-cron");
const multer = require("multer");

// ---------------- ENV ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = Number(process.env.PORT || 8000);
const PUBLIC_DOMAIN = process.env.KOYEB_PUBLIC_DOMAIN;
const MONGO_URI = process.env.MONGO_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";

const TIMEZONE = "Asia/Kolkata";
const MENU_DELETE_MS = Number(process.env.MENU_DELETE_MS || 30 * 60 * 1000);
const APP_NAME = "Yercaud Express Ticket Bot";

if (
  !BOT_TOKEN ||
  !ADMIN_ID ||
  !PUBLIC_DOMAIN ||
  !MONGO_URI ||
  !ADMIN_USERNAME ||
  !ADMIN_PASSWORD ||
  !SESSION_SECRET
) {
  console.error("Missing required environment variables ❌");
  process.exit(1);
}

// ---------------- APP / BOT ----------------
const app = express();
app.set("trust proxy", 1);

const bot = new TelegramBot(BOT_TOKEN);
const WEBHOOK_PATH = `/telegram/${BOT_TOKEN}`;
const WEBHOOK_URL = `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`;

const client = new MongoClient(MONGO_URI);
let ticketsCollection;
let logsCollection;

const pendingAdminUploads = new Map();

// ---------------- MULTER ----------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      String(file.originalname || "").toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      return cb(new Error("Only PDF files are allowed"));
    }

    cb(null, true);
  },
});

// ---------------- MIDDLEWARE ----------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

// ---------------- DB ----------------
async function connectDB() {
  await client.connect();
  const db = client.db("ticket_bot");
  ticketsCollection = db.collection("tickets");
  logsCollection = db.collection("logs");

  await ticketsCollection.createIndex({ date: 1 }, { unique: true });
  await logsCollection.createIndex({ time: -1 });

  console.log("MongoDB connected ✅");
}

// ---------------- HELPERS ----------------
function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function todayInIST() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function formatDateTimeIST(date) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(date));
}

function extractDate(text = "") {
  const match = String(text).match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (!match) return null;

  const yyyy = match[1];
  const mm = match[2];
  const dd = match[3];

  const month = Number(mm);
  const day = Number(dd);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function isValidDate(date) {
  return extractDate(date) === date;
}

async function getValidTickets() {
  const today = todayInIST();
  return ticketsCollection.find({ date: { $gte: today } }).sort({ date: 1 }).toArray();
}

async function getAllTickets() {
  return ticketsCollection.find().sort({ date: 1 }).toArray();
}

async function saveOrReplaceTicket(ticketData) {
  await ticketsCollection.updateOne(
    { date: ticketData.date },
    {
      $set: {
        ...ticketData,
        updated_at: new Date(),
      },
      $setOnInsert: {
        created_at: new Date(),
      },
    },
    { upsert: true }
  );
}

async function logDownload(user, date, source = "telegram") {
  await logsCollection.insertOne({
    user_id: user?.id || null,
    username: user?.username || user?.first_name || "unknown",
    full_name: [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "unknown",
    date,
    source,
    time: new Date(),
  });
}

async function cleanupExpiredTickets() {
  const today = todayInIST();
  const result = await ticketsCollection.deleteMany({ date: { $lt: today } });
  console.log(`Cleanup done 🧹 Deleted ${result.deletedCount} expired ticket(s)`);
}

async function scheduleDeleteMessage(chatId, messageId, delayMs = MENU_DELETE_MS) {
  if (!messageId || delayMs <= 0) return;

  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, String(messageId));
    } catch (_) {}
  }, delayMs);
}

function adminOnly(msg) {
  return msg?.from?.id === ADMIN_ID;
}

function requireAdminLogin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/admin/login");
}

function getFlashMessage(req) {
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  return flash;
}

function setFlashMessage(req, type, text) {
  if (req.session) {
    req.session.flash = { type, text };
  }
}

function renderFlash(flash) {
  if (!flash) return "";
  const bg = flash.type === "error" ? "#7f1d1d" : "#14532d";
  const color = flash.type === "error" ? "#fecaca" : "#bbf7d0";

  return `
    <div style="background:${bg}; color:${color}; padding:12px 14px; border-radius:10px; margin-bottom:16px;">
      ${escapeHtml(flash.text)}
    </div>
  `;
}

function dashboardLayout(title, content) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #0f172a;
        color: #fff;
      }
      .topbar {
        background: #111827;
        padding: 18px 24px;
        font-size: 22px;
        font-weight: 700;
      }
      .wrap {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px;
      }
      .card {
        background: #1e293b;
        border-radius: 12px;
        padding: 18px;
        margin-bottom: 20px;
      }
      .muted {
        color: #94a3b8;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 12px 10px;
        border-bottom: 1px solid #334155;
        vertical-align: top;
      }
      th {
        color: #cbd5e1;
      }
      .btn, button {
        display: inline-block;
        padding: 8px 12px;
        border: none;
        border-radius: 8px;
        text-decoration: none;
        cursor: pointer;
        font-weight: 600;
      }
      .btn-primary { background: #22c55e; color: #08130a; }
      .btn-danger { background: #ef4444; color: white; }
      .btn-secondary { background: #3b82f6; color: white; }
      .btn-dark { background: #0f172a; color: white; border: 1px solid #334155; }
      .btn-warning { background: #f59e0b; color: #111827; }
      input {
        width: 100%;
        padding: 12px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0f172a;
        color: white;
        box-sizing: border-box;
      }
      input[type="file"] {
        padding: 10px;
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }
      .row-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 16px;
      }
      .small {
        font-size: 13px;
      }
      .mb8 { margin-bottom: 8px; }
      .mb12 { margin-bottom: 12px; }
      .mb16 { margin-bottom: 16px; }
      .flex {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .pill {
        background: #0f172a;
        border: 1px solid #334155;
        color: #cbd5e1;
        border-radius: 999px;
        padding: 6px 10px;
        display: inline-block;
        font-size: 12px;
      }
      @media (max-width: 768px) {
        .row, .row-3 {
          grid-template-columns: 1fr;
        }
        .flex {
          flex-direction: column;
          align-items: flex-start;
        }
      }
    </style>
  </head>
  <body>
    <div class="topbar">${escapeHtml(title)}</div>
    <div class="wrap">
      ${content}
    </div>
  </body>
  </html>
  `;
}

// ---------------- TELEGRAM ----------------
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const tickets = await getValidTickets();

    if (!tickets.length) {
      const m = await bot.sendMessage(chatId, "❌ No valid tickets available right now.");
      await scheduleDeleteMessage(chatId, m.message_id);
      return;
    }

    const buttons = tickets.map((t) => [{ text: t.date, callback_data: `ticket:${t.date}` }]);

    const sent = await bot.sendMessage(chatId, "🚆 Select Date", {
      reply_markup: { inline_keyboard: buttons },
    });

    await scheduleDeleteMessage(chatId, sent.message_id);
  } catch (err) {
    console.error("/start error:", err);
  }
});

bot.onText(/\/admin/, async (msg) => {
  if (!adminOnly(msg)) return;

  const text = [
    "🛠 Admin commands",
    "",
    "1. Send a PDF directly to upload a ticket",
    "2. If the filename contains a date like 2026-04-10.pdf, it will save automatically",
    "3. Otherwise I will ask you for the date in YYYY-MM-DD format",
    "4. Send /cancel to cancel pending upload",
  ].join("\n");

  await bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/cancel/, async (msg) => {
  if (!adminOnly(msg)) return;
  pendingAdminUploads.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "✅ Pending upload cancelled.");
});

bot.on("document", async (msg) => {
  try {
    if (!adminOnly(msg)) return;

    const doc = msg.document;
    const chatId = msg.chat.id;
    if (!doc) return;

    const mimeType = doc.mime_type || "";
    if (mimeType !== "application/pdf" && !String(doc.file_name || "").toLowerCase().endsWith(".pdf")) {
      await bot.sendMessage(chatId, "❌ Please send only PDF files.");
      return;
    }

    const payload = {
      file_id: doc.file_id,
      file_unique_id: doc.file_unique_id,
      file_name: doc.file_name || "ticket.pdf",
      mime_type: doc.mime_type || "application/pdf",
      file_size: doc.file_size || 0,
      uploaded_at: new Date(),
      source_type: "telegram_upload",
    };

    const autoDate = extractDate(doc.file_name || "");

    if (autoDate) {
      await saveOrReplaceTicket({
        date: autoDate,
        ...payload,
      });

      await bot.sendMessage(
        chatId,
        `✅ Ticket saved for ${autoDate}\n📄 File: ${payload.file_name}\n♻️ If this date already existed, it was replaced.`
      );
      return;
    }

    pendingAdminUploads.set(chatId, payload);
    await bot.sendMessage(
      chatId,
      "📅 Date not found in filename.\nPlease send the ticket date in this format:\nYYYY-MM-DD\n\nExample: 2026-04-10"
    );
  } catch (err) {
    console.error("document upload error:", err);
    try {
      await bot.sendMessage(msg.chat.id, "❌ Failed to process the uploaded PDF.");
    } catch (_) {}
  }
});

bot.on("message", async (msg) => {
  try {
    if (!adminOnly(msg)) return;
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const pending = pendingAdminUploads.get(chatId);
    if (!pending) return;

    const date = extractDate(msg.text.trim());
    if (!date) {
      await bot.sendMessage(chatId, "❌ Invalid date format. Please send as YYYY-MM-DD");
      return;
    }

    await saveOrReplaceTicket({
      date,
      ...pending,
    });

    pendingAdminUploads.delete(chatId);

    await bot.sendMessage(
      chatId,
      `✅ Ticket saved for ${date}\n📄 File: ${pending.file_name}\n♻️ If this date already existed, it was replaced.`
    );
  } catch (err) {
    console.error("admin date reply error:", err);
  }
});

bot.on("callback_query", async (query) => {
  try {
    const data = query.data || "";
    const chatId = query.message?.chat?.id;

    if (!data.startsWith("ticket:")) {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const date = data.replace("ticket:", "");
    const ticket = await ticketsCollection.findOne({ date });

    if (!ticket) {
      await bot.answerCallbackQuery(query.id, { text: "Ticket not found", show_alert: true });
      return;
    }

    await bot.answerCallbackQuery(query.id, { text: `Sending ticket for ${date}` });

    if (ticket.file_id) {
      await bot.sendDocument(chatId, ticket.file_id, {}, {
        filename: ticket.file_name || `${date}.pdf`,
        contentType: ticket.mime_type || "application/pdf",
      });
    } else {
      const fileLink = await bot.getFileLink(ticket.file_id);
      await bot.sendMessage(chatId, `📄 Open your ticket: ${fileLink}`);
    }

    await logDownload(query.from, date, "telegram");

    try {
      if (query.message?.message_id) {
        await bot.deleteMessage(chatId, String(query.message.message_id));
      }
    } catch (_) {}
  } catch (err) {
    console.error("callback_query error:", err);
    try {
      await bot.answerCallbackQuery(query.id, { text: "Something went wrong", show_alert: true });
    } catch (_) {}
  }
});

// ---------------- WEBHOOK ----------------
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Webhook processing failed");
  }
});

// ---------------- PUBLIC ROUTES ----------------
app.get("/", async (req, res) => {
  const tickets = await getValidTickets();

  const html = dashboardLayout(APP_NAME, `
    <div class="card">
      <h2 class="mb8">🚆 Available Tickets</h2>
      <p class="muted mb16">You can download tickets from the browser here, or use the Telegram bot.</p>
      ${
        tickets.length
          ? `
            <table>
              <tr>
                <th>Date</th>
                <th>Actions</th>
              </tr>
              ${tickets
                .map(
                  (t) => `
                  <tr>
                    <td>${escapeHtml(t.date)}</td>
                    <td class="flex">
                      <a class="btn btn-secondary" href="/tickets/${encodeURIComponent(t.date)}/view" target="_blank">View</a>
                      <a class="btn btn-primary" href="/tickets/${encodeURIComponent(t.date)}/download">Download</a>
                    </td>
                  </tr>
                `
                )
                .join("")}
            </table>
          `
          : `<p>❌ No valid tickets available.</p>`
      }
    </div>

    <div class="card">
      <h2 class="mb8">🤖 Telegram Bot</h2>
      <p class="muted">Open your Telegram bot and send <b>/start</b> to receive tickets inside Telegram.</p>
    </div>

    <div class="card">
      <h2 class="mb8">🔐 Admin</h2>
      <a class="btn btn-dark" href="/admin/login">Open Admin Login</a>
    </div>
  `);

  res.status(200).send(html);
});

app.get("/tickets", async (req, res) => {
  return res.redirect("/");
});

app.get("/tickets/:date/view", async (req, res) => {
  try {
    const date = req.params.date;
    const ticket = await ticketsCollection.findOne({ date });

    if (!ticket) return res.status(404).send("Ticket not found");

    const fileLink = await bot.getFileLink(ticket.file_id);
    await logDownload({ id: null, username: "web-view", first_name: "Web User" }, date, "web");

    return res.redirect(fileLink);
  } catch (err) {
    console.error("view route error:", err);
    return res.status(500).send("Failed to open ticket");
  }
});

app.get("/tickets/:date/download", async (req, res) => {
  try {
    const date = req.params.date;
    const ticket = await ticketsCollection.findOne({ date });

    if (!ticket) return res.status(404).send("Ticket not found");

    const fileLink = await bot.getFileLink(ticket.file_id);
    await logDownload({ id: null, username: "web-download", first_name: "Web User" }, date, "web");

    return res.redirect(fileLink);
  } catch (err) {
    console.error("download route error:", err);
    return res.status(500).send("Failed to download ticket");
  }
});

// ---------------- ADMIN AUTH ----------------
app.get("/admin/login", (req, res) => {
  if (req.session?.isAdmin) return res.redirect("/admin");

  const html = dashboardLayout("Admin Login", `
    <div class="card" style="max-width:500px;margin:40px auto;">
      <h2 class="mb16">🔐 Admin Login</h2>
      <form method="POST" action="/admin/login">
        <div class="mb12">
          <label class="small muted">Username</label>
          <input type="text" name="username" required />
        </div>
        <div class="mb16">
          <label class="small muted">Password</label>
          <input type="password" name="password" required />
        </div>
        <button class="btn btn-primary" type="submit">Login</button>
      </form>
    </div>
  `);

  res.status(200).send(html);
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;

    return req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).send("Login failed");
      }
      return res.redirect("/admin");
    });
  }

  const html = dashboardLayout("Admin Login", `
    <div class="card" style="max-width:500px;margin:40px auto;">
      <h2 class="mb16">🔐 Admin Login</h2>
      <p style="color:#fca5a5;">Invalid username or password.</p>
      <form method="POST" action="/admin/login">
        <div class="mb12">
          <label class="small muted">Username</label>
          <input type="text" name="username" required />
        </div>
        <div class="mb16">
          <label class="small muted">Password</label>
          <input type="password" name="password" required />
        </div>
        <button class="btn btn-primary" type="submit">Login</button>
      </form>
    </div>
  `);

  res.status(401).send(html);
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin/login");
  });
});

// ---------------- ADMIN DASHBOARD ----------------
app.get("/admin", requireAdminLogin, async (req, res) => {
  const tickets = await getAllTickets();
  const logs = await logsCollection.find().sort({ time: -1 }).limit(25).toArray();
  const totalDownloads = await logsCollection.countDocuments();
  const validTickets = await getValidTickets();
  const flash = getFlashMessage(req);

  const html = dashboardLayout("🚀 Ticket Bot Admin Dashboard", `
    ${renderFlash(flash)}

    <div class="card">
      <h2 class="mb16">📤 Upload Ticket from Web</h2>
      <form method="POST" action="/admin/upload" enctype="multipart/form-data">
        <div class="row-3">
          <div>
            <label class="small muted">Ticket Date</label>
            <input type="text" name="date" placeholder="YYYY-MM-DD" required />
          </div>
          <div>
            <label class="small muted">PDF File</label>
            <input type="file" name="ticket_pdf" accept="application/pdf,.pdf" required />
          </div>
          <div style="display:flex; align-items:end;">
            <button class="btn btn-primary" type="submit">Upload Ticket</button>
          </div>
        </div>
      </form>
      <p class="muted small" style="margin-top:12px;">
        Upload a PDF directly from the browser. If the date already exists, the old ticket will be replaced.
      </p>
    </div>

    <div class="row">
      <div class="card">
        <h2 class="mb8">📊 Stats</h2>
        <p>Total Tickets: <b>${tickets.length}</b></p>
        <p>Valid Tickets: <b>${validTickets.length}</b></p>
        <p>Total Downloads: <b>${totalDownloads}</b></p>
        <p>Today (IST): <b>${todayInIST()}</b></p>
      </div>

      <div class="card">
        <h2 class="mb8">📝 Upload Instructions</h2>
        <p>Upload tickets from Telegram or from this dashboard.</p>
        <div class="mb8"><span class="pill">Web upload supported</span></div>
        <div class="mb8"><span class="pill">Telegram PDF upload supported</span></div>
        <div class="mb8"><span class="pill">Same date = replace old ticket</span></div>
        <div class="mb8"><span class="pill">Cleanup runs daily at 12:00 AM IST</span></div>
        <div class="flex" style="margin-top:14px;">
          <a class="btn btn-dark" href="/" target="_blank">Open Public Site</a>
          <a class="btn btn-dark" href="/admin/logout">Logout</a>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="mb16">🎫 Tickets</h2>
      ${
        tickets.length
          ? `
            <table>
              <tr>
                <th>Date</th>
                <th>File</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
              ${tickets
                .map(
                  (t) => `
                    <tr>
                      <td>${escapeHtml(t.date)}</td>
                      <td>${escapeHtml(t.file_name || "ticket.pdf")}</td>
                      <td>${t.updated_at ? escapeHtml(formatDateTimeIST(t.updated_at)) : "-"}</td>
                      <td class="flex">
                        <a class="btn btn-secondary" target="_blank" href="/tickets/${encodeURIComponent(t.date)}/view">View</a>
                        <a class="btn btn-primary" href="/tickets/${encodeURIComponent(t.date)}/download">Download</a>
                        <form method="POST" action="/admin/delete/${encodeURIComponent(t.date)}" onsubmit="return confirm('Delete ticket for ${escapeHtml(t.date)}?')">
                          <button class="btn btn-danger" type="submit">Delete</button>
                        </form>
                      </td>
                    </tr>
                  `
                )
                .join("")}
            </table>
          `
          : `<p>No tickets found.</p>`
      }
    </div>

    <div class="card">
      <h2 class="mb16">📥 Recent Downloads</h2>
      ${
        logs.length
          ? `
            <table>
              <tr>
                <th>User</th>
                <th>Date</th>
                <th>Source</th>
                <th>Time</th>
              </tr>
              ${logs
                .map(
                  (l) => `
                    <tr>
                      <td>${escapeHtml(l.username || l.full_name || "unknown")}</td>
                      <td>${escapeHtml(l.date || "-")}</td>
                      <td>${escapeHtml(l.source || "-")}</td>
                      <td>${escapeHtml(formatDateTimeIST(l.time))}</td>
                    </tr>
                  `
                )
                .join("")}
            </table>
          `
          : `<p>No download logs yet.</p>`
      }
    </div>
  `);

  res.status(200).send(html);
});

// ---------------- ADMIN WEB UPLOAD ----------------
app.post("/admin/upload", requireAdminLogin, (req, res) => {
  upload.single("ticket_pdf")(req, res, async (err) => {
    try {
      if (err) {
        setFlashMessage(req, "error", err.message || "Upload failed");
        return res.redirect("/admin");
      }

      const date = String(req.body?.date || "").trim();
      const file = req.file;

      if (!date || !isValidDate(date)) {
        setFlashMessage(req, "error", "Please enter a valid date in YYYY-MM-DD format.");
        return res.redirect("/admin");
      }

      if (!file) {
        setFlashMessage(req, "error", "Please choose a PDF file.");
        return res.redirect("/admin");
      }

      // Send uploaded PDF to admin Telegram chat to get Telegram file_id
      const sentMessage = await bot.sendDocument(
        ADMIN_ID,
        file.buffer,
        {
          caption: `Web upload saved for ${date}`,
        },
        {
          filename: file.originalname || `${date}.pdf`,
          contentType: "application/pdf",
        }
      );

      const doc = sentMessage?.document;
      if (!doc?.file_id) {
        setFlashMessage(req, "error", "Upload failed while storing the file in Telegram.");
        return res.redirect("/admin");
      }

      await saveOrReplaceTicket({
        date,
        file_id: doc.file_id,
        file_unique_id: doc.file_unique_id,
        file_name: file.originalname || `${date}.pdf`,
        mime_type: "application/pdf",
        file_size: file.size || 0,
        uploaded_at: new Date(),
        source_type: "web_upload",
      });

      setFlashMessage(req, "success", `Ticket uploaded successfully for ${date}.`);
      return res.redirect("/admin");
    } catch (error) {
      console.error("admin web upload error:", error);
      setFlashMessage(req, "error", "Failed to upload ticket from web.");
      return res.redirect("/admin");
    }
  });
});

app.post("/admin/delete/:date", requireAdminLogin, async (req, res) => {
  try {
    const date = req.params.date;
    await ticketsCollection.deleteOne({ date });
    setFlashMessage(req, "success", `Ticket deleted for ${date}.`);
    return res.redirect("/admin");
  } catch (err) {
    console.error("delete ticket error:", err);
    setFlashMessage(req, "error", "Failed to delete ticket.");
    return res.redirect("/admin");
  }
});

// ---------------- HEALTH ----------------
app.get("/health", async (req, res) => {
  try {
    await client.db("admin").command({ ping: 1 });
    res.status(200).json({
      ok: true,
      service: APP_NAME,
      today_ist: todayInIST(),
      webhook: WEBHOOK_URL,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// ---------------- STARTUP ----------------
async function startServer() {
  try {
    await connectDB();

    await cleanupExpiredTickets();

    cron.schedule(
      "0 0 * * *",
      async () => {
        try {
          await cleanupExpiredTickets();
        } catch (err) {
          console.error("Scheduled cleanup error:", err);
        }
      },
      { timezone: TIMEZONE }
    );

    const server = app.listen(PORT, async () => {
      console.log(`Server listening on port ${PORT} 🚀`);
      console.log(`Webhook URL: ${WEBHOOK_URL}`);

      await bot.setWebHook(WEBHOOK_URL);
      console.log("Telegram webhook set ✅");
    });

    process.on("SIGINT", async () => {
      console.log("Shutting down...");
      await client.close();
      server.close(() => process.exit(0));
    });

    process.on("SIGTERM", async () => {
      console.log("Shutting down...");
      await client.close();
      server.close(() => process.exit(0));
    });
  } catch (err) {
    console.error("Startup failed ❌", err);
    process.exit(1);
  }
}

startServer();
