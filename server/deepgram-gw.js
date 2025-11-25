// deepgram-gw.js (NEXT: dual-port, strict diarization, rooms per exten, metrics, reconnect)
// - Receives RTP slin16@16kHz on two fixed UDP ports:
//     RTP_PORT_IN  => dir=in (Caller)
//     RTP_PORT_OUT => dir=out (Agent)
// - /register injects context (uuid, exten, caller, callername) per call.
// - Sessions keyed by SSRC, dir is fixed by port (no mixing / no heuristics).
// - One Deepgram WS per SSRC.
// - Broadcasts transcripts to Socket.IO room = exten.
// - Emits "call-start" on /register so widget can auto-clear.
// - Prometheus metrics at /metrics
// - WS reconnect with exponential backoff + jitter
// - DG_MAX_SESSIONS limit (from env)

const dgram     = require('dgram');
const WebSocket = require('ws');
const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const fs        = require('fs');
const prom      = require('prom-client');

// === ENV ===
const DG_KEY       = process.env.DEEPGRAM_API_KEY;
const DG_LANG      = process.env.DG_LANGUAGE || 'es';
const DG_INTERIM   = (process.env.DG_INTERIM || 'true') === 'true';
const DG_PUNCT     = (process.env.DG_PUNCTUATE || 'true') === 'true';
const DG_SMART     = (process.env.DG_SMART_FORMAT || 'true') === 'true';
const DG_DIARIZE   = (process.env.DG_DIARIZE || 'false') === 'true';

const WIDGET_PORT  = Number(process.env.WIDGET_PORT || 8080);

const RTP_PORT_IN  = Number(process.env.RTP_PORT_IN  || 40000);
const RTP_PORT_OUT = Number(process.env.RTP_PORT_OUT || 40001);

const DG_MAX_SESSIONS = Number(process.env.DG_MAX_SESSIONS || 3);

const SWAP_ENDIAN  = (process.env.SWAP_ENDIAN || '0') === '1';
const DUMP_WAV     = (process.env.DUMP_WAV || '0') === '1';

if (!DG_KEY) {
  console.error('[DG-GW] ❌ Missing DEEPGRAM_API_KEY');
  process.exit(1);
}

// =======================================================
// Prometheus metrics
// =======================================================
const register = prom.register;
prom.collectDefaultMetrics({ register });

const gSessions = new prom.Gauge({
  name: 'dg_sessions_active',
  help: 'Active RTP->Deepgram sessions',
  registers: [register]
});

const cRtpPackets = new prom.Counter({
  name: 'dg_rtp_packets_total',
  help: 'Total RTP packets received',
  labelNames: ['dir'],
  registers: [register]
});

const cWsReconnects = new prom.Counter({
  name: 'dg_ws_reconnects_total',
  help: 'Total Deepgram WS reconnect attempts',
  registers: [register]
});

const cZeroPcmFrames = new prom.Counter({
  name: 'dg_zero_frames_total',
  help: 'Zero PCM frames (all samples are 0)',
  labelNames: ['dir'],
  registers: [register]
});

// =======================================================
// Web + Socket.IO (widget)
// =======================================================
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static('public'));

httpServer.listen(WIDGET_PORT, () => {
  console.log(`[DG-GW] Web server on :${WIDGET_PORT}`);
});

