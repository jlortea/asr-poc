// mti-gw.js
// Gateway MTI/Whisper:
//  - Recibe RTP/SLIN16 (16kHz, 16bit LE, mono) desde Asterisk ExternalMedia.
//  - Agrupa paquetes por SSRC (1 SSRC = 1 llamada/1 sesión).
//  - Por cada sesión abre 1 socket TCP hacia el servidor MTI.
//  - Envía frames binarios con formato:
//      [ TYPE (1 byte) ][ LENGTH (2 bytes, big-endian) ][ PAYLOAD (n bytes) ]
//    Secuencia:
//      - TYPE=0x01, LENGTH=len(UUID), PAYLOAD=UUID (UTF-8)   → inicio
//      - TYPE=0x12, LENGTH=640, PAYLOAD=640 bytes PCM       → audio (20ms)
//      - TYPE=0x00, LENGTH=0, sin PAYLOAD                   → fin
//    Después de TYPE=0x00 cierra el socket TCP.

const dgram = require('dgram');
const net   = require('net');

// === Configuración desde entorno ===
// Para mantener compatibilidad con tu docker-compose actual,
// usamos las mismas variables "WHISPER_*" pero representan el servidor MTI.
const MTI_HOST      = process.env.MTI_HOST     || '127.0.0.1';
const MTI_PORT      = Number(process.env.MTI_PORT     || 9092);
const MTI_RTP_PORT  = Number(process.env.MTI_RTP_PORT || 40010);

if (!MTI_HOST || !MTI_PORT) {
  console.error('[MTI-GW] ❌ Falta MTI_HOST/MTI_PORT (host/puerto servidor MTI)');
  process.exit(1);
}

// === Constantes del protocolo y timing ===
const AUDIO_FRAME_SIZE = 640;    // 20ms @16kHz 16-bit mono
const INACTIVITY_MS    = 8000;   // Si no llega RTP en 8s → fin sesión

// === RTP utils ===
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

// Construye un frame AudioSocket: [TYPE][LEN_BE][PAYLOAD]
function buildFrame(type, payloadBuf) {
  const len = payloadBuf ? payloadBuf.length : 0;
  const buf = Buffer.alloc(1 + 2 + len);
  buf[0] = type;
  buf.writeUInt16BE(len, 1);
  if (payloadBuf && len > 0) {
    payloadBuf.copy(buf, 3);
  }
  return buf;
}

// Genera un UUID "decente" para la sesión a partir del SSRC.
// Importante: de cara al cliente, podemos cambiar esto para que sea
// exactamente el UUID de llamada que queramos. Ahora mismo es un
// placeholder estable por sesión.
function mkUuidForSsrc(ssrc) {
  // Simple: "mti-<ssrc-en-decimal>"
  return `mti-${ssrc}`;
}

// === Gestión de sesiones por SSRC ===
//
// sessions[ssrc] = {
//   ssrc,
//   uuid,
//   socket,
//   connected,
//   queue: [frameBuf, ...],
//   audioBuffer: Buffer,
//   lastRtpMs,
//   ended,
//   inactivityTimer
// }

const sessions = new Map();

function ensureSession(ssrc) {
  let sess = sessions.get(ssrc);
  if (sess) return sess;

  const uuid = mkUuidForSsrc(ssrc);
  console.log(`[MTI-GW] New SSRC=${ssrc}, UUID=${uuid}`);

  const socket = new net.Socket();

  sess = {
    ssrc,
    uuid,
    socket,
    connected: false,
    queue: [],
    audioBuffer: Buffer.alloc(0),
    lastRtpMs: Date.now(),
    ended: false,
    inactivityTimer: null
  };

  sessions.set(ssrc, sess);

  // Eventos del socket TCP
  socket.on('connect', () => {
    console.log(`[MTI-GW] TCP connected to ${MTI_HOST}:${MTI_PORT} for SSRC=${ssrc} UUID=${uuid}`);

    // 1) Enviamos frame de inicio TYPE=0x01 con UUID
    const payload = Buffer.from(uuid, 'utf8');
    const frame   = buildFrame(0x01, payload);
    socket.write(frame);
    console.log(`[MTI-GW] Sent START frame (type=0x01, len=${payload.length}) SSRC=${ssrc}`);

    // 2) Marcamos conectado y drenamos la cola de frames acumulados (audio)
    sess.connected = true;
    if (sess.queue.length > 0) {
      console.log(`[MTI-GW] Flushing ${sess.queue.length} queued frames for SSRC=${ssrc}`);
      for (const f of sess.queue) {
        socket.write(f);
      }
      sess.queue = [];
    }

    // 3) Arrancamos watchdog de inactividad si no está
    if (!sess.inactivityTimer) {
      sess.inactivityTimer = setInterval(() => {
        const now = Date.now();
        if (!sess.ended && now - sess.lastRtpMs > INACTIVITY_MS) {
          console.log(`[MTI-GW] Inactivity timeout for SSRC=${ssrc}, sending END`);
          sendEndAndClose(sess, 'inactivity');
        }
      }, 2000);
    }
  });

  socket.on('error', (err) => {
    console.error(`[MTI-GW] TCP error SSRC=${ssrc} UUID=${uuid}:`, err.message || err);
    // En caso de error, marcamos sesión como terminada
    sendEndAndClose(sess, 'tcp-error');
  });

  socket.on('close', () => {
    console.log(`[MTI-GW] TCP closed for SSRC=${ssrc} UUID=${uuid}`);
    cleanupSession(ssrc, 'tcp-close');
  });

  // Conectamos al servidor MTI
  socket.connect(MTI_PORT, MTI_HOST);

  return sess;
}

