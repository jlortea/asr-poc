// Gateway: recibe RTP/UDP (Asterisk ExternalMedia slin16@16kHz L-E),
// lo envía a Deepgram vía WS y sirve el widget por Socket.IO.

const dgram   = require('dgram');
const WebSocket = require('ws');
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const fs      = require('fs');

// === Config por entorno ===
const DG_KEY       = process.env.DEEPGRAM_API_KEY;                // requerido
const DG_LANG      = process.env.DG_LANGUAGE || 'es';
const DG_INTERIM   = (process.env.DG_INTERIM || 'true') === 'true';
const DG_PUNCT     = (process.env.DG_PUNCTUATE || 'true') === 'true';
const DG_SMART     = (process.env.DG_SMART_FORMAT || 'true') === 'true';
const DG_DIARIZE   = (process.env.DG_DIARIZE || 'false') === 'true';

const WIDGET_PORT  = Number(process.env.WIDGET_PORT || 8080);
const RTP_PORT     = Number(process.env.RTP_PORT || 40000);

const SWAP_ENDIAN  = (process.env.SWAP_ENDIAN || '0') === '1';    // debe ser 0 con slin16 de Asterisk
const DUMP_WAV     = (process.env.DUMP_WAV || '0') === '1';

if (!DG_KEY) {
  console.error('[ASR-GW] ❌ Falta DEEPGRAM_API_KEY en el entorno');
  process.exit(1);
}

// === Web + Socket.IO (widget) ===
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
app.use(express.static('public'));
httpServer.listen(WIDGET_PORT, () => {
  console.log(`Web server on :${WIDGET_PORT}`);
});

io.on('connection', (s) => {
  const { uuid } = s.handshake.query;
  if (uuid) s.join(uuid);
  console.log(`[Widget] socket conectado room=${uuid || '(sin uuid)'}`);
});

// === Deepgram WS helper ===
function dgConnect(roomUUID, sampleRate = 16000, lang = DG_LANG) {
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
    console.log(`[DG] WS open room=${roomUUID} sr=${sampleRate} lang=${lang} diarize=${DG_DIARIZE}`);
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'Results' && msg.channel?.alternatives?.length) {
        const alt = msg.channel.alternatives[0];
        io.to(roomUUID).emit('stt', {
          text: alt.transcript || '',
          isFinal: !!msg.is_final,
          words: alt.words || []
        });
      }
    } catch (e) {
      console.error('[DG] parse error', e);
    }
  });

  ws.on('error', err => console.error('[DG] WS error:', err?.message || err));
  ws.on('close', (code, reason) => {
    console.error(`[DG] WS close room=${roomUUID} code=${code} reason=${reason}`);
    io.to(roomUUID).emit('stt-end', {});
  });

  return ws;
}