io.on('connection', (s) => {
  // retrocompat: widget sends query.uuid = room name (exten)
  const { uuid } = s.handshake.query;
  if (uuid) s.join(uuid);
  console.log(`[Widget] socket conectado room=${uuid || '(sin room)'}`);
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// =======================================================
// Signaling: /register from TAP
// =======================================================

// uuid -> { exten, caller, callername, lastTs }
const ctxByUuid = new Map();

// pending per dir, to bind next SSRC on that dir to uuid
const pendingByDir = { in: [], out: [] };
const PENDING_TTL_MS = 4000;

function pushPending(dir, uuid) {
  if (!(dir === 'in' || dir === 'out')) return;
  const now = Date.now();
  pendingByDir[dir].push({ uuid, ts: now });
  pendingByDir[dir] = pendingByDir[dir].filter(x => now - x.ts < PENDING_TTL_MS);
}

function popPending(dir) {
  if (!(dir === 'in' || dir === 'out')) return null;
  const now = Date.now();
  pendingByDir[dir] = pendingByDir[dir].filter(x => now - x.ts < PENDING_TTL_MS);
  return pendingByDir[dir].shift() || null;
}

app.get('/register', (req, res) => {
  const { uuid, exten, caller, callername, dir } = req.query;
  if (!uuid) return res.status(400).send('missing uuid');

  const isNew = !ctxByUuid.has(uuid);

  let ctx = ctxByUuid.get(uuid);
  if (!ctx) {
    ctx = {
      uuid,
      exten: exten || 'mix',
      caller: caller || '',
      callername: callername || '',
      lastTs: Date.now()
    };
    ctxByUuid.set(uuid, ctx);
  } else {
    if (exten) ctx.exten = exten;
    if (caller) ctx.caller = caller;
    if (callername) ctx.callername = callername;
    ctx.lastTs = Date.now();
  }

  if (dir === 'in' || dir === 'out') pushPending(dir, uuid);

  // Emit call-start so widget can auto-clear on new call
  if (isNew || req.query.force_start === '1') {
    io.to(ctx.exten).emit('call-start', {
      uuid,
      exten: ctx.exten,
      caller: ctx.caller,
      callername: ctx.callername,
      ts: Date.now()
    });
  }

  console.log(`[DG-GW] register uuid=${uuid} exten=${ctx.exten} caller=${ctx.caller} dir=${dir}`);
  res.send('OK');
});

app.get('/unregister', (req, res) => {
  const { uuid } = req.query;
  if (uuid && ctxByUuid.has(uuid)) {
    ctxByUuid.delete(uuid);
    console.log(`[DG-GW] unregister uuid=${uuid}`);
  }
  res.send('OK');
});

// =======================================================
// Deepgram WS + reconnect/backoff
// =======================================================
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS  = 8000;

function nextBackoffMs(attempt) {
  const ms = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** attempt));
  const jitter = Math.floor(Math.random() * 200);
  return ms + jitter;
}

function dgConnect(sampleRate = 16000, lang = DG_LANG) {
  const qs = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    interim_results: String(DG_INTERIM),
    punctuate: String(DG_PUNCT),
    smart_format: String(DG_SMART),
    diarize: String(DG_DIARIZE),
    language: lang
  }).toString();

  const url = `wss://api.deepgram.com/v1/listen?${qs}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${DG_KEY}` } });

  ws.on('open', () => {
    const s = ws._tapSess;
    console.log(`[DG] WS open ssrc=${s?.ssrc} uuid=${s?.uuid} dir=${s?.dir} room=${s?.room}`);
    if (s?.boot?.length) {
      for (const chunk of s.boot) ws.send(chunk, { binary: true });
      s.boot.length = 0;
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'Results' && msg.channel?.alternatives?.length) {
      const alt = msg.channel.alternatives[0];
      const s = ws._tapSess;

      const text = alt.transcript || '';
      if (!text) return;

      const speaker =
        (s?.dir === 'in')
          ? (s.callername || s.caller || 'Caller')
          : (s?.exten || 'Agent');

      io.to(s.room).emit('stt', {
        text,
        isFinal: !!msg.is_final,
        words: alt.words || [],
        uuid: s.uuid,
        dir: s.dir,
        speaker,
        exten: s.exten,
        caller: s.caller || s.callername || ''
      });
    }
  });

  ws.on('error', err => console.error('[DG] WS error:', err?.message || err));

  ws.on('close', () => {
    const s = ws._tapSess;
    if (!s || s.closing) return;

    const attempt = s.reconnects++;
    const waitMs = nextBackoffMs(attempt);

    console.warn(`[DG] WS closed ssrc=${s.ssrc} dir=${s.dir} -> reconnect in ${waitMs}ms (attempt ${attempt+1})`);
    cWsReconnects.inc();

    setTimeout(() => {
      if (!rtpSessions.has(s.ssrc)) return; // session already gone
      const newWs = dgConnect(16000, DG_LANG);
      s.ws = newWs;
      newWs._tapSess = s;
    }, waitMs);
  });

  return ws;
}

