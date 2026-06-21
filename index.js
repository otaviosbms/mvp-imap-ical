require("dotenv").config();
const express = require("express");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const ical = require("ical-generator");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

function extractEmail(text) {
  const match = text.match(/<(.+?)>/);
  return match ? match[1] : text.trim();
}

function isAllowedSender(fromText, allowedSenders) {
  if (!allowedSenders || allowedSenders.length === 0) return true;
  const fromEmail = extractEmail(fromText).toLowerCase();
  return allowedSenders.some((s) => s.toLowerCase() === fromEmail);
}

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

async function fetchEmails() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 993,
    secure: process.env.IMAP_SECURE !== "false",
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS,
    },
    logger: false,
  });

  await client.connect();

  const emails = [];
  const limit = Number(process.env.EMAIL_FETCH_LIMIT) || 50;
  const mailbox = process.env.IMAP_MAILBOX || "INBOX";

  try {
    const lock = await client.getMailboxLock(mailbox);

    try {
      // Busca as mensagens mais recentes
      const total = client.mailbox.exists;
      const start = Math.max(1, total - limit + 1);
      const range = total > 0 ? `${start}:${total}` : "1:1";

      if (total === 0) return emails;

      for await (const msg of client.fetch(range, {
        envelope: true,
        bodyStructure: true,
        source: true,
      })) {
        try {
          const parsed = await simpleParser(msg.source);
          const fromText = parsed.from?.text || "";
          const { allowedSenders } = loadConfig();

          if (!isAllowedSender(fromText, allowedSenders)) continue;

          emails.push({
            uid: msg.uid,
            subject: parsed.subject || "(Sem assunto)",
            from: fromText,
            to: parsed.to?.text || "",
            date: parsed.date || new Date(),
            text: parsed.text || "",
            html: parsed.html || "",
            messageId: parsed.messageId || `uid-${msg.uid}`,
          });
        } catch {
          // Ignora mensagens que não consegue parsear
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return emails;
}

function emailsToICS(emails, calendarName = "Emails") {
  const calendar = ical.default({
    name: calendarName,
    prodId: { company: "imap-ics-feed", product: "Email Feed" },
    timezone: "America/Sao_Paulo",
  });

  for (const email of emails) {
    const start = new Date(email.date);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // +1 hora

    const description = [
      `De: ${email.from}`,
      `Para: ${email.to}`,
      "",
      email.text?.slice(0, 500) || "",
    ]
      .join("\n")
      .trim();

    calendar.createEvent({
      uid: email.messageId,
      summary: email.subject,
      description,
      start,
      end,
      organizer: email.from
        ? { name: email.from, email: extractEmail(email.from) }
        : undefined,
      url: undefined,
    });
  }

  return calendar;
}

// Rota principal: retorna o feed .ics
app.get("/feed.ics", async (req, res) => {
  try {
    const emails = await fetchEmails();
    const calendar = emailsToICS(emails, "Feed de Emails");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="email-feed.ics"'
    );
    res.send(calendar.toString());
  } catch (err) {
    console.error("Erro ao buscar emails:", err.message);
    res.status(500).json({ error: "Falha ao conectar ao servidor IMAP", detail: err.message });
  }
});

// Rota de status / preview em JSON
app.get("/emails", async (req, res) => {
  try {
    const emails = await fetchEmails();
    res.json({ total: emails.length, emails });
  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Rota raiz com instruções
app.get("/", (req, res) => {
  const { allowedSenders } = loadConfig();
  res.json({
    status: "ok",
    endpoints: {
      feed: `${BASE_URL}/feed.ics`,
      preview: `${BASE_URL}/emails`,
    },
    allowedSenders,
    instructions: "Adicione a URL do feed .ics no seu app de calendário.",
  });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em ${BASE_URL}`);
  console.log(`Feed ICS disponível em: ${BASE_URL}/feed.ics`);
});