// === WAV dump opcional (primeros ~5s) ===
let wavWrite = null, wavBytes = 0, wavSamples = 0;
function wavBegin(sr = 16000) {
  const p = '/tmp/capture.wav';
  wavWrite = fs.createWriteStream(p);
  const h = Buffer.alloc(44); wavWrite.write(h); // header placeholder
  console.log(`[WAV] dump a ${p}`);
}
function wavAppend(buf) {
  if (!wavWrite) return;
  wavWrite.write(buf);
  wavBytes += buf.length;
  wavSamples += buf.length / 2;
  if (wavBytes >= 5 * 16000 * 2) wavEnd(16000); // ~5s
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

// === RTP receiver (UDP) ===
const rtpSock = dgram.createSocket('udp4');

// SSRC -> sesión
// { ws, room, sampleRate, boot[], last, timer, pkts, bytes, zeros }
const rtpSessions = new Map();

function rtpPayload(buf) {
  if (buf.length < 12) return null;
  const cc = buf[0] & 0x0f;
  const x = (buf[0] & 0x10) !== 0;
  let offset = 12 + cc * 4;
  if (x) {
    if (buf.length < offset + 4) return null;
    const extLen = buf.readUInt16BE(offset + 2);
    offset += 4 + extLen * 4;
  }
  if (buf.length <= offset) return null;
  return buf.subarray(offset);
}

const BOOT_FRAMES = 50;   // ~1s @16kHz (50 x 20ms)
const INACT_MS    = 8000; // watchdog de inactividad

function ensureSess(ssrc) {
  let sess = rtpSessions.get(ssrc);
  if (!sess) {
    const room = 'mix'; // PoC: abre widget con ?uuid=mix
    const ws = dgConnect(room, 16000, DG_LANG);
    sess = { ws, room, sampleRate: 16000, boot: [], last: Date.now(), timer: null, pkts: 0, bytes: 0, zeros: 0 };
    rtpSessions.set(ssrc, sess);
    console.log(`Started DG session for SSRC=${ssrc} → room=${room}`);

    ws.on('open', () => {
      if (sess.boot.length) {
        for (const chunk of sess.boot) ws.send(chunk, { binary: true });
        sess.boot.length = 0;
      }
      if (!sess.timer) {
        sess.timer = setInterval(() => {
          if (Date.now() - sess.last > INACT_MS) {
            console.log(`[DG] SSRC=${ssrc} inactivo → close`);
            try { ws.close(); } catch {}
            clearInterval(sess.timer);
            rtpSessions.delete(ssrc);
          }
        }, 2000);
      }
    });

    ws.on('close', () => {
      if (sess.timer) clearInterval(sess.timer);
      rtpSessions.delete(ssrc);
    });
  }
  return sess;
}

function maybeSwapEndian(buf) {
  if (!SWAP_ENDIAN) return buf;
  for (let i = 0; i < buf.length; i += 2) {
    const a = buf[i]; buf[i] = buf[i+1]; buf[i+1] = a;
  }
  return buf;
}

function rmsAndPeak(bufLE16) {
  let sum = 0, peak = 0;
  for (let i = 0; i < bufLE16.length; i += 2) {
    const s = bufLE16.readInt16LE(i);
    const a = Math.abs(s);
    sum += s * s;
    if (a > peak) peak = a;
  }
  const n = bufLE16.length / 2 || 1;
  const rms = Math.sqrt(sum / n);
  return { rms: rms / 32768, peak: peak / 32768 };
}

function isAllZero16(buf) {
  for (let i = 0; i < buf.length; i += 2) {
    if (buf[i] !== 0 || buf[i+1] !== 0) return false;
  }
  return true;
}

rtpSock.on('message', (msg) => {
  if (msg.length < 12) return;
  const ssrc = msg.readUInt32BE(8);
  const payload = rtpPayload(msg);
  if (!payload) return;

  const sess = ensureSess(ssrc);

  // contabilidad
  sess.pkts++;
  sess.bytes += payload.length;
  sess.last = Date.now();

  // Asterisk slin16 ⇒ little-endian; swap solo si lo fuerzas por env
  let pcm = Buffer.from(payload);
  if (isAllZero16(pcm)) sess.zeros++;
  pcm = maybeSwapEndian(pcm);

  // métricas y dump opcional
  const m = rmsAndPeak(pcm);
  if (DUMP_WAV) {
    if (!wavWrite) wavBegin(16000);
    wavAppend(pcm);
  }

  // envío o boot
  if (sess.ws.readyState === WebSocket.OPEN) {
    sess.ws.send(pcm, { binary: true });
  } else if (sess.boot.length < BOOT_FRAMES) {
    sess.boot.push(pcm);
  }

  // trazas cada 100 paquetes (~2s a 20ms/paquete)
  if (sess.pkts % 100 === 0) {
    console.log(
      `[RTP] SSRC=${ssrc} pkts=${sess.pkts} bytes=${sess.bytes} ` +
      `zeros=${sess.zeros} ws=${sess.ws.readyState} ` +
      `rms=${m.rms.toFixed(3)} peak=${m.peak.toFixed(3)}`
    );
  }
});

rtpSock.on('listening', () => {
  const addr = rtpSock.address();
  console.log(
    `RTP receiver listening on ${addr.address}:${addr.port} ` +
    `(format=slin16, ${SWAP_ENDIAN ? 'swap-endian ON' : 'little-endian'})`
  );
});

rtpSock.bind(RTP_PORT, '0.0.0.0');