// =======================================================
// WAV dump (~5s) optional
// =======================================================
let wavWrite = null, wavBytes = 0, wavSamples = 0;
function wavBegin(sr = 16000, tag='capture') {
  const p = `/tmp/${tag}.wav`;
  wavWrite = fs.createWriteStream(p);
  wavWrite.write(Buffer.alloc(44));
  console.log(`[WAV] dump a ${p}`);
}
function wavAppend(buf) {
  if (!wavWrite) return;
  wavWrite.write(buf);
  wavBytes += buf.length;
  wavSamples += buf.length / 2;
  if (wavBytes >= 5 * 16000 * 2) wavEnd(16000);
}
function wavEnd(sr = 16000) {
  if (!wavWrite) return;
  const fd = wavWrite.fd;
  const riff = Buffer.alloc(44);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(36 + wavBytes, 4);
  riff.write('WAVE', 8);
  riff.write('fmt ', 12);
  riff.writeUInt32LE(16, 16);
  riff.writeUInt16LE(1, 20);
  riff.writeUInt16LE(1, 22);
  riff.writeUInt32LE(sr, 24);
  riff.writeUInt32LE(sr * 2, 28);
  riff.writeUInt16LE(2, 32);
  riff.writeUInt16LE(16, 34);
  riff.write('data', 36);
  riff.writeUInt32LE(wavBytes, 40);
  fs.writeSync(fd, riff, 0, 44, 0);
  wavWrite.end();
  console.log(`[WAV] cerrado: ${wavSamples} muestras`);
  wavWrite = null; wavBytes = 0; wavSamples = 0;
}
process.on('exit', () => wavEnd(16000));
process.on('SIGINT', () => { wavEnd(16000); process.exit(0); });

// =======================================================
// RTP receiver (dual UDP)
// =======================================================
const rtpSockIn  = dgram.createSocket('udp4');
const rtpSockOut = dgram.createSocket('udp4');

// SSRC -> session
// { ssrc, ws, room, uuid, dir, exten, caller, callername, boot[], last, timer, pkts, bytes, zeros, reconnects, closing }
const rtpSessions = new Map();

const BOOT_FRAMES = 50;
const INACT_MS    = 8000;

function rtpPayload(buf) {
  if (buf.length < 12) return null;
  const cc = buf[0] & 0x0f;
  const x  = (buf[0] & 0x10) !== 0;
  let offset = 12 + cc * 4;
  if (x) {
    if (buf.length < offset + 4) return null;
    const extLen = buf.readUInt16BE(offset + 2);
    offset += 4 + extLen * 4;
  }
  if (buf.length <= offset) return null;
  return buf.subarray(offset);
}

function maybeSwapEndian(buf) {
  if (!SWAP_ENDIAN) return buf;
  for (let i = 0; i < buf.length; i += 2) {
    const a = buf[i]; buf[i] = buf[i+1]; buf[i+1] = a;
  }
  return buf;
}

function isAllZero16(buf) {
  for (let i = 0; i < buf.length; i += 2) {
    if (buf[i] !== 0 || buf[i+1] !== 0) return false;
  }
  return true;
}

function resolveContextForNewSSRC(dir) {
  const p = popPending(dir);
  if (p) {
    const ctx = ctxByUuid.get(p.uuid);
    return { uuid: p.uuid, ctx };
  }
  return { uuid: 'unknown', ctx: null };
}

