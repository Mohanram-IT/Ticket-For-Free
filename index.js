const express = require("express");
const session = require("express-session");
const TelegramBot = require("node-telegram-bot-api");
const { MongoClient } = require("mongodb");
const cron = require("node-cron");
const multer = require("multer");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ---------------- ENV ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = Number(process.env.PORT || 8000);
const PUBLIC_DOMAIN = process.env.KOYEB_PUBLIC_DOMAIN;
const MONGO_URI = process.env.MONGO_URI;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";
const TRAIN_SOUND_URL = process.env.TRAIN_SOUND_URL || "";

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

// static files from public folder
app.use(express.static("public"));

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
    fileSize: 10 * 1024 * 1024,
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
  console.log(\`Cleanup done 🧹 Deleted \${result.deletedCount} expired ticket(s)\`);
}

function scheduleDelete(chatId, messageId, delayMs = MENU_DELETE_MS) {
  if (!chatId || !messageId || delayMs <= 0) return;

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
  const bg =
    flash.type === "error"
      ? "linear-gradient(135deg, rgba(127,29,29,.95), rgba(239,68,68,.85))"
      : "linear-gradient(135deg, rgba(20,83,45,.95), rgba(34,197,94,.85))";
  const color = flash.type === "error" ? "#fee2e2" : "#dcfce7";

  return `
    <div class="flash" style="background:${bg}; color:${color};">
      ${escapeHtml(flash.text)}
    </div>
  `;
}

function requestUrl(urlString, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    const parsed = new URL(urlString);
    const clientLib = parsed.protocol === "http:" ? http : https;

    const req = clientLib.get(parsed, (resp) => {
      const status = resp.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status) && resp.headers.location) {
        const redirectUrl = new URL(resp.headers.location, urlString).toString();
        resp.resume();
        resolve(requestUrl(redirectUrl, redirectCount + 1));
        return;
      }

      if (status >= 400) {
        reject(new Error(\`Remote file request failed with status \${status}\`));
        return;
      }

      resolve(resp);
    });

    req.on("error", reject);
  });
}

async function streamTelegramFileToResponse(fileUrl, res, fileName, inline = true) {
  const remoteResponse = await requestUrl(fileUrl);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    \`\${inline ? "inline" : "attachment"}; filename="\${String(fileName || "ticket.pdf").replace(/"/g, "")}"\`
  );

  const contentLength = remoteResponse.headers["content-length"];
  if (contentLength) {
    res.setHeader("Content-Length", contentLength);
  }

  return new Promise((resolve, reject) => {
    remoteResponse.pipe(res);
    remoteResponse.on("end", resolve);
    remoteResponse.on("error", reject);
  });
}

function themeAndInteractionScript() {
  return `
    <div id="train-cursor" aria-hidden="true">🚂</div>

    <div id="pdf-modal" class="pdf-modal hidden" aria-hidden="true">
      <div class="pdf-backdrop"></div>
      <div class="pdf-dialog">
        <div class="pdf-header">
          <div class="pdf-title">📄 Ticket Preview</div>
          <button class="btn btn-dark pdf-close" type="button" id="pdf-close-btn">✖ Close</button>
        </div>
        <div class="pdf-frame-wrap">
          <iframe id="pdf-frame" title="Ticket PDF Preview"></iframe>
        </div>
      </div>
    </div>

    <div id="page-loader" class="page-loader hidden" aria-hidden="true">
      <div class="page-loader-backdrop"></div>
      <div class="page-loader-box">
        <div class="loader-train-track">
          <div class="loader-train">🚂</div>
        </div>
        <h3>Train is arriving...</h3>
        <p>Please wait while we move you to the dashboard.</p>
      </div>
    </div>

    <script>
      (function () {
        const TRAIN_SOUND_URL = ${JSON.stringify(TRAIN_SOUND_URL)};
        const root = document.documentElement;
        const savedTheme = localStorage.getItem("ticket_theme") || "dark";
        root.setAttribute("data-theme", savedTheme);

        const themeButtons = document.querySelectorAll("[data-theme-toggle]");
        themeButtons.forEach((btn) => {
          btn.addEventListener("click", () => {
            const current = root.getAttribute("data-theme") || "dark";
            const next = current === "dark" ? "light" : "dark";
            root.setAttribute("data-theme", next);
            localStorage.setItem("ticket_theme", next);
          });
        });

        const cursor = document.getElementById("train-cursor");
        let mouseX = window.innerWidth / 2;
        let mouseY = window.innerHeight / 2;
        let currentX = mouseX;
        let currentY = mouseY;

        function animateCursor() {
          currentX += (mouseX - currentX) * 0.16;
          currentY += (mouseY - currentY) * 0.16;
          if (cursor) {
            cursor.style.transform = "translate(" + currentX + "px, " + currentY + "px)";
          }
          requestAnimationFrame(animateCursor);
        }

        document.addEventListener("mousemove", function (e) {
          mouseX = e.clientX + 6;
          mouseY = e.clientY + 6;
        });

        document.addEventListener("mouseleave", function () {
          if (cursor) cursor.style.opacity = "0";
        });

        document.addEventListener("mouseenter", function () {
          if (cursor) cursor.style.opacity = "1";
        });

        function playFallbackHorn() {
          try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const now = ctx.currentTime;

            const master = ctx.createGain();
            master.gain.setValueAtTime(0.0001, now);
            master.gain.exponentialRampToValueAtTime(0.18, now + 0.05);
            master.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);
            master.connect(ctx.destination);

            const osc1 = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const osc3 = ctx.createOscillator();

            const gain1 = ctx.createGain();
            const gain2 = ctx.createGain();
            const gain3 = ctx.createGain();

            osc1.type = "sawtooth";
            osc2.type = "square";
            osc3.type = "triangle";

            osc1.frequency.setValueAtTime(220, now);
            osc1.frequency.linearRampToValueAtTime(185, now + 1.6);

            osc2.frequency.setValueAtTime(330, now);
            osc2.frequency.linearRampToValueAtTime(265, now + 1.6);

            osc3.frequency.setValueAtTime(440, now);
            osc3.frequency.linearRampToValueAtTime(360, now + 1.6);

            gain1.gain.value = 0.42;
            gain2.gain.value = 0.22;
            gain3.gain.value = 0.12;

            osc1.connect(gain1);
            osc2.connect(gain2);
            osc3.connect(gain3);

            gain1.connect(master);
            gain2.connect(master);
            gain3.connect(master);

            osc1.start(now);
            osc2.start(now);
            osc3.start(now);

            osc1.stop(now + 1.8);
            osc2.stop(now + 1.8);
            osc3.stop(now + 1.8);

            setTimeout(() => {
              try { ctx.close(); } catch (_) {}
            }, 2200);
          } catch (_) {}
        }

        function playFallbackRunning(durationMs = 2500) {
          try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const now = ctx.currentTime;
            const master = ctx.createGain();
            master.gain.setValueAtTime(0.0001, now);
            master.gain.exponentialRampToValueAtTime(0.10, now + 0.05);
            master.connect(ctx.destination);

            const bufferSize = 2 * ctx.sampleRate;
            const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const output = noiseBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
              output[i] = Math.random() * 2 - 1;
            }

            const noise = ctx.createBufferSource();
            noise.buffer = noiseBuffer;
            noise.loop = true;

            const bandpass = ctx.createBiquadFilter();
            bandpass.type = "bandpass";
            bandpass.frequency.value = 120;
            bandpass.Q.value = 0.8;

            const tremolo = ctx.createGain();
            tremolo.gain.value = 0.35;

            const lfo = ctx.createOscillator();
            const lfoGain = ctx.createGain();
            lfo.frequency.value = 7;
            lfoGain.gain.value = 0.24;

            lfo.connect(lfoGain);
            lfoGain.connect(tremolo.gain);

            noise.connect(bandpass);
            bandpass.connect(tremolo);
            tremolo.connect(master);

            noise.start(now);
            lfo.start(now);

            master.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);

            noise.stop(now + durationMs / 1000);
            lfo.stop(now + durationMs / 1000);

            setTimeout(() => {
              try { ctx.close(); } catch (_) {}
            }, durationMs + 500);
          } catch (_) {}
        }

        function playDirectSound(url, maxMs = 5000, onFail) {
          try {
            if (!url) {
              if (onFail) onFail();
              return;
            }

            const audio = new Audio(url);
            audio.preload = "auto";

            let stopped = false;
            const stopAudio = () => {
              if (stopped) return;
              stopped = true;
              try {
                audio.pause();
                audio.currentTime = 0;
              } catch (_) {}
            };

            const fail = () => {
              stopAudio();
              if (onFail) onFail();
            };

            audio.onerror = fail;

            audio.play()
              .then(() => {
                setTimeout(stopAudio, maxMs);
              })
              .catch(fail);
          } catch (_) {
            if (onFail) onFail();
          }
        }

        function playClickSound() {
          playDirectSound(TRAIN_SOUND_URL, 1800, () => playFallbackHorn());
        }

        function playLoadingSound() {
          playDirectSound(TRAIN_SOUND_URL, 5000, () => playFallbackRunning(3200));
        }

        document.addEventListener("click", function (e) {
          const clickable = e.target.closest("a, button");
          if (!clickable) return;

          playClickSound();

          if (cursor) {
            cursor.classList.remove("cursor-pop");
            void cursor.offsetWidth;
            cursor.classList.add("cursor-pop");
          }
        });

        const loader = document.getElementById("page-loader");
        document.querySelectorAll("form[data-login-form]").forEach((form) => {
          form.addEventListener("submit", function () {
            if (loader) {
              loader.classList.remove("hidden");
              loader.setAttribute("aria-hidden", "false");
            }
            playLoadingSound();
          });
        });

        const modal = document.getElementById("pdf-modal");
        const pdfFrame = document.getElementById("pdf-frame");
        const closeBtn = document.getElementById("pdf-close-btn");

        function openPdfModal(url) {
          if (!modal || !pdfFrame) return;
          pdfFrame.src = url;
          modal.classList.remove("hidden");
          modal.setAttribute("aria-hidden", "false");
          document.body.classList.add("modal-open");
          playLoadingSound();
        }

        function closePdfModal() {
          if (!modal || !pdfFrame) return;
          modal.classList.add("hidden");
          modal.setAttribute("aria-hidden", "true");
          pdfFrame.src = "";
          document.body.classList.remove("modal-open");
        }

        document.querySelectorAll("[data-view-pdf]").forEach((btn) => {
          btn.addEventListener("click", function (e) {
            e.preventDefault();
            const url = btn.getAttribute("data-view-pdf");
            if (url) openPdfModal(url);
          });
        });

        if (closeBtn) closeBtn.addEventListener("click", closePdfModal);

        if (modal) {
          modal.addEventListener("click", function (e) {
            if (e.target.classList.contains("pdf-backdrop")) closePdfModal();
          });
        }

        document.addEventListener("keydown", function (e) {
          if (e.key === "Escape") closePdfModal();
        });

        animateCursor();
      })();
    </script>
  `;
}

function dashboardLayout(title, content) {
  return \`
  <!DOCTYPE html>
  <html data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>\${escapeHtml(title)}</title>
    <style>
      :root {
        --bg-grad-1: #020617;
        --bg-grad-2: #0f172a;
        --bg-grad-3: #111827;
        --text: #f8fafc;
        --muted: #cbd5e1;
        --soft: #94a3b8;
        --line: rgba(255,255,255,.10);
        --card: rgba(255,255,255,.055);
        --card-strong: rgba(255,255,255,.075);
        --backdrop: rgba(15,23,42,.72);
        --input: rgba(2,6,23,.55);
        --shadow: 0 14px 38px rgba(0,0,0,.20);
        --shadow-big: 0 20px 60px rgba(0,0,0,.25);
      }

      html[data-theme="light"] {
        --bg-grad-1: #eef6ff;
        --bg-grad-2: #f8fafc;
        --bg-grad-3: #e2e8f0;
        --text: #0f172a;
        --muted: #334155;
        --soft: #475569;
        --line: rgba(15,23,42,.12);
        --card: rgba(255,255,255,.78);
        --card-strong: rgba(255,255,255,.90);
        --backdrop: rgba(255,255,255,.78);
        --input: rgba(255,255,255,.92);
        --shadow: 0 14px 38px rgba(15,23,42,.10);
        --shadow-big: 0 20px 60px rgba(15,23,42,.12);
      }

      * { box-sizing: border-box; }
      html, body { cursor: none; }

      body {
        margin: 0;
        font-family: Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(59,130,246,.20), transparent 28%),
          radial-gradient(circle at top right, rgba(236,72,153,.18), transparent 24%),
          radial-gradient(circle at bottom left, rgba(34,197,94,.15), transparent 24%),
          linear-gradient(135deg, var(--bg-grad-1) 0%, var(--bg-grad-2) 38%, var(--bg-grad-3) 100%);
        min-height: 100vh;
      }

      body.modal-open { overflow: hidden; }
      a, button, input, label, form { cursor: none !important; }

      #train-cursor {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 99999;
        pointer-events: none;
        font-size: 24px;
        transform: translate(-100px, -100px);
        filter: drop-shadow(0 8px 14px rgba(0,0,0,.35));
        transition: opacity .18s ease;
      }

      .cursor-pop { animation: cursorBounce .28s ease; }
      @keyframes cursorBounce {
        0% { transform: scale(1); }
        50% { transform: scale(1.28); }
        100% { transform: scale(1); }
      }

      .topbar {
        position: sticky;
        top: 0;
        z-index: 20;
        padding: 18px 24px;
        font-size: 22px;
        font-weight: 800;
        backdrop-filter: blur(14px);
        background: var(--backdrop);
        border-bottom: 1px solid var(--line);
        box-shadow: 0 8px 24px rgba(0,0,0,.12);
      }

      .topbar-inner {
        max-width: 1240px;
        margin: 0 auto;
        display: flex;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
      }

      .wrap {
        max-width: 1240px;
        margin: 0 auto;
        padding: 24px;
      }

      .hero {
        margin-bottom: 22px;
        padding: 26px;
        border-radius: 24px;
        background:
          linear-gradient(135deg, rgba(59,130,246,.18), rgba(139,92,246,.16), rgba(236,72,153,.15)),
          var(--card);
        border: 1px solid var(--line);
        backdrop-filter: blur(12px);
        box-shadow: var(--shadow-big);
        animation: fadeUp .55s ease;
      }

      .hero h1 {
        margin: 0 0 10px 0;
        font-size: 34px;
        line-height: 1.1;
      }

      .hero p {
        margin: 0;
        color: var(--muted);
        font-size: 15px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 20px;
        margin-bottom: 20px;
        backdrop-filter: blur(12px);
        box-shadow: var(--shadow);
        animation: fadeUp .55s ease;
      }

      .muted { color: var(--soft); }
      .small { font-size: 13px; }
      .mb8 { margin-bottom: 8px; }
      .mb12 { margin-bottom: 12px; }
      .mb16 { margin-bottom: 16px; }

      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
      }

      .row-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 18px;
      }

      .stats {
        display:grid;
        grid-template-columns: repeat(4, 1fr);
        gap:16px;
        margin-bottom:20px;
      }

      .stat {
        border-radius: 20px;
        padding: 18px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.08);
        box-shadow: 0 12px 28px rgba(0,0,0,.16);
        transition: transform .22s ease, box-shadow .22s ease;
      }

      .stat:hover {
        transform: translateY(-4px);
        box-shadow: 0 20px 42px rgba(0,0,0,.18);
      }

      .stat h3 {
        margin: 0;
        font-size: 14px;
        color: rgba(255,255,255,.92);
      }

      .stat .num {
        margin-top: 10px;
        font-size: 30px;
        font-weight: 800;
        color: white;
      }

      .stat.blue { background: linear-gradient(135deg, rgba(59,130,246,.92), rgba(6,182,212,.82)); }
      .stat.green { background: linear-gradient(135deg, rgba(34,197,94,.92), rgba(16,185,129,.82)); }
      .stat.purple { background: linear-gradient(135deg, rgba(139,92,246,.92), rgba(236,72,153,.78)); }
      .stat.amber { background: linear-gradient(135deg, rgba(245,158,11,.92), rgba(251,191,36,.78)); }

      table {
        width: 100%;
        border-collapse: collapse;
        overflow: hidden;
        border-radius: 16px;
      }

      th, td {
        text-align: left;
        padding: 14px 12px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: .04em;
      }

      tbody tr:hover { background: rgba(255,255,255,.04); }
      html[data-theme="light"] tbody tr:hover { background: rgba(15,23,42,.03); }

      .btn, button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 10px 14px;
        border: none;
        border-radius: 12px;
        text-decoration: none;
        cursor: none !important;
        font-weight: 700;
        transition: transform .18s ease, opacity .18s ease, box-shadow .18s ease;
        box-shadow: 0 10px 24px rgba(0,0,0,.12);
        color: inherit;
      }

      .btn:hover, button:hover {
        transform: translateY(-2px) scale(1.01);
        opacity: .96;
      }

      .btn-primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: #04120a; }
      .btn-danger { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; }
      .btn-secondary { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; }
      .btn-dark {
        background: linear-gradient(135deg, rgba(15,23,42,.95), rgba(30,41,59,.95));
        color: white;
        border: 1px solid rgba(255,255,255,.08);
      }
      .btn-warning { background: linear-gradient(135deg, #f59e0b, #d97706); color: #111827; }

      .flex {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }

      input {
        width: 100%;
        padding: 13px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: var(--input);
        color: var(--text);
        outline: none;
        transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
      }

      input:focus {
        border-color: rgba(59,130,246,.8);
        box-shadow: 0 0 0 4px rgba(59,130,246,.16);
      }

      input[type="file"] { padding: 10px; }

      .pill {
        background: rgba(255,255,255,.06);
        border: 1px solid var(--line);
        color: var(--text);
        border-radius: 999px;
        padding: 7px 12px;
        display: inline-block;
        font-size: 12px;
        margin: 0 8px 8px 0;
      }

      html[data-theme="light"] .pill { background: rgba(255,255,255,.85); }

      .flash {
        padding: 14px 16px;
        border-radius: 16px;
        margin-bottom: 18px;
        box-shadow: 0 12px 26px rgba(0,0,0,.14);
        border: 1px solid rgba(255,255,255,.08);
      }

      .section-title {
        margin: 0 0 14px 0;
        font-size: 22px;
      }

      .subtle {
        color: var(--muted);
        line-height: 1.6;
      }

      .upload-box {
        padding: 16px;
        border-radius: 18px;
        border: 1px dashed var(--line);
        background: linear-gradient(135deg, rgba(59,130,246,.08), rgba(236,72,153,.06));
      }

      .tagline {
        display:inline-block;
        padding:8px 12px;
        border-radius:999px;
        background: rgba(255,255,255,.08);
        border:1px solid var(--line);
        font-size:12px;
        margin-bottom:12px;
      }

      html[data-theme="light"] .tagline { background: rgba(255,255,255,.9); }
      .theme-btn { min-width: 128px; }

      .pdf-modal {
        position: fixed;
        inset: 0;
        z-index: 9998;
      }

      .pdf-modal.hidden { display: none; }

      .pdf-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(2, 6, 23, 0.45);
        backdrop-filter: blur(10px);
      }

      .pdf-dialog {
        position: relative;
        z-index: 2;
        width: min(1100px, calc(100vw - 32px));
        height: min(86vh, 860px);
        margin: 5vh auto;
        border-radius: 24px;
        background: var(--card-strong);
        border: 1px solid var(--line);
        box-shadow: 0 30px 80px rgba(0,0,0,.28);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .pdf-header {
        padding: 16px 18px;
        border-bottom: 1px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        background: var(--backdrop);
        backdrop-filter: blur(14px);
      }

      .pdf-title {
        font-weight: 800;
        font-size: 18px;
      }

      .pdf-frame-wrap {
        flex: 1;
        background: rgba(255,255,255,.35);
      }

      #pdf-frame {
        width: 100%;
        height: 100%;
        border: 0;
        background: white;
      }

      .page-loader {
        position: fixed;
        inset: 0;
        z-index: 10000;
      }

      .page-loader.hidden { display: none; }

      .page-loader-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(2, 6, 23, 0.55);
        backdrop-filter: blur(12px);
      }

      .page-loader-box {
        position: relative;
        z-index: 2;
        width: min(520px, calc(100vw - 32px));
        margin: 24vh auto 0;
        padding: 26px;
        border-radius: 24px;
        background: var(--card-strong);
        border: 1px solid var(--line);
        box-shadow: 0 30px 80px rgba(0,0,0,.28);
        text-align: center;
      }

      .page-loader-box h3 {
        margin: 16px 0 8px;
        font-size: 24px;
      }

      .page-loader-box p {
        margin: 0;
        color: var(--muted);
      }

      .loader-train-track {
        width: 100%;
        height: 58px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(59,130,246,.12), rgba(236,72,153,.10), rgba(34,197,94,.10));
        overflow: hidden;
        position: relative;
      }

      .loader-train {
        position: absolute;
        top: 10px;
        left: -60px;
        font-size: 34px;
        animation: trainRun 1.45s linear infinite;
      }

      @keyframes trainRun {
        0% { transform: translateX(0); }
        100% { transform: translateX(560px); }
      }

      @keyframes fadeUp {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @media (max-width: 980px) {
        .row, .row-3, .stats { grid-template-columns: 1fr; }
      }

      @media (max-width: 768px) {
        html, body, a, button, input, label, form { cursor: auto !important; }
        #train-cursor { display: none; }

        .wrap { padding: 16px; }
        .hero h1 { font-size: 28px; }

        .flex {
          flex-direction: column;
          align-items: stretch;
        }

        .btn, button { width: 100%; }

        .topbar-inner {
          flex-direction: column;
          align-items: stretch;
        }

        .pdf-dialog {
          width: calc(100vw - 16px);
          height: 88vh;
          margin: 3vh auto;
        }
      }
    </style>
  </head>
  <body>
    <div class="topbar">
      <div class="topbar-inner">
        <div>${escapeHtml(title)}</div>
        <button class="btn btn-dark theme-btn" type="button" data-theme-toggle>🌓 Change Theme</button>
      </div>
    </div>
    <div class="wrap">
      ${content}
    </div>
    ${themeAndInteractionScript()}
  </body>
  </html>
  `;
}

