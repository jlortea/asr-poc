// tap-service.js (REFAC retrocompatible, MTI aislado, Deepgram separado + fixes)
// - /start_tap router por gw: mti | deepgram
// - MTI mantiene comportamiento EXACTO:
//     snoop spy=both, bridge mixing, EM dinámico con /register en mti-gw
// - Deepgram:
//     dual-snoop (in/out) + EM fijo a RTP_HOST_DEEPGRAM
//     signaling HTTP /register a deepgram-gw por cada stream (dir)
// - FIX 1: single-flight bridge => evita 2 bridges por uuid con snoops simultáneos
// - FIX 2: cleanup idempotente => evita logs / hangups duplicados
// - Retrocompat si gw viene en lista (mti,deepgram): usa el primero

const http   = require('http');
const url    = require('url');
const client = require('ari-client');

// === ENV ===
const {
  ARI_URL,
  ARI_USER,
  ARI_PASS,
  TAP_APP_NAME,
  TAP_HTTP_PORT,

  RTP_HOST_MTI,
  RTP_HOST_DEEPGRAM,

  MTI_GW_HTTP_HOST,
  MTI_GW_HTTP_PORT,

  MTI_RTP_START,
  MTI_RTP_END,

  // opcional: para signaling Deepgram desde TAP
  DEEPGRAM_GW_HTTP_HOST,
  DEEPGRAM_GW_HTTP_PORT
} = process.env;

if (!ARI_URL || !ARI_USER || !ARI_PASS || !TAP_APP_NAME || !TAP_HTTP_PORT) {
  console.error('[TAP] ❌ Missing env (ARI_URL, ARI_USER, ARI_PASS, TAP_APP_NAME, TAP_HTTP_PORT)');
  process.exit(1);
}

// === GW config ===
const GATEWAYS = {
  mti: {
    name: 'mti',
    rtpHost: RTP_HOST_MTI || null,
    dynamicPort: true
  },
  deepgram: {
    name: 'deepgram',
    rtpHost: RTP_HOST_DEEPGRAM || null, // ej: "192.168.1.65:40000"
    dynamicPort: false
  }
};

// === MTI HTTP control target ===
const MTI_HTTP_HOST = MTI_GW_HTTP_HOST || 'mti-gw';
const MTI_HTTP_PORT = Number(MTI_GW_HTTP_PORT || 9093);

// === Deepgram HTTP signaling target ===
// por defecto usa el service docker deepgram-gw escuchando en WIDGET_PORT interno (8080)
const DG_HTTP_HOST = DEEPGRAM_GW_HTTP_HOST || 'deepgram-gw';
const DG_HTTP_PORT = Number(DEEPGRAM_GW_HTTP_PORT || 8080);

// === MTI RTP dynamic range ===
const RTP_START = Number(MTI_RTP_START || 41000);
const RTP_END   = Number(MTI_RTP_END   || 41999);
const usedPorts = new Set();

// === STATE ===
// uuid -> session
// MTI: { gw:'mti', bridge, snoopId, emIds[], emMeta(Map), ari, cleaned? }
// Deepgram: { gw:'deepgram', bridge, bridgePromise?, emIds[], emMeta(Map), ari,
//             exten, caller, callername, cleaned? }
const sessions = new Map();

// map channelId -> uuid (para cleanup por eventos)
const chan2uuid = new Map();
const mapChan = (uuid, channelId) => {
  if (uuid && channelId) chan2uuid.set(channelId, uuid);
};
const unmapChan = (channelId) => {
  if (channelId) chan2uuid.delete(channelId);
};
const findUuidByChannel = (channelId) => chan2uuid.get(channelId);

// =======================
// Helpers
// =======================

function normalizeGw(raw) {
  if (!raw) return 'mti';
  const s = String(raw).trim();
  const first = s.split(',').map(x => x.trim()).filter(Boolean)[0] || 'mti';
  const gw = first.toLowerCase();
  if (!['mti', 'deepgram'].includes(gw)) {
    console.warn(`[TAP] Unknown gw="${raw}" -> fallback to mti`);
    return 'mti';
  }
  if (s.includes(',')) {
    console.warn(`[TAP] gw list "${raw}" received. Using first="${gw}" (retrocompat).`);
  }
  return gw;
}

