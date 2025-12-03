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
const https     = require('https');
const { URL }   = require('url');

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

// Cómo interpretar dir=in / dir=out respecto a agente/cliente
// - 'CALLER_IN' (por defecto): dir=in = cliente (caller), dir=out = agente (exten)
// - 'AGENT_IN' : dir=in = agente (exten), dir=out = cliente (caller)
const DG_ROLE_MODE = process.env.DG_ROLE_MODE || 'CALLER_IN';
console.log('[DG-GW] DG_ROLE_MODE=${DG_ROLE_MODE}');



// ==================================================================
// GEN-ASSISTANT: configuración (no cambia comportamiento por defecto)
// ==================================================================
const GENERATIVE_ASSISTANT = (process.env.GENERATIVE_ASSISTANT || 'false') === 'true';
const SHOW_TRANSCRIPTION   = (process.env.SHOW_TRANSCRIPTION   || 'true')  === 'true';

const GEN_ASS_ENGINE     = process.env.GEN_ASS_ENGINE    || 'n8n';
const GEN_ASS_URL        = process.env.GEN_ASS_URL       || '';        // si está vacío, no se llama
const GEN_ASS_AUTH       = process.env.GEN_ASS_AUTH      || '';
const GEN_ASS_NAME       = process.env.GEN_ASS_NAME      || 'BOT';
const GEN_ASS_INTERVAL   = Number(process.env.GEN_ASS_INTERVAL   || 10);    // segundos
const GEN_ASS_TAIL_CHARS = Number(process.env.GEN_ASS_TAIL_CHARS || 2000);  // 0 = sin tail
const GEN_ASS_MIN_CHARS  = Number(process.env.GEN_ASS_MIN_CHARS  || 120);

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

// ==================================================================
// GEN-ASSISTANT: métricas específicas
// ==================================================================
const gGenAssConversations = new prom.Gauge({
  name: 'dg_gen_assistant_conversations_active',
  help: 'Conversations tracked for generative assistant',
  registers: [register]
});

const cGenAssRequests = new prom.Counter({
  name: 'dg_gen_assistant_requests_total',
  help: 'Requests sent to generative assistant engine',
  labelNames: ['engine'],
  registers: [register]
});

const cGenAssErrors = new prom.Counter({
  name: 'dg_gen_assistant_errors_total',
  help: 'Errors calling generative assistant engine',
  labelNames: ['engine', 'type'],
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

// ==================================================================
// GEN-ASSISTANT: memoria en proceso por llamada
//  - Solo se usa si GENERATIVE_ASSISTANT === true
//  - Estructura básica: uuid -> { items: [...], totalChars, lastActivity }
//  - items que se mandan a N8N: { ts, speaker: "user"|"agent", text }
// ==================================================================
const convByUuid = new Map();

// Devuelve la etiqueta que verá el agente en el widget
function widgetSpeakerLabel(sess) {
  const dir = sess?.dir;
  const callerLabel = sess?.callername || sess?.caller || 'Caller';
  const agentLabel  = sess?.exten || 'Agent';

  if (DG_ROLE_MODE === 'AGENT_IN') {
    // "in" = agente, "out" = cliente
    return (dir === 'in') ? agentLabel : callerLabel;
  }

  // Modo por defecto: "CALLER_IN" => "in" = cliente, "out" = agente
  return (dir === 'in') ? callerLabel : agentLabel;
}

// Devuelve el rol lógico para el LLM: "user"/"agent"
function llmRoleForDir(dir) {
  if (DG_ROLE_MODE === 'AGENT_IN') {
    // Si "in" es el agente:
    //  - dir=in  => agent
    //  - dir=out => user (cliente)
    return (dir === 'in') ? 'agent' : 'user';
  }

  // Modo por defecto: "CALLER_IN"
  //  - dir=in  => user (cliente)
  //  - dir=out => agent
  return (dir === 'in') ? 'user' : 'agent';
}

function genAssEnsureConv(uuid) {
  let conv = convByUuid.get(uuid);
  if (!conv) {
    conv = { items: [], totalChars: 0, lastActivity: Date.now(), lastSentItems: 0 };
    convByUuid.set(uuid, conv);
    gGenAssConversations.set(convByUuid.size);
  }
  return conv;
}

function genAssAddFinalSegment(uuid, dir, text) {
  if (!GENERATIVE_ASSISTANT) return;
  if (!text) return;

  const conv = genAssEnsureConv(uuid);

  // rol lógico para el LLM, según DG_ROLE_MODE
  const speaker = llmRoleForDir(dir);
  const ts = Date.now() / 1000; // epoch seconds

  conv.items.push({ ts, speaker, text });
  conv.totalChars += text.length;
  conv.lastActivity = Date.now();
}

function genAssCleanupConversation(uuid) {
  if (!convByUuid.has(uuid)) return;
  convByUuid.delete(uuid);
  gGenAssConversations.set(convByUuid.size);
}

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

  // Calculamos "from" y "to" lógicos según el modo:
  // - CALLER_IN  => from = cliente (caller), to = agente (exten)
  // - AGENT_IN   => from = agente (exten),  to = cliente (caller)
  const agent  = ctx.exten;
  const client = ctx.caller || ctx.callername || '';
  let from = client;
  let to   = agent;

  if (DG_ROLE_MODE === 'AGENT_IN') {
    from = agent;
    to   = client;
  }

  // Emit call-start para que el widget pueda pintar cabecera
  if (isNew || req.query.force_start === '1') {
    io.to(ctx.exten).emit('call-start', {
      uuid,
      exten: ctx.exten,
      caller: ctx.caller,
      callername: ctx.callername,
      from,
      to,
      ts: Date.now()
    });
  }

  console.log(
    `[DG-GW] register uuid=${uuid} exten=${ctx.exten} caller=${ctx.caller} ` +
    `dir=${dir} from=${from} to=${to}`
  );
  res.send('OK');
});