// ---------------- TELEGRAM ----------------
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    scheduleDelete(chatId, msg.message_id);

    const tickets = await getValidTickets();

    if (!tickets.length) {
      const m = await bot.sendMessage(chatId, "❌ No valid tickets available right now.");
      scheduleDelete(chatId, m.message_id);
      return;
    }

    const buttons = tickets.map((t) => [{ text: t.date, callback_data: `ticket:${t.date}` }]);

    const sent = await bot.sendMessage(chatId, "🚆 Select Date", {
      reply_markup: { inline_keyboard: buttons },
    });

    scheduleDelete(chatId, sent.message_id);
  } catch (err) {
    console.error("/start error:", err);
  }
});

bot.onText(/\/admin/, async (msg) => {
  if (!adminOnly(msg)) return;

  scheduleDelete(msg.chat.id, msg.message_id);

  const text = [
    "🛠 Admin commands",
    "",
    "1. Send a PDF directly to upload a ticket",
    "2. If the filename contains a date like 2026-04-10.pdf, it will save automatically",
    "3. Otherwise I will ask you for the date in YYYY-MM-DD format",
    "4. Send /cancel to cancel pending upload",
  ].join("\n");

  const reply = await bot.sendMessage(msg.chat.id, text);
  scheduleDelete(msg.chat.id, reply.message_id);
});

