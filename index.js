const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const { MongoClient } = require("mongodb");

// ---------------- ENV ----------------
const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.PORT || 8000;
const PUBLIC_DOMAIN = process.env.KOYEB_PUBLIC_DOMAIN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!token || !ADMIN_ID || !PUBLIC_DOMAIN || !MONGO_URI || !ADMIN_KEY) {
  console.error("Missing ENV ❌");
  process.exit(1);
}

// ---------------- SETUP ----------------
const bot = new TelegramBot(token);
const WEBHOOK_PATH = `/telegram/${token}`;
const WEBHOOK_URL = `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`;

const client = new MongoClient(MONGO_URI);
let ticketsCollection, logsCollection;

// ---------------- CONNECT DB ----------------
async function connectDB() {
  await client.connect();
  const db = client.db("ticket_bot");
  ticketsCollection = db.collection("tickets");
  logsCollection = db.collection("logs");
  console.log("MongoDB connected ✅");
}

// ---------------- HELPERS ----------------
async function getValidTickets() {
  const tickets = await ticketsCollection.find().toArray();
  const today = new Date();
  today.setHours(0,0,0,0);
  return tickets.filter(t => new Date(t.date) >= today);
}

async function logDownload(user, date) {
  await logsCollection.insertOne({
    user_id: user.id,
    username: user.username || "unknown",
    date,
    time: new Date()
  });
}

// ---------------- BOT ----------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const tickets = await getValidTickets();
  if (!tickets.length) return bot.sendMessage(chatId, "❌ No tickets");

  const buttons = tickets.map(t => [{ text: t.date, callback_data: t.date }]);

  bot.sendMessage(chatId, "🚆 Select Date", {
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.on("callback_query", async (q) => {
  const ticket = await ticketsCollection.findOne({ date: q.data });
  if (!ticket) return;

  await bot.sendDocument(q.message.chat.id, ticket.file_id);
  await logDownload(q.from, ticket.date);
});

// ---------------- SERVER ----------------
const server = http.createServer(async (req, res) => {

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const key = url.searchParams.get("key");

  // ---- TELEGRAM ----
  if (req.method === "POST" && pathname === WEBHOOK_PATH) {
    let body="";
    req.on("data", c => body+=c);
    req.on("end", ()=>{
      bot.processUpdate(JSON.parse(body));
      res.end("OK");
    });
    return;
  }

  // ---- ADMIN AUTH ----
  if (pathname.startsWith("/admin") && key !== ADMIN_KEY) {
    res.end("❌ Unauthorized");
    return;
  }

  // ---- DELETE API ----
  if (pathname === "/delete") {
    const date = url.searchParams.get("date");
    await ticketsCollection.deleteOne({ date });
    res.writeHead(302, { Location: `/admin?key=${ADMIN_KEY}` });
    res.end();
    return;
  }

  // ---- DOWNLOAD API ----
  if (pathname === "/download") {
    const date = url.searchParams.get("date");
    const ticket = await ticketsCollection.findOne({ date });

    if (ticket) {
      await bot.sendDocument(ADMIN_ID, ticket.file_id);
    }

    res.writeHead(302, { Location: `/admin?key=${ADMIN_KEY}` });
    res.end();
    return;
  }

  // ---- DASHBOARD ----
  if (pathname === "/admin") {
    const tickets = await ticketsCollection.find().sort({date:1}).toArray();
    const logs = await logsCollection.find().sort({time:-1}).limit(10).toArray();

    res.writeHead(200, {"Content-Type":"text/html"});
    res.end(`
<!DOCTYPE html>
<html>
<head>
<title>Dashboard</title>
<style>
body {
  font-family: Arial;
  background: #0f172a;
  color: white;
  margin:0;
}
.header {
  padding:20px;
  background:#1e293b;
  font-size:24px;
}
.container { padding:20px; }

.card {
  background:#1e293b;
  padding:15px;
  margin-bottom:20px;
  border-radius:10px;
}

table {
  width:100%;
  border-collapse: collapse;
}

th, td {
  padding:10px;
  border-bottom:1px solid #334155;
}

th { color:#94a3b8; }

.btn {
  padding:6px 10px;
  border-radius:5px;
  text-decoration:none;
  color:white;
}

.delete { background:#ef4444; }
.download { background:#22c55e; }

</style>
</head>

<body>

<div class="header">🚀 Ticket Bot Dashboard</div>

<div class="container">

<div class="card">
<h2>📊 Stats</h2>
<p>Total Tickets: ${tickets.length}</p>
<p>Total Downloads: ${await logsCollection.countDocuments()}</p>
</div>

<div class="card">
<h2>🎫 Tickets</h2>
<table>
<tr><th>Date</th><th>Actions</th></tr>

${tickets.map(t => `
<tr>
<td>${t.date}</td>
<td>
<a class="btn download" href="/download?key=${ADMIN_KEY}&date=${t.date}">⬇️</a>
<a class="btn delete" href="/delete?key=${ADMIN_KEY}&date=${t.date}">❌</a>
</td>
</tr>
`).join("")}

</table>
</div>

<div class="card">
<h2>📥 Recent Downloads</h2>
<table>
<tr><th>User</th><th>Date</th><th>Time</th></tr>

${logs.map(l => `
<tr>
<td>${l.username}</td>
<td>${l.date}</td>
<td>${new Date(l.time).toLocaleString()}</td>
</tr>
`).join("")}

</table>
</div>

</div>

</body>
</html>
`);
    return;
  }

  // ---- DEFAULT ----
  res.end("Ticket bot running");
});

// ---------------- START ----------------
server.listen(PORT, async () => {
  await connectDB();
  await bot.setWebHook(WEBHOOK_URL);
  console.log("Server running 🚀");
});
