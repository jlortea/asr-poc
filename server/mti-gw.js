// mti-gw.js (OPCIÓN 2 DEFINITIVA)
//  - Recibe RTP SLIN16 en PUERTOS DINÁMICOS por llamada.
//  - Cada llamada se registra vía HTTP /register (uuid, port).
//  - 1 puerto UDP = 1 sesión = 1 socket TCP hacia MTI.
//  - START frame incluye el UNIQUEID real.

const dgram = require('dgram');
const net   = require('net');
const http  = require('http');
const url   = require('url');

const MTI_HOST = process.env.MTI_HOST || '127.0.0.1';
const MTI_PORT = Number(process.env.MTI_PORT || 9092);

// HTTP control
const MTI_GW_HTTP_PORT = Number(process.env.MTI_GW_HTTP_PORT || 9093);

if (!MTI_HOST || !MTI_PORT) {
  console.error('[MTI-GW] ❌ Missing MTI_HOST/MTI_PORT');
  process.exit(1);
}

const AUDIO_FRAME_SIZE = 640;
const INACTIVITY_MS    = 8000;

// RTP payload extractor
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

function buildFrame(type, payloadBuf) {
  const len = payloadBuf ? payloadBuf.length : 0;
  const buf = Buffer.alloc(1 + 2 + len);
  buf[0] = type;
  buf.writeUInt16BE(len, 1);
  if (payloadBuf && len > 0) payloadBuf.copy(buf, 3);
  return buf;
}

// sessionsByPort[port] = { port, uuid, udpSock, tcpSock, connected, queue, audioBuffer, lastRtpMs, ended, timer }
const sessionsByPort = new Map();

function createSession(port, uuid) {
  if (sessionsByPort.has(port)) {
    throw new Error(`Port already registered: ${port}`);
  }

  const udpSock = dgram.createSocket('udp4');
  const tcpSock = new net.Socket();

  const sess = {
    port,
    uuid,
    udpSock,
    tcpSock,
    connected: false,
    queue: [],
    audioBuffer: Buffer.alloc(0),
    lastRtpMs: Date.now(),
    ended: false,
    inactivityTimer: null
  };

  sessionsByPort.set(port, sess);

  // TCP events
  tcpSock.on('connect', () => {
    console.log(`[MTI-GW] TCP connected to ${MTI_HOST}:${MTI_PORT} port=${port} uuid=${uuid}`);

    const payload = Buffer.from(uuid, 'utf8');
    tcpSock.write(buildFrame(0x01, payload));
    console.log(`[MTI-GW] Sent START (0x01 len=${payload.length}) port=${port} uuid=${uuid}`);

    sess.connected = true;

    if (sess.queue.length) {
      console.log(`[MTI-GW] Flushing ${sess.queue.length} queued audio frames port=${port}`);
      for (const f of sess.queue) tcpSock.write(f);
      sess.queue = [];
    }

    if (!sess.inactivityTimer) {
      sess.inactivityTimer = setInterval(() => {
        const now = Date.now();
        if (!sess.ended && now - sess.lastRtpMs > INACTIVITY_MS) {
          console.log(`[MTI-GW] Inactivity timeout port=${port} uuid=${uuid}`);
          sendEndAndClose(sess, 'inactivity');
        }
      }, 2000);
    }
  });

  tcpSock.on('error', (err) => {
    console.error(`[MTI-GW] TCP error port=${port} uuid=${uuid}: ${err.message}`);
    sendEndAndClose(sess, 'tcp-error');
  });

  tcpSock.on('close', () => {
    cleanupSession(port, 'tcp-close');
  });

  // UDP listener
  udpSock.on('message', (msg) => {
    if (msg.length < 12) return;
    const payload = rtpPayload(msg);
    if (!payload) return;

    sess.lastRtpMs = Date.now();

    sess.audioBuffer = Buffer.concat([sess.audioBuffer, payload]);

    while (sess.audioBuffer.length >= AUDIO_FRAME_SIZE) {
      const chunk = sess.audioBuffer.subarray(0, AUDIO_FRAME_SIZE);
      sess.audioBuffer = sess.audioBuffer.subarray(AUDIO_FRAME_SIZE);

      const frame = buildFrame(0x12, chunk);
      if (sess.ended) return;

      if (sess.connected) tcpSock.write(frame);
      else sess.queue.push(frame);
    }
  });

  udpSock.on('listening', () => {
    const a = udpSock.address();
    console.log(`[MTI-GW] RTP listening on ${a.address}:${a.port} uuid=${uuid}`);
  });

  udpSock.on('error', (err) => {
    console.error(`[MTI-GW] UDP error port=${port} uuid=${uuid}: ${err.message}`);
    sendEndAndClose(sess, 'udp-error');
  });

  udpSock.bind(port, '0.0.0.0');

  // connect TCP lazily on first RTP? No, conectamos ya:
  tcpSock.connect(MTI_PORT, MTI_HOST);

  return sess;
}

function sendEndAndClose(sess, reason) {
  if (sess.ended) return;
  sess.ended = true;

  try {
    if (sess.connected) {
      sess.tcpSock.write(buildFrame(0x00, Buffer.alloc(0)));
      console.log(`[MTI-GW] Sent END (0x00) port=${sess.port} reason=${reason}`);
    }
  } catch {}

  try { sess.tcpSock.end(); } catch {}
}

function cleanupSession(port, why) {
  const sess = sessionsByPort.get(port);
  if (!sess) return;

  console.log(`[MTI-GW] cleanup port=${port} uuid=${sess.uuid} reason=${why}`);

  if (sess.inactivityTimer) clearInterval(sess.inactivityTimer);

  try { sess.udpSock.close(); } catch {}
  try {
    if (!sess.ended) sendEndAndClose(sess, why || 'cleanup');
  } catch {}

  sessionsByPort.delete(port);
}

// ---------- HTTP CONTROL SERVER ----------
const httpServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/register') {
    const uuid = parsed.query.uuid;
    const port = Number(parsed.query.port);

    if (!uuid || !port) {
      res.statusCode = 400; return res.end('Missing uuid/port');
    }

    try {
      createSession(port, uuid);
      console.log(`[MTI-GW] Registered port=${port} uuid=${uuid}`);
      res.statusCode = 200; return res.end('OK');
    } catch (e) {
      res.statusCode = 409; return res.end(String(e.message || e));
    }
  }

  if (parsed.pathname === '/unregister') {
    const port = Number(parsed.query.port);
    if (!port) {
      res.statusCode = 400; return res.end('Missing port');
    }
    cleanupSession(port, 'unregister');
    res.statusCode = 200; return res.end('OK');
  }

  res.statusCode = 404; res.end('Not found');
});

httpServer.listen(MTI_GW_HTTP_PORT, '0.0.0.0', () => {
  console.log(`[MTI-GW] HTTP control listening on :${MTI_GW_HTTP_PORT} (/register /unregister)`);
});

// shutdown limpio
process.on('SIGINT', () => {
  console.log('[MTI-GW] SIGINT closing sessions...');
  for (const p of sessionsByPort.keys()) cleanupSession(p, 'sigint');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('[MTI-GW] SIGTERM closing sessions...');
  for (const p of sessionsByPort.keys()) cleanupSession(p, 'sigterm');
  process.exit(0);
});
