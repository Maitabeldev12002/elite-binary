const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try { require('dotenv').config(); } catch (_) { /* optional */ }

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret-please';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER || 'payhero').toLowerCase();
const DEFAULT_MOCK_PAYMENTS = String(process.env.MOCK_PAYMENTS || 'true').toLowerCase() !== 'false';
const MPESA_ENV = (process.env.MPESA_ENV || 'sandbox').toLowerCase();
const MPESA_HOST = MPESA_ENV === 'production' ? 'api.safaricom.co.ke' : 'sandbox.safaricom.co.ke';
const PAYHERO_HOST = process.env.PAYHERO_HOST || 'backend.payhero.co.ke';
const DEFAULT_DEPOSIT_WALLET = 'I & M Bank Limited 06509279966150 / Channel ID 8005';
const LEGACY_DEPOSIT_WALLETS = new Set(['NCBA Loop 440200250861 / Channel ID 7598']);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_DB_TABLE = process.env.SUPABASE_DB_TABLE || 'app_state';
const SUPABASE_DB_ID = process.env.SUPABASE_DB_ID || 'elite-binary';

const USE_FILE_DB = process.env.USE_FILE_DB !== 'false';
const DB_DIR = process.env.DB_DIR || '/tmp';
const DB_PATH = path.join(DB_DIR, 'db.json');

let memoryDb = null;
const autoTradingSessions = new Map();

const defaultDb = {
  config: {
    settlementMode: 'fair_server',
    payoutRate: 0.9,
    winProbability: 0.5,
    settlementDelayMs: 900,
    designatedWallet: DEFAULT_DEPOSIT_WALLET,
    mockPayments: DEFAULT_MOCK_PAYMENTS
  },
  users: [],
  deposits: [],
  withdrawals: [],
  trades: [],
  ledger: [],
  otpCodes: [],
  autoTradingStates: []
};

function initializeMemoryDb() {
  if (!memoryDb) {
    memoryDb = JSON.parse(JSON.stringify(defaultDb));
  }
  return memoryDb;
}

function ensureDbDir() {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
  } catch (e) {
    console.warn(`[DB] Cannot create directory ${DB_DIR}:`, e.message);
  }
}

function readDbFromFile() {
  try {
    if (!USE_FILE_DB) return null;
    ensureDbDir();
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2));
    }
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db.config = { ...defaultDb.config, ...(db.config || {}) };
    if (!db.config.designatedWallet || LEGACY_DEPOSIT_WALLETS.has(db.config.designatedWallet)) {
      db.config.designatedWallet = DEFAULT_DEPOSIT_WALLET;
    }
    for (const key of ['users', 'deposits', 'withdrawals', 'trades', 'ledger', 'otpCodes', 'autoTradingStates']) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
    return db;
  } catch (e) {
    console.warn(`[DB] File persistence error (falling back to memory):`, e.message);
    return null;
  }
}

function writeDbToFile(db) {
  if (!USE_FILE_DB) return;
  try {
    ensureDbDir();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.warn(`[DB] Cannot write to file (using memory only):`, e.message);
  }
}

function normalizeDb(db) {
  const normalized = db || JSON.parse(JSON.stringify(defaultDb));
  normalized.config = { ...defaultDb.config, ...(normalized.config || {}) };
  if (!normalized.config.designatedWallet || LEGACY_DEPOSIT_WALLETS.has(normalized.config.designatedWallet)) {
    normalized.config.designatedWallet = DEFAULT_DEPOSIT_WALLET;
  }
  for (const key of ['users', 'deposits', 'withdrawals', 'trades', 'ledger', 'otpCodes', 'autoTradingStates']) {
    if (!Array.isArray(normalized[key])) normalized[key] = [];
  }
  return normalized;
}

