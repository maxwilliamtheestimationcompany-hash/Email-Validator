require("dotenv").config();
const express = require("express");
const cors = require("cors");
const validator = require("validator");
const dns = require("dns").promises;
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const { createValidectClient } = require("./validect");
const validect = createValidectClient();
const app = express();
app.use(cors({
  origin(origin, cb) {
    if (!origin || CORS_ORIGINS.includes("*") || CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "5mb" }));
// Serve only the UI, never backend source, saved jobs, or credentials.

const APP_VERSION = "6.4.0";
const PORT = Number(process.env.PORT || 3093);
const MAX_BULK_EMAILS = Number(process.env.MAX_BULK_EMAILS || 5000);
const BULK_CONCURRENCY = Number(process.env.BULK_CONCURRENCY || 20);
const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 5000);
const SMTP_ATTEMPT_HARD_TIMEOUT_MS = Number(process.env.SMTP_ATTEMPT_HARD_TIMEOUT_MS || 6500);
const DNS_TIMEOUT_MS = Number(process.env.DNS_TIMEOUT_MS || 3000);
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const MAX_MX_ATTEMPTS = Number(process.env.MAX_MX_ATTEMPTS || 2);
const DOMAIN_DELAY_MS = Number(process.env.DOMAIN_DELAY_MS || 90);
const DOMAIN_CONCURRENCY = Math.max(1, Number(process.env.DOMAIN_CONCURRENCY || 2));
const MX_CACHE_TTL_MS = Number(process.env.MX_CACHE_TTL_MS || 10 * 60 * 1000);
const DOMAIN_SIGNAL_TTL_MS = Number(process.env.DOMAIN_SIGNAL_TTL_MS || 30 * 60 * 1000);
const EMAIL_HARD_TIMEOUT_MS = Number(process.env.EMAIL_HARD_TIMEOUT_MS || 18000);
const GLOBAL_CONCURRENCY = Math.max(1, Number(process.env.GLOBAL_CONCURRENCY || 24));
const QUIET_EMAIL_LOGS = String(process.env.QUIET_EMAIL_LOGS || "1") !== "0";
const SMTP_BEHAVIOR_TTL_MS = Number(process.env.SMTP_BEHAVIOR_TTL_MS || 15 * 60 * 1000);
const LOCAL_TEST_MODE = true; // v6.1 free/no-key: browser and backend use same-origin access
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "*").split(",").map(v => v.trim()).filter(Boolean);
const JOB_RETENTION_MS = Number(process.env.JOB_RETENTION_MS || 24 * 60 * 60 * 1000);
const JOB_RESULT_PAGE_SIZE = Math.max(50, Math.min(1000, Number(process.env.JOB_RESULT_PAGE_SIZE || 500)));
const DATA_DIR = path.join(__dirname, "data", "jobs");

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}


// IMPORTANT FOR ACCURACY:
// Set these to a real hostname/email on a domain you control when possible.
// A matching PTR/rDNS for the server IP also reduces anti-bot SMTP rejections.
const SMTP_HELO = String(
  process.env.SMTP_HELO ||
  (os.hostname().includes(".") ? os.hostname() : "verifier.localhost")
).trim();
const SMTP_FROM = String(process.env.SMTP_FROM || "").trim().toLowerCase();

const mxCache = new Map();
const signalCache = new Map();
const domainStates = new Map();
const smtpBehaviorCache = new Map();

const globalState = { active: 0, queue: [] };

async function withGlobalLimit(fn) {
  if (globalState.active >= GLOBAL_CONCURRENCY) {
    await new Promise(resolve => globalState.queue.push(resolve));
  }

  globalState.active += 1;

  try {
    return await fn();
  } finally {
    globalState.active -= 1;
    const next = globalState.queue.shift();
    if (next) next();
  }
}

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "ymail.com", "aol.com", "icloud.com", "me.com",
  "mac.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com",
  "zoho.com", "fastmail.com"
]);

const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "10minutemail.net", "guerrillamail.com", "guerrillamail.net",
  "mailinator.com", "tempmail.com", "temp-mail.org", "yopmail.com", "sharklasers.com",
  "getnada.com", "trashmail.com", "dispostable.com", "maildrop.cc", "fakeinbox.com",
  "mintemail.com", "mohmal.com", "emailondeck.com", "throwawaymail.com"
]);

const ROLE_PREFIXES = new Set([
  "admin", "billing", "contact", "hello", "help", "hr", "info", "office",
  "orders", "postmaster", "reception", "sales", "security", "support",
  "team", "webmaster", "careers", "jobs", "accounts", "accounting", "finance",
  "marketing", "service", "customerservice", "customer.service", "recruiting", "recruitment"
]);