function sendFrame(sess, type, payloadBuf) {
  if (sess.ended) return; // no enviar nada después del END

  const frame = buildFrame(type, payloadBuf);

  if (sess.connected) {
    sess.socket.write(frame);
  } else {
    // Todavía no se ha establecido la conexión TCP → encolamos
    sess.queue.push(frame);
  }
}

function sendEndAndClose(sess, reason) {
  if (sess.ended) return;
  sess.ended = true;

  try {
    // TYPE=0x00, LENGTH=0, sin payload
    const endFrame = buildFrame(0x00, Buffer.alloc(0));
    if (sess.connected) {
      sess.socket.write(endFrame);
      console.log(`[MTI-GW] Sent END frame (0x00) SSRC=${sess.ssrc} reason=${reason}`);
    } else {
      // Si nunca conectó, no tiene sentido mandar END, pero lo dejamos como log
      console.log(`[MTI-GW] Marking END without TCP connect SSRC=${sess.ssrc} reason=${reason}`);
    }
  } catch (e) {
    console.error('[MTI-GW] Error sending END frame:', e.message || e);
  }

  try {
    sess.socket.end();
  } catch (e) {
    // ignoramos
  }
}

function cleanupSession(ssrc, why) {
  const sess = sessions.get(ssrc);
  if (!sess) return;

  console.log(`[MTI-GW] cleanupSession SSRC=${ssrc} UUID=${sess.uuid} reason=${why}`);

  if (sess.inactivityTimer) {
    clearInterval(sess.inactivityTimer);
  }

  try {
    if (!sess.ended) {
      // Si por cualquier motivo llegamos aquí sin haber enviado END, lo enviamos
      sendEndAndClose(sess, why || 'cleanup');
    }
  } catch (e) {
    // ignoramos
  }

  sessions.delete(ssrc);
}

// === RTP listener ===
const rtpSock = dgram.createSocket('udp4');

rtpSock.on('message', (msg) => {
  if (msg.length < 12) return;

  const ssrc    = msg.readUInt32BE(8);
  const payload = rtpPayload(msg);
  if (!payload) return;

  const sess = ensureSession(ssrc);

  // Actualizamos timestamp de última trama
  sess.lastRtpMs = Date.now();

  // Acumulamos audio hasta tener múltiplos de 640 bytes (20ms)
  sess.audioBuffer = Buffer.concat([sess.audioBuffer, payload]);

  while (sess.audioBuffer.length >= AUDIO_FRAME_SIZE) {
    const chunk = sess.audioBuffer.subarray(0, AUDIO_FRAME_SIZE);
    sess.audioBuffer = sess.audioBuffer.subarray(AUDIO_FRAME_SIZE);

    // Enviamos frame TYPE=0x12 con 640 bytes PCM
    sendFrame(sess, 0x12, chunk);
  }
});

rtpSock.on('listening', () => {
  const addr = rtpSock.address();
  console.log(
    `[MTI-GW] RTP listening on ${addr.address}:${addr.port} ` +
    `(esperando slin16@16k desde ExternalMedia MTI)`
  );
});

rtpSock.on('error', (err) => {
  console.error('[MTI-GW] RTP socket error:', err.message || err);
});

rtpSock.bind(MTI_RTP_PORT, '0.0.0.0');

// Cierre limpio en shutdown
process.on('SIGINT', () => {
  console.log('[MTI-GW] SIGINT recibido, cerrando sesiones...');
  for (const ssrc of sessions.keys()) {
    cleanupSession(ssrc, 'process-sigint');
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[MTI-GW] SIGTERM recibido, cerrando sesiones...');
  for (const ssrc of sessions.keys()) {
    cleanupSession(ssrc, 'process-sigterm');
  }
  process.exit(0);
});
