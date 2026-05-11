export default {
  async fetch(request, env, ctx) {
    const requestOrigin = request.headers.get('Origin') || '';
    const allowedOrigins = String(env.ADMIN_ORIGIN || env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const originIsAllowed = !requestOrigin || allowedOrigins.length === 0 || allowedOrigins.includes(requestOrigin);
    const corsOrigin = allowedOrigins.length === 0 ? '*' : (originIsAllowed ? requestOrigin : allowedOrigins[0]);
    const headers = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Pananth-Admin-Token',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: originIsAllowed ? 204 : 403, headers });
    }

    if (!originIsAllowed) {
      return new Response('Forbidden origin', { status: 403, headers });
    }

    const TOKEN = env.LINE_TOKEN;
    const OWNER_ID = env.OWNER_ID;
    const EASYSLIP_API_KEY = env.EASYSLIP_API_KEY;
    const LINE_CHANNEL_SECRET = env.LINE_CHANNEL_SECRET;
    const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
    const PIN_MAX_FAILS = 5;
    const PIN_LOCK_MS = 30 * 60 * 1000;
    const PIN_LOCK_KEY = 'adminPinLock';
    const ADMIN_UNLOCK_KEY = String(env.ADMIN_UNLOCK_KEY || '').trim();
    // ===== R2 AUTO BACKUP =====
    // เก็บ Auto Backup ประมาณ 6 เดือน ถ้าไม่ได้ตั้งค่าใน Variables จะใช้ 180 วัน
    const R2_AUTO_BACKUP_RETENTION_DAYS = Math.max(1, Math.min(3650, Number(env.R2_AUTO_BACKUP_RETENTION_DAYS || 180)));
    const R2_AUTO_BACKUP_PREFIX = 'backups/auto/';

    // ===== TEST ROOM 99 =====
    const TEST_ROOM_NUM = 99;
    const TEST_ROOM_KEY = String(TEST_ROOM_NUM);

    const isTestRoom = (roomNum) =>
      String(roomNum || '').trim() === TEST_ROOM_KEY;

    const isValidRoomNum = (roomNum) => {
      const n = parseInt(roomNum, 10);
      // v15.4.2.30 รองรับเพิ่มห้องในอนาคตจากหน้า ตั้งค่าห้อง/ค่าเช่า
      return (n >= 1 && n <= 999) || n === TEST_ROOM_NUM;
    };

    const markTestPaymentRecord = (record = {}) => ({
      ...record,
      isTestRoom: true,
      testRoom: true,
      roomNum: TEST_ROOM_KEY,
      room: TEST_ROOM_KEY,
      note: String(record.note || '').includes('[TEST ROOM 99]')
        ? record.note
        : ('[TEST ROOM 99] ' + (record.note || '')).trim(),
    });

    const ensureTestRoomData = (rooms = {}, tenants = {}, cfg = {}) => {
      if (!rooms[TEST_ROOM_KEY]) {
        rooms[TEST_ROOM_KEY] = {
          roomNum: TEST_ROOM_KEY,
          room: TEST_ROOM_KEY,
          rent: 1,
          customRent: 1,
          prorateRent: 1,
          trash: 0,
          wifi: 0,
          ep: 0,
          ec: 0,
          wp: 0,
          wc: 0,
          paid: false,
          status: 'unpaid',
          isTestRoom: true,
          testRoom: true,
          tenantName: 'ห้องทดสอบ',
        };
      } else {
        rooms[TEST_ROOM_KEY].roomNum = TEST_ROOM_KEY;
        rooms[TEST_ROOM_KEY].room = TEST_ROOM_KEY;
        rooms[TEST_ROOM_KEY].isTestRoom = true;
        rooms[TEST_ROOM_KEY].testRoom = true;
        // ห้อง 99 เป็นห้องทดสอบเท่านั้น: ค่าเช่า 1 บาท / ค่าขยะ 0 บาท
        // บังคับล้างค่าเก่าที่อาจเคยติด 50 บาทจาก HTML เวอร์ชันก่อน
        rooms[TEST_ROOM_KEY].rent = 1;
        rooms[TEST_ROOM_KEY].customRent = 1;
        rooms[TEST_ROOM_KEY].prorateRent = 1;
        rooms[TEST_ROOM_KEY].trash = 0;
        if (!rooms[TEST_ROOM_KEY].tenantName) rooms[TEST_ROOM_KEY].tenantName = 'ห้องทดสอบ';
      }

      if (tenants && typeof tenants === 'object') {
        tenants[TEST_ROOM_KEY] = {
          ...(tenants[TEST_ROOM_KEY] || {}),
          name: tenants[TEST_ROOM_KEY]?.name || 'ห้องทดสอบ',
          isTestRoom: true,
          testRoom: true,
        };
      }

      if (cfg && typeof cfg === 'object') {
        if (!cfg.userIds) cfg.userIds = {};
        if (cfg.userIds[TEST_ROOM_KEY] === undefined) {
          cfg.userIds[TEST_ROOM_KEY] = '';
        }
      }

      return rooms[TEST_ROOM_KEY];
    };

    const jsonResponse = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      });

    const textResponse = (text, status = 200) =>
      new Response(text, { status, headers });

    const safeJsonParse = (text, fallback) => {
      try { return text ? JSON.parse(text) : fallback; }
      catch (_) { return fallback; }
    };

    const bytesToHex = (bytes) =>
      Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const randomToken = () => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return bytesToHex(bytes);
    };

    const timingSafeEqual = (a, b) => {
      const x = String(a || '');
      const y = String(b || '');
      if (x.length !== y.length) return false;
      let out = 0;
      for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
      return out === 0;
    };

    const createAdminSession = async () => {
      const token = randomToken();
      const now = Date.now();
      const expiresAt = new Date(now + ADMIN_SESSION_TTL_MS).toISOString();
      await env.DB.put('adminSession:' + token, JSON.stringify({
        createdAt: new Date(now).toISOString(),
        expiresAt,
      }), { expirationTtl: Math.ceil(ADMIN_SESSION_TTL_MS / 1000) });
      return { token, expiresAt };
    };

    const getAdminToken = () =>
      request.headers.get('X-Pananth-Admin-Token') || '';

    const checkAdminAuth = async () => {
      const token = getAdminToken();
      if (!token || !/^[a-f0-9]{64}$/i.test(token)) return { ok: false, reason: 'missing-token' };
      const raw = await env.DB.get('adminSession:' + token);
      if (!raw) return { ok: false, reason: 'invalid-token' };
      const session = safeJsonParse(raw, null);
      if (!session || !session.expiresAt || Date.now() > new Date(session.expiresAt).getTime()) {
        try { await env.DB.delete('adminSession:' + token); } catch (_) {}
        return { ok: false, reason: 'expired-token' };
      }
      return { ok: true, token, session };
    };

    const requireAdminAuth = async (action = 'admin') => {
      const auth = await checkAdminAuth();
      if (!auth.ok) {
        await logEvent({ level: 'warn', action: 'authDenied', message: 'Admin auth denied', extra: { action, reason: auth.reason } });
        return jsonResponse({ ok: false, authRequired: true, error: 'Admin authentication required' }, 401);
      }
      return null;
    };

    const getPinLockState = async () => {
      const raw = await env.DB.get(PIN_LOCK_KEY);
      const state = safeJsonParse(raw, {});
      const now = Date.now();
      const lockedUntilMs = state.lockedUntil ? new Date(state.lockedUntil).getTime() : 0;

      // ถ้าหมดเวลาล็อกแล้ว ให้ล้าง state อัตโนมัติ
      if (lockedUntilMs && now >= lockedUntilMs) {
        try { await env.DB.delete(PIN_LOCK_KEY); } catch (_) {}
        return { failCount: 0, locked: false, lockedUntil: '', remainingMs: 0, remainingAttempts: PIN_MAX_FAILS };
      }

      const failCount = Math.max(0, Number(state.failCount || 0));
      const locked = !!(lockedUntilMs && now < lockedUntilMs);
      return {
        failCount,
        locked,
        lockedUntil: locked ? state.lockedUntil : '',
        remainingMs: locked ? Math.max(0, lockedUntilMs - now) : 0,
        remainingAttempts: Math.max(0, PIN_MAX_FAILS - failCount),
        lastFailedAt: state.lastFailedAt || '',
      };
    };

    const resetPinLockState = async () => {
      try { await env.DB.delete(PIN_LOCK_KEY); } catch (_) {}
    };

    const recordPinFailure = async () => {
      const current = await getPinLockState();
      const now = Date.now();
      const nextFailCount = Number(current.failCount || 0) + 1;
      const base = {
        failCount: nextFailCount,
        lastFailedAt: new Date(now).toISOString(),
      };

      if (nextFailCount >= PIN_MAX_FAILS) {
        const lockedUntil = new Date(now + PIN_LOCK_MS).toISOString();
        await env.DB.put(PIN_LOCK_KEY, JSON.stringify({ ...base, failCount: 0, lockedUntil }), { expirationTtl: Math.ceil(PIN_LOCK_MS / 1000) + 300 });
        return { locked: true, lockedUntil, remainingMs: PIN_LOCK_MS, remainingAttempts: 0 };
      }

      await env.DB.put(PIN_LOCK_KEY, JSON.stringify(base), { expirationTtl: 24 * 60 * 60 });
      return { locked: false, lockedUntil: '', remainingMs: 0, remainingAttempts: Math.max(0, PIN_MAX_FAILS - nextFailCount) };
    };

    const verifyLineSignature = async (rawBody) => {
      const signature = request.headers.get('X-Line-Signature') || '';
      if (!LINE_CHANNEL_SECRET) {
        await logEvent({ level: 'error', action: 'lineSignature', message: 'Missing LINE_CHANNEL_SECRET' });
        return false;
      }
      if (!signature) return false;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(LINE_CHANNEL_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
      const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));
      return timingSafeEqual(expected, signature);
    };

    const thTime = (d = new Date()) =>
      new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

    const sanitizeConfig = (cfg = {}) => {
      const cleaned = { ...(cfg || {}) };
      delete cleaned.token;
      delete cleaned.lineToken;
      delete cleaned.LINE_TOKEN;
      delete cleaned.channelAccessToken;
      if (!cleaned.userIds) cleaned.userIds = {};
      if (!cleaned.mutedRooms) cleaned.mutedRooms = {};
      if (!cleaned.reminderDays) cleaned.reminderDays = [5, 10, 15, 20, 25];
      cleaned.roomSettings = normalizeRoomSettingsMap(cleaned.roomSettings || {});
      return cleaned;
    };

    const normalizeRoomSettingsMap = (input = {}) => {
      const out = {};
      const entries = Array.isArray(input)
        ? input.map(row => [row.room || row.roomNum, row])
        : Object.entries(input || {});
      for (const [key, rowRaw] of entries) {
        const row = rowRaw || {};
        const room = parseInt(row.room || row.roomNum || key, 10);
        if (!Number.isFinite(room) || room <= 0 || room === TEST_ROOM_NUM) continue;
        const status = ['active','vacant','disabled'].includes(String(row.status || '').trim()) ? String(row.status).trim() : 'active';
        out[String(room)] = {
          room,
          rent: Math.max(0, Number(row.rent ?? row.customRent ?? (room <= 20 ? 2500 : 3000)) || 0),
          trash: Math.max(0, Number(row.trash ?? 50) || 0),
          status,
          note: String(row.note || '').trim(),
          updatedAt: row.updatedAt || ''
        };
      }
      return out;
    };

    const getRoomSettingFromConfig = (cfg = {}, roomNum) => {
      const s = normalizeRoomSettingsMap(cfg.roomSettings || {})[String(parseInt(roomNum, 10))];
      return s || null;
    };

    const getKVJson = async (key, fallback) =>
      safeJsonParse(await env.DB.get(key), fallback);

    const putKVJson = async (key, data) =>
      env.DB.put(key, JSON.stringify(data));

    const mergeR2BackupStatus = async (patch = {}) => {
      const current = await getKVJson('r2BackupStatus', {});
      const next = {
        ...(current && typeof current === 'object' ? current : {}),
        ...(patch && typeof patch === 'object' ? patch : {}),
        updatedAt: new Date().toISOString(),
        updatedAtText: thTime(),
      };
      await putKVJson('r2BackupStatus', next);
      return next;
    };

    const safeMergeR2BackupStatus = async (patch = {}) => {
      try {
        return await mergeR2BackupStatus(patch);
      } catch (err) {
        try { await logEvent({ level: 'warn', action: 'r2BackupStatus', message: err.message || String(err) }); } catch (_) {}
        return null;
      }
    };

    const arrayBufferToBase64 = (buffer) => {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    };


    const getEasySlipPartyName = (party = {}) => {
      const name = party?.account?.name;
      if (typeof name === 'string') return name || '?';
      return (
        name?.th ||
        name?.en ||
        party?.account?.nameTh ||
        party?.account?.nameEn ||
        party?.name?.th ||
        party?.name?.en ||
        party?.name ||
        '?'
      );
    };

    const getEasySlipDateTime = (raw = {}) => {
      if (!raw) return '';
      if (typeof raw.date === 'string') return raw.date;
      if (raw.date?.iso) return raw.date.iso;
      if (raw.date?.timestamp) return raw.date.timestamp;
      if (raw.transDate && raw.transTime) return raw.transDate + ' ' + raw.transTime;
      return raw.dateTime || raw.datetime || raw.createdAt || '';
    };

    const verifySlipWithEasySlip = async (base64Image) => {
      if (!EASYSLIP_API_KEY) throw new Error('Missing EASYSLIP_API_KEY');

      const slipRes = await fetch('https://api.easyslip.com/v2/verify/bank', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + EASYSLIP_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base64: base64Image,
          checkDuplicate: true,
        }),
      });

      let slipResult = {};
      try {
        slipResult = await slipRes.json();
      } catch (_) {
        throw new Error('EasySlip response is not JSON: HTTP ' + slipRes.status);
      }

      if (!slipRes.ok || !slipResult?.success) {
        const code = slipResult?.error?.code || 'EASYSLIP_ERROR';
        const message = slipResult?.error?.message || slipResult?.message || ('HTTP ' + slipRes.status);
        throw new Error(code + ': ' + message);
      }

      const data = slipResult.data || {};
      const raw = data.rawSlip || {};
      const rawAmount = raw.amount || {};
      const amount =
        Number(data.amountInSlip) ||
        Number(rawAmount.amount) ||
        Number(rawAmount.local?.amount) ||
        Number(rawAmount) ||
        0;

      return {
        provider: 'EasySlip',
        isDuplicate: !!data.isDuplicate,
        transRef:
          raw.transRef ||
          raw.ref ||
          raw.reference ||
          raw.referenceNo ||
          raw.transRefNo ||
          '',
        amount,
        dateTime: getEasySlipDateTime(raw),
        sender: {
          bank: raw.sender?.bank || {},
          account: { name: getEasySlipPartyName(raw.sender) },
        },
        receiver: {
          bank: raw.receiver?.bank || {},
          account: { name: getEasySlipPartyName(raw.receiver) },
        },
        matchedAccount: data.matchedAccount || null,
        rawSlip: raw,
        easySlipRaw: data,
      };
    };

    const logEvent = async ({
      level = 'info',
      action = 'log',
      message = '',
      roomNum = '',
      ref = '',
      extra = {},
    }) => {
      try {
        const logs = await getKVJson('logs', []);
        logs.push({
          time: new Date().toISOString(),
          timeText: thTime(),
          level,
          action,
          message: String(message || ''),
          roomNum,
          ref,
          extra,
        });
        while (logs.length > 200) logs.shift();
        await putKVJson('logs', logs);
      } catch (_) {}
    };


    const validateBackupData = (data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return 'Invalid backup data';
      }
      const restoreSchema = {
        rooms: 'object', config: 'object', shopinfo: 'object', tenants: 'object', history: 'object',
        paymentHistory: 'array', expenses: 'array', logs: 'array', slipRefs: 'object',
        monthClosures: 'object', lockedMonths: 'object', arrears: 'object', editHistory: 'array',
        monthlyArchiveIndex: 'object'
      };
      for (const [key, expected] of Object.entries(restoreSchema)) {
        if (data[key] === undefined || data[key] === null) continue;
        const ok = expected === 'array'
          ? Array.isArray(data[key])
          : (typeof data[key] === 'object' && !Array.isArray(data[key]));
        if (!ok) return 'Invalid backup field: ' + key;
      }
      if (data.monthlyArchives !== undefined && (typeof data.monthlyArchives !== 'object' || Array.isArray(data.monthlyArchives))) {
        return 'Invalid backup field: monthlyArchives';
      }
      return '';
    };

    const restoreBackupDataToKV = async (data, source = 'web-file') => {
      const error = validateBackupData(data);
      if (error) throw new Error(error);

      const allowed = [
        ['rooms', {}],
        ['config', {}],
        ['shopinfo', {}],
        ['tenants', {}],
        ['history', {}],
        ['paymentHistory', []],
        ['expenses', []],
        ['logs', []],
        ['slipRefs', {}],
        ['monthClosures', {}],
        ['lockedMonths', {}],
        ['lastCloseBackup', null],
        ['arrears', {}],
        ['editHistory', []],
        ['monthlyArchiveIndex', {}],
      ];

      const restoredKeys = [];
      for (const [key, fallback] of allowed) {
        if (data[key] !== undefined) {
          const value = key === 'config' ? sanitizeConfig(data[key] || {}) : data[key] ?? fallback;
          await putKVJson(key, value);
          restoredKeys.push(key);
        }
      }

      let restoredArchives = 0;
      if (data.monthlyArchives && typeof data.monthlyArchives === 'object' && !Array.isArray(data.monthlyArchives)) {
        for (const [monthKey, archive] of Object.entries(data.monthlyArchives)) {
          if (/^\d{4}-\d{2}$/.test(monthKey)) {
            await putKVJson('monthlyArchive:' + monthKey, archive || {});
            restoredArchives += 1;
          }
        }
      }

      // เพื่อความปลอดภัย Restore จะไม่เขียนทับ PIN ผ่านไฟล์ backup หรือ R2
      await logEvent({
        action: 'restoreBackup',
        message: 'Restore backup completed',
        extra: { source, restoredKeys, restoredArchives, pinExcluded: true },
      });

      return { restoredKeys, restoredArchives };
    };

    const pushLine = async (token, to, text) => {
      if (!token || !to || !text) return { ok: false, error: 'Missing token/to/text' };

      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({
          to,
          messages: [{ type: 'text', text }],
        }),
      });

      let result = {};
      try { result = await res.json(); } catch (_) {}

      return { ok: res.ok, status: res.status, result };
    };

    const replyLine = async (token, replyToken, text) => {
      if (!token || !replyToken || !text) return { ok: false, error: 'Missing token/replyToken/text' };

      const res = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({
          replyToken,
          messages: [{ type: 'text', text }],
        }),
      });

      let result = {};
      try { result = await res.json(); } catch (_) {}

      return { ok: res.ok, status: res.status, result };
    };

    const calcExpectedAmount = (roomNum, roomData = {}, cfg = {}) => {
      const r = parseInt(roomNum, 10);
      const elec = ((Number(roomData.ec) || 0) - (Number(roomData.ep) || 0)) * 8;
      const water = ((Number(roomData.wc) || 0) - (Number(roomData.wp) || 0)) * 35;
      if (isTestRoom(roomNum)) {
        // ห้อง 99 ใช้ทดสอบสลิปเท่านั้น ไม่คิดค่าขยะ และตั้งยอดทดสอบพื้นฐาน 1 บาท
        const rent = Number(roomData.customRent ?? roomData.prorateRent ?? roomData.rent ?? 1) || 1;
        return rent + elec + water + (Number(roomData.wifi) || 0);
      }
      const setting = getRoomSettingFromConfig(cfg, roomNum);
      const rent = Number(roomData.prorateRent ?? roomData.rent ?? setting?.rent ?? (r <= 20 ? 2500 : 3000));
      const trash = Number(roomData.trash !== undefined ? roomData.trash : (setting?.trash !== undefined ? setting.trash : 50));
      return rent + elec + water + trash + (Number(roomData.wifi) || 0);
    };

    const getRoomRentValue = (roomNum, roomData = {}, cfg = {}) => {
      if (isTestRoom(roomNum)) return 1;
      const r = parseInt(roomNum, 10);
      const setting = getRoomSettingFromConfig(cfg, roomNum);
      return Number(roomData.prorateRent ?? roomData.rent ?? setting?.rent ?? (r <= 20 ? 2500 : 3000)) || 0;
    };

    const getRoomTrashValue = (roomNum, roomData = {}, cfg = {}) => {
      if (isTestRoom(roomNum)) return 0;
      const setting = getRoomSettingFromConfig(cfg, roomNum);
      return Number(roomData.trash !== undefined ? roomData.trash : (setting?.trash !== undefined ? setting.trash : 50)) || 0;
    };

    const shiftMonthKey = (monthKey, delta) => {
      const [yr, mo] = String(monthKey || '').split('-').map(Number);
      if (!yr || !mo) return '';
      const d = new Date(yr, mo - 1 + Number(delta || 0), 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    };

    const monthTextFromKey = (monthKey) => {
      const [yr, mo] = String(monthKey || '').split('-').map(Number);
      const thMonths = ['','มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
      if (!yr || !mo || !thMonths[mo]) return monthKey || '-';
      return thMonths[mo] + ' ' + (yr + 543);
    };

    const getBillingMetaFromConfig = (cfg = {}) => {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
      const fallbackPaymentKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const paymentKey = cfg.currentPaymentMonthKey || cfg.paymentMonthKey || fallbackPaymentKey;
      const billingKey = cfg.currentBillingMonthKey || cfg.billingMonthKey || shiftMonthKey(paymentKey, -1);
      return {
        paymentMonthKey: paymentKey,
        paymentMonthText: cfg.currentPaymentMonthText || cfg.paymentMonthText || monthTextFromKey(paymentKey),
        billingMonthKey: billingKey,
        billingMonthText: cfg.currentBillingMonthText || cfg.billingMonthText || monthTextFromKey(billingKey),
      };
    };

    const safeBackupPart = (v, fallback = 'unknown') => String(v || fallback)
      .replace(/[^0-9a-zA-Zก-๙_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || fallback;

    const getBackupSnapshot = async ({ backupType = 'auto-r2', reason = 'auto', billingMeta = {}, createdFrom = 'worker' } = {}) => {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const backupId = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const keys = ['rooms','config','shopinfo','tenants','history','paymentHistory','expenses','logs','slipRefs','monthClosures','lockedMonths','lastCloseBackup','arrears','editHistory','monthlyArchiveIndex'];
      const values = await Promise.all(keys.map(k => env.DB.get(k)));
      const backup = {
        app: 'pananth-rental',
        version: 'v15.4.2.36',
        backupType,
        reason,
        backupId,
        createdAt: now.toISOString(),
        createdAtText: thTime(now),
        createdFrom,
        pinExcluded: true,
      };

      keys.forEach((k, idx) => {
        const fallback = k === 'paymentHistory' || k === 'expenses' || k === 'logs' || k === 'editHistory' ? [] : (k === 'lastCloseBackup' ? null : {});
        const parsed = safeJsonParse(values[idx], fallback);
        backup[k] = k === 'config' ? sanitizeConfig(parsed || {}) : parsed;
      });

      const cfgMeta = getBillingMetaFromConfig(backup.config || {});
      backup.billingMeta = {
        ...cfgMeta,
        ...(billingMeta && typeof billingMeta === 'object' ? billingMeta : {}),
      };

      backup.monthlyArchives = {};
      try {
        const index = backup.monthlyArchiveIndex || {};
        const archiveKeys = Object.keys(index || {});
        const archiveValues = await Promise.all(archiveKeys.map(k => env.DB.get('monthlyArchive:' + k)));
        archiveKeys.forEach((k, idx) => {
          backup.monthlyArchives[k] = safeJsonParse(archiveValues[idx], null);
        });
      } catch (_) {}

      return { backup, backupId, now };
    };

    const pruneR2BackupIndex = async ({ cutoffMs = 0, deletedKeys = [] } = {}) => {
      try {
        const deletedSet = new Set((deletedKeys || []).filter(Boolean));
        const index = await getKVJson('r2BackupIndex', []);
        if (!Array.isArray(index)) return [];
        const kept = index.filter(item => {
          const key = item.objectKey || item.key || '';
          if (deletedSet.has(key)) return false;
          const t = new Date(item.createdAt || item.uploaded || 0).getTime();
          if (cutoffMs && t && t < cutoffMs) return false;
          return true;
        }).slice(-300);
        await putKVJson('r2BackupIndex', kept);
        return kept;
      } catch (_) { return []; }
    };

    const cleanupOldR2Backups = async ({ retentionDays = R2_AUTO_BACKUP_RETENTION_DAYS, prefix = R2_AUTO_BACKUP_PREFIX, maxPages = 5 } = {}) => {
      if (!env.RENTAL_R2 || typeof env.RENTAL_R2.list !== 'function' || typeof env.RENTAL_R2.delete !== 'function') {
        return { ok: false, skipped: true, reason: 'missing-r2-binding' };
      }

      const safePrefix = String(prefix || R2_AUTO_BACKUP_PREFIX).trim();
      if (!safePrefix.startsWith('backups/') || safePrefix.includes('..')) {
        return { ok: false, error: 'Invalid R2 cleanup prefix' };
      }

      const days = Math.max(1, Math.min(3650, Number(retentionDays || R2_AUTO_BACKUP_RETENTION_DAYS)));
      const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
      const deletedKeys = [];
      let cursor = undefined;
      let scanned = 0;
      let page = 0;

      do {
        const listed = await env.RENTAL_R2.list({ prefix: safePrefix, limit: 1000, cursor, include: ['customMetadata'] });
        const objects = listed.objects || [];
        scanned += objects.length;
        for (const obj of objects) {
          const key = String(obj.key || '');
          if (!key.endsWith('.json')) continue;
          const metaCreated = obj.customMetadata?.createdAt || '';
          const uploadedAt = obj.uploaded ? new Date(obj.uploaded).getTime() : 0;
          const createdAt = metaCreated ? new Date(metaCreated).getTime() : uploadedAt;
          if (createdAt && createdAt < cutoffMs) {
            await env.RENTAL_R2.delete(key);
            deletedKeys.push(key);
          }
        }
        cursor = listed.truncated ? listed.cursor : undefined;
        page += 1;
      } while (cursor && page < maxPages);

      await pruneR2BackupIndex({ cutoffMs, deletedKeys });
      if (deletedKeys.length) {
        await logEvent({ action: 'cleanupR2Backups', message: 'Old R2 auto backups deleted', extra: { prefix: safePrefix, retentionDays: days, scanned, deleted: deletedKeys.length } });
      }
      return { ok: true, prefix: safePrefix, retentionDays: days, scanned, deleted: deletedKeys.length, deletedKeys, truncated: !!cursor };
    };

    const createR2Backup = async ({ backupType = 'auto-r2', reason = 'auto', billingMeta = {}, createdFrom = 'worker' } = {}) => {
      if (!env.RENTAL_R2 || typeof env.RENTAL_R2.put !== 'function') {
        return { ok: false, skipped: true, reason: 'missing-r2-binding', error: 'ยังไม่ได้ผูก R2 Bucket Binding ชื่อ RENTAL_R2 กับ Worker' };
      }

      const { backup, backupId, now } = await getBackupSnapshot({ backupType, reason, billingMeta, createdFrom });
      const folderMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')}`;
      const backupFolder = backupType === 'manual-r2' ? 'manual' : 'auto';
      const reasonPart = backupType === 'manual-r2' ? '' : '_' + safeBackupPart(reason, 'auto');
      const billingMonthKey = safeBackupPart(backup.billingMeta?.billingMonthKey || backup.config?.currentBillingMonthKey || backup.config?.currentBillingMonth || 'unknown');
      const paymentMonthKey = safeBackupPart(backup.billingMeta?.paymentMonthKey || backup.config?.currentPaymentMonthKey || backup.config?.currentPaymentMonth || 'unknown');
      const objectKey = `backups/${backupFolder}/${folderMonth}/pananth-rental_${backupType}_${backupId}${reasonPart}_billing-${billingMonthKey}_payment-${paymentMonthKey}.json`;
      backup.objectKey = objectKey;

      const jsonText = JSON.stringify(backup, null, 2);
      await env.RENTAL_R2.put(objectKey, jsonText, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          app: 'pananth-rental',
          backupType,
          backupId,
          reason: String(reason || '').slice(0, 120),
          billingMonthKey,
          paymentMonthKey,
          createdAt: backup.createdAt,
        },
      });

      const r2BackupIndex = await getKVJson('r2BackupIndex', []);
      const nextIndex = Array.isArray(r2BackupIndex) ? r2BackupIndex : [];
      nextIndex.push({
        backupId,
        objectKey,
        backupType,
        reason,
        size: jsonText.length,
        createdAt: backup.createdAt,
        createdAtText: backup.createdAtText,
        billingMeta: backup.billingMeta,
      });
      while (nextIndex.length > 300) nextIndex.shift();
      await putKVJson('r2BackupIndex', nextIndex);

      if (backupType !== 'manual-r2') {
        try { await cleanupOldR2Backups({ retentionDays: R2_AUTO_BACKUP_RETENTION_DAYS, prefix: R2_AUTO_BACKUP_PREFIX }); } catch (e) {
          await logEvent({ level: 'warn', action: 'cleanupR2Backups', message: e.message || String(e), extra: { afterBackup: objectKey } });
        }
      }

      const result = { ok: true, backupId, objectKey, size: jsonText.length, createdAt: backup.createdAt, createdAtText: backup.createdAtText, backupType, reason, billingMeta: backup.billingMeta };

      let backupStatus = null;
      if (backupType === 'auto-r2') {
        backupStatus = await safeMergeR2BackupStatus({
          lastAutoBackup: { ...result, status: 'success' },
          lastAutoBackupAt: backup.createdAt,
          lastAutoBackupAtText: backup.createdAtText,
          lastAutoBackupKey: objectKey,
          lastAutoBackupReason: reason,
          lastAutoBackupStatus: 'success',
        });
      } else if (backupType === 'manual-r2') {
        backupStatus = await safeMergeR2BackupStatus({
          lastManualBackup: { ...result, status: 'success' },
          lastManualBackupAt: backup.createdAt,
          lastManualBackupAtText: backup.createdAtText,
          lastManualBackupKey: objectKey,
          lastManualBackupReason: reason,
          lastManualBackupStatus: 'success',
        });
      }

      await logEvent({ action: backupType === 'manual-r2' ? 'backupToR2' : 'autoBackupToR2', message: 'R2 backup completed', extra: { objectKey, backupId, backupType, reason, size: jsonText.length } });
      return { ...result, backupStatus };
    };

    const autoBackupBeforeImportantAction = async (reason, billingMeta = {}) => {
      try {
        const result = await createR2Backup({ backupType: 'auto-r2', reason, billingMeta, createdFrom: 'worker-auto' });
        if (!result || !result.ok) {
          const now = new Date();
          const failed = {
            ok: false,
            status: 'failed',
            reason,
            error: result?.error || result?.reason || 'Auto Backup failed',
            createdAt: now.toISOString(),
            createdAtText: thTime(now),
          };
          const backupStatus = await safeMergeR2BackupStatus({
            lastAutoBackupError: failed,
            lastAutoBackupFailedAt: failed.createdAt,
            lastAutoBackupFailedAtText: failed.createdAtText,
            lastAutoBackupFailedReason: reason,
            lastAutoBackupStatus: 'failed',
          });
          return { ...(result || failed), backupStatus };
        }
        return result;
      } catch (err) {
        const now = new Date();
        const failed = {
          ok: false,
          status: 'failed',
          reason,
          error: err.message || String(err),
          createdAt: now.toISOString(),
          createdAtText: thTime(now),
        };
        const backupStatus = await safeMergeR2BackupStatus({
          lastAutoBackupError: failed,
          lastAutoBackupFailedAt: failed.createdAt,
          lastAutoBackupFailedAtText: failed.createdAtText,
          lastAutoBackupFailedReason: reason,
          lastAutoBackupStatus: 'failed',
        });
        await logEvent({ level: 'warn', action: 'autoBackupToR2', message: err.message || String(err), extra: { reason } });
        return { ...failed, backupStatus };
      }
    };


    const isMonthKey = (value) => /^\d{4}-\d{2}$/.test(String(value || ''));

    const normalizeBillingCycleConfig = (rawCfg = {}, monthClosures = {}, lastCloseBackup = null) => {
      const cfg = sanitizeConfig(rawCfg || {});
      let source = 'config';
      let paymentKey = cfg.currentPaymentMonthKey || cfg.paymentMonthKey || '';

      const openedKeys = [];
      if (lastCloseBackup && isMonthKey(lastCloseBackup.openedToMonthKey)) {
        openedKeys.push({ key: lastCloseBackup.openedToMonthKey, source: 'lastCloseBackup' });
      }

      for (const closure of Object.values(monthClosures || {})) {
        if (closure && isMonthKey(closure.openedToMonthKey)) {
          openedKeys.push({ key: closure.openedToMonthKey, source: 'monthClosures' });
        }
      }

      openedKeys.sort((a, b) => String(a.key).localeCompare(String(b.key)));
      const latestOpened = openedKeys[openedKeys.length - 1];

      if (!isMonthKey(paymentKey) && latestOpened) {
        paymentKey = latestOpened.key;
        source = latestOpened.source;
      } else if (isMonthKey(paymentKey) && latestOpened && String(latestOpened.key) > String(paymentKey)) {
        paymentKey = latestOpened.key;
        source = latestOpened.source + ':newerThanConfig';
      }

      const changedBefore = JSON.stringify({
        currentPaymentMonthKey: cfg.currentPaymentMonthKey || '',
        currentPaymentMonthText: cfg.currentPaymentMonthText || '',
        currentBillingMonthKey: cfg.currentBillingMonthKey || '',
        currentBillingMonthText: cfg.currentBillingMonthText || '',
      });

      if (isMonthKey(paymentKey)) {
        const billingKey = shiftMonthKey(paymentKey, -1);
        cfg.currentPaymentMonthKey = paymentKey;
        cfg.currentPaymentMonthText = monthTextFromKey(paymentKey);
        cfg.currentBillingMonthKey = billingKey;
        cfg.currentBillingMonthText = monthTextFromKey(billingKey);
        cfg.cycleUpdatedAt = cfg.cycleUpdatedAt || new Date().toISOString();
        cfg.cycleSyncSource = source;
      }

      const changedAfter = JSON.stringify({
        currentPaymentMonthKey: cfg.currentPaymentMonthKey || '',
        currentPaymentMonthText: cfg.currentPaymentMonthText || '',
        currentBillingMonthKey: cfg.currentBillingMonthKey || '',
        currentBillingMonthText: cfg.currentBillingMonthText || '',
      });

      return {
        config: cfg,
        billingMeta: getBillingMetaFromConfig(cfg),
        source,
        changed: changedBefore !== changedAfter,
      };
    };

    const getCurrentMonthText = (cfg = {}) => {
      // ชื่อเดิมยังใช้ในระบบเดิม แต่ค่าที่ส่งออกให้หมายถึง “รอบบิล” จาก KV config ก่อน ไม่ใช่คำนวณจากวันที่เครื่องอย่างเดียว
      return getBillingMetaFromConfig(cfg).billingMonthText;
    };

    const getCurrentMonthKey = (cfg = {}) => {
      // ใช้ key ของรอบบิลจาก KV config ก่อน เพื่อให้ข้อความ EasySlip ตรงกับรอบที่เจ้าของเปิดไว้ในหน้าเว็บ
      return getBillingMetaFromConfig(cfg).billingMonthKey;
    };

    const findRoomsByUserId = (cfg, tenants, userId) => {
      const matches = [];

      if (!userId) return matches;

      if (cfg.userIds) {
        for (const [rNum, uid] of Object.entries(cfg.userIds)) {
          if (uid === userId && isValidRoomNum(rNum)) {
            const tenantName = tenants[rNum]?.name || '';

            matches.push({
              roomNum: String(rNum),
              roomInfo: isTestRoom(rNum)
                ? 'ห้อง 99 TEST (ห้องทดสอบ)'
                : 'ห้อง ' + rNum + (tenantName ? ' (' + tenantName + ')' : ''),
            });
          }
        }
      }

      // ถ้าเจ้าของส่งสลิป ให้เพิ่มห้อง 99 เป็นตัวเลือกทดสอบด้วย
      // แต่ไม่บังคับเลือกทันที ต้องให้ยอดเงินตรงก่อน
      if (OWNER_ID && userId === OWNER_ID) {
        const hasTestRoom = matches.some(x => String(x.roomNum) === TEST_ROOM_KEY);

        if (!hasTestRoom) {
          matches.push({
            roomNum: TEST_ROOM_KEY,
            roomInfo: 'ห้อง 99 TEST (ห้องทดสอบ)',
          });
        }
      }

      return matches;
    };

    const describeUserRooms = (cfg, tenants, userId) => {
      const rooms = findRoomsByUserId(cfg, tenants, userId);
      if (rooms.length === 0) return 'ไม่ทราบห้อง';
      if (rooms.length === 1) return rooms[0].roomInfo;
      return rooms.map(r => r.roomInfo).join(', ');
    };

    const chooseRoomByUserIdAndAmount = ({
      cfg,
      tenants,
      rooms,
      arrears,
      userId,
      amount,
    }) => {
      const candidates = findRoomsByUserId(cfg, tenants, userId);
      const paidAmount = Number(amount) || 0;

      // ห้อง 99 ใช้ทดสอบ EasySlip: ถ้ายอด 1 บาท ให้เพิ่มเป็นตัวเลือกทดสอบเสมอ
      // เพื่อให้เจ้าของทดสอบได้ แม้ USER ID เดียวกันจะผูกหลายห้องจริงอยู่
      if (paidAmount === 1 && !candidates.some(c => String(c.roomNum) === TEST_ROOM_KEY)) {
        candidates.push({
          roomNum: TEST_ROOM_KEY,
          roomInfo: 'ห้อง 99 TEST (ห้องทดสอบ)',
        });
      }

      if (paidAmount === 1 && candidates.some(c => String(c.roomNum) === TEST_ROOM_KEY)) {
        return {
          ok: true,
          roomNum: TEST_ROOM_KEY,
          roomInfo: 'ห้อง 99 TEST (ห้องทดสอบ)',
          matchedBy: 'testRoom99OneBaht',
          candidates,
        };
      }

      if (candidates.length === 0) {
        return {
          ok: false,
          reason: 'ไม่พบห้องที่ผูกกับ USER ID นี้',
          candidates: [],
        };
      }

      const scored = candidates.map(c => {
        const room = rooms[String(c.roomNum)] || rooms[Number(c.roomNum)] || {};

        const currentFull = room && !room.vacant
          ? calcExpectedAmount(c.roomNum, room)
          : 0;

        const currentPaid = Number(room.manualPaidAmount || 0);

        const currentDue = room.paid || room.vacant
          ? 0
          : Math.max(0, currentFull - currentPaid);

        const arrearsDue = getRoomArrearsTotal(arrears, c.roomNum);
        const totalDue = arrearsDue + currentDue;
        const diffTotal = Math.abs(totalDue - paidAmount);
        const diffCurrent = Math.abs(currentDue - paidAmount);
        const diffArrears = Math.abs(arrearsDue - paidAmount);

        let score = 0;
        const isMultiRoomUser = candidates.length > 1;
        const exactTotalMatch = paidAmount > 0 && totalDue > 0 && paidAmount === totalDue;
        const exactCurrentMatch = paidAmount > 0 && currentDue > 0 && paidAmount === currentDue;
        const exactArrearsMatch = paidAmount > 0 && arrearsDue > 0 && paidAmount === arrearsDue;
        const partialSingleRoomMatch = !isMultiRoomUser && paidAmount > 0 && totalDue > 0 && paidAmount < totalDue;

        // หลักการเลือกห้องจากสลิป:
        // 1 ห้องต่อ 1 USER ID: ยอมรับการจ่ายบางส่วนได้
        // หลายห้องต่อ 1 USER ID: ต้องยอดตรงกับห้องใดห้องหนึ่งเท่านั้น
        // หลายห้อง + ยอดบางส่วน/ไม่ชัด: ไม่อัปเดตอัตโนมัติ ให้เจ้าของตรวจสอบ

        // ยอดสลิปตรงกับยอดค้างรวมของห้องนั้น
        if (exactTotalMatch) score += 100;

        // ยอดสลิปตรงกับยอดเดือนปัจจุบัน
        if (exactCurrentMatch) score += 80;

        // ยอดสลิปตรงกับยอดค้างเก่า
        if (exactArrearsMatch) score += 70;

        // จ่ายบางส่วน: อนุญาตเฉพาะ USER ID ที่ผูกห้องเดียวเท่านั้น
        if (partialSingleRoomMatch) score += 30;

        // ห้องยังรอชำระ ให้คะแนนเพิ่มเฉพาะกรณีที่มีเหตุผลพอแล้ว
        // กันกรณี USER ID หลายห้อง + จ่ายบางส่วน แล้วระบบเดาห้องเอง
        if (!room.paid && !room.vacant && totalDue > 0 && (!isMultiRoomUser || score > 0)) score += 10;

        // ห้องว่าง ลดคะแนน
        if (room.vacant) score -= 50;

        return {
          ...c,
          currentDue,
          arrearsDue,
          totalDue,
          score,
          diffTotal,
          diffCurrent,
          diffArrears,
        };
      });

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.diffTotal - b.diffTotal;
      });

      const best = scored[0];
      const second = scored[1];

      // ถ้ามีห้องเดียว ใช้ห้องนั้นได้เลย
      if (scored.length === 1) {
        return {
          ok: true,
          roomNum: best.roomNum,
          roomInfo: best.roomInfo,
          matchedBy: 'userIdOnly',
          candidates: scored,
        };
      }

      // ถ้ามีหลายห้อง ต้องให้ยอดเงินตรงกับห้องใดห้องหนึ่งอย่างชัดเจนเท่านั้น
      // ไม่ใช้เงื่อนไขจ่ายบางส่วนกับ USER ID ที่ผูกหลายห้อง
      if (best && best.score >= 70 && (!second || best.score > second.score)) {
        return {
          ok: true,
          roomNum: best.roomNum,
          roomInfo: best.roomInfo,
          matchedBy: 'userIdAndExactAmount',
          candidates: scored,
        };
      }

      // ถ้าแยกไม่ได้ ห้ามอัปเดตผิดห้อง
      return {
        ok: false,
        reason: 'USER ID นี้ผูกหลายห้อง และยอดเงินเป็นการจ่ายบางส่วนหรือยังไม่ตรงกับห้องใดชัดเจน',
        candidates: scored,
      };
    };

    const makeSlipKey = (slipData) => {
      const ref = String(slipData?.transRef || '').trim();
      if (ref && ref !== '-') return ref;
      return [
        slipData?.dateTime || '',
        slipData?.amount || '',
        slipData?.sender?.account?.name || '',
        slipData?.receiver?.account?.name || '',
      ].join('|');
    };

    const getRoomArrearsTotal = (arrears, roomNum) => {
      const list = arrears?.[String(roomNum)] || [];
      return list.reduce((sum, a) => sum + Math.max(0, Number(a.remaining) || 0), 0);
    };

    const applyPaymentToRoom = ({
      roomNum,
      amount,
      rooms,
      arrears,
      note = '',
      source = 'manual',
      ref = '',
      sender = '',
      receiver = '',
      billingMeta = {},
      config = {},
    }) => {
      let remainingPayment = Number(amount) || 0;
      const rKey = String(roomNum);
      if (!arrears[rKey]) arrears[rKey] = [];

      const appliedItems = [];

      arrears[rKey].sort((a, b) => String(a.monthKey || '').localeCompare(String(b.monthKey || '')));

      for (const item of arrears[rKey]) {
        const remaining = Math.max(0, Number(item.remaining) || 0);
        if (remainingPayment <= 0 || remaining <= 0) continue;

        const apply = Math.min(remainingPayment, remaining);
        item.paidAmount = (Number(item.paidAmount) || 0) + apply;
        item.remaining = Math.max(0, remaining - apply);
        item.status = item.remaining <= 0 ? 'paid' : 'partial';
        item.lastPaidAt = new Date().toISOString();
        item.lastPaidAtText = thTime();
        item.lastNote = note;

        remainingPayment -= apply;

        appliedItems.push({
          type: 'arrear',
          monthKey: item.monthKey,
          monthText: item.monthText,
          amount: apply,
          remaining: item.remaining,
        });
      }

      const room = rooms[rKey] || rooms[Number(roomNum)];

      const currentFullAmount = room && !room.vacant ? calcExpectedAmount(roomNum, room, config) : 0;
      const currentPaidAmount = Number(room?.manualPaidAmount || 0);
      const currentAmount = room && !room.vacant && !room.paid
        ? Math.max(0, currentFullAmount - currentPaidAmount)
        : 0;

      let appliedCurrent = 0;
      if (remainingPayment > 0 && currentAmount > 0 && room) {
        appliedCurrent = Math.min(remainingPayment, currentAmount);
        room.manualPaidAmount = (Number(room.manualPaidAmount) || 0) + appliedCurrent;
        room.manualPaidAt = new Date().toISOString();
        room.manualPaidAtText = thTime();

        const fullTotal = calcExpectedAmount(roomNum, room, config);

        if (room.manualPaidAmount >= fullTotal) {
          room.paid = true;
          room.manualRemaining = 0;
        } else {
          room.paid = false;
          room.manualRemaining = fullTotal - room.manualPaidAmount;
        }

        remainingPayment -= appliedCurrent;

        appliedItems.push({
          type: 'current',
          monthKey: billingMeta.billingMonthKey || getCurrentMonthKey(),
          monthText: billingMeta.billingMonthText || getCurrentMonthText(),
          amount: appliedCurrent,
          remaining: Math.max(0, fullTotal - (Number(room.manualPaidAmount) || 0)),
        });
      }
            const oldDebtAfter = getRoomArrearsTotal(arrears, roomNum);
      const currentAfter = room && !room.paid && !room.vacant
        ? Math.max(0, calcExpectedAmount(roomNum, room) - (Number(room.manualPaidAmount) || 0))
        : 0;

      return {
        appliedItems,
        appliedTotal: (Number(amount) || 0) - remainingPayment,
        change: remainingPayment,
        oldDebtAfter,
        currentAfter,
        remainingTotal: oldDebtAfter + currentAfter,
        currentAmount,
      };
    };

    // ===== GET =====
    if (request.method === 'GET') {
      const pin = await env.DB.get('pin');
      const auth = await checkAdminAuth();
      if (!auth.ok) {
        return jsonResponse({
          ok: false,
          authRequired: true,
          pinEnabled: !!pin,
          pinSet: !!pin,
        });
      }

      const [
        rooms,
        config,
        shopinfo,
        tenants,
        history,
        paymentHistory,
        expenses,
        logs,
        slipRefs,
        monthClosures,
        lockedMonths,
        lastCloseBackup,
        arrears,
        editHistory,
        monthlyArchiveIndex,
        r2BackupIndex,
        r2BackupStatus,
      ] = await Promise.all([
        env.DB.get('rooms'),
        env.DB.get('config'),
        env.DB.get('shopinfo'),
        env.DB.get('tenants'),
        env.DB.get('history'),
        env.DB.get('paymentHistory'),
        env.DB.get('expenses'),
        env.DB.get('logs'),
        env.DB.get('slipRefs'),
        env.DB.get('monthClosures'),
        env.DB.get('lockedMonths'),
        env.DB.get('lastCloseBackup'),
        env.DB.get('arrears'),
        env.DB.get('editHistory'),
        env.DB.get('monthlyArchiveIndex'),
        env.DB.get('r2BackupIndex'),
        env.DB.get('r2BackupStatus'),
      ]);

      const monthlyArchiveIndexObj = safeJsonParse(monthlyArchiveIndex, {});
      const monthlyArchives = {};
      try {
        const archiveKeys = Object.keys(monthlyArchiveIndexObj || {});
        const archiveValues = await Promise.all(
          archiveKeys.map(k => env.DB.get('monthlyArchive:' + k))
        );
        archiveKeys.forEach((k, idx) => {
          monthlyArchives[k] = safeJsonParse(archiveValues[idx], null);
        });
      } catch (_) {}

      const parsedMonthClosuresForCycle = safeJsonParse(monthClosures, {});
      const parsedLastCloseBackupForCycle = safeJsonParse(lastCloseBackup, null);
      const normalizedCycle = normalizeBillingCycleConfig(
        safeJsonParse(config, {}),
        parsedMonthClosuresForCycle,
        parsedLastCloseBackupForCycle
      );
      if (normalizedCycle.changed) {
        ctx.waitUntil(putKVJson('config', normalizedCycle.config));
        ctx.waitUntil(logEvent({ action: 'autoSyncBillingCycle', message: 'Billing cycle config auto-synced on GET', extra: { source: normalizedCycle.source, billingMeta: normalizedCycle.billingMeta } }));
      }

      return jsonResponse({
        rooms: safeJsonParse(rooms, {}),
        config: normalizedCycle.config,
        billingMeta: normalizedCycle.billingMeta,
        shopinfo: safeJsonParse(shopinfo, {}),
        tenants: safeJsonParse(tenants, {}),
        history: safeJsonParse(history, {}),
        paymentHistory: safeJsonParse(paymentHistory, []),
        expenses: safeJsonParse(expenses, []),
        pinEnabled: !!pin,
        logs: safeJsonParse(logs, []),
        slipRefs: safeJsonParse(slipRefs, {}),
        monthClosures: safeJsonParse(monthClosures, {}),
        lockedMonths: safeJsonParse(lockedMonths, {}),
        lastCloseBackup: safeJsonParse(lastCloseBackup, null),
        arrears: safeJsonParse(arrears, {}),
        editHistory: safeJsonParse(editHistory, []),
        monthlyArchiveIndex: monthlyArchiveIndexObj,
        monthlyArchives,
        r2BackupIndex: safeJsonParse(r2BackupIndex, []),
        r2BackupStatus: safeJsonParse(r2BackupStatus, {}),
      });
    }

    if (request.method !== 'POST') return textResponse('Method Not Allowed', 405);

    let rawBody = '';
    let body;
    try {
      rawBody = await request.text();
      body = safeJsonParse(rawBody, null);
      if (!body || typeof body !== 'object') throw new Error('Invalid JSON');
    } catch (_) { return textResponse('Bad Request', 400); }

    if (body.action === 'pinStatus') {
      const storedPin = await env.DB.get('pin');
      const lockState = await getPinLockState();
      return jsonResponse({
        ok: true,
        pinEnabled: !!storedPin,
        pinSet: !!storedPin,
        lock: lockState,
      });
    }

    if (body.action === 'verifyPin') {
      const storedPin = await env.DB.get('pin');
      const pinHash = String(body.pinHash || body.data || '');
      const lockState = await getPinLockState();

      if (lockState.locked) {
        return jsonResponse({
          ok: false,
          error: 'PIN locked',
          locked: true,
          lockedUntil: lockState.lockedUntil,
          remainingMs: lockState.remainingMs,
        }, 423);
      }

      if (!storedPin) return jsonResponse({ ok: false, pinEnabled: false, needSet: true }, 400);

      if (!/^[a-f0-9]{64}$/i.test(pinHash) || !timingSafeEqual(pinHash, storedPin)) {
        const nextLock = await recordPinFailure();
        await logEvent({ level: 'warn', action: 'verifyPin', message: nextLock.locked ? 'PIN verify failed: locked' : 'PIN verify failed', extra: { remainingAttempts: nextLock.remainingAttempts, locked: nextLock.locked, lockedUntil: nextLock.lockedUntil || '' } });
        return jsonResponse({
          ok: false,
          error: nextLock.locked ? 'PIN locked' : 'Invalid PIN',
          locked: nextLock.locked,
          lockedUntil: nextLock.lockedUntil || '',
          remainingMs: nextLock.remainingMs || 0,
          remainingAttempts: nextLock.remainingAttempts,
        }, nextLock.locked ? 423 : 401);
      }

      await resetPinLockState();
      const session = await createAdminSession();
      await logEvent({ action: 'verifyPin', message: 'Admin PIN verified' });
      return jsonResponse({ ok: true, token: session.token, expiresAt: session.expiresAt, remainingAttempts: PIN_MAX_FAILS });
    }

    if (body.action === 'emergencyUnlockPin') {
      const unlockKey = String(body.unlockKey || body.data || '').trim();

      if (!ADMIN_UNLOCK_KEY) {
        await logEvent({ level: 'error', action: 'emergencyUnlockPin', message: 'Missing ADMIN_UNLOCK_KEY secret' });
        return jsonResponse({ ok: false, error: 'ยังไม่ได้ตั้งค่า ADMIN_UNLOCK_KEY ใน Cloudflare Secret' }, 500);
      }

      if (!unlockKey || !timingSafeEqual(unlockKey, ADMIN_UNLOCK_KEY)) {
        await logEvent({ level: 'warn', action: 'emergencyUnlockPin', message: 'Emergency unlock failed: invalid key' });
        return jsonResponse({ ok: false, error: 'รหัสปลดล็อกฉุกเฉินไม่ถูกต้อง' }, 401);
      }

      await resetPinLockState();
      await logEvent({ action: 'emergencyUnlockPin', message: 'PIN lock cleared by emergency unlock key' });
      return jsonResponse({
        ok: true,
        unlocked: true,
        message: 'ปลดล็อก PIN แล้ว กรุณาใส่ PIN ปกติอีกครั้ง',
        lock: { failCount: 0, locked: false, lockedUntil: '', remainingMs: 0, remainingAttempts: PIN_MAX_FAILS },
      });
    }

    if (body.events) {
      const lineOk = await verifyLineSignature(rawBody);
      if (!lineOk) {
        await logEvent({ level: 'warn', action: 'lineSignature', message: 'Rejected LINE webhook: invalid signature' });
        return textResponse('Invalid LINE signature', 401);
      }
    } else {
      // savePin อนุญาตเฉพาะกรณีตั้ง PIN ครั้งแรก ถ้ามี PIN แล้วต้องผ่าน admin token
      if (body.action === 'savePin') {
        const currentPin = await env.DB.get('pin');
        if (currentPin) {
          const denied = await requireAdminAuth('savePin');
          if (denied) return denied;
        }
      } else {
        const denied = await requireAdminAuth(body.action || (body.userId && body.message ? 'pushLineFromWeb' : 'unknown'));
        if (denied) return denied;
      }
    }

    if (body.action === 'checkAdmin') {
      return jsonResponse({ ok: true });
    }

    // ===== Save actions =====
    if (body.action === 'save') {
      await putKVJson('rooms', body.data || {});
      return textResponse('OK');
    }

    if (body.action === 'saveConfig') {
      await putKVJson('config', sanitizeConfig(body.data || {}));
      return textResponse('OK');
    }

    if (body.action === 'saveShop') {
      await putKVJson('shopinfo', body.data || {});
      return textResponse('OK');
    }

    if (body.action === 'saveTenants') {
      await putKVJson('tenants', body.data || {});
      return textResponse('OK');
    }

    if (body.action === 'saveHistory') {
      await putKVJson('history', body.data || {});
      return textResponse('OK');
    }

    if (body.action === 'savePaymentHistory') {
      await putKVJson('paymentHistory', Array.isArray(body.data) ? body.data : []);
      return textResponse('OK');
    }

    if (body.action === 'saveExpenses') {
      await putKVJson('expenses', Array.isArray(body.data) ? body.data : []);
      return textResponse('OK');
    }

    if (body.action === 'savePin') {
      const pinHash = String(body.data || '');
      if (pinHash && !/^[a-f0-9]{64}$/i.test(pinHash)) {
        return jsonResponse({ ok: false, error: 'Invalid PIN hash' }, 400);
      }
      await env.DB.put('pin', pinHash);
      await resetPinLockState();
      const session = pinHash ? await createAdminSession() : null;
      await logEvent({ action: 'savePin', message: pinHash ? 'PIN saved' : 'PIN cleared by authenticated admin' });
      return jsonResponse({ ok: true, token: session?.token || '', expiresAt: session?.expiresAt || '' });
    }

    if (body.action === 'clearLogs') {
      await putKVJson('logs', []);
      return textResponse('OK');
    }

    if (body.action === 'saveMonthControl') {
      const data = body.data || {};

      if (data.monthClosures !== undefined) await putKVJson('monthClosures', data.monthClosures || {});
      if (data.lockedMonths !== undefined) await putKVJson('lockedMonths', data.lockedMonths || {});
      if (data.lastCloseBackup !== undefined) await putKVJson('lastCloseBackup', data.lastCloseBackup || null);
      if (data.arrears !== undefined) await putKVJson('arrears', data.arrears || {});

      try {
        const currentCfg = await getKVJson('config', {});
        const normalizedCycle = normalizeBillingCycleConfig(
          currentCfg,
          data.monthClosures || await getKVJson('monthClosures', {}),
          data.lastCloseBackup || await getKVJson('lastCloseBackup', null)
        );
        if (normalizedCycle.changed) {
          await putKVJson('config', normalizedCycle.config);
          await logEvent({ action: 'autoSyncBillingCycle', message: 'Billing cycle config synced from month control', extra: { source: normalizedCycle.source, billingMeta: normalizedCycle.billingMeta } });
        }
      } catch (_) {}

      if (data.rollbackInfo !== undefined) {
        await logEvent({
          action: 'rollbackMonthClose',
          message: 'Rollback latest month close completed',
          extra: data.rollbackInfo,
        });
      } else {
        await logEvent({
          action: 'saveMonthControl',
          message: 'Month control saved',
        });
      }

      return textResponse('OK');
    }


    if (body.action === 'createSafetyBackup') {
      try {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const backupId = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const reason = String(body.reason || 'manual');
        const backupKey = 'safetyBackup:' + backupId;

        const snap = await getBackupSnapshot({
          backupType: 'safety-kv',
          reason,
          billingMeta: body.billingMeta || {},
          createdFrom: body.createdFrom || 'web',
        });
        const backup = {
          ...snap.backup,
          backupId,
          backupKey,
          backupType: 'safety-kv',
        };

        await putKVJson(backupKey, backup);
        const backupIndex = await getKVJson('safetyBackupIndex', []);
        backupIndex.push({
          backupId,
          backupKey,
          reason,
          createdAt: backup.createdAt,
          createdAtText: backup.createdAtText,
          billingMeta: backup.billingMeta || {},
        });
        while (backupIndex.length > 30) {
          const old = backupIndex.shift();
          try { if (old && old.backupKey) await env.DB.delete(old.backupKey); } catch (_) {}
        }
        await putKVJson('safetyBackupIndex', backupIndex);

        const r2Backup = await autoBackupBeforeImportantAction(reason, backup.billingMeta || body.billingMeta || {});
        await logEvent({ action: 'createSafetyBackup', message: 'Safety backup created before important action', extra: { backupKey, reason, r2Backup } });
        return jsonResponse({ ok: true, backupId, backupKey, r2Backup });
      } catch (err) {
        await logEvent({ level: 'error', action: 'createSafetyBackup', message: err.message });
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }



    if (body.action === 'listR2Backups') {
      try {
        if (!env.RENTAL_R2 || typeof env.RENTAL_R2.list !== 'function') {
          return jsonResponse({ ok: false, error: 'ยังไม่ได้ผูก R2 Bucket Binding ชื่อ RENTAL_R2 กับ Worker' }, 500);
        }

        const prefix = String(body.prefix || 'backups/').trim();
        if (!prefix.startsWith('backups/')) {
          return jsonResponse({ ok: false, error: 'Invalid R2 prefix' }, 400);
        }

        const index = await getKVJson('r2BackupIndex', []);
        const byKey = new Map((Array.isArray(index) ? index : []).map(x => [x.objectKey || x.key, x]));
        const listed = await env.RENTAL_R2.list({ prefix, limit: 1000, include: ['customMetadata'] });
        const backups = (listed.objects || []).filter(obj => String(obj.key || '').endsWith('.json')).map(obj => {
          const meta = obj.customMetadata || {};
          const fromIndex = byKey.get(obj.key) || {};
          const createdAt = fromIndex.createdAt || meta.createdAt || (obj.uploaded ? new Date(obj.uploaded).toISOString() : '');
          const billingMeta = fromIndex.billingMeta || {
            billingMonthKey: meta.billingMonthKey || '',
            paymentMonthKey: meta.paymentMonthKey || '',
          };
          return {
            objectKey: obj.key,
            key: obj.key,
            size: obj.size || fromIndex.size || 0,
            etag: obj.etag || '',
            uploaded: obj.uploaded ? new Date(obj.uploaded).toISOString() : '',
            createdAt,
            createdAtText: fromIndex.createdAtText || (createdAt ? thTime(createdAt) : ''),
            backupId: fromIndex.backupId || meta.backupId || '',
            backupType: fromIndex.backupType || meta.backupType || 'manual-r2',
            reason: fromIndex.reason || meta.reason || '',
            billingMeta,
            billingMonthKey: billingMeta.billingMonthKey || meta.billingMonthKey || '',
            paymentMonthKey: billingMeta.paymentMonthKey || meta.paymentMonthKey || '',
          };
        }).sort((a, b) => new Date(b.createdAt || b.uploaded || 0).getTime() - new Date(a.createdAt || a.uploaded || 0).getTime());

        await logEvent({ action: 'listR2Backups', message: 'R2 backup list loaded', extra: { count: backups.length } });
        return jsonResponse({ ok: true, backups, truncated: !!listed.truncated, cursor: listed.cursor || '' });
      } catch (err) {
        await logEvent({ level: 'error', action: 'listR2Backups', message: err.message });
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (body.action === 'cleanupR2Backups') {
      try {
        const prefix = String(body.prefix || R2_AUTO_BACKUP_PREFIX).trim();
        if (!prefix.startsWith('backups/') || prefix.includes('..')) {
          return jsonResponse({ ok: false, error: 'Invalid R2 prefix' }, 400);
        }
        const retentionDays = Math.max(1, Math.min(3650, Number(body.retentionDays || R2_AUTO_BACKUP_RETENTION_DAYS)));
        const result = await cleanupOldR2Backups({ retentionDays, prefix });
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (err) {
        await logEvent({ level: 'error', action: 'cleanupR2Backups', message: err.message });
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (body.action === 'restoreFromR2') {
      try {
        if (!env.RENTAL_R2 || typeof env.RENTAL_R2.get !== 'function') {
          return jsonResponse({ ok: false, error: 'ยังไม่ได้ผูก R2 Bucket Binding ชื่อ RENTAL_R2 กับ Worker' }, 500);
        }

        const objectKey = String(body.objectKey || body.key || '').trim();
        if (!/^backups\/.+\.json$/i.test(objectKey) || objectKey.includes('..')) {
          return jsonResponse({ ok: false, error: 'Invalid R2 backup key' }, 400);
        }

        const obj = await env.RENTAL_R2.get(objectKey);
        if (!obj) return jsonResponse({ ok: false, error: 'ไม่พบไฟล์ Backup ใน R2' }, 404);

        const text = await obj.text();
        const data = safeJsonParse(text, null);
        if (!data) return jsonResponse({ ok: false, error: 'ไฟล์ Backup ใน R2 ไม่ใช่ JSON ที่ถูกต้อง' }, 400);

        const preRestoreBackup = await autoBackupBeforeImportantAction('before_restore_from_r2', body.billingMeta || {});
        const result = await restoreBackupDataToKV(data, 'r2:' + objectKey);
        await logEvent({ action: 'restoreFromR2', message: 'Restore from R2 completed', extra: { objectKey, preRestoreBackup, ...result } });
        return jsonResponse({ ok: true, objectKey, preRestoreBackup, ...result });
      } catch (err) {
        await logEvent({ level: 'error', action: 'restoreFromR2', message: err.message });
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (body.action === 'backupToR2') {
      try {
        const result = await createR2Backup({
          backupType: 'manual-r2',
          reason: String(body.reason || 'manual'),
          billingMeta: body.billingMeta || {},
          createdFrom: body.createdFrom || 'web',
        });
        if (!result.ok) return jsonResponse(result, 500);
        return jsonResponse(result);
      } catch (err) {
        await logEvent({ level: 'error', action: 'backupToR2', message: err.message });
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (body.action === 'saveMonthlyArchive') {
      const archive = body.data || {};
      const monthKey = String(archive.monthKey || '').trim();

      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
        return jsonResponse({ ok: false, error: 'Invalid monthKey' }, 400);
      }

      const key = 'monthlyArchive:' + monthKey;

      const normalizedArchive = {
        ...archive,
        savedAt: new Date().toISOString(),
        savedAtText: thTime(),
      };

      await putKVJson(key, normalizedArchive);

      const index = await getKVJson('monthlyArchiveIndex', {});
      index[monthKey] = {
        monthKey,
        monthText: archive.monthText || monthKey,
        billingMonthKey: archive.billingMonthKey || '',
        billingMonthText: archive.billingMonthText || '',
        paymentMonthKey: archive.paymentMonthKey || monthKey,
        paymentMonthText: archive.paymentMonthText || archive.monthText || monthKey,
        archivedAt: archive.archivedAt || new Date().toISOString(),
        archivedAtText: archive.archivedAtText || thTime(),
        unpaidCount: Number(archive.summary?.unpaidCount || 0),
        unpaidTotal: Number(archive.summary?.unpaidTotal || 0),
        paymentCount: Number(archive.summary?.paymentCount || 0),
        paidAmount: Number(archive.summary?.paidAmount || 0),
        savedAt: new Date().toISOString(),
        savedAtText: thTime(),
      };

      await putKVJson('monthlyArchiveIndex', index);

      await logEvent({
        action: 'saveMonthlyArchive',
        message: 'Monthly archive saved',
        extra: { monthKey, billingMonthKey: archive.billingMonthKey || '', paymentMonthKey: archive.paymentMonthKey || monthKey, summary: archive.summary || {} },
      });

      return jsonResponse({ ok: true, monthKey, monthlyArchiveIndex: index });
    }

    if (body.action === 'getMonthlyArchive') {
      const monthKey = String(body.monthKey || '').trim();

      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
        return jsonResponse({ ok: false, error: 'Invalid monthKey' }, 400);
      }

      const archive = await getKVJson('monthlyArchive:' + monthKey, null);

      if (!archive) {
        return jsonResponse({ ok: false, error: 'Monthly archive not found' }, 404);
      }

      return jsonResponse({ ok: true, archive });
    }
        if (body.action === 'saveEditHistory') {
      const item = body.data || {};

      const editHistory = await getKVJson('editHistory', []);

      editHistory.push({
        ...item,
        savedAt: new Date().toISOString(),
        savedAtText: thTime(),
      });

      while (editHistory.length > 500) {
        editHistory.shift();
      }

      await putKVJson('editHistory', editHistory);

      await logEvent({
        action: 'saveEditHistory',
        message: 'Room edit history saved',
        roomNum: item.roomNum || '',
        extra: {
          action: item.action || '',
          totalFull: item.totalFull || 0,
          totalDue: item.totalDue || 0,
        },
      });

      return jsonResponse({
        ok: true,
        count: editHistory.length,
      });
    }

    if (body.action === 'undoPaymentById') {
      const paymentId = String(body.paymentId || '').trim();

      if (!paymentId) {
        return jsonResponse({
          ok: false,
          error: 'Missing paymentId',
        }, 400);
      }

      const [rooms, arrears, paymentHistory, slipRefs] = await Promise.all([
        getKVJson('rooms', {}),
        getKVJson('arrears', {}),
        getKVJson('paymentHistory', []),
        getKVJson('slipRefs', {}),
      ]);

      if (!Array.isArray(paymentHistory) || paymentHistory.length === 0) {
        return jsonResponse({
          ok: false,
          error: 'No payment history',
        }, 400);
      }

      const index = paymentHistory.findIndex(p => String(p.id || '') === paymentId);

      if (index < 0) {
        return jsonResponse({
          ok: false,
          error: 'Payment not found',
        }, 404);
      }

      const targetPayment = paymentHistory[index];

      if (
        String(targetPayment.source || '').toLowerCase() === 'easyslip' ||
        String(targetPayment.source || '').toLowerCase() === 'slip2go' ||
        String(targetPayment.source || '').toLowerCase() === 'line' ||
        (targetPayment.ref && String(targetPayment.ref || '').trim() !== '-')
      ) {
        return jsonResponse({
          ok: false,
          error: 'รายการนี้มาจาก EasySlip/Slip2Go/LINE ไม่สามารถยกเลิกจากหน้าเว็บได้',
        }, 403);
      }

      const roomNum = String(targetPayment.roomNum || '').trim();

      if (!roomNum) {
        return jsonResponse({
          ok: false,
          error: 'Payment has no roomNum',
        }, 400);
      }

      const room = rooms[roomNum] || rooms[Number(roomNum)];
      const appliedItems = Array.isArray(targetPayment.appliedItems)
        ? targetPayment.appliedItems
        : [];

      await autoBackupBeforeImportantAction('before_undo_payment_by_id_room_' + roomNum, body.billingMeta || {});

      for (const item of appliedItems) {
        const amount = Number(item.amount || 0);
        if (amount <= 0) continue;

        if (item.type === 'arrear') {
          const list = arrears[roomNum] || [];

          const targetArrear = list.find(a =>
            String(a.monthKey || '') === String(item.monthKey || '') &&
            String(a.type || 'monthlyRent') === 'monthlyRent'
          );

          if (targetArrear) {
            targetArrear.paidAmount = Math.max(
              0,
              Number(targetArrear.paidAmount || 0) - amount
            );

            targetArrear.remaining = Math.min(
              Number(targetArrear.originalAmount || 0),
              Number(targetArrear.remaining || 0) + amount
            );

            if (targetArrear.remaining <= 0) {
              targetArrear.status = 'paid';
            } else if (targetArrear.paidAmount > 0) {
              targetArrear.status = 'partial';
            } else {
              targetArrear.status = 'unpaid';
            }

            targetArrear.lastUndoAt = new Date().toISOString();
            targetArrear.lastUndoAtText = thTime();
            targetArrear.lastUndoPaymentId = paymentId;
          }
        }

        if (item.type === 'current' && room) {
          room.manualPaidAmount = Math.max(
            0,
            Number(room.manualPaidAmount || 0) - amount
          );

          const fullTotal = calcExpectedAmount(roomNum, room, config);

          room.manualRemaining = Math.max(
            0,
            fullTotal - Number(room.manualPaidAmount || 0)
          );

          if (room.manualPaidAmount >= fullTotal && fullTotal > 0) {
            room.paid = true;
            room.manualRemaining = 0;
          } else {
            room.paid = false;
          }

          room.lastUndoAt = new Date().toISOString();
          room.lastUndoAtText = thTime();
          room.lastUndoPaymentId = paymentId;
        }
      }

      // กรณีรายการเก่าไม่มี appliedItems
      if (appliedItems.length === 0 && room) {
        const amount = Number(targetPayment.appliedTotal || targetPayment.amount || 0);

        room.manualPaidAmount = Math.max(
          0,
          Number(room.manualPaidAmount || 0) - amount
        );

        const fullTotal = calcExpectedAmount(roomNum, room, config);

        room.manualRemaining = Math.max(
          0,
          fullTotal - Number(room.manualPaidAmount || 0)
        );

        room.paid = room.manualPaidAmount >= fullTotal && fullTotal > 0;
        room.lastUndoAt = new Date().toISOString();
        room.lastUndoAtText = thTime();
        room.lastUndoPaymentId = paymentId;
      }

      const removed = paymentHistory.splice(index, 1)[0];

      await Promise.all([
        putKVJson('rooms', rooms),
        putKVJson('arrears', arrears),
        putKVJson('paymentHistory', paymentHistory),
        putKVJson('slipRefs', slipRefs),
      ]);

      await logEvent({
        action: 'undoPaymentById',
        message: 'Selected payment undone',
        roomNum,
        ref: removed?.ref || '',
        extra: {
          paymentId,
          removedPayment: removed,
        },
      });

      return jsonResponse({
        ok: true,
        roomNum,
        removedPayment: removed,
        remainingPaymentHistory: paymentHistory.length,
      });
    }

    if (body.action === 'undoLatestPayment') {
      const [rooms, arrears, paymentHistory, config, monthClosures, lastCloseBackup] = await Promise.all([
        getKVJson('rooms', {}),
        getKVJson('arrears', {}),
        getKVJson('paymentHistory', []),
        getKVJson('config', {}),
        getKVJson('monthClosures', {}),
        getKVJson('lastCloseBackup', null),
      ]);
      const normalizedCycle = normalizeBillingCycleConfig(config || {}, monthClosures || {}, lastCloseBackup || null);
      const billingMeta = normalizedCycle.billingMeta;
      if (normalizedCycle.changed) ctx.waitUntil(putKVJson('config', normalizedCycle.config));

      if (!Array.isArray(paymentHistory) || paymentHistory.length === 0) {
        return jsonResponse({
          ok: false,
          error: 'No payment history to undo',
        }, 400);
      }

      const latest = paymentHistory[paymentHistory.length - 1];
      const roomNum = String(latest.roomNum || '').trim();

      if (!roomNum) {
        return jsonResponse({
          ok: false,
          error: 'Latest payment has no roomNum',
        }, 400);
      }

      const room = rooms[roomNum] || rooms[Number(roomNum)];
      const appliedItems = Array.isArray(latest.appliedItems) ? latest.appliedItems : [];

      await autoBackupBeforeImportantAction('before_undo_latest_payment_room_' + roomNum, billingMeta || body.billingMeta || {});

      for (const item of appliedItems) {
        const amount = Number(item.amount || 0);
        if (amount <= 0) continue;

        if (item.type === 'arrear') {
          const list = arrears[roomNum] || [];

          const target = list.find(a =>
            String(a.monthKey || '') === String(item.monthKey || '') &&
            String(a.type || 'monthlyRent') === 'monthlyRent'
          );

          if (target) {
            target.paidAmount = Math.max(0, Number(target.paidAmount || 0) - amount);
            target.remaining = Math.min(
              Number(target.originalAmount || 0),
              Number(target.remaining || 0) + amount
            );

            if (target.remaining <= 0) {
              target.status = 'paid';
            } else if (target.paidAmount > 0) {
              target.status = 'partial';
            } else {
              target.status = 'unpaid';
            }

            target.lastUndoAt = new Date().toISOString();
            target.lastUndoAtText = thTime();
          }
        }
                if (item.type === 'current' && room) {
          room.manualPaidAmount = Math.max(0, Number(room.manualPaidAmount || 0) - amount);

          const fullTotal = calcExpectedAmount(roomNum, room, config);
          room.manualRemaining = Math.max(0, fullTotal - Number(room.manualPaidAmount || 0));

          if (room.manualPaidAmount >= fullTotal && fullTotal > 0) {
            room.paid = true;
            room.manualRemaining = 0;
          } else {
            room.paid = false;
          }

          room.lastUndoAt = new Date().toISOString();
          room.lastUndoAtText = thTime();
        }
      }

      if (appliedItems.length === 0 && room) {
        const amount = Number(latest.appliedTotal || latest.amount || 0);
        room.manualPaidAmount = Math.max(0, Number(room.manualPaidAmount || 0) - amount);

        const fullTotal = calcExpectedAmount(roomNum, room, config);
        room.manualRemaining = Math.max(0, fullTotal - Number(room.manualPaidAmount || 0));
        room.paid = room.manualPaidAmount >= fullTotal && fullTotal > 0;

        room.lastUndoAt = new Date().toISOString();
        room.lastUndoAtText = thTime();
      }

      const removed = paymentHistory.pop();

      await Promise.all([
        putKVJson('rooms', rooms),
        putKVJson('arrears', arrears),
        putKVJson('paymentHistory', paymentHistory),
      ]);

      await logEvent({
        action: 'undoLatestPayment',
        message: 'Latest payment undone',
        roomNum,
        extra: {
          removedPayment: removed,
        },
      });

      return jsonResponse({
        ok: true,
        roomNum,
        removedPayment: removed,
        remainingPaymentHistory: paymentHistory.length,
      });
    }

    if (body.action === 'manualPayment') {
      const roomNum = String(body.roomNum || '').trim();
      const amount = Number(body.amount || 0);
      const note = String(body.note || '');
      const method = String(body.method || 'manual');

      if (!roomNum || !Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
        return jsonResponse({ ok: false, error: 'Missing roomNum or invalid amount' }, 400);
      }

      if (!isValidRoomNum(roomNum)) {
        return jsonResponse({ ok: false, error: 'Invalid roomNum' }, 400);
      }

      const allowedManualMethods = ['manual', 'cash', 'offline_transfer', 'transfer_unverified', 'bank_transfer', 'transfer', 'other'];
      if (!allowedManualMethods.includes(method)) {
        return jsonResponse({ ok: false, error: 'Invalid payment method' }, 400);
      }

      const [rooms, arrears, paymentHistory, config] = await Promise.all([
        getKVJson('rooms', {}),
        getKVJson('arrears', {}),
        getKVJson('paymentHistory', []),
        getKVJson('config', {}),
      ]);
      const billingMeta = getBillingMetaFromConfig(sanitizeConfig(config || {}));

      if (isTestRoom(roomNum)) ensureTestRoomData(rooms, {}, {});

      const room = rooms[String(roomNum)] || rooms[Number(roomNum)];
      const oldDebtBefore = getRoomArrearsTotal(arrears, roomNum);
      const currentPaidBefore = Number(room?.manualPaidAmount || 0);
      const currentFullBefore = room && !room.vacant ? calcExpectedAmount(roomNum, room, config) : 0;
      const currentDueBefore = room && !room.vacant && !room.paid
        ? Math.max(0, currentFullBefore - currentPaidBefore)
        : 0;
      const totalDueBefore = oldDebtBefore + currentDueBefore;
      const amountMatchesDue = amount === totalDueBefore;
      const allowMismatch = body.allowMismatch === true;

      if (totalDueBefore <= 0) {
        return jsonResponse({
          ok: false,
          error: 'ห้องนี้ไม่มียอดคงเหลือ หรือชำระครบแล้ว',
          balanceBefore: { oldDebtBefore, currentDueBefore, totalDueBefore }
        }, 400);
      }

      if (!amountMatchesDue && !allowMismatch) {
        return jsonResponse({
          ok: false,
          error: 'ยอดรับชำระไม่ตรงกับยอดคงเหลือ กรุณายืนยันจากหน้าเว็บก่อนบันทึก',
          balanceBefore: { oldDebtBefore, currentDueBefore, totalDueBefore }
        }, 400);
      }

      await autoBackupBeforeImportantAction('before_manual_payment_room_' + roomNum, billingMeta || body.billingMeta || {});

      const result = applyPaymentToRoom({
        roomNum,
        amount,
        rooms,
        arrears,
        note: isTestRoom(roomNum) ? ('[TEST ROOM 99] ' + note).trim() : note,
        source: method,
        billingMeta,
        config,
      });

      let paymentRecord = {
        id: 'manual-' + Date.now() + '-room-' + roomNum,
        ref: '-',
        roomNum,
        amount,
        appliedTotal: result.appliedTotal,
        remainingTotal: result.remainingTotal,
        change: result.change,
        balanceBefore: { oldDebtBefore, currentDueBefore, totalDueBefore },
        amountMatchesDue,
        allowMismatch,
        appliedItems: result.appliedItems,
        method,
        note,
        month: billingMeta.billingMonthText,
        paidAt: new Date().toISOString(),
        paidAtText: thTime(),
        status: result.remainingTotal <= 0 ? 'paid' : 'partial',
        source: isTestRoom(roomNum) ? 'Manual TEST' : 'Manual',
      };

      if (isTestRoom(roomNum)) paymentRecord = markTestPaymentRecord(paymentRecord);

      let tenantNotify = { ok: false, skipped: true, reason: 'not_requested' };
      if (body.notifyTenant === true) {
        const userId = config?.userIds?.[roomNum] || config?.userIds?.[String(roomNum)] || config?.userIds?.[Number(roomNum)];
        if (!userId) {
          tenantNotify = { ok: false, skipped: true, reason: 'no_user_id', error: 'ห้องนี้ยังไม่มี LINE User ID' };
        } else {
          const statusText = result.remainingTotal <= 0 ? 'ชำระแล้ว' : 'รับชำระบางส่วน';
          const notifyText = result.remainingTotal <= 0
            ? `✅ อัปเดตสถานะการชำระแล้ว\n\nห้อง ${roomNum}\nรอบบิล ${billingMeta.billingMonthText || '-'}\nสถานะ: ชำระแล้ว\n\nเจ้าของตรวจสอบยอดและอัปเดตให้เรียบร้อยแล้ว`
            : `✅ อัปเดตยอดชำระแล้ว\n\nห้อง ${roomNum}\nรอบบิล ${billingMeta.billingMonthText || '-'}\nสถานะ: ${statusText}\nรับชำระแล้ว: ${Number(result.appliedTotal || amount || 0).toLocaleString('th-TH')} บาท\nยอดคงเหลือ: ${Number(result.remainingTotal || 0).toLocaleString('th-TH')} บาท\n\nเจ้าของตรวจสอบยอดและอัปเดตให้เรียบร้อยแล้ว`;
          tenantNotify = await pushLine(TOKEN, userId, notifyText);
        }
        paymentRecord.tenantNotify = tenantNotify;
      }

      paymentHistory.push(paymentRecord);
      while (paymentHistory.length > 1000) paymentHistory.shift();

      await Promise.all([
        putKVJson('rooms', rooms),
        putKVJson('arrears', arrears),
        putKVJson('paymentHistory', paymentHistory),
      ]);

      await logEvent({
        action: 'manualPayment',
        message: 'Manual payment applied',
        roomNum,
        extra: paymentRecord,
      });

      return jsonResponse({
        ok: true,
        ...result,
        paymentRecord,
        tenantNotify,
      });
    }

    if (body.action === 'setupTestRoom99') {
      const [rooms, tenants, config] = await Promise.all([
        getKVJson('rooms', {}),
        getKVJson('tenants', {}),
        getKVJson('config', {}),
      ]);

      const cfg = sanitizeConfig(config || {});
      ensureTestRoomData(rooms, tenants, cfg);

      await Promise.all([
        putKVJson('rooms', rooms),
        putKVJson('tenants', tenants),
        putKVJson('config', cfg),
      ]);

      await logEvent({ action: 'setupTestRoom99', message: 'Test room 99 setup from web app', roomNum: TEST_ROOM_KEY });

      return jsonResponse({ ok: true, roomNum: TEST_ROOM_KEY, room: rooms[TEST_ROOM_KEY] });
    }

    if (body.action === 'sendOwnerMessage') {
      try {
        const result = await pushLine(TOKEN, OWNER_ID, body.message || '');
        if (!result.ok) {
          await logEvent({ level: 'error', action: 'sendOwnerMessage', message: JSON.stringify(result) });
        }
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (err) {
        await logEvent({ level: 'error', action: 'sendOwnerMessage', message: err.message });
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    if (body.action === 'restoreBackup') {
      try {
        const data = body.data || {};
        const preRestoreBackup = await autoBackupBeforeImportantAction('before_restore_from_file', body.billingMeta || {});
        const result = await restoreBackupDataToKV(data, 'web-file');
        return jsonResponse({ ok: true, preRestoreBackup, ...result });
      } catch (err) {
        await logEvent({ level: 'error', action: 'restoreBackup', message: err.message });
        return jsonResponse({ ok: false, error: err.message }, 400);
      }
    }

    // ===== ส่งข้อความจากเว็บ =====
    if (body.userId && body.message && !body.events) {
      try {
        const result = await pushLine(TOKEN, body.userId, body.message);
        if (!result.ok) {
          await logEvent({ level: 'error', action: 'pushLineFromWeb', message: JSON.stringify(result) });
        }
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (err) {
        await logEvent({ level: 'error', action: 'pushLineFromWeb', message: err.message });
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // ===== LINE Webhook =====
    if (body.events) {
      ctx.waitUntil((async () => {
        for (const event of body.events) {
          try {
            const userId = event.source?.userId || '';

            // ===== รูปสลิป =====
            if (event.type === 'message' && event.message?.type === 'image') {
              await replyLine(TOKEN, event.replyToken, 'ได้รับข้อมูลแล้วครับ รอตรวจสอบสักครู่นะครับ 😊');

              const [configData, tenantsData, roomsData, paymentData, slipRefsData, arrearsData, monthClosuresData, lastCloseBackupData] = await Promise.all([
                env.DB.get('config'),
                env.DB.get('tenants'),
                env.DB.get('rooms'),
                env.DB.get('paymentHistory'),
                env.DB.get('slipRefs'),
                env.DB.get('arrears'),
                env.DB.get('monthClosures'),
                env.DB.get('lastCloseBackup'),
              ]);

              const normalizedCycle = normalizeBillingCycleConfig(
                safeJsonParse(configData, {}),
                safeJsonParse(monthClosuresData, {}),
                safeJsonParse(lastCloseBackupData, null)
              );
              const cfg = normalizedCycle.config;
              const billingMeta = normalizedCycle.billingMeta;
              if (normalizedCycle.changed) {
                ctx.waitUntil(putKVJson('config', normalizedCycle.config));
                ctx.waitUntil(logEvent({ action: 'autoSyncBillingCycle', message: 'Billing cycle config auto-synced before EasySlip payment', extra: { source: normalizedCycle.source, billingMeta } }));
              }
              const ten = safeJsonParse(tenantsData, {});
              const rms = safeJsonParse(roomsData, {});
              const paymentHistory = safeJsonParse(paymentData, []);
              const slipRefs = safeJsonParse(slipRefsData, {});
              const arrears = safeJsonParse(arrearsData, {});
              let roomNum = null;
              let roomInfo = describeUserRooms(cfg, ten, userId);

              let slipData = null;
              let slipCheckError = '';

              try {
                const imageRes = await fetch(
                  `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
                  { headers: { Authorization: 'Bearer ' + TOKEN } }
                );

                if (!imageRes.ok) throw new Error('LINE image fetch failed: ' + imageRes.status);

                const imageBuffer = await imageRes.arrayBuffer();
                const base64Image = 'data:image/jpeg;base64,' + arrayBufferToBase64(imageBuffer);

                try {
                  slipData = await verifySlipWithEasySlip(base64Image);
                } catch (e) {
                  slipCheckError = e.message;
                }
              } catch (e) {
                slipCheckError = e.message;
              }

              if (!slipData) {
                const msg =
                  '🧾 มีสลิปเข้ามาครับ' +
                  '\n🏠 ' + roomInfo +
                  '\n\n⚠️ ตรวจไม่ได้ กรุณาตรวจสอบด้วยตนเองครับ' +
                  (slipCheckError ? '\n\nสาเหตุ: ' + slipCheckError : '');

                await pushLine(TOKEN, OWNER_ID, msg);
                await logEvent({
                  level: 'error',
                  action: 'verifySlipFailed',
                  message: slipCheckError || 'EasySlip no data',
                  roomNum,
                });
                continue;
              }

              const slipAmount = Number(slipData.amount ?? 0);
              const sender = slipData.sender?.account?.name ?? '?';
              const receiver = slipData.receiver?.account?.name ?? '?';
              const ref = slipData.transRef ?? '-';
              const refKey = makeSlipKey(slipData);
              const dt = slipData.dateTime
                ? new Date(slipData.dateTime).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
                : '?';

              if (slipData.isDuplicate) {
                await pushLine(
                  TOKEN,
                  userId,
                  '⚠️ สลิปนี้เคยถูกตรวจแล้วครับ' +
                    '\n💰 ยอด: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                    '\n🔢 Ref: ' + ref +
                    '\n\nกรุณาติดต่อเจ้าของหอเพื่อตรวจสอบครับ'
                );

                await pushLine(
                  TOKEN,
                  OWNER_ID,
                  '⚠️ EasySlip แจ้งว่าสลิปนี้ซ้ำครับ' +
                    '\n🏠 ' + roomInfo +
                    '\n💰 ยอด: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                    '\n🔢 Ref: ' + ref +
                    '\n📅 ' + dt +
                    '\n\nระบบไม่ได้อัปเดตสถานะครับ'
                );

                await logEvent({
                  level: 'info',
                  action: 'easySlipDuplicate',
                  message: 'EasySlip duplicate slip ignored',
                  roomNum,
                  ref,
                  extra: { userId, slipAmount },
                });

                continue;
              }

              ensureTestRoomData(rms, ten, cfg);

              const matchRoom = chooseRoomByUserIdAndAmount({
                cfg,
                tenants: ten,
                rooms: rms,
                arrears,
                userId,
                amount: slipAmount,
              });

              if (!matchRoom.ok) {
                const listText = (matchRoom.candidates || []).map(c =>
                  'ห้อง ' + c.roomNum +
                  ' | ค้างรวม: ' + Number(c.totalDue || 0).toLocaleString('th-TH') + ' ฿' +
                  ' | เดือนนี้: ' + Number(c.currentDue || 0).toLocaleString('th-TH') + ' ฿' +
                  ' | ค้างเก่า: ' + Number(c.arrearsDue || 0).toLocaleString('th-TH') + ' ฿'
                ).join('\n');

                await pushLine(
                  TOKEN,
                  userId,
                  '✅ ตรวจสอบสลิปผ่านแล้วครับ' +
                    '\nแต่ระบบยังไม่สามารถเลือกห้องได้อัตโนมัติ' +
                    '\nกรุณารอเจ้าของตรวจสอบก่อนครับ'
                );

                await pushLine(
                  TOKEN,
                  OWNER_ID,
                  '⚠️ สลิปตรวจผ่าน แต่เลือกห้องไม่ได้อัตโนมัติ' +
                    '\nUSER ID นี้อาจผูกหลายห้อง หรือยอดเงินไม่ตรงชัดเจน' +
                    '\n\n💰 ยอดสลิป: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                    '\n✏️ ผู้โอน: ' + sender +
                    '\n➡️ ผู้รับ: ' + receiver +
                    '\n🔢 Ref: ' + ref +
                    '\n\nรายการห้องที่เป็นไปได้:' +
                    '\n' + (listText || '- ไม่พบห้อง -') +
                    '\n\nระบบยังไม่อัปเดตสถานะห้อง เพื่อกันลงผิดห้องครับ'
                );

                await logEvent({
                  level: 'error',
                  action: 'slipRoomMatchFailed',
                  message: matchRoom.reason,
                  roomNum: '',
                  ref,
                  extra: {
                    userId,
                    slipAmount,
                    candidates: matchRoom.candidates || [],
                  },
                });

                continue;
              }

              roomNum = matchRoom.roomNum;
              roomInfo = matchRoom.roomInfo;

              if (slipRefs[refKey]) {
                const used = slipRefs[refKey];

                await pushLine(
                  TOKEN,
                  userId,
                  '⚠️ สลิปนี้เคยถูกใช้แล้วครับ' +
                    '\n🏠 ใช้กับห้อง: ' + (used.roomNum || '-') +
                    '\n💰 ยอด: ' + (Number(used.amount) || 0).toLocaleString('th-TH') + ' ฿' +
                    '\n📅 เวลาที่บันทึก: ' + (used.usedAtText || used.usedAt || '-') +
                    '\n\nกรุณาติดต่อเจ้าของหอเพื่อตรวจสอบครับ'
                );

                await pushLine(
                  TOKEN,
                  OWNER_ID,
                  '⚠️ พบสลิปซ้ำครับ' +
                    '\n🏠 ผู้ส่งปัจจุบัน: ' + roomInfo +
                    '\n💰 ยอด: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                    '\n🔢 Ref: ' + ref +
                    '\n\nสลิปนี้เคยถูกใช้แล้ว' +
                    '\n🏠 ใช้กับห้อง: ' + (used.roomNum || '-') +
                    '\n💰 ยอดเดิม: ' + (Number(used.amount) || 0).toLocaleString('th-TH') + ' ฿' +
                    '\n📅 เวลาที่บันทึก: ' + (used.usedAtText || used.usedAt || '-') +
                    '\n\nระบบไม่ได้อัปเดตสถานะซ้ำครับ'
                );

                await logEvent({ level: 'info', action: 'duplicateSlip', message: 'Duplicate slip ignored', roomNum, ref });
                continue;
              }

              if (roomNum && rms[roomNum]) {
                const currentExpected = rms[roomNum].paid
                  ? 0
                  : Math.max(0, calcExpectedAmount(roomNum, rms[roomNum], cfg) - Number(rms[roomNum].manualPaidAmount || 0));

                const oldDebt = getRoomArrearsTotal(arrears, roomNum);
                const totalDue = oldDebt + currentExpected;

                await autoBackupBeforeImportantAction('before_slip_payment_room_' + roomNum, billingMeta || {});

                const applyResult = applyPaymentToRoom({
                  roomNum,
                  amount: slipAmount,
                  rooms: rms,
                  arrears,
                  note: 'ชำระผ่าน EasySlip',
                  source: 'EasySlip',
                  ref,
                  sender,
                  receiver,
                  billingMeta,
                  config: cfg,
                });

                slipRefs[refKey] = {
                  ref,
                  roomNum,
                  userId,
                  amount: slipAmount,
                  sender,
                  receiver,
                  slipDateTime: slipData.dateTime || '',
                  usedAt: new Date().toISOString(),
                  usedAtText: thTime(),
                };

                const status = applyResult.remainingTotal <= 0 ? 'verified' : 'partial';

                let paymentRecord = {
                  id: refKey,
                  ref,
                  roomNum,
                  userId,
                  amount: slipAmount,
                  expectedAmount: totalDue,
                  appliedTotal: applyResult.appliedTotal,
                  remainingTotal: applyResult.remainingTotal,
                  appliedItems: applyResult.appliedItems,
                  sender,
                  receiver,
                  month: billingMeta.billingMonthText,
                  slipDateTime: slipData.dateTime || '',
                  paidAt: new Date().toISOString(),
                  paidAtText: thTime(),
                  status,
                  source: isTestRoom(roomNum) ? 'EasySlip TEST' : 'EasySlip',
                };

                if (isTestRoom(roomNum)) paymentRecord = markTestPaymentRecord(paymentRecord);

                paymentHistory.push(paymentRecord);

                while (paymentHistory.length > 1000) paymentHistory.shift();

                await Promise.all([
                  putKVJson('rooms', rms),
                  putKVJson('arrears', arrears),
                  putKVJson('slipRefs', slipRefs),
                  putKVJson('paymentHistory', paymentHistory),
                ]);

                if (isTestRoom(roomNum)) {
                  await pushLine(
                    TOKEN,
                    OWNER_ID,
                    '🧪 [EasySlip TEST ห้อง 99]' +
                      '\nตรวจสลิปผ่านและบันทึกยอดทดสอบแล้ว' +
                      '\n✏️ ผู้โอน: ' + sender +
                      '\n➡️ ผู้รับ: ' + receiver +
                      '\n💰 ยอด: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                      '\n💰 ยอดที่ต้องชำระ: ' + totalDue.toLocaleString('th-TH') + ' ฿' +
                      '\n💰 คงเหลือหลังตัดยอด: ' + applyResult.remainingTotal.toLocaleString('th-TH') + ' ฿' +
                      '\n📅 ' + dt +
                      '\n🔢 Ref: ' + ref +
                      '\n\nรายการนี้เป็นรายการทดสอบ ไม่ควรนับรวมรายได้จริง'
                  );

                  await logEvent({
                    action: 'verifiedSlipTestRoom99',
                    message: 'Test room 99 slip payment applied',
                    roomNum,
                    ref,
                    extra: applyResult,
                  });

                  continue;
                }

                if (status === 'verified') {
                  await pushLine(
                    TOKEN,
                    userId,
                    '✅ ตรวจสอบสลิปเรียบร้อยครับ' +
                      '\n🏠 ' + roomInfo +
                      '\n📅 รอบบิล: ' + billingMeta.billingMonthText +
                      '\n💰 ยอดชำระ: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                      '\nสถานะห้องของคุณถูกอัปเดตเป็น “ชำระแล้ว” แล้วครับ 😊'
                  );

                  await pushLine(
                    TOKEN,
                    OWNER_ID,
                    '✅ สลิปถูกต้อง! อัปเดตสถานะแล้วครับ' +
                      '\n🏠 ' + roomInfo +
                      '\n✏️ ผู้โอน: ' + sender +
                      '\n💰 ยอด: ' + slipAmount.toLocaleString('th-TH') +
                      ' ฿ (ยอดที่ต้องชำระ ' + totalDue.toLocaleString('th-TH') + ' ฿)' +
                      '\n📅 ' + dt +
                      '\n🔢 Ref: ' + ref
                  );
                } else {
                  await pushLine(
                    TOKEN,
                    userId,
                    '✅ ได้รับสลิปและบันทึกยอดชำระแล้วครับ' +
                      '\n🏠 ' + roomInfo +
                      '\n📅 รอบบิล: ' + billingMeta.billingMonthText +
                      '\n💰 ยอดที่ชำระ: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                      '\n⚠️ ยอดคงเหลือ: ' + applyResult.remainingTotal.toLocaleString('th-TH') + ' ฿' +
                      '\nกรุณาชำระยอดคงเหลือภายหลังครับ'
                  );

                  await pushLine(
                    TOKEN,
                    OWNER_ID,
                    '⚠️ รับชำระบางส่วนครับ' +
                      '\n🏠 ' + roomInfo +
                      '\n✏️ ผู้โอน: ' + sender +
                      '\n💰 ยอดที่โอน: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                      '\n💰 ยอดที่ต้องชำระทั้งหมด: ' + totalDue.toLocaleString('th-TH') + ' ฿' +
                      '\n💰 คงเหลือ: ' + applyResult.remainingTotal.toLocaleString('th-TH') + ' ฿' +
                      '\n📅 ' + dt +
                      '\n🔢 Ref: ' + ref
                  );
                }

                await logEvent({
                  action: status === 'verified' ? 'verifiedSlip' : 'partialSlipPayment',
                  message: 'EasySlip payment applied',
                  roomNum,
                  ref,
                  extra: applyResult,
                });
              } else {
                await pushLine(
                  TOKEN,
                  OWNER_ID,
                  '🧾 ตรวจสลิปสำเร็จครับ' +
                    '\n🏠 ' + roomInfo +
                    '\n✏️ ผู้โอน: ' + sender +
                    '\n➡️ ผู้รับ: ' + receiver +
                    '\n💰 ยอด: ' + slipAmount.toLocaleString('th-TH') + ' ฿' +
                    '\n📅 ' + dt +
                    '\n🔢 Ref: ' + ref +
                    '\n\nกรุณาตรวจสอบและกดชำระในโปรแกรมด้วยครับ'
                );

                await logEvent({
                  level: 'info',
                  action: 'verifiedSlipUnknownRoom',
                  message: 'Slip verified but room not found',
                  roomNum,
                  ref,
                });
              }

              continue;
            }

            // ===== ข้อความ / สติ๊กเกอร์ =====
            if (
              event.type === 'message' &&
              (event.message?.type === 'text' || event.message?.type === 'sticker')
            ) {
              const text = event.message?.text || '';
              const normalized = text.trim().replace(/\s+/g, '');

              // ลงทะเบียนได้เฉพาะคำสั่งที่มีเจตนาชัดเจนเท่านั้น
              // ไม่รับข้อความสั้น ๆ แบบ "ห้อง12" เพื่อกันผู้เช่าคุยถึงห้องอื่นแล้ว User ID ย้ายผิดห้อง
              const matchRoom = normalized.match(
                /^(?:สมัคร|สมัครห้อง|ลงทะเบียน|ลงทะเบียนห้อง|ยืนยัน|ยืนยันห้อง)(\d{1,3})$/i
              );

              if (matchRoom) {
                const roomNum = String(parseInt(matchRoom[1], 10));

                if (isValidRoomNum(roomNum)) {
                  const cfg = sanitizeConfig(await getKVJson('config', {}));
                  const ten = await getKVJson('tenants', {});
                  const rms = await getKVJson('rooms', {});

                  if (!cfg.userIds) cfg.userIds = {};

                  if (isTestRoom(roomNum)) {
                    cfg.userIds[roomNum] = userId;
                    ensureTestRoomData(rms, ten, cfg);
                    await Promise.all([
                      putKVJson('config', cfg),
                      putKVJson('tenants', ten),
                      putKVJson('rooms', rms),
                    ]);

                    await replyLine(
                      TOKEN,
                      event.replyToken,
                      '✅ ลงทะเบียนห้องทดสอบ 99 สำเร็จครับ 🧪\nข้อความ LINE ของห้องทดสอบจะส่งเข้าเจ้าของ'
                    );

                    await pushLine(
                      TOKEN,
                      OWNER_ID,
                      'ผู้เช่าลงทะเบียนห้องทดสอบ 99 เรียบร้อยแล้ว' +
                        '\n🔑 User ID: ' + userId
                    );

                    await logEvent({
                      action: 'registerTestRoom99',
                      message: 'Test room 99 registered',
                      roomNum,
                      extra: { userId },
                    });
                    continue;
                  }

                  cfg.userIds[roomNum] = userId;
                  await putKVJson('config', cfg);

                  await replyLine(TOKEN, event.replyToken, '✅ ลงทะเบียนห้อง ' + roomNum + ' เรียบร้อยแล้วครับ 😊');

                  await pushLine(
                    TOKEN,
                    OWNER_ID,
                    'ผู้เช่าลงทะเบียนห้อง ' + roomNum + ' เรียบร้อยแล้ว' +
                      '\n🔑 User ID: ' + userId
                  );

                  await logEvent({
                    action: 'registerRoom',
                    message: 'Tenant registered room',
                    roomNum,
                    extra: { userId },
                  });
                  continue;
                }

                await replyLine(TOKEN, event.replyToken, 'ไม่พบเลขห้องนี้ครับ กรุณาระบุห้อง 1-30 หรือห้อง 99 สำหรับทดสอบ');
                continue;
              }

              // ข้อความทั่วไป/สติ๊กเกอร์ทั่วไป: เงียบทั้งหมด
              // ไม่ตอบผู้เช่า ไม่แจ้งเจ้าของ และไม่บันทึก/ไม่ย้าย User ID
              continue;
            }
          } catch (err) {
            await logEvent({
              level: 'error',
              action: 'webhookEventError',
              message: err.stack || err.message,
            });

            try { await pushLine(TOKEN, OWNER_ID, '⚠️ Worker error: ' + err.message); } catch (_) {}
          }
        }
      })());

      return textResponse('OK');
    }

    return textResponse('Not Found', 404);
  },
    async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoRentReminder(env));
  },
};

// ===== Cron แจ้งเตือนอัตโนมัติ =====
async function runAutoRentReminder(env) {
  const TOKEN = env.LINE_TOKEN;
  const OWNER_ID = env.OWNER_ID;

  const safeJsonParse = (text, fallback) => {
    try { return text ? JSON.parse(text) : fallback; }
    catch (_) { return fallback; }
  };

  const thTime = (d = new Date()) =>
    new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

  const todayBangkok = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })
  );

  const day = todayBangkok.getDate();

  const pushLine = async (to, text) => {
    if (!TOKEN || !to || !text) return { ok: false, error: 'Missing token/to/text' };

    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + TOKEN,
      },
      body: JSON.stringify({
        to,
        messages: [{ type: 'text', text }],
      }),
    });

    let result = {};
    try { result = await res.json(); } catch (_) {}

    return { ok: res.ok, status: res.status, result };
  };

  const getKVJson = async (key, fallback) =>
    safeJsonParse(await env.DB.get(key), fallback);

  const putKVJson = async (key, data) =>
    env.DB.put(key, JSON.stringify(data));

  const logEvent = async ({
    level = 'info',
    action = 'autoReminder',
    message = '',
    roomNum = '',
    extra = {},
  }) => {
    try {
      const logs = await getKVJson('logs', []);
      logs.push({
        time: new Date().toISOString(),
        timeText: thTime(),
        level,
        action,
        message: String(message || ''),
        roomNum,
        extra,
      });
      while (logs.length > 200) logs.shift();
      await putKVJson('logs', logs);
    } catch (_) {}
  };

  const normalizeRoomSettingsMap = (input = {}) => {
    const out = {};
    const entries = Array.isArray(input) ? input.map(row => [row.room || row.roomNum, row]) : Object.entries(input || {});
    for (const [key, rowRaw] of entries) {
      const row = rowRaw || {};
      const room = parseInt(row.room || row.roomNum || key, 10);
      if (!Number.isFinite(room) || room <= 0 || String(room) === '99') continue;
      const status = ['active','vacant','disabled'].includes(String(row.status || '').trim()) ? String(row.status).trim() : 'active';
      out[String(room)] = { room, rent: Math.max(0, Number(row.rent ?? (room <= 20 ? 2500 : 3000)) || 0), trash: Math.max(0, Number(row.trash ?? 50) || 0), status, note: String(row.note || '').trim() };
    }
    return out;
  };

  const getRoomSetting = (roomNum) => normalizeRoomSettingsMap(config?.roomSettings || {})[String(parseInt(roomNum, 10))] || null;

  const getRoomRentValue = (roomNum, roomData = {}) => {
    const r = parseInt(roomNum, 10);
    const setting = getRoomSetting(roomNum);
    return Number(roomData.prorateRent ?? roomData.rent ?? setting?.rent ?? (r <= 20 ? 2500 : 3000)) || 0;
  };

  const getRoomTrashValue = (roomNum, roomData = {}) => {
    if (String(roomNum) === '99') return 0;
    const setting = getRoomSetting(roomNum);
    return Number(roomData.trash !== undefined ? roomData.trash : (setting?.trash !== undefined ? setting.trash : 50)) || 0;
  };

  const calcTotal = (roomNum, d) => {
    const elec = ((Number(d.ec) || 0) - (Number(d.ep) || 0)) * 8;
    const water = ((Number(d.wc) || 0) - (Number(d.wp) || 0)) * 35;
    const rent = getRoomRentValue(roomNum, d);
    const trash = getRoomTrashValue(roomNum, d);
    return rent + elec + water + trash + (Number(d.wifi) || 0);
  };

  const getMonthTextFromKey = (monthKey) => {
    const [yr, mo] = String(monthKey || '').split('-').map(Number);
    const thMonths = ['','มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
    if (!yr || !mo || !thMonths[mo]) return monthKey || '-';
    return thMonths[mo] + ' ' + (yr + 543);
  };

  const shiftMonthKeyForReminder = (monthKey, delta) => {
    const [yr, mo] = String(monthKey || '').split('-').map(Number);
    if (!yr || !mo) return '';
    const d = new Date(yr, mo - 1 + Number(delta || 0), 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  };

  const getMonthText = () => {
    // ใช้รอบบิลจาก KV config ก่อน เพื่อให้แจ้งเตือนอัตโนมัติตรงกับรอบที่เปิดไว้จริง
    const fallbackPaymentKey = todayBangkok.getFullYear() + '-' + String(todayBangkok.getMonth() + 1).padStart(2, '0');
    const paymentKey = config?.currentPaymentMonthKey || fallbackPaymentKey;
    const billingKey = config?.currentBillingMonthKey || shiftMonthKeyForReminder(paymentKey, -1);
    return config?.currentBillingMonthText || getMonthTextFromKey(billingKey);
  };

  const getDateText = () => {
    return todayBangkok.toLocaleDateString('th-TH', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  const getRoomArrearsTotal = (arrears, roomNum) => {
    const list = arrears?.[String(roomNum)] || [];
    return list.reduce((sum, a) => sum + Math.max(0, Number(a.remaining) || 0), 0);
  };

  const [rooms, configRaw, tenants, arrears] = await Promise.all([
    getKVJson('rooms', {}),
    getKVJson('config', {}),
    getKVJson('tenants', {}),
    getKVJson('arrears', {}),
  ]);

  const config = {
    ...configRaw,
    userIds: configRaw.userIds || {},
    mutedRooms: configRaw.mutedRooms || {},
    reminderMuteRooms: configRaw.reminderMuteRooms || {},
    reminderDays: configRaw.reminderDays || [5, 10, 15, 20, 25],
    roomSettings: normalizeRoomSettingsMap(configRaw.roomSettings || {}),
  };

  const reminderDays = config.reminderDays || [5, 10, 15, 20, 25];

  if (!reminderDays.includes(day)) {
    await logEvent({
      action: 'autoReminderSkipped',
      message: 'Today is not reminder day: ' + day,
    });
    return;
  }

  let sent = 0;
  let failed = 0;
  let skippedPaid = 0;
  let skippedMuted = 0;
  let skippedUntilDay = 0;
  let skippedNoUserId = 0;
  let totalAmount = 0;
  const sentRooms = [];

  const reminderRoomNums = Array.from(new Set([
    ...Array.from({length: 30}, (_, idx) => idx + 1),
    ...Object.keys(rooms || {}).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0 && n !== 99),
    ...Object.keys(config.roomSettings || {}).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0 && n !== 99),
  ])).sort((a,b)=>a-b).filter(n => (config.roomSettings?.[String(n)]?.status || 'active') !== 'disabled');

  for (const i of reminderRoomNums) {
    const room = rooms[i] || rooms[String(i)];
    if (!room) continue;
    if (room.vacant) continue;

    const oldDebt = getRoomArrearsTotal(arrears, i);
    const currentDue = room.paid
      ? 0
      : Math.max(0, calcTotal(i, room) - Number(room.manualPaidAmount || 0));

    const totalDue = oldDebt + currentDue;

    if (totalDue <= 0) {
      skippedPaid++;
      continue;
    }

    if (config.mutedRooms && (config.mutedRooms[i] || config.mutedRooms[String(i)])) {
      skippedMuted++;
      continue;
    }

    const muteInfo = config.reminderMuteRooms?.[i] || config.reminderMuteRooms?.[String(i)];
    const muteUntilDay = Number(muteInfo?.untilDay || 0);
    if (muteUntilDay && day < muteUntilDay) {
      skippedUntilDay++;
      await logEvent({
        action: 'autoReminderSkippedUntilDay',
        message: 'Room muted until day ' + muteUntilDay,
        roomNum: String(i),
        extra: { muteUntilDay, note: muteInfo?.note || '' },
      });
      continue;
    }

    const userId = config.userIds?.[i] || config.userIds?.[String(i)];

    if (!userId) {
      skippedNoUserId++;
      continue;
    }

    totalAmount += totalDue;

    const tenantName = tenants[i]?.name || tenants[String(i)]?.name || '';

    const elecUnit = (Number(room.ec) || 0) - (Number(room.ep) || 0);
    const waterUnit = (Number(room.wc) || 0) - (Number(room.wp) || 0);
    const elecAmt = elecUnit * 8;
    const waterAmt = waterUnit * 35;
    const rent = getRoomRentValue(i, room);
    const trash = getRoomTrashValue(i, room);
    const wifi = Number(room.wifi) || 0;

    const message =
`ระบบอัตโนมัติ
🔔 แจ้งเตือนค่าเช่า — ห้อง ${i}
${tenantName ? `👤 ${tenantName}\n` : ''}📅 รอบบิล ${getMonthText()}
🗓️ วันที่แจ้ง ${getDateText()}
━━━━━━━━━━━━━━
${oldDebt ? `📌 ยอดค้างเก่า: ${oldDebt.toLocaleString('th-TH')}฿\n` : ''}${currentDue ? `⚡ ค่าไฟ: ${room.ep} → ${room.ec} (${elecUnit} หน่วย × 8฿) = ${elecAmt.toLocaleString('th-TH')}฿
💧 ค่าน้ำ: ${room.wp} → ${room.wc} (${waterUnit} หน่วย × 35฿) = ${waterAmt.toLocaleString('th-TH')}฿
🏠 ค่าเช่า: ${rent.toLocaleString('th-TH')}฿
🗑️ ค่าขยะ: ${trash.toLocaleString('th-TH')}฿
${wifi ? `📶 WiFi: ${wifi.toLocaleString('th-TH')}฿\n` : ''}` : ''}━━━━━━━━━━━━━━
💰 รวมต้องชำระทั้งหมด: ${totalDue.toLocaleString('th-TH')}฿
━━━━━━━━━━━━━━
🏦 โอนเข้า บัญชี ttb 919-7-253892
นายบุญรัตน์ ชลา
ส่งสลิปที่ไลน์นี้นะครับ`;

    try {
      const result = await pushLine(userId, message);

      if (result.ok) {
        sent++;
        sentRooms.push(`ห้อง ${i}: ${totalDue.toLocaleString('th-TH')}฿`);

        await logEvent({
          action: 'autoReminderSent',
          message: 'Auto reminder sent',
          roomNum: String(i),
          extra: { amount: totalDue },
        });
      } else {
        failed++;
        await logEvent({
          level: 'error',
          action: 'autoReminderFailed',
          message: JSON.stringify(result),
          roomNum: String(i),
        });
      }
    } catch (err) {
      failed++;
      await logEvent({
        level: 'error',
        action: 'autoReminderError',
        message: err.message,
        roomNum: String(i),
      });
    }
  }

  const ownerSummary =
`📋 สรุปแจ้งเตือนอัตโนมัติ
วันที่ ${getDateText()}
รอบบิล ${getMonthText()}

✅ ส่งสำเร็จ: ${sent} ห้อง
❌ ส่งไม่สำเร็จ: ${failed} ห้อง
✓ ไม่มีหนี้/ชำระแล้ว ข้าม: ${skippedPaid} ห้อง
🔕 งดแจ้งถาวร ข้าม: ${skippedMuted} ห้อง
⏸️ งดถึงวันที่ ข้าม: ${skippedUntilDay} ห้อง
⚠️ ไม่มี User ID: ${skippedNoUserId} ห้อง

💰 ยอดค้างที่แจ้งรวม: ${totalAmount.toLocaleString('th-TH')}฿
${sentRooms.length ? '\n━━━━━━━━━━━━━━\n' + sentRooms.join('\n') : ''}`;

  await pushLine(OWNER_ID, ownerSummary);

  await logEvent({
    action: 'autoReminderSummary',
    message: 'Auto reminder completed',
    extra: {
      sent,
      failed,
      skippedPaid,
      skippedMuted,
      skippedUntilDay,
      skippedNoUserId,
      totalAmount,
    },
  });
}