function startWatchdog(sess) {
  sess.timer = setInterval(() => {
    if (Date.now() - sess.last > INACT_MS) {
      console.log(`[DG-GW] SSRC=${sess.ssrc} dir=${sess.dir} inactive -> close`);
      sess.closing = true;
      try { sess.ws.close(); } catch {}
      clearInterval(sess.timer);
      rtpSessions.delete(sess.ssrc);
      gSessions.set(rtpSessions.size);
    }
  }, 2000);
}

function ensureSess(ssrc, dir) {
  let sess = rtpSessions.get(ssrc);
  if (sess) return sess;

  if (rtpSessions.size >= DG_MAX_SESSIONS) {
    console.warn(`[DG-GW] max sessions reached (${DG_MAX_SESSIONS}). Dropping SSRC=${ssrc} dir=${dir}`);
    return null;
  }

  const { uuid, ctx } = resolveContextForNewSSRC(dir);

  const exten      = ctx?.exten || 'mix';
  const caller     = ctx?.caller || '';
  const callername = ctx?.callername || '';
  const room       = exten;

  const ws = dgConnect(16000, DG_LANG);

  sess = {
    ssrc,
    ws,
    room,
    uuid,
    dir,
    exten,
    caller,
    callername,
    boot: [],
    last: Date.now(),
    timer: null,
    pkts: 0,
    bytes: 0,
    zeros: 0,
    reconnects: 0,
    closing: false
  };

  ws._tapSess = sess;
  rtpSessions.set(ssrc, sess);
  gSessions.set(rtpSessions.size);

  console.log(`[DG-GW] Started session dir=${dir} SSRC=${ssrc} uuid=${uuid} room=${room}`);

  startWatchdog(sess);
  return sess;
}

function onRtpMessage(dir) {
  return (msg) => {
    if (msg.length < 12) return;

    const ssrc = msg.readUInt32BE(8);
    const payload = rtpPayload(msg);
    if (!payload) return;

    const sess = ensureSess(ssrc, dir);
    if (!sess) return;

    sess.pkts++;
    sess.bytes += payload.length;
    sess.last = Date.now();

    cRtpPackets.inc({ dir });

    let pcm = Buffer.from(payload);
    if (isAllZero16(pcm)) {
	    sess.zeros++;
	    cZeroPcmFrames.inc({ dir });
    }
    pcm = maybeSwapEndian(pcm);

    if (DUMP_WAV) {
      if (!wavWrite) wavBegin(16000, `ssrc-${ssrc}-${dir}`);
      wavAppend(pcm);
    }

    if (sess.ws.readyState === WebSocket.OPEN) {
      sess.ws.send(pcm, { binary: true });
    } else if (sess.boot.length < BOOT_FRAMES) {
      sess.boot.push(pcm);
    }

    if (sess.pkts % 100 === 0) {
      console.log(
        `[RTP] dir=${dir} SSRC=${ssrc} pkts=${sess.pkts} bytes=${sess.bytes} zeros=${sess.zeros} ` +
        `ws=${sess.ws.readyState} room=${sess.room}`
      );
    }
  };
}

rtpSockIn.on('message', onRtpMessage('in'));
rtpSockOut.on('message', onRtpMessage('out'));

rtpSockIn.bind(RTP_PORT_IN, '0.0.0.0', () => {
  const a = rtpSockIn.address();
  console.log(`[DG-GW] RTP IN listening on ${a.address}:${a.port} (slin16 ${SWAP_ENDIAN?'swap':'LE'})`);
});

rtpSockOut.bind(RTP_PORT_OUT, '0.0.0.0', () => {
  const a = rtpSockOut.address();
  console.log(`[DG-GW] RTP OUT listening on ${a.address}:${a.port} (slin16 ${SWAP_ENDIAN?'swap':'LE'})`);
});