const COMMON_DOMAIN_TYPOS = new Map([
  ["gmai.com", "gmail.com"], ["gmial.com", "gmail.com"], ["gmal.com", "gmail.com"],
  ["gmail.co", "gmail.com"], ["hotmai.com", "hotmail.com"], ["hotmal.com", "hotmail.com"],
  ["outlok.com", "outlook.com"], ["outllook.com", "outlook.com"],
  ["yaho.com", "yahoo.com"], ["yahooo.com", "yahoo.com"],
  ["aol.co", "aol.com"], ["outlook.co", "outlook.com"],
  ["icloud.co", "icloud.com"], ["protonmail.co", "protonmail.com"]
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


function providerFromDomain(domain) {
  const d = String(domain || "").toLowerCase();
  if (["gmail.com", "googlemail.com"].includes(d)) return "Google Workspace / Gmail";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(d)) return "Microsoft 365 / Outlook";
  if (["yahoo.com", "ymail.com", "aol.com"].includes(d)) return "Yahoo / AOL Mail";
  if (["icloud.com", "me.com", "mac.com"].includes(d)) return "Apple iCloud Mail";
  if (["proton.me", "protonmail.com"].includes(d)) return "Proton Mail";
  if (["gmx.com", "gmx.net"].includes(d)) return "GMX Mail";
  if (d === "zoho.com") return "Zoho Mail";
  if (d === "fastmail.com") return "Fastmail";
  return null;
}

function scoreDeliverability({ syntaxValid = true, mxFound = false, hasSpf = false, hasDmarc = false, mailboxStatus = "Unknown", catchAll = null, disposable = false, roleBased = false, provider = "Custom / Other", suggestion = null }) {
  if (!syntaxValid) return 0;
  let score = 25;
  if (mxFound) score += 30;
  if (hasSpf) score += 6;
  if (hasDmarc) score += 6;
  if (provider !== "Custom / Other") score += 4;
  if (mailboxStatus === "Accepted") score += 28;
  if (mailboxStatus === "Invalid") score = Math.min(score, 5);
  if (mailboxStatus === "Protected") score += 2;
  if (mailboxStatus === "Temporary") score -= 4;
  if (mailboxStatus === "Unknown") score -= 6;
  if (mailboxStatus === "Timed Out") score -= 2;
  if (catchAll === true) score -= 14;
  if (catchAll === false && mailboxStatus === "Accepted") score += 5;
  if (disposable) score -= 35;
  if (roleBased) score -= 4;
  if (suggestion) score -= 30;

  // Domain authentication and MX records prove that the DOMAIN can receive mail,
  // not that this exact mailbox exists. Keep unverified/protected results from
  // receiving a misleadingly high deliverability score.
  if (mailboxStatus === "Protected") score = Math.min(score, 55);
  if (mailboxStatus === "Temporary") score = Math.min(score, 45);
  if (mailboxStatus === "Unknown") score = Math.min(score, 45);
  if (mailboxStatus === "Timed Out") score = Math.min(score, 65);

  return clamp(Math.round(score), 0, 100);
}

function verificationLevel(mailboxStatus, catchAll) {
  if (mailboxStatus === "Accepted" && catchAll === false) return "Mailbox Confirmed";
  if (mailboxStatus === "Accepted" && catchAll === true) return "Catch-All Domain";
  if (mailboxStatus === "Accepted") return "Mailbox Accepted";
  if (mailboxStatus === "Invalid") return "Mailbox Rejected";
  if (mailboxStatus === "Protected") return "Domain Confirmed / Mailbox Protected";
  if (mailboxStatus === "Temporary") return "Temporary SMTP Result";
  if (mailboxStatus === "Timed Out") return "Domain Confirmed / SMTP Timeout";
  return "Domain Confirmed / Mailbox Unverified";
}

function enrichResult(result) {
  const signals = { hasSpf: Boolean(result.spf), hasDmarc: Boolean(result.dmarc) };
  const mailboxStatus = result.mailboxStatus || "Unknown";
  const enriched = {
    ...result,
    engineVersion: APP_VERSION,
    verificationLevel: result.verificationLevel || verificationLevel(mailboxStatus, result.catchAll),
  };
  enriched.deliverabilityScore = Number.isFinite(Number(result.deliverabilityScore))
    ? Number(result.deliverabilityScore)
    : scoreDeliverability({
        syntaxValid: result.syntaxValid !== false,
        mxFound: Boolean(result.mxFound),
        hasSpf: signals.hasSpf,
        hasDmarc: signals.hasDmarc,
        mailboxStatus,
        catchAll: result.catchAll,
        disposable: Boolean(result.disposable),
        roleBased: Boolean(result.roleBased),
        provider: result.provider || "Custom / Other",
        suggestion: result.suggestion || null
      });

  // Final-status caps prevent domain-level evidence from making unverified
  // addresses look mailbox-confirmed in the score column.
  if (["Risky", "Not Verified", "Catch-All", "Protected", "Unverified"].includes(enriched.status)) enriched.deliverabilityScore = Math.min(enriched.deliverabilityScore, 55);
  if (enriched.status === "Unknown") enriched.deliverabilityScore = Math.min(enriched.deliverabilityScore, 45);
  if (enriched.status === "Invalid") enriched.deliverabilityScore = Math.min(enriched.deliverabilityScore, 25);
  return enriched;
}

function normalizeSmtpMessage(reply) {
  return (reply?.lines || [])
    .map(line => line.replace(/^\d{3}[- ]?/, "").trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 700);
}

function detectProvider(mxRecords, domain = "") {
  const direct = providerFromDomain(domain);
  if (direct) return direct;
  const hosts = (mxRecords || []).map(r => String(r.exchange || "").toLowerCase()).join(" ");

  if (/protection\.outlook\.com|outlook\.com/.test(hosts)) return "Microsoft 365 / Outlook";
  if (/google\.com|googlemail\.com/.test(hosts)) return "Google Workspace / Gmail";
  if (/yahoodns\.net|yahoo\.com|aol\.com/.test(hosts)) return "Yahoo / AOL Mail";
  if (/zoho\.(com|eu|in)|zohomail/.test(hosts)) return "Zoho Mail";
  if (/pphosted\.com|proofpoint/.test(hosts)) return "Proofpoint";
  if (/mimecast\.com/.test(hosts)) return "Mimecast";
  if (/messagelabs\.com/.test(hosts)) return "Broadcom / MessageLabs";
  if (/barracudanetworks\.com|barracuda/.test(hosts)) return "Barracuda";
  if (/secureserver\.net/.test(hosts)) return "GoDaddy Email";
  if (/privateemail\.com/.test(hosts)) return "Namecheap Private Email";
  if (/icloud\.com/.test(hosts)) return "Apple iCloud Mail";
  if (/protonmail\.ch|protonmail/.test(hosts)) return "Proton Mail";
  if (/fastmail/.test(hosts)) return "Fastmail";
  return "Custom / Other";
}

function classifyDomainType(domain) {
  if (DISPOSABLE_DOMAINS.has(domain)) return "Disposable";
  if (FREE_MAIL_DOMAINS.has(domain)) return "Free Mail";
  return "Corporate / Custom";
}

function isRoleAddress(email) {
  const local = String(email).split("@")[0] || "";
  return ROLE_PREFIXES.has(local);
}

function isExplicitInvalidRecipient(message) {
  const text = String(message || "").toLowerCase();
  const patterns = [
    /\b5\.1\.1\b/,
    /\b5\.1\.10\b/,
    /\b5\.1\.0\b.*recipient/,
    /recipientnotfound/,
    /user unknown/,
    /unknown user/,
    /unknown recipient/,
    /no such user/,
    /no such recipient/,
    /recipient[^|]*not found/,
    /mailbox[^|]*not found/,
    /recipient[^|]*does not exist/,
    /address[^|]*does not exist/,
    /invalid recipient/,
    /recipient address rejected[^|]*user unknown/,
    /recipient rejected[^|]*unknown/,
    /account[^|]*does not exist/,
    /mailbox[^|]*does not exist/,
    /mailbox[^|]*unknown/,
    /mailbox[^|]*unavailable[^|]*(?:no such|unknown|not found|does not exist)/,
    /requested mail action aborted[^|]*mailbox not found/,
    /recipient address rejected[^|]*(?:unknown|not found|does not exist)/
  ];
  return patterns.some(pattern => pattern.test(text));
}

function looksLikePolicyBlock(message) {
  const text = String(message || "").toLowerCase();
  const patterns = [
    /access denied/, /policy/, /spam/, /blocked/, /blacklist/, /reputation/,
    /client host rejected/, /sender rejected/, /authentication required/,
    /relay (access )?denied/, /not permitted/, /prohibited/, /security policy/,
    /service unavailable/, /connection rejected/, /reverse dns/, /rbl/
  ];
  return patterns.some(pattern => pattern.test(text));
}

function makeRandomMailbox(domain) {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  return `probe-${token}@${domain}`;
}

function buildSenderStrategies() {
  const strategies = [];
  if (SMTP_FROM && validator.isEmail(SMTP_FROM)) {
    strategies.push(`<${SMTP_FROM}>`);
  }

  // Null reverse-path is standards-compliant and avoids spoofing example.com.
  strategies.push("<>");

  if (!SMTP_FROM && SMTP_HELO.includes(".") && !SMTP_HELO.endsWith(".localhost")) {
    const fallback = `postmaster@${SMTP_HELO}`;
    if (validator.isEmail(fallback)) strategies.push(`<${fallback}>`);
  }

  return [...new Set(strategies)];
}

function createResponseReader(socket) {
  let buffer = "";
  let activeCode = null;
  let activeLines = [];
  const queue = [];
  const waiters = [];
  let terminalError = null;

  function emit(reply) {
    if (waiters.length) {
      waiters.shift().resolve(reply);
    } else {
      queue.push(reply);
    }
  }

  function fail(error) {
    if (terminalError) return;
    terminalError = error instanceof Error ? error : new Error(String(error || "SMTP connection failed"));
    while (waiters.length) waiters.shift().reject(terminalError);
  }

  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      const match = line.match(/^(\d{3})([- ])(.*)$/);
      if (!match) continue;

      const code = Number(match[1]);
      const separator = match[2];

      if (activeCode === null) {
        activeCode = code;
        activeLines = [line];
      } else if (activeCode === code) {
        activeLines.push(line);
      } else {
        // Unexpected new reply code; flush the previous group defensively.
        emit({ code: activeCode, lines: activeLines });
        activeCode = code;
        activeLines = [line];
      }

      if (separator === " ") {
        emit({ code: activeCode, lines: activeLines });
        activeCode = null;
        activeLines = [];
      }
    }
  });

  socket.on("error", fail);
  socket.on("timeout", () => {
    const error = new Error("SMTP server timed out");
    error.code = "ETIMEDOUT";
    fail(error);
    socket.destroy();
  });
  socket.on("close", hadError => {
    if (!hadError && !terminalError && waiters.length) {
      const error = new Error("SMTP server closed the connection");
      error.code = "ECONNCLOSED";
      fail(error);
    }
  });

  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    }
  };
}