function parseHostOnly(hostport) {
  if (!hostport) return null;
  const s = String(hostport).trim();
  const idx = s.lastIndexOf(':');
  if (idx > -1 && s.slice(idx + 1).match(/^\d+$/)) {
    return s.slice(0, idx);
  }
  return s;
}

function allocPort() {
  const maxTries = (RTP_END - RTP_START + 1);
  for (let i = 0; i < maxTries; i++) {
    const p = RTP_START + Math.floor(Math.random() * (RTP_END - RTP_START + 1));
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  return null;
}

function freePort(p) {
  if (!p) return;
  usedPorts.delete(p);
}

function mtiHttp(pathname, qs) {
  const q = new URLSearchParams(qs).toString();
  const options = {
    host: MTI_HTTP_HOST,
    port: MTI_HTTP_PORT,
    path: `${pathname}?${q}`,
    method: 'GET',
    timeout: 2000
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// signaling Deepgram (solo deepgram)
function deepgramHttp(pathname, qs) {
  const q = new URLSearchParams(qs).toString();
  const options = {
    host: DG_HTTP_HOST,
    port: DG_HTTP_PORT,
    path: `${pathname}?${q}`,
    method: 'GET',
    timeout: 2000
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      res.on('data', ()=>{});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// retry sobre addChannel para evitar "Channel not found" race
async function addToBridgeWithRetry(bridge, channelId, tries = 12, delayMs = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      await bridge.addChannel({ channel: channelId });
      return true;
    } catch (e) {
      const msg = e?.message || '';
      if (!/not found/i.test(msg)) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Channel not found after retry channelId=${channelId}`);
}

// FIX 1: single-flight bridge (evita doble bridge cuando entran in/out a la vez)
// FIX: bridge por dirección para Deepgram (evita mezcla)
async function getOrCreateBridgeDir(sess, ari, uuid, dir, tag='DG') {
  if (!sess.bridges) sess.bridges = {};
  if (!sess.bridgePromises) sess.bridgePromises = {};

  if (sess.bridges[dir]) return sess.bridges[dir];
  if (sess.bridgePromises[dir]) return await sess.bridgePromises[dir];

  sess.bridgePromises[dir] = (async () => {
    const bridge = ari.Bridge();
    await bridge.create({ type: 'mixing' });
    sess.bridges[dir] = bridge;
    console.log(`[TAP][${tag}] Bridge created id=${bridge.id} uuid=${uuid} dir=${dir}`);
    return bridge;
  })();

  const b = await sess.bridgePromises[dir];
  sess.bridgePromises[dir] = null;
  return b;
}

// =======================
// Cleanup (idempotente)  FIX 2
// =======================
const cleanupSession = async (uuid, why = 'cleanup') => {
  const sess = sessions.get(uuid);
  if (!sess) return;

  if (sess.cleaned) return;
  sess.cleaned = true;

  console.log(`[TAP] cleanup uuid=${uuid} gw=${sess.gw} reason=${why}`);

  const { bridge, snoopId, emIds, emMeta, ari } = sess;

  // MTI unregister dynamic ports
  if (emMeta) {
    for (const [emId, meta] of emMeta.entries()) {
      if (meta?.gwName === 'mti' && meta?.rtpPort) {
        try {
          await mtiHttp('/unregister', { port: meta.rtpPort });
          console.log(`[TAP][MTI] Unregistered port=${meta.rtpPort} uuid=${uuid}`);
        } catch (e) {
          console.warn(`[TAP][MTI] unregister failed port=${meta.rtpPort}: ${e.message}`);
        } finally {
          freePort(meta.rtpPort);
        }
      }
    }
  }

  // ✅ NUEVO: Deepgram unregister por uuid (solo si la sesión es deepgram)
  if (sess.gw === 'deepgram') {
    try {
      await deepgramHttp('/unregister', { uuid });
      console.log(`[TAP][DG] unregister → deepgram-gw uuid=${uuid}`);
    } catch (e) {
      console.warn(`[TAP][DG] unregister failed uuid=${uuid}: ${e.message}`);
    }
  }

  // destruir bridges Deepgram por-dir
  if (sess.gw === 'deepgram' && sess.bridges) {
    for (const d of ['in', 'out']) {
      const b = sess.bridges[d];
      if (b) {
        try { await b.destroy().catch(() => {}); } catch {}
      }
    }
  }


  // ahora ya destruimos bridge y colgamos canales
  if (bridge) {
    try { await bridge.destroy().catch(() => {}); } catch {}
  }

  const hangupIfAlive = async (channelId, label) => {
    if (!channelId) return;
    try {
      const ch = await ari.channels.get({ channelId }).catch(() => null);
      if (ch) {
        console.log(`[TAP] Hanging up ${label} channelId=${channelId} uuid=${uuid}`);
        await ch.hangup().catch(() => {});
      }
    } catch {}
  };

  await hangupIfAlive(snoopId, 'snoop');

  if (Array.isArray(emIds)) {
    for (const emId of emIds) await hangupIfAlive(emId, 'externalMedia');
  }

  if (snoopId) unmapChan(snoopId);
  if (Array.isArray(emIds)) for (const emId of emIds) unmapChan(emId);

  sessions.delete(uuid);
};


// =======================
// ExternalMedia factory (MTI / Deepgram)
// =======================
async function createExternalMediaForGw(ari, uuid, bridge, gwName, sess, dir = 'both') {
  const gw = GATEWAYS[gwName];
  if (!gw) {
    console.warn(`[TAP] Unknown gateway gw=${gwName} uuid=${uuid}`);
    return null;
  }
  if (!gw.rtpHost) {
    console.warn(`[TAP] Gateway ${gwName} without RTP host configured uuid=${uuid}`);
    return null;
  }

  let externalHost = gw.rtpHost;
  let rtpPort = null;

  if (gw.dynamicPort) {
    rtpPort = allocPort();
    if (!rtpPort) throw new Error('No free MTI RTP ports in range');

    const hostOnly = parseHostOnly(gw.rtpHost);
    externalHost = `${hostOnly}:${rtpPort}`;

    const reg = await mtiHttp('/register', { uuid, port: rtpPort });
    if (reg.status !== 200) {
      freePort(rtpPort);
      throw new Error(`MTI register failed status=${reg.status} body=${reg.body}`);
    }

    console.log(`[TAP][MTI] reserved port=${rtpPort} uuid=${uuid}`);
  }

  // signaling a deepgram-gw antes de crear EM (solo deepgram)
  if (gwName === 'deepgram') {
    try {
      await deepgramHttp('/register', {
        uuid,
        exten: sess.exten || '',
        caller: sess.caller || '',
        callername: sess.callername || '',
        dir
      });
      console.log(`[TAP][DG] register → deepgram-gw uuid=${uuid} dir=${dir} exten=${sess.exten || ''}`);
    } catch (e) {
      console.warn(`[TAP][DG] register failed uuid=${uuid} dir=${dir}: ${e.message}`);
    }
  }

  console.log(`[TAP] ExternalMedia → gw=${gwName} host=${externalHost} uuid=${uuid} dir=${dir}`);

  // APP REAL: entra en TAP_APP_NAME con role=em
  // Para MTI dejamos args clásicos: `${uuid},em,mti`
  // Para Deepgram añadimos metadata + dir
  let emArgs;
  if (gwName === 'mti') {
    emArgs = `${uuid},em,mti`;
  } else {
    emArgs = `${uuid},em,deepgram,${sess.exten || ''},${sess.caller || ''},${sess.callername || ''},${dir}`;
  }

  const em = await ari.channels.externalMedia({
    app: TAP_APP_NAME,
    appArgs: emArgs,
    external_host: externalHost,
    format: 'slin16',
    transport: 'udp',
    encapsulation: 'rtp'
  });

  await addToBridgeWithRetry(bridge, em.id);

  if (!sess.emMeta) sess.emMeta = new Map();
  sess.emMeta.set(em.id, { gwName, rtpPort, dir });

  console.log(`[TAP] EM added em.id=${em.id} gw=${gwName} uuid=${uuid}`);
  return em.id;
}

// =======================
// GW-specific pipelines
// =======================

async function handleSnoopMTI({ ari, ch, uuid }) {
  console.log(`[TAP][MTI] StasisStart snoop ch=${ch.id} uuid=${uuid}`);

  mapChan(uuid, ch.id);

  let sess = sessions.get(uuid);
  if (!sess) {
    sess = { gw: 'mti', bridge: null, snoopId: ch.id, emIds: [], emMeta: new Map(), ari };
    sessions.set(uuid, sess);
  }

  // Bridge mixing (igual que antes)
  if (!sess.bridge) {
    const bridge = ari.Bridge();
    await bridge.create({ type: 'mixing' });
    sess.bridge = bridge;
    console.log(`[TAP][MTI] Bridge created id=${bridge.id} uuid=${uuid}`);
  }

  const bridge = sess.bridge;

  // Añade snoop a bridge
  await bridge.addChannel({ channel: ch.id });
  console.log('[TAP][MTI] Snoop added to bridge');

  // EM MTI dinámico
  const emId = await createExternalMediaForGw(ari, uuid, bridge, 'mti', sess);
  if (emId) {
    sess.emIds.push(emId);
    mapChan(uuid, emId);
  }

  ch.on('StasisEnd', () => {
    console.log(`[TAP][MTI] StasisEnd snoop ch=${ch.id} uuid=${uuid}`);
    cleanupSession(uuid, 'mti-snoop-stasis-end');
  });

  sessions.set(uuid, sess);
}

async function handleSnoopDeepgram({ ari, ch, uuid, exten, caller, callername, dir }) {
  console.log(`[TAP][DG] StasisStart snoop dir=${dir} ch=${ch.id} uuid=${uuid} exten=${exten}`);

  mapChan(uuid, ch.id);

  let sess = sessions.get(uuid);
  if (!sess) {
    sess = {
      gw: 'deepgram',
      bridge: null,
      bridgePromise: null,
      snoopId: null,
      emIds: [],
      emMeta: new Map(),
      ari,
      exten,
      caller,
      callername
    };
    sessions.set(uuid, sess);
  } else {
    // refresca metadata si llega en el segundo snoop
    sess.exten = exten || sess.exten;
    sess.caller = caller || sess.caller;
    sess.callername = callername || sess.callername;
  }

  // FIX 1: bridge single-flight
  // ✅ bridge independiente por cada dir
  const bridge = await getOrCreateBridgeDir(sess, ari, uuid, dir, 'DG');

  await bridge.addChannel({ channel: ch.id });
  console.log(`[TAP][DG] Snoop added to bridge dir=${dir} bridge=${bridge.id}`);

  const emId = await createExternalMediaForGw(ari, uuid, bridge, 'deepgram', sess, dir);

  if (emId) {
    sess.emIds.push(emId);
    mapChan(uuid, emId);
  }

  ch.on('StasisEnd', () => {
    console.log(`[TAP][DG] StasisEnd snoop ch=${ch.id} uuid=${uuid} dir=${dir}`);
    cleanupSession(uuid, 'dg-snoop-stasis-end');
  });

  sessions.set(uuid, sess);
}

// =======================
// Main
// =======================
(async () => {
  const ari = await client.connect(ARI_URL, ARI_USER, ARI_PASS);
  console.log('[TAP] Connected to ARI', ARI_URL, 'user', ARI_USER);

  ari.on('StasisStart', async (evt, ch) => {
    const app = evt.application;
    if (app !== TAP_APP_NAME) return;

    const args = evt.args || [];
    const uuid = args[0] || '(no-uuid)';
    const role = args[1] || 'snoop';
    const gw   = normalizeGw(args[2]);

    const exten      = args[3] || '';
    const caller     = args[4] || '';
    const callername = args[5] || '';
    const dir        = args[6] || 'both'; // in/out para deepgram

    // ExternalMedia entra también aquí, pero lo ignoramos siempre
    if (role === 'em' || String(ch.name || '').startsWith('UnicastRTP/')) {
      console.log(`[TAP] StasisStart ignored (EM): name=${ch.name} id=${ch.id} uuid=${uuid}`);
      return;
    }

    try {
      if (gw === 'mti') {
        await handleSnoopMTI({ ari, ch, uuid });
      } else if (gw === 'deepgram') {
        await handleSnoopDeepgram({ ari, ch, uuid, exten, caller, callername, dir });
      } else {
        await handleSnoopMTI({ ari, ch, uuid });
      }
    } catch (err) {
      console.error('[TAP] ❌ Error in GW flow:', err?.message || err);
      await cleanupSession(uuid, 'exception');
    }
  });

  // Cleanup por eventos globales
  ari.on('ChannelHangupRequest', async (ev) => {
    const channelId = ev.channel?.id;
    const uuid = findUuidByChannel(channelId);
    if (uuid) {
      console.log(`[TAP] ChannelHangupRequest channel=${channelId} uuid=${uuid}`);
      await cleanupSession(uuid, 'hangup-request');
    }
  });

  ari.on('StasisEnd', async (ev, ch) => {
    const channelId = ch?.id;
    const uuid = findUuidByChannel(channelId);
    if (uuid) {
      console.log(`[TAP] StasisEnd (global) channel=${channelId} uuid=${uuid}`);
      await cleanupSession(uuid, 'global-stasis-end');
    }
  });

  ari.start(TAP_APP_NAME);
  console.log(`[TAP] Listening ARI app: ${TAP_APP_NAME}`);

  // HTTP /start_tap
  const port = Number(TAP_HTTP_PORT);
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname !== '/start_tap') {
      res.statusCode = 404; return res.end('Not found');
    }

    const chan = parsed.query.chan;
    const uuid = parsed.query.uuid;
    const gw   = normalizeGw(parsed.query.gw);

    // metadata opcional (solo deepgram)
    const exten      = parsed.query.exten || '';
    const caller     = parsed.query.caller || '';
    const callername = parsed.query.callername || '';

    if (!chan || !uuid) {
      res.statusCode = 400; return res.end('Missing chan or uuid');
    }

    console.log(`[TAP] /start_tap chan=${chan} uuid=${uuid} gw=${gw} exten=${exten} caller=${caller}`);

    try {
      if (gw === 'mti') {
        // 🔒 Retrocompatible: un único snoop spy=both
        await ari.channels.snoopChannel({
          channelId: chan,
          app: TAP_APP_NAME,
          spy: 'both',
          appArgs: `${uuid},snoop,mti`
        });
      } else if (gw === 'deepgram') {
        // ✅ Dual snoop estricto
        const baseArgs = `${uuid},snoop,deepgram,${exten},${caller},${callername}`;

        await ari.channels.snoopChannel({
          channelId: chan,
          app: TAP_APP_NAME,
          spy: 'in',
          appArgs: `${baseArgs},in`
        });

        await ari.channels.snoopChannel({
          channelId: chan,
          app: TAP_APP_NAME,
          spy: 'out',
          appArgs: `${baseArgs},out`
        });
      } else {
        // fallback
        await ari.channels.snoopChannel({
          channelId: chan,
          app: TAP_APP_NAME,
          spy: 'both',
          appArgs: `${uuid},snoop,mti`
        });
      }

      res.statusCode = 200; res.end('OK');
    } catch (err) {
      console.error('[TAP] ❌ Error creating SnoopChannel:', err?.message || err);
      res.statusCode = 500; res.end('ERROR');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[TAP] HTTP listening on :${port} (/start_tap)`);
    console.log(`[TAP] MTI dynamic RTP range ${RTP_START}-${RTP_END}`);
    console.log(`[TAP] MTI register target http://${MTI_HTTP_HOST}:${MTI_HTTP_PORT}`);
    console.log(`[TAP] Deepgram RTP host ${RTP_HOST_DEEPGRAM || '(not set)'}`);
    console.log(`[TAP] Deepgram register target http://${DG_HTTP_HOST}:${DG_HTTP_PORT}`);
  });
})();
