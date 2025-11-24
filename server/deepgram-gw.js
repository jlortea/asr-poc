// deepgram-gw.js (REFAC separado)
// - Recibe RTP/UDP fijo (slin16@16kHz L-E) desde Asterisk ExternalMedia
// - Mantiene sesiones concurrentes por SSRC
// - Cada SSRC abre su propio WS a Deepgram
// - Signaling HTTP /register para inyectar contexto por stream (uuid, exten, caller, dir)
// - Enruta transcripts a "room" = exten (un widget por extensión)
// - Diarización estricta local: dir=in => Caller, dir=out => Agent

const dgram     = require('dgram');
const WebSocket = require('ws');
const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const fs        = require('fs');

// === ENV ===
const DG_KEY       = process.env.DEEPGRAM_API_KEY;
const DG_LANG      = process.env.DG_LANGUAGE || 'es';
const DG_INTERIM   = (process.env.DG_INTERIM || 'true') === 'true';
const DG_PUNCT     = (process.env.DG_PUNCTUATE || 'true') === 'true';
const DG_SMART     = (process.env.DG_SMART_FORMAT || 'true') === 'true';
const DG_DIARIZE   = (process.env.DG_DIARIZE || 'false') === 'true'; // puedes dejar false

const WIDGET_PORT  = Number(process.env.WIDGET_PORT || 8080);
const RTP_PORT     = Number(process.env.RTP_PORT || 40000);

const SWAP_ENDIAN  = (process.env.SWAP_ENDIAN || '0') === '1';
const DUMP_WAV     = (process.env.DUMP_WAV || '0') === '1';

if (!DG_KEY) {
  console.error('[DG-GW] ❌ Falta DEEPGRAM_API_KEY');
  process.exit(1);
}

// === Web + Socket.IO (widget) ===
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
app.use(express.static('public'));

httpServer.listen(WIDGET_PORT, () => {
  console.log(`[DG-GW] Web server on :${WIDGET_PORT}`);
});

io.on('connection', (s) => {
  const { uuid } = s.handshake.query; // por retrocompat widget usa "uuid" como room; aquí será exten
  if (uuid) s.join(uuid);
  console.log(`[Widget] socket conectado room=${uuid || '(sin room)'}`);
});

// =======================================================
// Signaling: /register desde TAP solo para Deepgram
// =======================================================

// uuid -> { exten, caller, callername, streams:{inSSRC,outSSRC}, lastTs }
const ctxByUuid = new Map();

// Cola de asignación SSRC para streams recién creados
// dir -> [{ uuid, ts }]
const pendingByDir = { in: [], out: [] };

const PENDING_TTL_MS = 2500;

function pushPending(dir, uuid) {
  if (!(dir === 'in' || dir === 'out')) return;
  const now = Date.now();
  pendingByDir[dir].push({ uuid, ts: now });
  // limpia expirados
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

  let ctx = ctxByUuid.get(uuid);
  if (!ctx) {
    ctx = {
      uuid,
      exten: exten || 'mix',
      caller: caller || '',
      callername: callername || '',
      streams: {},
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
// Deepgram WS
// =======================================================
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
    // flush boot
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
  ws.on('close', (code, reason) => {
    const s = ws._tapSess;
    console.log(`[DG] WS close ssrc=${s?.ssrc} uuid=${s?.uuid} dir=${s?.dir} code=${code}`);
    if (s?.room) io.to(s.room).emit('stt-end', {});
  });

  return ws;
}

// =======================================================
// WAV dump opcional (~5s)
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
// RTP receiver (UDP)
// =======================================================
const rtpSock = dgram.createSocket('udp4');

// SSRC -> sess
// sess = { ssrc, ws, room, uuid, dir, exten, caller, callername, boot[], last, timer, pkts, bytes, zeros }
const rtpSessions = new Map();

const BOOT_FRAMES = 50;    // ~1s
const INACT_MS    = 8000;  // watchdog

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

// asigna contexto a SSRC nuevo usando pendingByDir
function resolveContextForNewSSRC() {
  const pin  = popPending('in');
  if (pin) {
    const ctx = ctxByUuid.get(pin.uuid);
    return { uuid: pin.uuid, dir: 'in', ctx };
  }
  const pout = popPending('out');
  if (pout) {
    const ctx = ctxByUuid.get(pout.uuid);
    return { uuid: pout.uuid, dir: 'out', ctx };
  }
  return { uuid: 'unknown', dir: 'unknown', ctx: null };
}

function ensureSess(ssrc) {
  let sess = rtpSessions.get(ssrc);
  if (sess) return sess;

  const { uuid, dir, ctx } = resolveContextForNewSSRC();

  const exten      = ctx?.exten || 'mix';
  const caller     = ctx?.caller || '';
  const callername = ctx?.callername || '';
  const room       = exten; // ✅ room por extensión

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
    zeros: 0
  };

  ws._tapSess = sess;
  rtpSessions.set(ssrc, sess);

  console.log(`[DG-GW] Started session SSRC=${ssrc} uuid=${uuid} dir=${dir} room=${room}`);

  sess.timer = setInterval(() => {
    if (Date.now() - sess.last > INACT_MS) {
      console.log(`[DG-GW] SSRC=${ssrc} inactivo → close`);
      try { ws.close(); } catch {}
      clearInterval(sess.timer);
      rtpSessions.delete(ssrc);
    }
  }, 2000);

  ws.on('close', () => {
    if (sess.timer) clearInterval(sess.timer);
    rtpSessions.delete(ssrc);
  });

  return sess;
}

rtpSock.on('message', (msg) => {
  if (msg.length < 12) return;

  const ssrc = msg.readUInt32BE(8);
  const payload = rtpPayload(msg);
  if (!payload) return;

  const sess = ensureSess(ssrc);

  sess.pkts++;
  sess.bytes += payload.length;
  sess.last = Date.now();

  let pcm = Buffer.from(payload);
  if (isAllZero16(pcm)) sess.zeros++;
  pcm = maybeSwapEndian(pcm);

  if (DUMP_WAV) {
    if (!wavWrite) wavBegin(16000, `ssrc-${ssrc}`);
    wavAppend(pcm);
  }

  if (sess.ws.readyState === WebSocket.OPEN) {
    sess.ws.send(pcm, { binary: true });
  } else if (sess.boot.length < BOOT_FRAMES) {
    sess.boot.push(pcm);
  }

  if (sess.pkts % 100 === 0) {
    console.log(`[RTP] SSRC=${ssrc} pkts=${sess.pkts} bytes=${sess.bytes} zeros=${sess.zeros} ws=${sess.ws.readyState} room=${sess.room} dir=${sess.dir}`);
  }
});

rtpSock.on('listening', () => {
  const addr = rtpSock.address();
  console.log(`[DG-GW] RTP listening on ${addr.address}:${addr.port} (slin16 ${SWAP_ENDIAN?'swap':'LE'})`);
});

rtpSock.bind(RTP_PORT, '0.0.0.0');