async function sendCommand(socket, reader, command) {
  socket.write(`${command}\r\n`);
  return await reader.next();
}

function classifyRecipientReply(reply) {
  const code = Number(reply?.code || 0);
  const message = normalizeSmtpMessage(reply);

  if (code >= 200 && code < 300) {
    return { mailboxStatus: "Accepted", smtpCode: code, smtpMessage: message };
  }

  if (code >= 400 && code < 500) {
    return {
      mailboxStatus: "Temporary",
      smtpCode: code,
      smtpMessage: message,
      reason: `Mail server temporarily refused verification (${code})`
    };
  }

  if (code >= 500 && code < 600) {
    if (isExplicitInvalidRecipient(message)) {
      return {
        mailboxStatus: "Invalid",
        smtpCode: code,
        smtpMessage: message,
        reason: `Recipient does not exist (${code})`
      };
    }

    const policyBlock = looksLikePolicyBlock(message);
    return {
      mailboxStatus: "Protected",
      policyBlock,
      smtpCode: code,
      smtpMessage: message,
      reason: policyBlock
        ? `Mail server blocked mailbox probing by policy (${code})`
        : `Recipient could not be confirmed because the server returned a non-specific ${code} response`
    };
  }

  return {
    mailboxStatus: "Unknown",
    smtpCode: code || null,
    smtpMessage: message,
    reason: code ? `Unexpected SMTP response (${code})` : "Unexpected SMTP response"
  };
}