function hasSupabaseDb() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseRequest(method, requestPath, payload) {
  return new Promise((resolve, reject) => {
    try {
      const endpoint = new URL(SUPABASE_URL);
      const raw = payload === undefined ? '' : JSON.stringify(payload);
      const req = https.request({
        hostname: endpoint.hostname,
        path: requestPath,
        method,
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          ...(raw ? { 'Content-Length': Buffer.byteLength(raw) } : {}),
          ...(method === 'POST' ? { Prefer: 'resolution=merge-duplicates' } : {})
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(new Error(parsed.message || parsed.error || `Supabase request failed with ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(raw);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function readDbFromSupabase() {
  if (!hasSupabaseDb()) return null;
  try {
    const path_ = `/rest/v1/${encodeURIComponent(SUPABASE_DB_TABLE)}?id=eq.${encodeURIComponent(SUPABASE_DB_ID)}&select=data&limit=1`;
    const rows = await supabaseRequest('GET', path_);
    if (!Array.isArray(rows) || !rows[0]) return null;
    return rows[0].data;
  } catch (e) {
    console.warn('[DB] Supabase read error:', e.message);
    return null;
  }
}

async function writeDbToSupabase(db) {
  if (!hasSupabaseDb()) return;
  try {
    await supabaseRequest('POST', `/rest/v1/${encodeURIComponent(SUPABASE_DB_TABLE)}?on_conflict=id`, {
      id: SUPABASE_DB_ID,
      data: db,
      updated_at: now()
    });
  } catch (e) {
    console.warn('[DB] Supabase write error:', e.message);
  }
}

async function readDb() {
  if (hasSupabaseDb()) {
    try {
      const storedDb = await readDbFromSupabase();
      const supabaseDb = normalizeDb(storedDb);
      memoryDb = supabaseDb;
      if (!storedDb) await writeDbToSupabase(supabaseDb);
      return supabaseDb;
    } catch (e) {
      console.warn('[DB] Supabase persistence error (falling back to file/memory):', e.message);
    }
  }

  let db = readDbFromFile();
  if (db) {
    db = normalizeDb(db);
    memoryDb = db;
    return db;
  }
  
  const db_ = normalizeDb(initializeMemoryDb());
  return db_;
}

async function writeDb(db) {
  memoryDb = JSON.parse(JSON.stringify(db));
  if (hasSupabaseDb()) {
    await writeDbToSupabase(db);
    return;
  }
  writeDbToFile(db);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function now() {
  return new Date().toISOString();
}

function findUser(db, userId) {
  return db.users.find((u) => u.id === userId);
}

function findUserByIdentifier(db, identifier) {
  if (!identifier) return null;
  const norm = String(identifier).trim().toLowerCase();
  return db.users.find((u) => String(u.identifier).toLowerCase() === norm) || null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  try {
    const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(derived, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  try {
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let payload;
    try { payload = JSON.parse(b64urlDecode(body)); } catch (_) { return null; }
    if (!payload || (payload.exp && payload.exp < Date.now())) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function getBearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function authenticate(req, db) {
  const token = getBearer(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.userId) return null;
  const user = findUser(db, payload.userId);
  if (!user || user.suspended) return null;
  return user;
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

function settleContract(contractType, params = {}, config = {}) {
  const type = String(contractType || '').toUpperCase();
  const configuredProbability = Number(config.winProbability);
  const probability = Number.isFinite(configuredProbability) ? Math.min(0.99, Math.max(0.01, configuredProbability)) : null;
  if (probability !== null) {
    return { won: Math.random() < probability, outcome: { settlement: 'server_probability', winProbability: probability } };
  }
  const digit = crypto.randomInt(0, 10);
  const direction = crypto.randomInt(0, 2) === 1 ? 'up' : 'down';
  const barrier = Number(params.barrier);

  if (type === 'DIGITEVEN') return { won: digit % 2 === 0, outcome: { digit } };
  if (type === 'DIGITODD') return { won: digit % 2 === 1, outcome: { digit } };
  if (type === 'DIGITMATCH') return { won: digit === barrier, outcome: { digit, barrier } };
  if (type === 'DIGITDIFF') return { won: digit !== barrier, outcome: { digit, barrier } };
  if (type === 'DIGITOVER') return { won: digit > barrier, outcome: { digit, barrier } };
  if (type === 'DIGITUNDER') return { won: digit < barrier, outcome: { digit, barrier } };
  if (['CALL', 'MULTUP', 'ASIANU', 'RESETCALL', 'TICKHIGH', 'LBFLOATCALL'].includes(type)) {
    return { won: direction === 'up', outcome: { direction } };
  }
  if (['PUT', 'MULTDOWN', 'ASIAND', 'RESETPUT', 'TICKLOW', 'LBFLOATPUT'].includes(type)) {
    return { won: direction === 'down', outcome: { direction } };
  }

  return { won: crypto.randomInt(0, 2) === 1, outcome: { settlement: 'server_fair_random' } };
}

function ledger(db, entry) {
  db.ledger.push({
    id: id('led'),
    createdAt: now(),
    ...entry,
    amount: money(entry.amount),
    balanceAfter: money(entry.balanceAfter)
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function providerRequest(method, requestPath, payload, token) {
  return new Promise((resolve, reject) => {
    try {
      const raw = payload ? JSON.stringify(payload) : '';
      const req = https.request({
        hostname: MPESA_HOST,
        path: requestPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(new Error(parsed.errorMessage || parsed.ResponseDescription || `M-Pesa request failed with ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      if (raw) req.write(raw);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function mpesaToken() {
  const basicAuth = process.env.MPESA_BASIC_AUTH;
  const auth = basicAuth || (() => {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    if (!key || !secret) throw new Error('M-Pesa credentials are not configured');
    return Buffer.from(`${key}:${secret}`).toString('base64');
  })();
  return new Promise((resolve, reject) => {
    try {
      const req = https.request({
        hostname: MPESA_HOST,
        path: '/oauth/v1/generate?grant_type=client_credentials',
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
          if (parsed.access_token) return resolve(parsed.access_token);
          reject(new Error(parsed.errorMessage || 'Unable to get M-Pesa access token'));
        });
      });
      req.on('error', reject);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function mpesaTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  return digits;
}

async function initiateStkPush({ amount, phone, accountReference }) {
  const shortCode = process.env.MPESA_SHORTCODE || process.env.MPESA_CHANNEL_ID;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;
  if (!shortCode || !passkey || !callbackUrl) throw new Error('M-Pesa STK settings are not configured');
  const timestamp = mpesaTimestamp();
  const token = await mpesaToken();
  return providerRequest('POST', '/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: shortCode,
    Password: Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64'),
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(Number(amount)),
    PartyA: normalizePhone(phone),
    PartyB: shortCode,
    PhoneNumber: normalizePhone(phone),
    CallBackURL: callbackUrl,
    AccountReference: accountReference,
    TransactionDesc: 'Elite Binary deposit'
  }, token);
}

function payheroRequest(method, requestPath, payload) {
  const token = process.env.PAYHERO_BASIC_AUTH;
  if (!token) throw new Error('PayHero credentials are not configured');
  const authorization = /^Basic\s+/i.test(token) ? token : `Basic ${token}`;
  return new Promise((resolve, reject) => {
    try {
      const raw = payload ? JSON.stringify(payload) : '';
      const req = https.request({
        hostname: PAYHERO_HOST,
        path: requestPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
          Authorization: authorization
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(new Error(parsed.message || parsed.error || `PayHero request failed with ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      if (raw) req.write(raw);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function initiatePayheroStkPush({ amount, phone, accountReference, customerName }) {
  const channelId = process.env.PAYHERO_CHANNEL_ID || process.env.MPESA_CHANNEL_ID || process.env.MPESA_SHORTCODE;
  const callbackUrl = process.env.PAYHERO_CALLBACK_URL || process.env.MPESA_CALLBACK_URL;
  const provider = process.env.PAYHERO_PROVIDER || 'm-pesa';
  if (!channelId || !callbackUrl) throw new Error('PayHero STK settings are not configured');
  const payload = {
    amount: Math.round(Number(amount)),
    phone_number: phone,
    channel_id: Number(channelId),
    provider,
    external_reference: accountReference,
    customer_name: customerName || 'Elite Binary customer',
    callback_url: callbackUrl
  };
  if (provider === 'sasapay') {
    payload.network_code = process.env.PAYHERO_NETWORK_CODE || '63902';
  }
  return payheroRequest('POST', '/api/v2/payments', payload);
}

async function sendB2cPayment({ amount, destination, reference }) {
  const shortCode = process.env.MPESA_B2C_SHORTCODE;
  const initiatorName = process.env.MPESA_B2C_INITIATOR_NAME;
  const securityCredential = process.env.MPESA_B2C_SECURITY_CREDENTIAL;
  const resultUrl = process.env.MPESA_B2C_RESULT_URL;
  const timeoutUrl = process.env.MPESA_B2C_TIMEOUT_URL || resultUrl;
  if (!shortCode || !initiatorName || !securityCredential || !resultUrl) {
    throw new Error('M-Pesa B2C settings are not configured');
  }
  const token = await mpesaToken();
  return providerRequest('POST', '/mpesa/b2c/v3/paymentrequest', {
    OriginatorConversationID: reference,
    InitiatorName: initiatorName,
    SecurityCredential: securityCredential,
    CommandID: 'BusinessPayment',
    Amount: Math.round(Number(amount)),
    PartyA: shortCode,
    PartyB: normalizePhone(destination),
    Remarks: 'Elite Binary withdrawal',
    QueueTimeOutURL: timeoutUrl,
    ResultURL: resultUrl,
    Occasion: 'Withdrawal'
  }, token);
}

async function deliverOtp(identifier, otp) {
  console.log(`[OTP] ${identifier} → ${otp}`);
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    send(res, 401, { error: 'Invalid admin key' });
    return false;
  }
  return true;
}

function requireUser(req, res, db) {
  const user = authenticate(req, db);
  if (!user) {
    send(res, 401, { error: 'Authentication required' });
    return null;
  }
  return user;
}

async function routeApi(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = await readDb();

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, time: now() });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { config: db.config });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = await parseBody(req);
      const identifier = String(body.identifier || '').trim();
      const password = String(body.password || '');
      const name = String(body.name || identifier).trim();
      const demo = Boolean(body.demo);

      if (!identifier) return send(res, 400, { error: 'Identifier (email/phone) is required' });
      if (!demo && password.length < 6) {
        return send(res, 400, { error: 'Password must be at least 6 characters' });
      }
      if (findUserByIdentifier(db, identifier)) {
        return send(res, 409, { error: 'Account already exists. Please login instead.' });
      }

      const user = {
        id: id('usr'),
        identifier,
        name: name || identifier,
        passwordHash: password ? hashPassword(password) : null,
        balance: demo ? 10000 : 0,
        demo,
        verified: false,
        suspended: false,
        role: 'user',
        createdAt: now()
      };
      db.users.push(user);
      ledger(db, {
        userId: user.id,
        type: demo ? 'demo_credit' : 'wallet_opened',
        amount: user.balance,
        balanceAfter: user.balance,
        reference: 'initial'
      });
      await writeDb(db);

      const token = signToken({ userId: user.id });
      return send(res, 200, { user: publicUser(user), token });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await parseBody(req);
      const identifier = String(body.identifier || '').trim();
      const password = String(body.password || '');

      if (!identifier) return send(res, 400, { error: 'Identifier is required' });

      let user = findUserByIdentifier(db, identifier);

      if (!user && (body.demo || !password)) {
        user = {
          id: id('usr'),
          identifier,
          name: String(body.name || identifier).trim(),
          passwordHash: null,
          balance: body.demo ? 10000 : 0,
          demo: Boolean(body.demo),
          verified: false,
          suspended: false,
          role: 'user',
          createdAt: now()
        };
        db.users.push(user);
        ledger(db, {
          userId: user.id,
          type: body.demo ? 'demo_credit' : 'wallet_opened',
          amount: user.balance,
          balanceAfter: user.balance,
          reference: 'initial'
        });
        await writeDb(db);
      }

      if (!user) return send(res, 404, { error: 'Account not found. Please register first.' });
      if (user.suspended) return send(res, 403, { error: 'Account suspended. Contact support.' });

      if (user.passwordHash) {
        if (!password) return send(res, 400, { error: 'Password is required' });
        if (!verifyPassword(password, user.passwordHash)) {
          return send(res, 401, { error: 'Invalid password' });
        }
      }

      const token = signToken({ userId: user.id });
      return send(res, 200, { user: publicUser(user), token });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/request-otp') {
      const body = await parseBody(req);
      const identifier = String(body.identifier || '').trim();
      if (!identifier) return send(res, 400, { error: 'Identifier is required' });
      db.otpCodes = db.otpCodes.filter((o) =>
        !(String(o.identifier).toLowerCase() === identifier.toLowerCase() && !o.verified && new Date(o.expiresAt) > new Date())
      );
      const otp = String(crypto.randomInt(100000, 1000000));
      const record = {
        id: id('otp'),
        identifier,
        otp,
        verified: false,
        createdAt: now(),
        expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString()
      };
      db.otpCodes.push(record);
      await writeDb(db);
      await deliverOtp(identifier, otp);
      const devEcho = String(process.env.OTP_DEV_ECHO || 'true').toLowerCase() !== 'false';
      return send(res, 200, { ok: true, expiresAt: record.expiresAt, ...(devEcho ? { devOtp: otp } : {}) });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/verify-otp') {
      const body = await parseBody(req);
      const identifier = String(body.identifier || '').trim();
      const otp = String(body.otp || '').trim();
      const record = [...db.otpCodes].reverse().find((o) =>
        String(o.identifier).toLowerCase() === identifier.toLowerCase() &&
        !o.verified &&
        new Date(o.expiresAt) > new Date()
      );
      if (!record) return send(res, 400, { error: 'OTP expired or not found. Request a new one.' });
      if (record.otp !== otp) return send(res, 400, { error: 'Invalid OTP' });
      record.verified = true;
      record.verifiedAt = now();
      const user = findUserByIdentifier(db, identifier);
      if (user) user.verified = true;
      await writeDb(db);
      return send(res, 200, { ok: true, verified: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
      const body = await parseBody(req);
      const identifier = String(body.identifier || '').trim();
      const newPassword = String(body.newPassword || body.password || '');
      const otp = String(body.otp || '').trim();
      if (newPassword.length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' });
      const user = findUserByIdentifier(db, identifier);
      if (!user) return send(res, 404, { error: 'Account not found' });
      const record = [...db.otpCodes].reverse().find((o) =>
        String(o.identifier).toLowerCase() === identifier.toLowerCase() &&
        o.otp === otp &&
        new Date(o.expiresAt) > new Date()
      );
      if (!record) return send(res, 400, { error: 'Invalid or expired OTP' });
      record.verified = true;
      user.passwordHash = hashPassword(newPassword);
      await writeDb(db);
      const token = signToken({ userId: user.id });
      return send(res, 200, { ok: true, user: publicUser(user), token });
    }

    if (req.method === 'GET' && url.pathname === '/api/user/profile') {
      const user = requireUser(req, res, db);
      if (!user) return;
      return send(res, 200, { user: publicUser(user) });
    }

    if (req.method === 'GET' && url.pathname === '/api/wallet') {
      let user = authenticate(req, db);
      if (!user) {
        const qid = url.searchParams.get('userId');
        user = qid ? findUser(db, qid) : null;
      }
      if (!user) return send(res, 401, { error: 'Authentication required' });
      return send(res, 200, {
        user: publicUser(user),
        ledger: db.ledger.filter((l) => l.userId === user.id).slice(-50)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/deposits') {
      const body = await parseBody(req);
      let user = authenticate(req, db);
      if (!user && body.userId) user = findUser(db, body.userId);
      if (!user) return send(res, 401, { error: 'Authentication required' });

      const amount = money(body.amount);
      if (amount <= 0) return send(res, 400, { error: 'Deposit amount must be greater than zero' });
      if (String(body.method || 'mpesa') === 'mpesa' && !String(body.phone || '').trim()) {
        return send(res, 400, { error: 'M-Pesa phone number is required' });
      }

      const deposit = {
        id: id('dep'),
        userId: user.id,
        method: String(body.method || 'mpesa'),
        phone: String(body.phone || '').trim(),
        amount,
        status: db.config.mockPayments ? 'completed' : 'pending_stk',
        providerReference: null,
        paymentProvider: db.config.mockPayments ? 'mock' : PAYMENT_PROVIDER,
        wallet: db.config.designatedWallet,
        createdAt: now()
      };

      if (!db.config.mockPayments && deposit.method === 'mpesa') {
        try {
          const stk = PAYMENT_PROVIDER === 'mpesa'
            ? await initiateStkPush({ amount, phone: deposit.phone, accountReference: deposit.id })
            : await initiatePayheroStkPush({
                amount,
                phone: deposit.phone,
                accountReference: deposit.id,
                customerName: user.name || user.identifier
              });
          deposit.providerReference = stk.CheckoutRequestID || stk.reference || stk.MerchantRequestID || id('stk');
          deposit.providerResponse = stk;
        } catch (e) {
          console.error('[STK] Error:', e.message);
          return send(res, 400, { error: 'Failed to initiate STK push: ' + e.message });
        }
      } else {
        deposit.providerReference = id('stk');
      }

      db.deposits.push(deposit);

      if (deposit.status === 'completed') {
        user.balance = money(user.balance + amount);
        ledger(db, {
          userId: user.id,
          type: 'deposit',
          amount,
          balanceAfter: user.balance,
          reference: deposit.id
        });
      }

      await writeDb(db);
      return send(res, 200, {
        deposit,
        user: publicUser(user),
        message: db.config.mockPayments
          ? 'Mock STK push completed and wallet credited.'
          : 'STK push initiated. Credit wallet from the provider callback.'
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/payhero/callback') {
      const body = await parseBody(req);
      const callback = body.response || body;
      const externalReference = callback.ExternalReference || callback.external_reference || body.user_reference;
      const checkoutId = callback.CheckoutRequestID || callback.reference;
      const resultCode = Number(callback.ResultCode);
      const status = String(callback.Status || body.status || '').toLowerCase();
      const deposit = db.deposits.find((d) =>
        d.id === externalReference ||
        d.providerReference === checkoutId ||
        d.providerReference === callback.MerchantRequestID
      );
      if (!deposit) return send(res, 200, { ok: true, ignored: true });
      deposit.callback = body;
      deposit.paymentProvider = 'payhero';
      deposit.providerReceipt = callback.MpesaReceiptNumber || callback.providerReference || deposit.providerReceipt;
      deposit.status = (resultCode === 0 || status === 'success' || body.paymentSuccess === true) ? 'completed' : 'failed';
      if (deposit.status === 'completed') {
        const user = findUser(db, deposit.userId);
        if (user && !db.ledger.some((l) => l.reference === deposit.id && l.type === 'deposit')) {
          user.balance = money(user.balance + deposit.amount);
          ledger(db, {
            userId: user.id,
            type: 'deposit',
            amount: deposit.amount,
            balanceAfter: user.balance,
            reference: deposit.id
          });
        }
      }
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/mpesa/stk-callback') {
      const body = await parseBody(req);
      const callback = body.Body && body.Body.stkCallback ? body.Body.stkCallback : body.stkCallback || body;
      const checkoutId = callback.CheckoutRequestID;
      const resultCode = Number(callback.ResultCode);
      const deposit = db.deposits.find((d) => d.providerReference === checkoutId);
      if (!deposit) return send(res, 200, { ok: true, ignored: true });
      deposit.callback = callback;
      deposit.status = resultCode === 0 ? 'completed' : 'failed';
      if (resultCode === 0) {
        const user = findUser(db, deposit.userId);
        if (user && !db.ledger.some((l) => l.reference === deposit.id && l.type === 'deposit')) {
          user.balance = money(user.balance + deposit.amount);
          ledger(db, {
            userId: user.id,
            type: 'deposit',
            amount: deposit.amount,
            balanceAfter: user.balance,
            reference: deposit.id
          });
        }
      }
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/trades') {
      const body = await parseBody(req);
      let user = authenticate(req, db);
      if (!user && body.userId) user = findUser(db, body.userId);
      if (!user) return send(res, 401, { error: 'Authentication required' });

      const stake = money(body.stake);
      if (stake <= 0) return send(res, 400, { error: 'Stake must be greater than zero' });
      if (user.balance < stake) return send(res, 400, { error: 'Insufficient wallet balance' });

      user.balance = money(user.balance - stake);
      ledger(db, {
        userId: user.id,
        type: 'trade_stake',
        amount: -stake,
        balanceAfter: user.balance,
        reference: body.contractType || 'trade'
      });

      const settlement = settleContract(body.contractType, body.params, db.config);
      const won = settlement.won;
      const profit = won ? money(stake * Number(db.config.payoutRate)) : -stake;
      if (won) {
        const credit = money(stake + profit);
        user.balance = money(user.balance + credit);
        ledger(db, {
          userId: user.id,
          type: 'trade_payout',
          amount: credit,
          balanceAfter: user.balance,
          reference: body.contractType || 'trade'
        });
      }

      const trade = {
        id: id('trd'),
        userId: user.id,
        contractType: String(body.contractType || 'UNKNOWN'),
        symbol: String(body.symbol || 'UNKNOWN'),
        stake,
        won,
        profit,
        outcome: settlement.outcome,
        balanceAfter: user.balance,
        createdAt: now()
      };
      db.trades.push(trade);
      await writeDb(db);
      return send(res, 200, { trade, user: publicUser(user), config: db.config });
    }

    if (req.method === 'GET' && url.pathname === '/api/trades') {
      const user = requireUser(req, res, db);
      if (!user) return;
      const trades = db.trades.filter((t) => t.userId === user.id).slice(-100);
      return send(res, 200, { trades });
    }

    if (req.method === 'POST' && url.pathname === '/api/auto-trading/start') {
      const user = requireUser(req, res, db);
      if (!user) return;
      const body = await parseBody(req);
      const sessionId = user.id + '_' + Date.now();
      const session = {
        id: sessionId,
        userId: user.id,
        stake: money(body.stake || 10),
        targetProfit: money(body.targetProfit || 100),
        stopLoss: money(body.stopLoss || 100),
        initialBalance: user.balance,
        currentBalance: user.balance,
        tradesCount: 0,
        contractType: body.contractType || 'DIGITEVEN',
        status: 'running',
        startedAt: now(),
        stoppedAt: null
      };
      autoTradingSessions.set(sessionId, session);
      db.autoTradingStates.push(session);
      await writeDb(db);
      return send(res, 200, { session });
    }

    if (req.method === 'POST' && url.pathname === '/api/auto-trading/stop') {
      const user = requireUser(req, res, db);
      if (!user) return;
      const body = await parseBody(req);
      const sessionId = body.sessionId;
      const session = autoTradingSessions.get(sessionId);
      if (!session || session.userId !== user.id) return send(res, 404, { error: 'Session not found' });
      session.status = 'stopped';
      session.stoppedAt = now();
      autoTradingSessions.delete(sessionId);
      const idx = db.autoTradingStates.findIndex((s) => s.id === sessionId);
      if (idx >= 0) db.autoTradingStates[idx] = session;
      await writeDb(db);
      return send(res, 200, { session });
    }

    if (req.method === 'GET' && url.pathname === '/api/auto-trading/status') {
      const user = requireUser(req, res, db);
      if (!user) return;
      const sessions = db.autoTradingStates.filter((s) => s.userId === user.id);
      const activeSessions = sessions.filter((s) => s.status === 'running');
      return send(res, 200, { activeSessions, allSessions: sessions });
    }

    if (req.method === 'POST' && url.pathname === '/api/withdrawals') {
      const body = await parseBody(req);
      let user = authenticate(req, db);
      if (!user && body.userId) user = findUser(db, body.userId);
      if (!user) return send(res, 401, { error: 'Authentication required' });

      const amount = money(body.amount);
      if (amount <= 0) return send(res, 400, { error: 'Withdrawal amount must be greater than zero' });
      if (user.balance < amount) return send(res, 400, { error: 'Insufficient wallet balance' });

      user.balance = money(user.balance - amount);
      const withdrawal = {
        id: id('wd'),
        userId: user.id,
        method: String(body.method || 'mpesa'),
        destination: String(body.destination || '').trim(),
        amount,
        status: db.config.mockPayments ? 'paid' : 'processing',
        providerReference: id('pay'),
        createdAt: now()
      };
      if (!db.config.mockPayments && withdrawal.method.toLowerCase().includes('mpesa')) {
        try {
          const payment = await sendB2cPayment({ amount, destination: withdrawal.destination, reference: withdrawal.id });
          withdrawal.status = 'processing';
          withdrawal.providerReference = payment.OriginatorConversationID || withdrawal.id;
          withdrawal.providerResponse = payment;
        } catch (e) {
          console.error('[B2C] Error:', e.message);
          user.balance = money(user.balance + amount);
          return send(res, 400, { error: 'Failed to process withdrawal: ' + e.message });
        }
      }
      db.withdrawals.push(withdrawal);
      ledger(db, {
        userId: user.id,
        type: 'withdrawal',
        amount: -amount,
        balanceAfter: user.balance,
        reference: withdrawal.id
      });
      await writeDb(db);
      return send(res, 200, { withdrawal, user: publicUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/mpesa/b2c-result') {
      const body = await parseBody(req);
      const result = body.Result || body;
      const reference = result.OriginatorConversationID || result.ConversationID;
      const withdrawal = db.withdrawals.find((w) => w.id === reference || w.providerReference === reference);
      if (!withdrawal) return send(res, 200, { ok: true, ignored: true });
      withdrawal.callback = result;
      if (Number(result.ResultCode) === 0) {
        withdrawal.status = 'paid';
      } else {
        withdrawal.status = 'failed';
        const user = findUser(db, withdrawal.userId);
        if (user && !db.ledger.some((l) => l.reference === `${withdrawal.id}:refund`)) {
          user.balance = money(user.balance + withdrawal.amount);
          ledger(db, {
            userId: user.id,
            type: 'withdrawal_refund',
            amount: withdrawal.amount,
            balanceAfter: user.balance,
            reference: `${withdrawal.id}:refund`
          });
        }
      }
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, {
        config: db.config,
        users: db.users.map(publicUser),
        deposits: db.deposits.slice(-100),
        withdrawals: db.withdrawals.slice(-100),
        trades: db.trades.slice(-100),
        ledger: db.ledger.slice(-200)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/config') {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      if (body.payoutRate !== undefined) {
        db.config.payoutRate = Math.min(10, Math.max(0.01, Number(body.payoutRate)));
      }
      if (body.winProbability !== undefined) {
        db.config.winProbability = Math.min(0.99, Math.max(0.01, Number(body.winProbability)));
      }
      if (body.settlementDelayMs !== undefined) {
        db.config.settlementDelayMs = Math.min(30000, Math.max(0, Number(body.settlementDelayMs)));
      }
      if (body.designatedWallet !== undefined) {
        db.config.designatedWallet = String(body.designatedWallet).trim();
      }
      if (body.mockPayments !== undefined) {
        db.config.mockPayments = Boolean(body.mockPayments);
      }
      await writeDb(db);
      return send(res, 200, { config: db.config });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/users/suspend') {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      const user = findUser(db, body.userId);
      if (!user) return send(res, 404, { error: 'User not found' });
      user.suspended = Boolean(body.suspended ?? true);
      await writeDb(db);
      return send(res, 200, { user: publicUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/withdrawals/approve') {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      const wd = db.withdrawals.find((w) => w.id === body.withdrawalId);
      if (!wd) return send(res, 404, { error: 'Withdrawal not found' });
      const action = String(body.action || 'approve');
      if (action === 'approve') {
        wd.status = 'paid';
      } else if (action === 'reject') {
        wd.status = 'failed';
        const user = findUser(db, wd.userId);
        if (user && !db.ledger.some((l) => l.reference === `${wd.id}:refund`)) {
          user.balance = money(user.balance + wd.amount);
          ledger(db, {
            userId: user.id,
            type: 'withdrawal_refund',
            amount: wd.amount,
            balanceAfter: user.balance,
            reference: `${wd.id}:refund`
          });
        }
      }
      await writeDb(db);
      return send(res, 200, { withdrawal: wd });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/deposits/approve') {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      const dep = db.deposits.find((d) => d.id === body.depositId);
      if (!dep) return send(res, 404, { error: 'Deposit not found' });
      if (dep.status !== 'completed') {
        const user = findUser(db, dep.userId);
        if (user && !db.ledger.some((l) => l.reference === dep.id && l.type === 'deposit')) {
          user.balance = money(user.balance + dep.amount);
          ledger(db, {
            userId: user.id,
            type: 'deposit',
            amount: dep.amount,
            balanceAfter: user.balance,
            reference: dep.id
          });
        }
        dep.status = 'completed';
      }
      await writeDb(db);
      return send(res, 200, { deposit: dep });
    }

    return send(res, 404, { error: 'API route not found' });
  } catch (err) {
    console.error('[ERROR]', err);
    return send(res, 500, { error: err.message || 'Server error' });
  }
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return routeApi(req, res);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  }
  if (url.pathname === '/dashboard' || url.pathname === '/dashboard.html') {
    return serveFile(res, path.join(__dirname, 'dashboard.html'), 'text/html; charset=utf-8');
  }

  const filePath = path.normalize(path.join(__dirname, url.pathname));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = STATIC_TYPES[ext] || 'application/octet-stream';
  return serveFile(res, filePath, type);
});

initializeMemoryDb();

server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║          ELITE BINARY - PRODUCTION SERVER STARTED             ║`);
  console.log(`╠════════════════════════════════════════════════════════════════╣`);
  console.log(`║ 🚀 Server running at http://localhost:${PORT}`);
  console.log(`║ 🔐 Admin key configured: ${ADMIN_KEY === 'change-this-admin-key' ? '❌ CHANGE ME!' : '✅'}`);
  console.log(`║ 💾 Database mode: ${hasSupabaseDb() ? 'Supabase Postgres' : USE_FILE_DB ? 'File (with memory fallback)' : 'Memory only'}`);
  console.log(`║ 💳 Payment provider: ${PAYMENT_PROVIDER}`);
  console.log(`║ 🤖 Auto-trading: ENABLED`);
  console.log(`║ 📊 Mock payments: ${DEFAULT_MOCK_PAYMENTS ? '✅ ON (testing)' : '❌ OFF (live)'}`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
});
