// mti-debug-server.js
// Servidor TCP de debug para validar el protocolo MTI AudioSocket-like.
// - Parseo de frames [TYPE][LEN_BE][PAYLOAD]
// - Stats de cadencia (fps), duración, gaps/jitter
// - Dump opcional de audio RAW por conexión
//
// Uso:
//   node mti-debug-server.js
//
// Luego, si se creó audio.raw:
//   ffmpeg -f s16le -ar 16000 -ac 1 -i <file>.raw <file>.wav

const net = require('net');
const fs  = require('fs');
const path = require('path');

const LISTEN_HOST = process.env.MTI_DEBUG_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.MTI_DEBUG_PORT || 9092);

// Activa dump RAW con MTI_DUMP_RAW=1
const DUMP_RAW = String(process.env.MTI_DUMP_RAW || '1') === '1';

// Umbrales para detectar gaps raros
const EXPECTED_FRAME_MS = 20;         // 20ms por frame
const GAP_WARN_MS       = 60;         // si hay hueco >60ms lo marcamos
const FPS_REPORT_EVERY  = 1000;       // reporte 1 vez/seg

function nowMs() { return Date.now(); }

const server = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n🔌 New connection from ${remote}`);

  let buf = Buffer.alloc(0);

  // Estado por conexión
  const st = {
    uuid: null,
    startMs: nowMs(),
    lastAudioMs: null,
    audioFrames: 0,
    audioBytes: 0,
    gaps: 0,
    maxGapMs: 0,
    fpsWindow: [], // timestamps de audio en el último segundo
    rawStream: null,
    rawFile: null
  };

  // timer que saca cadencia
  const fpsTimer = setInterval(() => {
    const t = nowMs();
    // limpia ventana >1s
    st.fpsWindow = st.fpsWindow.filter(x => (t - x) <= 1000);
    const fps = st.fpsWindow.length;
    if (st.uuid) {
      console.log(`📈 FPS last 1s: ${fps} frames/s  (uuid=${st.uuid})`);
    }
  }, FPS_REPORT_EVERY);

  function openRaw(uuid) {
    if (!DUMP_RAW || st.rawStream) return;
    const safeUuid = uuid.replace(/[^\w.-]/g, '_');
    const file = path.join(process.cwd(), `mti-${safeUuid}-${Date.now()}.raw`);
    st.rawFile = file;
    st.rawStream = fs.createWriteStream(file);
    console.log(`💾 Dumping RAW audio to: ${file}`);
  }

  function closeRaw() {
    if (st.rawStream) {
      try { st.rawStream.end(); } catch {}
      st.rawStream = null;
    }
  }

  function summary(reason) {
    const durMs = nowMs() - st.startMs;
    const durSec = (durMs / 1000).toFixed(2);
    const avgFps = durMs > 0 ? (st.audioFrames / (durMs / 1000)).toFixed(1) : '0';
    console.log(`\n✅ SUMMARY (${reason}) uuid=${st.uuid || '(none)'}:`);
    console.log(`   duration: ${durSec}s`);
    console.log(`   audio frames: ${st.audioFrames}`);
    console.log(`   audio bytes:  ${st.audioBytes}`);
    console.log(`   avg fps:      ${avgFps} frames/s (expected ~50)`);
    console.log(`   gaps >${GAP_WARN_MS}ms: ${st.gaps}`);
    console.log(`   max gap:      ${st.maxGapMs}ms`);
    if (st.rawFile) {
      console.log(`   raw file:     ${st.rawFile}`);
      console.log(`   to WAV:       ffmpeg -f s16le -ar 16000 -ac 1 -i "${st.rawFile}" "${st.rawFile}.wav"`);
    }
    console.log('');
  }

  function handleFrame(type, payload) {
    if (type === 0x01) {
      const uuid = payload.toString('utf8');
      st.uuid = uuid;
      console.log(`🟢 START frame: type=0x01 len=${payload.length} uuid="${uuid}"`);
      openRaw(uuid);
      return;
    }

    if (type === 0x12) {
      const t = nowMs();
      st.audioFrames++;
      st.audioBytes += payload.length;
      st.fpsWindow.push(t);

      if (st.lastAudioMs) {
        const delta = t - st.lastAudioMs;
        if (delta > GAP_WARN_MS) {
          st.gaps++;
          st.maxGapMs = Math.max(st.maxGapMs, delta);
          console.log(`⚠️  GAP detected: ${delta}ms (expected ~${EXPECTED_FRAME_MS}ms) uuid=${st.uuid}`);
        }
      }
      st.lastAudioMs = t;

      if (payload.length !== 640) {
        console.log(`⚠️  AUDIO len unexpected: ${payload.length} (expected 640)`);
      }

      if (st.rawStream) st.rawStream.write(payload);

      // No spamear tanto: comenta si quieres ver cada frame
      // console.log(`🎧 AUDIO frame: type=0x12 len=${payload.length}`);
      return;
    }

    if (type === 0x00) {
      console.log(`🔴 END frame: type=0x00 len=0`);
      summary('END');
      closeRaw();
      socket.end();
      return;
    }

    console.log(`❓ Unknown frame type=0x${type.toString(16)} len=${payload.length}`);
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= 3) {
      const type = buf[0];
      const len  = buf.readUInt16BE(1);
      if (buf.length < 3 + len) break;

      const payload = buf.subarray(3, 3 + len);
      buf = buf.subarray(3 + len);

      handleFrame(type, payload);
    }
  });

  socket.on('close', () => {
    clearInterval(fpsTimer);
    // si cerró sin END, resumen igualmente
    if (st.audioFrames > 0 || st.uuid) {
      summary('socket-close');
    }
    closeRaw();
    console.log(`📴 Connection closed by client (${remote})`);
  });

  socket.on('error', (err) => {
    clearInterval(fpsTimer);
    console.log(`❌ Socket error from ${remote}: ${err.message}`);
    summary('socket-error');
    closeRaw();
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`🚀 MTI debug server listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});