async function checkMailbox(email, mxHost, randomMailbox) {
  let socket;
  let hardTimer;
  let stage = "connect";

  try {
    socket = net.createConnection({
      host: mxHost,
      port: SMTP_PORT,
      // Prefer a quick IPv4/IPv6 fallback on supported Node versions. This
      // avoids false timeouts on Windows/ISP networks with broken IPv6.
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 750
    });

    hardTimer = setTimeout(() => {
      if (!socket || socket.destroyed) return;
      const error = new Error("SMTP attempt exceeded hard time limit");
      error.code = "ESMTPHARDTIMEOUT";
      socket.destroy(error);
    }, SMTP_ATTEMPT_HARD_TIMEOUT_MS);
    socket.setTimeout(SMTP_TIMEOUT_MS);
    socket.setNoDelay(true);

    const reader = createResponseReader(socket);

    await new Promise((resolve, reject) => {
      if (socket.readyState === "open") return resolve();
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    stage = "greeting";
    const greeting = await reader.next();
    if (greeting.code !== 220) {
      const message = normalizeSmtpMessage(greeting);
      return {
        mailboxStatus: greeting.code >= 400 ? "Protected" : "Unknown",
        stage,
        smtpCode: greeting.code,
        smtpMessage: message,
        reason: `SMTP greeting was blocked (${greeting.code})`
      };
    }

    stage = "ehlo";
    let hello = await sendCommand(socket, reader, `EHLO ${SMTP_HELO}`);
    if (hello.code !== 250) {
      stage = "helo";
      hello = await sendCommand(socket, reader, `HELO ${SMTP_HELO}`);
      if (hello.code !== 250) {
        return {
          mailboxStatus: hello.code >= 400 ? "Protected" : "Unknown",
          stage,
          smtpCode: hello.code,
          smtpMessage: normalizeSmtpMessage(hello),
          reason: `SMTP HELO/EHLO was rejected (${hello.code})`
        };
      }
    }

    stage = "mail_from";
    const senderStrategies = buildSenderStrategies();
    let senderAccepted = false;
    let lastSenderReply = null;

    for (let i = 0; i < senderStrategies.length; i++) {
      const sender = senderStrategies[i];
      const reply = await sendCommand(socket, reader, `MAIL FROM:${sender}`);
      lastSenderReply = reply;

      if (reply.code >= 200 && reply.code < 300) {
        senderAccepted = true;
        break;
      }

      // Reset envelope before trying another standards-compliant sender strategy.
      if (i < senderStrategies.length - 1) {
        try {
          const reset = await sendCommand(socket, reader, "RSET");
          if (!(reset.code >= 200 && reset.code < 300)) break;
        } catch {
          break;
        }
      }
    }

    if (!senderAccepted) {
      const code = lastSenderReply?.code || null;
      const message = normalizeSmtpMessage(lastSenderReply);
      return {
        mailboxStatus: "Protected",
        stage,
        smtpCode: code,
        smtpMessage: message,
        reason: code
          ? `SMTP server rejected the verification sender (${code}); recipient was not tested`
          : "SMTP server rejected the verification sender; recipient was not tested"
      };
    }

    stage = "rcpt_to";
    const recipientReply = await sendCommand(socket, reader, `RCPT TO:<${email}>`);
    const recipient = classifyRecipientReply(recipientReply);

    if (recipient.mailboxStatus !== "Accepted") {
      return { ...recipient, stage };
    }

    let catchAll = null;
    let catchAllCode = null;
    let catchAllMessage = "";

    if (randomMailbox) {
      // v5.8: catch-all testing is secondary evidence only. Once the TARGET
      // recipient has returned 2xx, a failure/timeout while probing a random
      // address must never erase that direct acceptance.
      try {
        stage = "catchall_rcpt";
        const randomReply = await sendCommand(socket, reader, `RCPT TO:<${randomMailbox}>`);
        catchAllCode = randomReply.code;
        catchAllMessage = normalizeSmtpMessage(randomReply);

        if (randomReply.code >= 200 && randomReply.code < 300) {
          catchAll = true;
        } else if (isExplicitInvalidRecipient(catchAllMessage)) {
          catchAll = false;
        }
      } catch (catchAllError) {
        catchAll = null;
        catchAllCode = catchAllError?.code || null;
        catchAllMessage = catchAllError?.message || "Catch-all probe could not be completed";
      } finally {
        stage = "rcpt_to";
      }
    }

    return {
      mailboxStatus: "Accepted",
      stage: "rcpt_to",
      smtpCode: recipient.smtpCode,
      smtpMessage: recipient.smtpMessage,
      catchAll,
      catchAllCode,
      catchAllMessage,
      reason: catchAll === false
        ? "Mail server accepted this mailbox and rejected a random mailbox in the same SMTP session."
        : catchAll === true
          ? "Mail server accepted this mailbox and also accepted a random mailbox."
          : "Mail server accepted this mailbox; catch-all status could not be determined."
    };
  } catch (error) {
    const code = error?.code || null;
    const reason = code === "ETIMEDOUT" || code === "ESMTPHARDTIMEOUT"
      ? "SMTP server timed out"
      : code === "ECONNREFUSED"
        ? "SMTP connection was refused"
        : code === "ENETUNREACH" || code === "EHOSTUNREACH"
          ? "SMTP server was unreachable"
          : error?.message || "Could not connect to SMTP server";

    return {
      mailboxStatus: "Unknown",
      stage,
      networkCode: code,
      reason
    };
  } finally {
    clearTimeout(hardTimer);
    if (socket) {
      try { socket.write("QUIT\r\n"); } catch {}
      socket.destroy();
    }
  }
}

async function checkAllMxServers(email, mxRecords, randomMailbox) {
  const results = [];
  const candidates = (mxRecords || []).slice(0, Math.max(1, MAX_MX_ATTEMPTS));

  for (const record of candidates) {
    const result = await checkMailbox(email, record.exchange, randomMailbox);
    const complete = { ...result, mxServer: record.exchange };
    results.push(complete);

    if (result.mailboxStatus === "Accepted") return complete;
    if (result.mailboxStatus === "Invalid") return complete; // explicit recipient evidence only

    // v6.2 DIRECT SMTP: do not stop on the first policy/protection response.
    // Try every available MX because another live MX may return a definitive
    // RCPT TO result for the target recipient. We still never fabricate a
    // Valid/Invalid result when every server refuses recipient verification.
    if (result.mailboxStatus === "Protected") {
      await sleep(250 + Math.floor(Math.random() * 250));
      continue;
    }

    // Temporary recipient-level errors get one short retry on the same MX.
    if (result.mailboxStatus === "Temporary") {
      await sleep(350 + Math.floor(Math.random() * 250));
      const retry = await checkMailbox(email, record.exchange, randomMailbox);
      const retried = { ...retry, mxServer: record.exchange, retried: true };
      results.push(retried);
      if (["Accepted", "Invalid"].includes(retry.mailboxStatus)) return retried;
      // If the retry is still protected/temporary, continue to the next live MX.
    }
  }

  // Prefer a meaningful server-side protection result over a generic network unknown.
  return (
    results.find(r => r.mailboxStatus === "Protected") ||
    results.find(r => r.mailboxStatus === "Temporary") ||
    results.find(r => r.mailboxStatus === "Unknown") ||
    { mailboxStatus: "Unknown", reason: "Could not verify mailbox" }
  );
}

async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(fallback), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withRejectingTimeout(promise, ms, label = "Operation") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out`);
          error.code = "ETIMEDOUT";
          reject(error);
        }, ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function getMxRoute(domain) {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_CACHE_TTL_MS) return cached.value;

  let mxRecords = [];
  let mxError = null;

  try {
    mxRecords = await withRejectingTimeout(
      dns.resolveMx(domain),
      DNS_TIMEOUT_MS,
      "MX lookup"
    );
  } catch (error) {
    mxError = error;
  }

  const nullMx = mxRecords.some(record => !record.exchange || record.exchange === ".");
  if (nullMx) {
    const value = { records: [], nullMx: true, implicitMx: false, dnsError: null };
    mxCache.set(domain, { at: Date.now(), value });
    return value;
  }

  mxRecords = mxRecords
    .filter(record => record.exchange)
    .sort((a, b) => a.priority - b.priority);

  if (mxRecords.length) {
    const value = { records: mxRecords, nullMx: false, implicitMx: false, dnsError: null };
    mxCache.set(domain, { at: Date.now(), value });
    return value;
  }

  // RFC-compatible fallback: a domain with no MX may receive mail at its A/AAAA host.
  let hasAddress = false;
  let addressError = null;
  try {
    const addresses = await withTimeout(
      Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]),
      4000,
      []
    );
    hasAddress = Array.isArray(addresses) && addresses.some(item =>
      item && item.status === "fulfilled" && Array.isArray(item.value) && item.value.length
    );
  } catch (error) {
    addressError = error;
  }

  if (hasAddress) {
    const value = {
      records: [{ priority: 0, exchange: domain }],
      nullMx: false,
      implicitMx: true,
      dnsError: null
    };
    mxCache.set(domain, { at: Date.now(), value });
    return value;
  }

  const dnsError = mxError || addressError;
  const value = {
    records: [],
    nullMx: false,
    implicitMx: false,
    dnsError: dnsError ? { code: dnsError.code || null, message: dnsError.message || "DNS lookup failed" } : null
  };
  mxCache.set(domain, { at: Date.now(), value });
  return value;
}

async function resolveTxtFlat(host) {
  try {
    const records = await withTimeout(dns.resolveTxt(host), 3500, []);
    return (records || []).map(parts => parts.join("")).filter(Boolean);
  } catch {
    return [];
  }
}

async function getDomainSignals(domain) {
  const cached = signalCache.get(domain);
  if (cached && Date.now() - cached.at < DOMAIN_SIGNAL_TTL_MS) return cached.value;

  const [rootTxt, dmarcTxt] = await Promise.all([
    resolveTxtFlat(domain),
    resolveTxtFlat(`_dmarc.${domain}`)
  ]);

  const value = {
    hasSpf: rootTxt.some(value => /^v=spf1\b/i.test(value)),
    hasDmarc: dmarcTxt.some(value => /^v=dmarc1\b/i.test(value))
  };
  signalCache.set(domain, { at: Date.now(), value });
  return value;
}

async function withDomainLimit(domain, fn) {
  let state = domainStates.get(domain);
  if (!state) {
    state = { active: 0, queue: [] };
    domainStates.set(domain, state);
  }

  if (state.active >= DOMAIN_CONCURRENCY) {
    await new Promise(resolve => state.queue.push(resolve));
  }

  state.active += 1;

  try {
    if (DOMAIN_DELAY_MS > 0) {
      await sleep(
        DOMAIN_DELAY_MS +
        Math.floor(Math.random() * Math.min(120, DOMAIN_DELAY_MS + 1))
      );
    }
    return await fn();
  } finally {
    state.active -= 1;
    const next = state.queue.shift();
    if (next) next();
    if (state.active === 0 && state.queue.length === 0) {
      domainStates.delete(domain);
    }
  }
}

function getSmtpBehavior(domain) {
  const cached = smtpBehaviorCache.get(domain);
  if (!cached) return null;
  if (Date.now() - cached.at > SMTP_BEHAVIOR_TTL_MS) {
    smtpBehaviorCache.delete(domain);
    return null;
  }
  return cached.value;
}

function setSmtpBehavior(domain, value) {
  smtpBehaviorCache.set(domain, { at: Date.now(), value });
}

function protectedConfidence({ provider, domainType, signals, stage, roleBased, disposable }) {
  let score = 50;
  if (provider !== "Custom / Other") score += 7;
  if (domainType === "Corporate / Custom") score += 5;
  if (signals.hasSpf) score += 5;
  if (signals.hasDmarc) score += 5;
  if (["greeting", "ehlo", "helo", "mail_from"].includes(stage)) score += 4;
  if (stage === "rcpt_to") score -= 5;
  if (roleBased) score -= 3;
  if (disposable) score -= 20;
  return clamp(score, 35, 76);
}

function baseResult(email, domain, mxRoute, provider, domainType, signals) {
  const localPart = email.split("@")[0] || "";
  return {
    email,
    syntaxValid: true,
    domain,
    domainType,
    provider,
    mxFound: mxRoute.records.length > 0,
    implicitMx: Boolean(mxRoute.implicitMx),
    mxServer: mxRoute.records[0]?.exchange || null,
    spf: signals.hasSpf,
    dmarc: signals.hasDmarc,
    roleBased: ROLE_PREFIXES.has(localPart),
    disposable: DISPOSABLE_DOMAINS.has(domain),
    suggestion: COMMON_DOMAIN_TYPOS.get(domain) || null
  };
}

async function verifyEmailAddress(originalEmail) {
  try {
    if (!originalEmail || typeof originalEmail !== "string") {
      return {
        email: originalEmail || "",
        status: "Invalid",
        valid: false,
        confidence: 100,
        reason: "Email is required"
      };
    }

    const email = originalEmail.trim().toLowerCase();

    if (!validator.isEmail(email, { allow_utf8_local_part: true, require_tld: true })) {
      return {
        email,
        status: "Invalid",
        valid: false,
        confidence: 100,
        syntaxValid: false,
        mxFound: false,
        mailboxStatus: "Not Checked",
        catchAll: null,
        reason: "Invalid email format"
      };
    }

    const domain = email.split("@")[1];
    const mxRoute = await getMxRoute(domain);

    if (mxRoute.nullMx) {
      return {
        email,
        status: "Invalid",
        valid: false,
        confidence: 99,
        syntaxValid: true,
        domain,
        mxFound: false,
        mailboxStatus: "Not Checked",
        catchAll: null,
        reason: "Domain publishes a Null MX record and does not accept email."
      };
    }

    if (!mxRoute.records.length) {
      const dnsCode = mxRoute.dnsError?.code || "";
      const temporaryDns = ["ESERVFAIL", "ETIMEOUT", "EAI_AGAIN", "EREFUSED"].includes(dnsCode);
      return {
        email,
        status: temporaryDns ? "Unknown" : "Invalid",
        valid: temporaryDns ? null : false,
        confidence: temporaryDns ? 20 : 97,
        syntaxValid: true,
        domain,
        mxFound: false,
        mailboxStatus: "Not Checked",
        catchAll: null,
        suggestion: COMMON_DOMAIN_TYPOS.get(domain) || null,
        reason: temporaryDns
          ? `Temporary DNS failure${dnsCode ? ` (${dnsCode})` : ""}. Try again later.`
          : "Domain has no MX record and no usable A/AAAA mail fallback."
      };
    }

    const provider = detectProvider(mxRoute.records, domain);
    const domainType = classifyDomainType(domain);
    const signals = await getDomainSignals(domain);
    const common = baseResult(email, domain, mxRoute, provider, domainType, signals);

    // v5.8 accuracy rule: never reuse a domain-level Protected/Timeout/Catch-All
    // result as the result for a different mailbox. Every address gets its own
    // RCPT TO check. Domain behavior can still be cached as metadata, but it
    // cannot skip the target-recipient probe.
    const cachedBehavior = getSmtpBehavior(domain);

    return await withDomainLimit(domain, async () => {
      const randomMailbox = makeRandomMailbox(domain);
      const mailbox = await checkAllMxServers(email, mxRoute.records, randomMailbox);
      const selectedMx = mailbox.mxServer || mxRoute.records[0].exchange;

      if (mailbox.mailboxStatus === "Accepted") {
        // v5.8: the target mailbox itself returned a 2xx RCPT response. This is
        // the same primary signal used by SMTP testers that display "Accepted".
        // Catch-all remains visible as a risk flag, but it does not overwrite
        // the target recipient's successful SMTP response.
        if (mailbox.catchAll === true) {
          setSmtpBehavior(domain, { type: "catchall", mxServer: selectedMx });
        }

        const confidence = mailbox.catchAll === false ? 99 : mailbox.catchAll === true ? 82 : 90;
        const reason = mailbox.catchAll === false
          ? "SMTP server returned 2xx for the target mailbox and explicitly rejected a random mailbox."
          : mailbox.catchAll === true
            ? "SMTP server returned 2xx for the target mailbox. The domain also accepts random recipients (catch-all), so delivery is accepted at RCPT stage but mailbox uniqueness is not proven."
            : "SMTP server returned 2xx for the target mailbox. The secondary catch-all probe was inconclusive, but the target recipient itself was accepted.";

        return {
          ...common,
          status: "Valid",
          valid: true,
          confidence,
          mxServer: selectedMx,
          mailboxStatus: "Accepted",
          catchAll: mailbox.catchAll,
          smtpCode: mailbox.smtpCode || null,
          smtpMessage: mailbox.smtpMessage || "",
          reason
        };
      }

      if (mailbox.mailboxStatus === "Invalid") {
        return {
          ...common,
          status: "Invalid",
          valid: false,
          confidence: 99,
          mxServer: selectedMx,
          mailboxStatus: "Invalid",
          catchAll: false,
          smtpCode: mailbox.smtpCode || null,
          smtpMessage: mailbox.smtpMessage || "",
          reason: mailbox.reason || "Mail server explicitly reported that the recipient does not exist."
        };
      }

      if (mailbox.mailboxStatus === "Protected") {
        const disposable = DISPOSABLE_DOMAINS.has(domain);
        const confidence = protectedConfidence({
          provider,
          domainType,
          signals,
          stage: mailbox.stage,
          roleBased: isRoleAddress(email),
          disposable
        });

        // Accuracy-first: provider protection proves only that recipient probing
        // was blocked. It must never promote an address to Valid/Likely Valid.
        setSmtpBehavior(domain, {
          type: "protected",
          stage: mailbox.stage || null,
          mxServer: selectedMx,
          reason: mailbox.reason || "Mail server blocked direct mailbox verification"
        });

        return {
          ...common,
          status: "Unverified",
          valid: null,
          confidence: Math.min(confidence, 55),
          mxServer: selectedMx,
          mailboxStatus: "Mailbox Unverified",
          catchAll: null,
          smtpCode: mailbox.smtpCode || null,
          smtpMessage: mailbox.smtpMessage || "",
          verificationStage: mailbox.stage || null,
          reason: `${mailbox.reason || "The live mail server did not return a definitive recipient decision."} The backend tried the available MX servers directly. A free live API fallback will now be attempted.`
        };
      }

      if (mailbox.mailboxStatus === "Temporary") {
        return {
          ...common,
          status: "Unknown",
          valid: null,
          confidence: 45,
          mxServer: selectedMx,
          mailboxStatus: "Temporarily Unavailable",
          catchAll: null,
          smtpCode: mailbox.smtpCode || null,
          smtpMessage: mailbox.smtpMessage || "",
          reason: mailbox.reason || "Mail server temporarily refused verification. Retry later."
        };
      }

      const isTimeout = /timed out|hard time limit/i.test(String(mailbox.reason || ""));

      if (isTimeout) {
        setSmtpBehavior(domain, {
          type: "timeout",
          stage: mailbox.stage || "connect",
          mxServer: selectedMx,
          reason: mailbox.reason || "SMTP server timed out"
        });
      }

      return {
        ...common,
        status: "Unknown",
        valid: null,
        confidence: isTimeout ? 35 : 40,
        mxServer: selectedMx,
        mailboxStatus: isTimeout ? "Timed Out" : "Unknown",
        catchAll: null,
        smtpCode: mailbox.smtpCode || null,
        smtpMessage: mailbox.smtpMessage || "",
        verificationStage: mailbox.stage || null,
        reason: `${mailbox.reason || "Mailbox could not be verified."} No recipient-level proof was obtained, so the address is excluded from Verified Valid.`
      };
    });
  } catch (error) {
    console.error("Verification error:", error);
    return {
      email: originalEmail || "",
      status: "Unknown",
      valid: null,
      confidence: 20,
      reason: "Verification failed unexpectedly"
    };
  }
}


function deadlineFallback(email) {
  const normalized =
    typeof email === "string"
      ? email.trim().toLowerCase()
      : String(email || "");

  const domain =
    normalized.includes("@")
      ? normalized.split("@").pop()
      : null;

  const knownProvider = domain ? providerFromDomain(domain) : null;
  const syntaxValid = Boolean(normalized && validator.isEmail(normalized, { require_tld: true }));

  return {
    email: normalized,
    status: "Network Block",
    valid: null,
    confidence: syntaxValid ? 30 : 15,
    syntaxValid,
    domain,
    domainType: domain ? classifyDomainType(domain) : null,
    provider: knownProvider || (domain ? "Custom / Other" : null),
    mxFound: Boolean(knownProvider),
    mailboxStatus: "Timed Out",
    catchAll: null,
    verificationLevel: "Mailbox Unverified / SMTP Timeout",
    reason: `Verification exceeded the ${Math.round(EMAIL_HARD_TIMEOUT_MS / 1000)}s safety budget. No mailbox decision was received, so the address is excluded from Verified Valid.`
  };
}

function applyStrictValidationStatus(result) {
  const enriched = enrichResult(result || {});

  // v5.7 FINAL ACCURACY GUARD:
  // A connection-stage timeout/unreachable result is an infrastructure/network
  // problem, not evidence about the mailbox. Keep it in a separate Network Block
  // bucket so bulk jobs do not misleadingly report hundreds of addresses as Unknown.
  const networkCode = String(enriched.networkCode || "").toUpperCase();
  const reasonText = String(enriched.reason || "").toLowerCase();
  const stageText = String(enriched.verificationStage || enriched.stage || "").toLowerCase();
  const isNetworkBlock =
    enriched.mailboxStatus === "Timed Out" ||
    ["ETIMEDOUT", "ESMTPHARDTIMEOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(networkCode) ||
    (/timed out|connection was refused|server was unreachable/.test(reasonText) && ["", "connect", "greeting"].includes(stageText));

  if (isNetworkBlock) {
    return {
      ...enriched,
      status: "Network Block",
      valid: null,
      confidence: Math.min(Number(enriched.confidence || 30), 35),
      deliverabilityScore: Math.min(Number(enriched.deliverabilityScore || 35), 45),
      verificationOutcome: "network_block",
      reason: `${enriched.reason || "SMTP verification could not connect."} This is not proof that the email is invalid. Check outbound TCP port 25 / VPS SMTP access.`
    };
  }

  // v5.8 priority: a direct 2xx response to RCPT TO for the TARGET address is
  // positive mailbox evidence and must not be overwritten by a secondary
  // catch-all/protected label. Preserve catch-all as metadata.
  const targetAccepted = enriched.mailboxStatus === "Accepted" &&
    Number(enriched.smtpCode) >= 200 && Number(enriched.smtpCode) < 300;

  if (targetAccepted) {
    const baseConfidence = enriched.catchAll === false ? 99 : enriched.catchAll === true ? 82 : 90;
    return {
      ...enriched,
      status: "Valid",
      valid: true,
      confidence: Math.max(Number(enriched.confidence || 0), baseConfidence),
      verificationOutcome: enriched.catchAll === true ? "accepted_catch_all" : "accepted"
    };
  }

  if (enriched.catchAll === true || /catch-all/i.test(String(enriched.mailboxStatus || ""))) {
    return {
      ...enriched,
      status: "Catch-All",
      valid: null,
      confidence: Math.min(Number(enriched.confidence || 50), 55),
      deliverabilityScore: Math.min(Number(enriched.deliverabilityScore || 50), 55),
      verificationOutcome: "catch_all"
    };
  }

  if (["Protected", "Server Refused Verification"].includes(enriched.mailboxStatus)) {
    return {
      ...enriched,
      status: "Unverified",
      valid: null,
      confidence: Math.min(Number(enriched.confidence || 50), 55),
      deliverabilityScore: Math.min(Number(enriched.deliverabilityScore || 50), 55),
      verificationOutcome: "server_refused_verification"
    };
  }

  if (enriched.status === "Invalid") {
    return { ...enriched, valid: false, verificationOutcome: "invalid" };
  }

  if (enriched.status === "Valid") {
    if (enriched.mailboxStatus === "Accepted" && Number(enriched.smtpCode) >= 200 && Number(enriched.smtpCode) < 300) {
      return { ...enriched, valid: true, confidence: Math.max(Number(enriched.confidence || 0), enriched.catchAll === true ? 82 : 90), verificationOutcome: enriched.catchAll === true ? "accepted_catch_all" : "accepted" };
    }
    return { ...enriched, status: "Unknown", valid: null, verificationOutcome: "unverified" };
  }

  // Compatibility guard for any stale v5.3/v5.4-style response.
  if (["Likely Valid", "Risky", "Not Verified"].includes(enriched.status)) {
    return { ...enriched, status: "Unknown", valid: null, verificationOutcome: "unverified" };
  }

  if (["Catch-All", "Unverified", "Network Block", "Unknown"].includes(enriched.status)) {
    return { ...enriched, valid: null, verificationOutcome: enriched.status.toLowerCase().replace(/[^a-z]+/g, "_") };
  }

  return { ...enriched, status: "Unknown", valid: null, verificationOutcome: "unverified" };
}

async function verifyEmailAddressSafe(email) {
  return await withGlobalLimit(async () => {
    const normalized = String(email || "").trim().toLowerCase();
    if (!validator.isEmail(normalized, { require_tld: true })) {
      return { email: normalized, status: "Invalid", valid: false, syntaxValid: false,
        confidence: 100, reason: "Invalid email syntax", verificationOutcome: "invalid_syntax" };
    }
    return await validect.verify(normalized);
  });
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }

  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: count }, () => runner()));
  return results;
}

const jobs = new Map();

function apiAuth(req, res, next) {
  // v6.1 FREE/NO-KEY: no external or paid API key is required.
  // When deployed, Nginx keeps the Node service on localhost and proxies the UI/API.
  return next();
}

function createJob(emails) {
  const id = crypto.randomUUID();
  const job = {
    id,
    version: APP_VERSION,
    status: "queued",
    total: emails.length,
    completed: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    durationSeconds: null,
    summary: { total: emails.length, valid: 0, invalid: 0, catchAll: 0, apiDeliverable: 0, unverified: 0, networkBlock: 0, unknown: 0 },
    results: [],
    emails
  };
  jobs.set(id, job);
  return job;
}

function bumpSummary(summary, result) {
  if (result.status === "Valid") summary.valid += 1;
  else if (result.status === "Invalid") summary.invalid += 1;
  else if (result.status === "Catch-All") summary.catchAll += 1;
  else if (result.status === "API Deliverable") summary.apiDeliverable += 1;
  else if (result.status === "Unverified") summary.unverified += 1;
  else if (result.status === "Network Block") summary.networkBlock += 1;
  else summary.unknown += 1;
}

function persistFinishedJob(job) {
  const payload = { ...job };
  delete payload.emails;
  try {
    fs.writeFileSync(path.join(DATA_DIR, `${job.id}.json`), JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn(`Could not persist job ${job.id}:`, error.message);
  }
}

async function processJob(job) {
  if (!job || job.status !== "queued") return;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const started = Date.now();
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= job.emails.length) return;
      const email = job.emails[index];
      const result = await verifyEmailAddressSafe(email);
      job.results.push({ ...result, inputIndex: index });
      job.completed += 1;
      bumpSummary(job.summary, result);
    }
  }

  try {
    const workers = Math.min(Math.max(1, BULK_CONCURRENCY), job.emails.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.error = error.message || "Job failed";
  } finally {
    job.finishedAt = new Date().toISOString();
    job.durationSeconds = Number(((Date.now() - started) / 1000).toFixed(2));
    // Keep completion order stable while clients page results. inputIndex lets the UI
    // restore the original input order after all pages have been fetched.
    persistFinishedJob(job);
  }
}

function publicJob(job, offset = 0, limit = JOB_RESULT_PAGE_SIZE) {
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || JOB_RESULT_PAGE_SIZE));
  const page = job.results.slice(safeOffset, safeOffset + safeLimit);
  return {
    id: job.id,
    version: job.version,
    status: job.status,
    total: job.total,
    completed: job.completed,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationSeconds: job.durationSeconds,
    summary: job.summary,
    error: job.error || null,
    offset: safeOffset,
    nextOffset: safeOffset + page.length,
    hasMore: safeOffset + page.length < job.results.length,
    results: page
  };
}

setInterval(() => {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs.entries()) {
    const t = Date.parse(job.finishedAt || job.createdAt || 0);
    if (t && t < cutoff) jobs.delete(id);
  }
}, Math.min(JOB_RETENTION_MS, 60 * 60 * 1000)).unref();

async function smtpNetworkTest(domain = "gmail.com") {
  const mxRoute = await getMxRoute(String(domain || "gmail.com").trim().toLowerCase());
  if (!mxRoute.records.length) return { ok: false, domain, error: "No MX route found" };
  const host = mxRoute.records[0].exchange;
  const started = Date.now();
  return await new Promise(resolve => {
    const socket = net.createConnection({ host, port: SMTP_PORT });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, domain, host, port: SMTP_PORT, ms: Date.now() - started, error: "SMTP TCP connection timed out" });
    }, Math.min(SMTP_TIMEOUT_MS, 8000));
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true, domain, host, port: SMTP_PORT, ms: Date.now() - started });
    });
    socket.once("error", error => {
      clearTimeout(timer);
      resolve({ ok: false, domain, host, port: SMTP_PORT, ms: Date.now() - started, error: error.code || error.message });
    });
  });
}

function summarize(results) {
  return {
    total: results.length,
    valid: results.filter(r => r.status === "Valid").length,
    invalid: results.filter(r => r.status === "Invalid").length,
    catchAll: results.filter(r => r.status === "Catch-All").length,
    apiDeliverable: results.filter(r => r.status === "API Deliverable").length,
    unverified: results.filter(r => r.status === "Unverified").length,
    networkBlock: results.filter(r => r.status === "Network Block").length,
    unknown: results.filter(r => r.status === "Unknown").length
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function healthPayload() {
  return {
    ok: true,
    version: APP_VERSION,
    architecture: "validect-rapidapi",
    authRequired: false,
    localTestMode: true,
    apiMode: "validect",
    externalLiveApi: { enabled: true, provider: "Validect", keyRequired: true, configured: Boolean(process.env.RAPIDAPI_KEY), mailboxProof: true },
    maxBulkEmails: MAX_BULK_EMAILS,
    smtpHelo: SMTP_HELO,
    smtpFromConfigured: Boolean(SMTP_FROM),
    maxMxAttempts: MAX_MX_ATTEMPTS,
    smtpTimeoutMs: SMTP_TIMEOUT_MS,
    smtpAttemptHardTimeoutMs: SMTP_ATTEMPT_HARD_TIMEOUT_MS,
    domainConcurrency: DOMAIN_CONCURRENCY,
    bulkConcurrency: BULK_CONCURRENCY,
    globalConcurrency: GLOBAL_CONCURRENCY,
    emailHardTimeoutMs: EMAIL_HARD_TIMEOUT_MS,
    smtpBehaviorCacheTtlMs: SMTP_BEHAVIOR_TTL_MS,
    smtpPort: SMTP_PORT,
    note: SMTP_FROM && !SMTP_HELO.endsWith(".localhost")
      ? "Verifier identity is configured."
      : "For best SMTP acceptance, configure SMTP_HELO and SMTP_FROM to a real domain you control."
  };
}

app.get("/health", (req, res) => res.json(healthPayload()));
app.get("/api/health", (req, res) => res.json(healthPayload()));
app.get("/api/network-test", apiAuth, async (req, res) => {
  try { res.json(await smtpNetworkTest(req.query.domain || "gmail.com")); }
  catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.post("/verify", apiAuth, async (req, res) => {
  const result = await verifyEmailAddressSafe(req.body.email);
  res.json(result);
});
app.post("/api/verify", apiAuth, async (req, res) => {
  const result = await verifyEmailAddressSafe(req.body.email);
  res.json(result);
});

app.post("/api/jobs", apiAuth, async (req, res) => {
  let emails = Array.isArray(req.body.emails) ? req.body.emails : [];
  emails = [...new Set(emails.filter(v => typeof v === "string").map(v => v.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return res.status(400).json({ error: "No email addresses provided" });
  if (emails.length > MAX_BULK_EMAILS) return res.status(400).json({ error: `Maximum ${MAX_BULK_EMAILS} emails per job` });
  const job = createJob(emails);
  setImmediate(() => processJob(job));
  return res.status(202).json({ success: true, job: publicJob(job) });
});

app.get("/api/jobs/:id", apiAuth, (req, res) => {
  let job = jobs.get(req.params.id);
  if (!job) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, `${req.params.id}.json`), "utf8");
      job = JSON.parse(raw);
      jobs.set(req.params.id, job);
    } catch (_) {}
  }
  if (!job) return res.status(404).json({ error: "Job not found or expired" });
  return res.json({ success: true, job: publicJob(job, req.query.offset, req.query.limit) });
});

app.post("/verify-bulk", apiAuth, async (req, res) => {
  try {
    let { emails } = req.body;

    if (!Array.isArray(emails)) {
      return res.status(400).json({ error: "emails must be an array" });
    }

    emails = emails
      .filter(email => typeof email === "string")
      .map(email => email.trim().toLowerCase())
      .filter(Boolean);

    const uniqueEmails = [...new Set(emails)];

    if (!uniqueEmails.length) {
      return res.status(400).json({ error: "No email addresses provided" });
    }

    if (uniqueEmails.length > MAX_BULK_EMAILS) {
      return res.status(400).json({
        error: `Maximum ${MAX_BULK_EMAILS} emails per API batch`
      });
    }

    const startedAt = Date.now();
    console.log(`Starting batch of ${uniqueEmails.length} emails`);

    const results = await runWithConcurrency(
      uniqueEmails,
      BULK_CONCURRENCY,
      async email => {
        if (!QUIET_EMAIL_LOGS) console.log(`Checking: ${email}`);
        return await verifyEmailAddressSafe(email);
      }
    );

    const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));
    console.log(`Batch finished in ${durationSeconds}s`);

    return res.json({
      success: true,
      summary: summarize(results),
      durationSeconds,
      results
    });
  } catch (error) {
    console.error("Bulk verification error:", error);
    return res.status(500).json({ error: "Bulk verification failed" });
  }
});

// Compatibility alias for API clients that prefer the /api prefix.
app.post("/api/verify-bulk", apiAuth, async (req, res) => {
  let emails = Array.isArray(req.body.emails) ? req.body.emails : [];
  emails = [...new Set(emails.filter(v => typeof v === "string").map(v => v.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return res.status(400).json({ error: "No email addresses provided" });
  if (emails.length > MAX_BULK_EMAILS) return res.status(400).json({ error: `Maximum ${MAX_BULK_EMAILS} emails per API batch` });
  const startedAt = Date.now();
  const results = await runWithConcurrency(emails, BULK_CONCURRENCY, verifyEmailAddressSafe);
  return res.json({ success: true, summary: summarize(results), durationSeconds: Number(((Date.now()-startedAt)/1000).toFixed(2)), results });
});

if (require.main === module) {
  app.listen(PORT, process.env.HOST || "127.0.0.1", () => {
    console.log(`Email Verifier Dedicated Backend v${APP_VERSION} running on http://localhost:${PORT}`);
    console.log(`SMTP HELO: ${SMTP_HELO}`);
    console.log(`SMTP FROM: ${SMTP_FROM || "<null reverse-path fallback>"}`);
    console.log(`Single verification: POST /api/verify`);
    console.log(`Async bulk jobs: POST /api/jobs`);
    console.log(`Global concurrency: ${GLOBAL_CONCURRENCY} | per-email safety deadline: ${EMAIL_HARD_TIMEOUT_MS}ms`);
  });
}

module.exports = {
  app,
  verifyEmailAddress,
  verifyEmailAddressSafe,
  checkMailbox,
  checkAllMxServers,
  classifyRecipientReply,
  isExplicitInvalidRecipient,
  looksLikePolicyBlock,
  detectProvider,
  classifyDomainType,
  scoreDeliverability,
  enrichResult,
  applyStrictValidationStatus,
  summarize
};