app.get('/unregister', (req, res) => {
  const { uuid } = req.query;
  if (uuid && ctxByUuid.has(uuid)) {
    ctxByUuid.delete(uuid);
    console.log(`[DG-GW] unregister uuid=${uuid}`);
  }

  // GEN-ASSISTANT: limpieza de memoria de conversación si existía
  if (uuid && GENERATIVE_ASSISTANT) {
    genAssCleanupConversation(uuid);
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

      // GEN-ASSISTANT: almacenar solo segmentos finales en memoria de conversación
      if (GENERATIVE_ASSISTANT && s?.uuid && msg.is_final) {
        genAssAddFinalSegment(s.uuid, s.dir, text);
      }

      // speaker que se muestra en el widget (número/extensión),
      // calculado según DG_ROLE_MODE
      const speaker = widgetSpeakerLabel(s);

      // DEBUG: loguear quién está “hablando” según el gateway
      if (msg.is_final) {
        console.log(
          '[STT-FINAL]',
          'uuid=', s.uuid,
          'dir=', s.dir,
          'exten=', s.exten,
          'caller=', s.caller,
          'speaker=', speaker,
          'text=', JSON.stringify(text)
        );
      }

      // SHOW_TRANSCRIPTION controla si enviamos STT al widget
      if (SHOW_TRANSCRIPTION) {
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

      // GEN-ASSISTANT: si esta era la última sesión de ese uuid, limpiamos memoria
      if (GENERATIVE_ASSISTANT && sess.uuid) {
        const stillHas = Array.from(rtpSessions.values()).some(s => s.uuid === sess.uuid);
        if (!stillHas) {
          genAssCleanupConversation(sess.uuid);
        }
      }
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

// ==================================================================
// GEN-ASSISTANT: ciclo periódico hacia N8N (u otro motor)
//  - Desactivado si GENERATIVE_ASSISTANT === false o GEN_ASS_URL vacío
//  - No rompe el comportamiento actual (solo añade capacidad extra)
// ==================================================================

function postJson(urlStr, headers, payload) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const body = Buffer.from(JSON.stringify(payload));
      const opts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': body.length
          },
          headers || {}
        )
      };

      const req = (u.protocol === 'https:' ? https : http).request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (!buf.length) return resolve(null);
          try {
            const json = JSON.parse(buf.toString('utf8'));
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function runGenAssistantCycle() {
  if (!GENERATIVE_ASSISTANT) return;
  if (!GEN_ASS_URL) return;

  for (const [uuid, conv] of convByUuid.entries()) {
    if (!conv.items.length) continue;

    if (conv.totalChars < GEN_ASS_MIN_CHARS) continue;

    if (conv.lastSentItems && conv.items.length === conv.lastSentItems) {
      continue;
    }

    // Construir ventana TAIL si aplica
    let items = conv.items;
    if (GEN_ASS_TAIL_CHARS > 0) {
      let acc = 0;
      const picked = [];
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        acc += (it.text || '').length;
        picked.push(it);
        if (acc >= GEN_ASS_TAIL_CHARS) break;
      }
      items = picked.reverse();
    }

    const payload = {
      call_id: uuid,
      conversation: items.map(it => ({
        ts: it.ts,
        speaker: it.speaker,
        text: it.text
      }))
    };

    try {
      cGenAssRequests.inc({ engine: GEN_ASS_ENGINE });

      const headers = {};
      if (GEN_ASS_AUTH) headers['Authorization'] = GEN_ASS_AUTH;

      const body = await postJson(GEN_ASS_URL, headers, payload);
      if (!body || !body.assistant) {
        cGenAssErrors.inc({ engine: GEN_ASS_ENGINE, type: 'parse' });
        continue;
      }

      const assistant = body.assistant || {};
      if (assistant.visibility === 'agent' && typeof assistant.text === 'string' && assistant.text.trim()) {
        const text = assistant.text.trim();
        const name = GEN_ASS_NAME || 'BOT';

        const ctx = ctxByUuid.get(uuid);
        const room = ctx?.exten || 'mix';

        io.to(room).emit('assist', {
          text,
          speaker: name
        });
	
	// 👇 NUEVO: añadimos también el mensaje del BOT a la memoria
        const conv = genAssEnsureConv(uuid);
        const ts = Date.now() / 1000;

        conv.items.push({
          ts,
          speaker: 'assistant',  // nuevo rol lógico
          text
        });
        // Opcional: no sumamos a totalChars para no inflar el umbral mínimo
        // conv.totalChars += text.length;

        conv.lastActivity = Date.now();

      } else {
        cGenAssErrors.inc({ engine: GEN_ASS_ENGINE, type: 'no_text' });
      }
    } catch (err) {
      console.error('[GEN-ASSISTANT] error:', err?.message || err);
      cGenAssErrors.inc({ engine: GEN_ASS_ENGINE, type: 'network' });
    } finally {
	conv.lastSentItems = conv.items.length;
    }
  }
}

if (GENERATIVE_ASSISTANT && GEN_ASS_INTERVAL > 0) {
  setInterval(runGenAssistantCycle, GEN_ASS_INTERVAL * 1000);
  console.log(`[GEN-ASSISTANT] enabled: engine=${GEN_ASS_ENGINE} interval=${GEN_ASS_INTERVAL}s`);
}