bot.onText(/\/cancel/, async (msg) => {
  if (!adminOnly(msg)) return;
  pendingAdminUploads.delete(msg.chat.id);

  scheduleDelete(msg.chat.id, msg.message_id);

  const reply = await bot.sendMessage(msg.chat.id, "✅ Pending upload cancelled.");
  scheduleDelete(msg.chat.id, reply.message_id);
});

bot.on("document", async (msg) => {
  try {
    if (!adminOnly(msg)) return;

    const doc = msg.document;
    const chatId = msg.chat.id;
    if (!doc) return;

    scheduleDelete(chatId, msg.message_id);

    const mimeType = doc.mime_type || "";
    if (mimeType !== "application/pdf" && !String(doc.file_name || "").toLowerCase().endsWith(".pdf")) {
      const reply = await bot.sendMessage(chatId, "❌ Please send only PDF files.");
      scheduleDelete(chatId, reply.message_id);
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

      const reply = await bot.sendMessage(
        chatId,
        \`✅ Ticket saved for \${autoDate}\n📄 File: \${payload.file_name}\n♻️ If this date already existed, it was replaced.\`
      );
      scheduleDelete(chatId, reply.message_id);
      return;
    }

    pendingAdminUploads.set(chatId, payload);

    const reply = await bot.sendMessage(
      chatId,
      "📅 Date not found in filename.\nPlease send the ticket date in this format:\nYYYY-MM-DD\n\nExample: 2026-04-10"
    );
    scheduleDelete(chatId, reply.message_id);
  } catch (err) {
    console.error("document upload error:", err);
    try {
      const reply = await bot.sendMessage(msg.chat.id, "❌ Failed to process the uploaded PDF.");
      scheduleDelete(msg.chat.id, reply.message_id);
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

    scheduleDelete(chatId, msg.message_id);

    const date = extractDate(msg.text.trim());
    if (!date) {
      const reply = await bot.sendMessage(chatId, "❌ Invalid date format. Please send as YYYY-MM-DD");
      scheduleDelete(chatId, reply.message_id);
      return;
    }

    await saveOrReplaceTicket({
      date,
      ...pending,
    });

    pendingAdminUploads.delete(chatId);

    const reply = await bot.sendMessage(
      chatId,
      \`✅ Ticket saved for \${date}\n📄 File: \${pending.file_name}\n♻️ If this date already existed, it was replaced.\`
    );
    scheduleDelete(chatId, reply.message_id);
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

    await bot.answerCallbackQuery(query.id, { text: \`Sending ticket for \${date}\` });

    const sentDoc = await bot.sendDocument(chatId, ticket.file_id, {}, {
      filename: ticket.file_name || \`\${date}.pdf\`,
      contentType: ticket.mime_type || "application/pdf",
    });

    scheduleDelete(chatId, sentDoc.message_id);

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

  const html = dashboardLayout(
    APP_NAME,
    \`
    <div class="hero">
      <div class="tagline">Fast • Clean • Browser + Telegram Access</div>
      <h1>Download your train tickets beautifully</h1>
      <p>Use the website for instant ticket access or use the Telegram bot for one-tap ticket delivery. Everything stays synced.</p>
    </div>

    <div class="stats">
      <div class="stat blue">
        <h3>Valid Tickets</h3>
        <div class="num">\${tickets.length}</div>
      </div>
      <div class="stat green">
        <h3>Today (IST)</h3>
        <div class="num" style="font-size:22px;">\${escapeHtml(todayInIST())}</div>
      </div>
      <div class="stat purple">
        <h3>Access Mode</h3>
        <div class="num" style="font-size:22px;">Web + Bot</div>
      </div>
      <div class="stat amber">
        <h3>Status</h3>
        <div class="num" style="font-size:22px;">Live</div>
      </div>
    </div>

    <div class="card">
      <h2 class="section-title">🚆 Available Tickets</h2>
      <p class="subtle mb16">Choose a date below to preview or download the ticket directly from your browser.</p>
      \${
        tickets.length
          ? \`
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${tickets
                  .map(
                    (t) => \`
                    <tr>
                      <td>\${escapeHtml(t.date)}</td>
                      <td>
                        <div class="flex">
                          <button class="btn btn-secondary" type="button" data-view-pdf="/tickets/\${encodeURIComponent(t.date)}/stream?mode=inline">👁 View</button>
                          <a class="btn btn-primary" href="/tickets/\${encodeURIComponent(t.date)}/download">⬇ Download</a>
                        </div>
                      </td>
                    </tr>
                  \`
                  )
                  .join("")}
              </tbody>
            </table>
          \`
          : \`<p>❌ No valid tickets available.</p>\`
      }
    </div>

    <div class="row">
      <div class="card">
        <h2 class="section-title">🤖 Telegram Bot</h2>
        <p class="subtle mb16">Open your Telegram bot and send <b>/start</b> to receive tickets inside Telegram.</p>
        <div class="pill">Interactive date buttons</div>
        <div class="pill">Automatic cleanup</div>
        <div class="pill">Fast ticket sending</div>
      </div>

      <div class="card">
        <h2 class="section-title">🔐 Admin</h2>
        <p class="subtle mb16">Admins can upload tickets from Telegram or the web dashboard.</p>
        <a class="btn btn-dark" href="/admin/login">Open Admin Login</a>
      </div>
    </div>
  \`
  );

  res.status(200).send(html);
});

app.get("/tickets", async (req, res) => {
  return res.redirect("/");
});

app.get("/tickets/:date/stream", async (req, res) => {
  try {
    const date = req.params.date;
    const mode = req.query.mode === "download" ? "download" : "inline";
    const ticket = await ticketsCollection.findOne({ date });

    if (!ticket) {
      return res.status(404).send("Ticket not found");
    }

    const fileLink = await bot.getFileLink(ticket.file_id);
    await logDownload(
      { id: null, username: mode === "download" ? "web-download" : "web-view", first_name: "Web User" },
      date,
      mode === "download" ? "web-download" : "web-view"
    );

    await streamTelegramFileToResponse(
      fileLink,
      res,
      ticket.file_name || \`\${date}.pdf\`,
      mode !== "download"
    );
  } catch (err) {
    console.error("stream route error:", err);
    if (!res.headersSent) {
      res.status(500).send("Failed to open ticket");
    }
  }
});

app.get("/tickets/:date/download", async (req, res) => {
  return res.redirect(\`/tickets/\${encodeURIComponent(req.params.date)}/stream?mode=download\`);
});

// ---------------- ADMIN AUTH ----------------
app.get("/admin/login", (req, res) => {
  if (req.session?.isAdmin) return res.redirect("/admin");

  const html = dashboardLayout(
    "Admin Login",
    \`
    <div class="hero">
      <div class="tagline">Secure Admin Access</div>
      <h1>Ticket Control Center</h1>
      <p>Login to upload, replace, manage, and monitor ticket activity from a colorful admin dashboard.</p>
    </div>

    <div class="card" style="max-width:520px;margin:0 auto;">
      <h2 class="section-title">🔐 Admin Login</h2>
      <form method="POST" action="/admin/login" data-login-form>
        <div class="mb12">
          <label class="small muted">Username</label>
          <input type="text" name="username" required />
        </div>
        <div class="mb16">
          <label class="small muted">Password</label>
          <input type="password" name="password" required />
        </div>
        <div class="flex">
          <button class="btn btn-primary" type="submit">Login</button>
          <a class="btn btn-dark" href="/">← Back to Public Page</a>
        </div>
      </form>
    </div>
  \`
  );

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

  const html = dashboardLayout(
    "Admin Login",
    \`
    <div class="card" style="max-width:520px;margin:40px auto;">
      <h2 class="section-title">🔐 Admin Login</h2>
      <div class="flash" style="background:linear-gradient(135deg, rgba(127,29,29,.95), rgba(239,68,68,.85)); color:#fee2e2;">
        Invalid username or password.
      </div>
      <form method="POST" action="/admin/login" data-login-form>
        <div class="mb12">
          <label class="small muted">Username</label>
          <input type="text" name="username" required />
        </div>
        <div class="mb16">
          <label class="small muted">Password</label>
          <input type="password" name="password" required />
        </div>
        <div class="flex">
          <button class="btn btn-primary" type="submit">Login</button>
          <a class="btn btn-dark" href="/">← Back to Public Page</a>
        </div>
      </form>
    </div>
  \`
  );

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

  const html = dashboardLayout(
    "🚀 Ticket Bot Admin Dashboard",
    \`
    <div class="hero">
      <div class="tagline">Upload • Replace • Monitor • Download</div>
      <h1>Admin Dashboard</h1>
      <p>Manage tickets from Telegram or from the browser. Everything syncs to the same database and remains accessible for both web and bot users.</p>
    </div>

    \${renderFlash(flash)}

    <div class="stats">
      <div class="stat blue">
        <h3>Total Tickets</h3>
        <div class="num">\${tickets.length}</div>
      </div>
      <div class="stat green">
        <h3>Valid Tickets</h3>
        <div class="num">\${validTickets.length}</div>
      </div>
      <div class="stat purple">
        <h3>Total Downloads</h3>
        <div class="num">\${totalDownloads}</div>
      </div>
      <div class="stat amber">
        <h3>Today (IST)</h3>
        <div class="num" style="font-size:22px;">\${escapeHtml(todayInIST())}</div>
      </div>
    </div>

    <div class="card">
      <h2 class="section-title">📤 Upload Ticket from Web</h2>
      <div class="upload-box">
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
      </div>
      <p class="subtle small" style="margin-top:12px;">
        Upload a PDF directly from the browser. If the same date already exists, the old ticket will be replaced automatically.
      </p>
    </div>

    <div class="row">
      <div class="card">
        <h2 class="section-title">📝 Features</h2>
        <div class="mb8"><span class="pill">Web upload supported</span></div>
        <div class="mb8"><span class="pill">Telegram upload supported</span></div>
        <div class="mb8"><span class="pill">Same date = replace old ticket</span></div>
        <div class="mb8"><span class="pill">Midnight cleanup in IST</span></div>
        <div class="mb8"><span class="pill">Inline PDF preview modal</span></div>
        <div class="mb8"><span class="pill">Light / Dark theme</span></div>
      </div>

      <div class="card">
        <h2 class="section-title">⚙ Quick Actions</h2>
        <div class="flex" style="margin-top:14px;">
          <a class="btn btn-dark" href="/" target="_blank">🌐 Open Public Site</a>
          <a class="btn btn-warning" href="/health" target="_blank">💓 Health Check</a>
          <a class="btn btn-dark" href="/admin/logout">🚪 Logout</a>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 class="section-title">🎫 Tickets</h2>
      \${
        tickets.length
          ? \`
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>File</th>
                  <th>Source</th>
                  <th>Uploaded</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${tickets
                  .map(
                    (t) => \`
                      <tr>
                        <td>\${escapeHtml(t.date)}</td>
                        <td>\${escapeHtml(t.file_name || "ticket.pdf")}</td>
                        <td>\${escapeHtml(t.source_type || "unknown")}</td>
                        <td>\${t.updated_at ? escapeHtml(formatDateTimeIST(t.updated_at)) : "-"}</td>
                        <td>
                          <div class="flex">
                            <button class="btn btn-secondary" type="button" data-view-pdf="/tickets/\${encodeURIComponent(t.date)}/stream?mode=inline">👁 View</button>
                            <a class="btn btn-primary" href="/tickets/\${encodeURIComponent(t.date)}/download">⬇ Download</a>
                            <form method="POST" action="/admin/delete/\${encodeURIComponent(t.date)}" onsubmit="return confirm('Delete ticket for \${escapeHtml(t.date)}?')">
                              <button class="btn btn-danger" type="submit">🗑 Delete</button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    \`
                  )
                  .join("")}
              </tbody>
            </table>
          \`
          : \`<p>No tickets found.</p>\`
      }
    </div>

    <div class="card">
      <h2 class="section-title">📥 Recent Downloads</h2>
      \${
        logs.length
          ? \`
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                \${logs
                  .map(
                    (l) => \`
                      <tr>
                        <td>\${escapeHtml(l.username || l.full_name || "unknown")}</td>
                        <td>\${escapeHtml(l.date || "-")}</td>
                        <td>\${escapeHtml(l.source || "-")}</td>
                        <td>\${escapeHtml(formatDateTimeIST(l.time))}</td>
                      </tr>
                    \`
                  )
                  .join("")}
              </tbody>
            </table>
          \`
          : \`<p>No download logs yet.</p>\`
      }
    </div>
  \`
  );

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

      const sentMessage = await bot.sendDocument(
        ADMIN_ID,
        file.buffer,
        {
          caption: \`Web upload saved for \${date}\`,
        },
        {
          filename: file.originalname || \`\${date}.pdf\`,
          contentType: "application/pdf",
        }
      );

      const doc = sentMessage?.document;
      if (!doc?.file_id) {
        setFlashMessage(req, "error", "Upload failed while storing the file in Telegram.");
        return res.redirect("/admin");
      }

      scheduleDelete(ADMIN_ID, sentMessage.message_id);

      await saveOrReplaceTicket({
        date,
        file_id: doc.file_id,
        file_unique_id: doc.file_unique_id,
        file_name: file.originalname || \`\${date}.pdf\`,
        mime_type: "application/pdf",
        file_size: file.size || 0,
        uploaded_at: new Date(),
        source_type: "web_upload",
      });

      setFlashMessage(req, "success", \`Ticket uploaded successfully for \${date}.\`);
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
    setFlashMessage(req, "success", \`Ticket deleted for \${date}.\`);
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
      train_sound_url: TRAIN_SOUND_URL || "/TrainSound.mp3",
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
      console.log(\`Server listening on port \${PORT} 🚀\`);
      console.log(\`Webhook URL: \${WEBHOOK_URL}\`);

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
