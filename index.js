const express = require("express");
const session = require("express-session");
const fileUpload = require("express-fileupload");
const TelegramBot = require("node-telegram-bot-api");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");

// ---------------- ENV ----------------
const PORT = process.env.PORT; // Use environment-provided port
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const MONGO_URI = process.env.MONGO_URI;
const PUBLIC_DOMAIN = process.env.KOYEB_PUBLIC_DOMAIN;

// ---------------- VALIDATION ----------------
if (!BOT_TOKEN || !ADMIN_ID || !MONGO_URI || !PUBLIC_DOMAIN) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// ---------------- EXPRESS APP ----------------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload());
app.use(express.static("public")); // for CSS/JS assets
app.set("view engine", "ejs"); // we'll use EJS templates

// ---------------- SESSIONS ----------------
app.use(session({
  secret: "ticket_bot_secret_key", // change in prod
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 3600000 } // 1 hour
}));

// ---------------- TELEGRAM BOT ----------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---------------- MONGODB ----------------
const client = new MongoClient(MONGO_URI);
let ticketsCollection;
let downloadsCollection;

async function connectDB() {
  await client.connect();
  const db = client.db("ticket_bot");
  ticketsCollection = db.collection("tickets");
  downloadsCollection = db.collection("downloads");
  console.log("MongoDB connected ✅");
}
connectDB();

// ---------------- HELPERS ----------------
function isLoggedIn(req) {
  return req.session?.user;
}

function isAdmin(req) {
  return req.session?.user?.role === "admin";
}

async function logDownload(user, ticketDate) {
  await downloadsCollection.insertOne({
    user,
    ticketDate,
    timestamp: new Date()
  });
}

async function getTickets(filter = "") {
  const tickets = await ticketsCollection.find(filter ? { date: { $regex: filter } } : {}).toArray();
  return tickets.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ---------------- LOGIN ROUTES ----------------
const USERS = [
  { username: "admin", password: "admin123", role: "admin" },
  { username: "user1", password: "user123", role: "user" }
];

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find(u => u.username === username && u.password === password);
  if (!user) return res.render("login", { error: "Invalid credentials" });
  req.session.user = { username: user.username, role: user.role };
  res.redirect("/dashboard");
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// ---------------- DASHBOARD ----------------
app.get("/dashboard", async (req, res) => {
  if (!isLoggedIn(req)) return res.redirect("/login");

  const filter = req.query.search || "";
  const tickets = await getTickets(filter);
  const totalDownloads = await downloadsCollection.countDocuments();
  const totalTickets = tickets.length;

  const recentDownloads = await downloadsCollection.find().sort({ timestamp: -1 }).limit(10).toArray();

  res.render("dashboard", {
    user: req.session.user,
    tickets,
    totalDownloads,
    totalTickets,
    recentDownloads,
    filter
  });
});

// ---------------- UPLOAD ----------------
app.post("/upload", async (req, res) => {
  if (!isLoggedIn(req) || !isAdmin(req)) return res.status(403).send("Unauthorized");
  if (!req.files || !req.files.ticket) return res.send("No file uploaded");

  const file = req.files.ticket;
  const date = path.parse(file.name).name;

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) return res.send("Filename must be YYYY-MM-DD.pdf");

  const exists = await ticketsCollection.findOne({ date });
  if (exists) return res.send("Ticket already exists");

  // Save file locally
  const savePath = path.join(__dirname, "uploads");
  if (!fs.existsSync(savePath)) fs.mkdirSync(savePath);
  const filePath = path.join(savePath, file.name);
  await file.mv(filePath);

  await ticketsCollection.insertOne({ date, file_path: filePath });
  res.redirect("/dashboard");
});

// ---------------- DELETE ----------------
app.get("/delete/:id", async (req, res) => {
  if (!isLoggedIn(req) || !isAdmin(req)) return res.status(403).send("Unauthorized");
  const id = req.params.id;
  const ticket = await ticketsCollection.findOne({ _id: new ObjectId(id) });
  if (!ticket) return res.send("Ticket not found");

  if (fs.existsSync(ticket.file_path)) fs.unlinkSync(ticket.file_path);
  await ticketsCollection.deleteOne({ _id: new ObjectId(id) });
  res.redirect("/dashboard");
});

// ---------------- DOWNLOAD ----------------
app.get("/download/:id", async (req, res) => {
  if (!isLoggedIn(req)) return res.status(403).send("Unauthorized");
  const id = req.params.id;
  const ticket = await ticketsCollection.findOne({ _id: new ObjectId(id) });
  if (!ticket) return res.send("Ticket not found");

  await logDownload(req.session.user.username, ticket.date);
  res.download(ticket.file_path, path.basename(ticket.file_path));
});

// ---------------- HEALTH CHECK ----------------
app.get("/health", (req, res) => {
  console.log("Health check received!"); // For debugging
  res.status(200).send("OK");
});

// ---------------- TELEGRAM BOT ----------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const tickets = await getTickets();
  if (tickets.length === 0) return bot.sendMessage(chatId, "No tickets available.");

  const buttons = tickets.map(t => [{ text: t.date, callback_data: t._id.toString() }]);
  buttons.push([{ text: "📥 Download All", callback_data: "download_all" }]);
  bot.sendMessage(chatId, "Select your travel date:", { reply_markup: { inline_keyboard: buttons } });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    if (data === "download_all") {
      const tickets = await getTickets();
      for (const t of tickets) await bot.sendDocument(chatId, t.file_path);
      return bot.answerCallbackQuery(query.id, { text: "All tickets sent." });
    }

    const ticket = await ticketsCollection.findOne({ _id: new ObjectId(data) });
    if (!ticket) return bot.sendMessage(chatId, "Ticket not found.");
    await bot.sendDocument(chatId, ticket.file_path);
    bot.answerCallbackQuery(query.id, { text: `Ticket for ${ticket.date} sent.` });
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "Error occurred while sending ticket.");
  }
});

// ---------------- SERVER ----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});
