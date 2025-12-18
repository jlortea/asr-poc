// tap-service.js (REFAC retrocompatible, MTI aislado, Deepgram separado + fixes)
// - /start_tap router por gw: mti | deepgram
// - MTI mantiene comportamiento EXACTO en audio:
//     snoop spy=both, bridge mixing, EM dinámico con /register en mti-gw
// - Deepgram:
//     dual-snoop (in/out) + bridges por dir + EM fijo por dir a RTP_HOST_DEEPGRAM_IN/OUT
//     signaling HTTP /register a deepgram-gw por cada stream (dir)
// - FIX: cleanup idempotente + destroy bridges deepgram por dir
// - Retrocompat si gw viene en lista (mti,deepgram): usa el primero
// - EXTENSIÓN MTI: /register hacia mti-gw incluye metadatos de agente
//      (agent_extension, agent_username, agent_id) para el START frame JSON.

const http   = require('http');
const url    = require('url');
const { connectAri } = require('./ari/ari-client');
const prom   = require('prom-client');

// =======================================================
// Prometheus metrics
// =======================================================
const register = prom.register;
prom.collectDefaultMetrics({ register });

const gTapSessionsActive = new prom.Gauge({
  name: 'tap_sessions_active',
  help: 'Active TAP sessions'
});

const cTapSessionsStarted = new prom.Counter({
  name: 'tap_sessions_started_total',
  help: 'TAP sessions started',
  labelNames: ['gw']
});

const cTapSessionsEnded = new prom.Counter({
  name: 'tap_sessions_ended_total',
  help: 'TAP sessions ended',
  labelNames: ['gw', 'reason']
});

const gTapEmActive = new prom.Gauge({
  name: 'tap_em_channels_active',
  help: 'Active ExternalMedia channels',
  labelNames: ['gw', 'dir']
});

const cTapEmCreated = new prom.Counter({
  name: 'tap_em_created_total',
  help: 'ExternalMedia channels created',
  labelNames: ['gw', 'dir']
});

const cTapEmDestroyed = new prom.Counter({
  name: 'tap_em_destroyed_total',
  help: 'ExternalMedia channels destroyed',
  labelNames: ['gw', 'dir', 'reason']
});

const cTapGatewayHttpErrors = new prom.Counter({
  name: 'tap_gateway_http_errors_total',
  help: 'HTTP errors calling downstream gateways (MTI / Deepgram)',
  labelNames: ['gw', 'op']
});

const cTapErrors = new prom.Counter({
  name: 'tap_errors_total',
  help: 'Unhandled errors in tap-service',
  labelNames: ['place', 'gw']
});

const gTapMtiPortsInUse = new prom.Gauge({
  name: 'tap_mti_ports_in_use',
  help: 'MTI dynamic RTP ports currently allocated'
});

// 🔢 métricas básicas adicionales para el dashboard unificado
const gTapSnoopActive = new prom.Gauge({
  name: 'tap_snoop_active',
  help: 'Active snoop channels (in/out, all gateways)'
});

const gTapExternalMediaActive = new prom.Gauge({
  name: 'tap_externalmedia_active',
  help: 'Active externalMedia channels (all gateways)'
});

const cTapCleanupTotal = new prom.Counter({
  name: 'tap_cleanup_total',
  help: 'cleanupSession calls',
  labelNames: ['gw', 'reason']
});

// === ENV ===
const {
  ARI_URL,
  ARI_USER,
  ARI_PASS,
  ASTERISK_HTTP_PREFIX,

  TAP_APP_NAME,
  TAP_HTTP_PORT,

  RTP_HOST_MTI,
  RTP_HOST_DEEPGRAM_IN,
  RTP_HOST_DEEPGRAM_OUT,

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


// === Bloque de ARI_BASE_URL
function stripSlashes(s) {
  return String(s || '').trim().replace(/^\/+|\/+$/g, '');
}

function stripTrailingSlash(s) {
  return String(s || '').trim().replace(/\/+$/g, '');
}

// Construye la base URL de ARI respetando prefix opcional y siendo retrocompatible
function buildAriBaseUrl(rawBase, rawPrefix) {
  const base = stripTrailingSlash(rawBase);
  const prefix = stripSlashes(rawPrefix);

  // Si no hay prefix, devolvemos base tal cual
  if (!prefix) return base;

  // Si el usuario ya incluyó el prefix en ARI_URL, no lo duplicamos
  // Ej: base termina en "/asterisk"
  if (base.endsWith('/' + prefix)) return base;

  return `${base}/${prefix}`;
}

const ARI_BASE_URL = buildAriBaseUrl(ARI_URL, ASTERISK_HTTP_PREFIX);


// === GW config ===
const GATEWAYS = {
  mti: {
    name: 'mti',
    rtpHost: RTP_HOST_MTI || null,
    dynamicPort: true
  },
  deepgram: {
    name: 'deepgram',
    rtpHostIn:  RTP_HOST_DEEPGRAM_IN  || null,
    rtpHostOut: RTP_HOST_DEEPGRAM_OUT || null,
    dynamicPort: false
  }
};

// === MTI HTTP control target ===
const MTI_HTTP_HOST = MTI_GW_HTTP_HOST || 'mti-gw';
const MTI_HTTP_PORT = Number(MTI_GW_HTTP_PORT || 9093);

// === Deepgram HTTP signaling target ===
const DG_HTTP_HOST = DEEPGRAM_GW_HTTP_HOST || 'deepgram-gw';
const DG_HTTP_PORT = Number(DEEPGRAM_GW_HTTP_PORT || 8080);

// === MTI RTP dynamic range ===
const RTP_START = Number(MTI_RTP_START || 41000);
const RTP_END   = Number(MTI_RTP_END   || 41999);
const usedPorts = new Set();

// === STATE ===
// uuid -> session
// MTI: { gw:'mti', bridge, snoopId, emIds[], emMeta(Map), ari, cleaned?,
//        agent_extension, agent_username, agent_id }
// Deepgram: { gw:'deepgram', bridges{in,out}, bridgePromises{in,out}, emIds[], emMeta(Map), ari,
//             exten, caller, callername, cleaned? }
const sessions = new Map();

// uuid -> { agent_extension, agent_username, agent_id }
// Solo usado para MTI: metadatos que queremos mandar al mti-gw en /register
const mtiAgentByUuid = new Map();

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
      gTapMtiPortsInUse.set(usedPorts.size);
      return p;
    }
  }
  return null;
}

function freePort(p) {
  if (!p) return;
  usedPorts.delete(p);
  gTapMtiPortsInUse.set(usedPorts.size);
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
    req.on('error', (err) => {
      cTapGatewayHttpErrors.inc({ gw: 'mti', op: pathname });
      reject(err);
    });
    req.on('timeout', () => {
      cTapGatewayHttpErrors.inc({ gw: 'mti', op: pathname });
      req.destroy(new Error('timeout'));
    });
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
    req.on('error', (err) => {
      cTapGatewayHttpErrors.inc({ gw: 'deepgram', op: pathname });
      reject(err);
    });
    req.on('timeout', () => {
      cTapGatewayHttpErrors.inc({ gw: 'deepgram', op: pathname });
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

async function resolveAriChannelIdByName(ari, channelName) {
  const chans = await ari.channels.list();
  let match = chans.find(c => c && c.name === channelName);

  // fallback por si hay pequeñas variaciones
  if (!match) match = chans.find(c => c && typeof c.name === 'string' && c.name.startsWith(channelName));

  if (!match || !match.id) {
    throw new Error(`ARI channel not found by name="${channelName}" (active=${chans.length})`);
  }
  return match.id;
}

async function snoopChannelCompat(ari, params) {
  // params = { channelId, app, spy, appArgs }
  try {
    return await ari.channels.snoopChannel(params);
  } catch (e) {
    // Solo hacemos fallback si realmente es "not found"
    const is404 = (e && (e.statusCode === 404 || String(e.message || '').includes('-> 404')));
    const looksLikeName = params.channelId && String(params.channelId).includes('/');

    if (!is404 || !looksLikeName) throw e;

    const resolvedId = await resolveAriChannelIdByName(ari, params.channelId);
    console.log(`[TAP] ARI snoop fallback: name="${params.channelId}" -> id="${resolvedId}"`);
    return await ari.channels.snoopChannel({ ...params, channelId: resolvedId });
  }
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

// bridge por dirección para Deepgram (evita mezcla)
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
// Cleanup (idempotente)
// =======================
const cleanupSession = async (uuid, why = 'cleanup') => {
  const sess = sessions.get(uuid);
  if (!sess) return;

  if (sess.cleaned) return;
  sess.cleaned = true;

  console.log(`[TAP] cleanup uuid=${uuid} gw=${sess.gw} reason=${why}`);

  // métrica global de cleanup
  cTapCleanupTotal.inc({
    gw: sess.gw || 'unknown',
    reason: why || 'unknown'
  });

  const { bridge, snoopId, emIds, emMeta, ari } = sess;

  // metric: session ended
  cTapSessionsEnded.inc({
    gw: sess.gw || 'unknown',
    reason: why || 'unknown'
  });

  // EM metrics + MTI unregister dynamic ports
  if (emMeta) {
    for (const [emId, meta] of emMeta.entries()) {
      const gwName = meta?.gwName || sess.gw || 'unknown';
      const dir    = meta?.dir || 'both';

      // EM destroyed
      cTapEmDestroyed.inc({ gw: gwName, dir, reason: why || 'cleanup' });
      gTapEmActive.dec({ gw: gwName, dir });
      gTapExternalMediaActive.dec();

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

  // Deepgram unregister por uuid
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

  // destruir bridge MTI (si existe)
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

  // cuelga snoops
  await hangupIfAlive(snoopId, 'snoop');

  // cuelga EM
  if (Array.isArray(emIds)) {
    for (const emId of emIds) await hangupIfAlive(emId, 'externalMedia');
  }

  if (snoopId) unmapChan(snoopId);
  if (Array.isArray(emIds)) for (const emId of emIds) unmapChan(emId);

  sessions.delete(uuid);
  gTapSessionsActive.set(sessions.size);

  // Limpieza de metadatos MTI
  mtiAgentByUuid.delete(uuid);
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

  // validar host según gateway
  if (gwName === 'mti' && !gw.rtpHost) {
    console.warn(`[TAP] Gateway mti without RTP host configured uuid=${uuid}`);
    return null;
  }
  if (gwName === 'deepgram' && (!gw.rtpHostIn || !gw.rtpHostOut)) {
    console.warn(`[TAP] Gateway deepgram without RTP host IN/OUT configured uuid=${uuid}`);
    return null;
  }

  // externalHost base
  let externalHost = (gwName === 'mti') ? gw.rtpHost : gw.rtpHostIn;
  let rtpPort = null;

  // Deepgram por-dir (dual-port)
  if (gwName === 'deepgram') {
    if (dir === 'in') externalHost = gw.rtpHostIn;
    else if (dir === 'out') externalHost = gw.rtpHostOut;
    else externalHost = gw.rtpHostIn; // fallback
  }

  // MTI dynamic port + register
  if (gw.dynamicPort) {
    rtpPort = allocPort();
    if (!rtpPort) throw new Error('No free MTI RTP ports in range');

    const hostOnly = parseHostOnly(gw.rtpHost);
    externalHost = `${hostOnly}:${rtpPort}`;

    // Metadatos opcionales de agente (si no existen, enviamos "" según especificación MTI)
    const agent_extension = (sess.agent_extension || '');
    const agent_username  = (sess.agent_username || '');
    const agent_id        = (sess.agent_id || '');

    const reg = await mtiHttp('/register', {
      uuid,
      port: rtpPort,
      agent_extension,
      agent_username,
      agent_id
    });
    if (reg.status !== 200) {
      freePort(rtpPort);
      throw new Error(`MTI register failed status=${reg.status} body=${reg.body}`);
    }

    console.log(
      `[TAP][MTI] reserved port=${rtpPort} uuid=${uuid} ` +
      `agent_extension=${agent_extension} agent_username=${agent_username} agent_id=${agent_id}`
    );
  }

  // signaling Deepgram antes de crear EM
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

  // appArgs
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

  // métricas EM
  cTapEmCreated.inc({ gw: gwName, dir });
  gTapEmActive.inc({ gw: gwName, dir });
  gTapExternalMediaActive.inc();

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
    // Recuperamos metadatos opcionales para MTI (si los hubiera)
    const meta = mtiAgentByUuid.get(uuid) || {};
    sess = {
      gw: 'mti',
      bridge: null,
      snoopId: ch.id,
      emIds: [],
      emMeta: new Map(),
      ari,
      agent_extension: meta.agent_extension || '',
      agent_username: meta.agent_username || '',
      agent_id: meta.agent_id || ''
    };
    sessions.set(uuid, sess);
    cTapSessionsStarted.inc({ gw: 'mti' });
    gTapSessionsActive.set(sessions.size);
  }

  // Bridge mixing MTI
  if (!sess.bridge) {
    const bridge = ari.Bridge();
    await bridge.create({ type: 'mixing' });
    sess.bridge = bridge;
    console.log(`[TAP][MTI] Bridge created id=${bridge.id} uuid=${uuid}`);
  }

  const bridge = sess.bridge;

  await bridge.addChannel({ channel: ch.id });
  console.log('[TAP][MTI] Snoop added to bridge');

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
      bridges: null,
      bridgePromises: null,
      emIds: [],
      emMeta: new Map(),
      ari,
      exten,
      caller,
      callername
    };
    sessions.set(uuid, sess);
    cTapSessionsStarted.inc({ gw: 'deepgram' });
    gTapSessionsActive.set(sessions.size);
  } else {
    sess.exten = exten || sess.exten;
    sess.caller = caller || sess.caller;
    sess.callername = callername || sess.callername;
  }

  // bridge independiente por cada dir
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
  const ari = await connectAri(ARI_BASE_URL, ARI_USER, ARI_PASS);
  console.log('[TAP] Connected to ARI', ARI_BASE_URL, 'user', ARI_USER);

  ari.on('error', (err) => {
    console.error('[TAP] ARI adapter error:', err?.message || err);
  });

  ari.on('StasisStart', async (evt, ch) => {
    if (evt.application !== TAP_APP_NAME) return;

    const args = evt.args || [];
    const uuid = args[0] || '(no-uuid)';
    const role = args[1] || 'snoop';
    const gw   = normalizeGw(args[2]);

    const exten      = args[3] || '';
    const caller     = args[4] || '';
    const callername = args[5] || '';
    const dir        = args[6] || 'both'; // in/out para deepgram

    // Ignorar ExternalMedia re-entries
    if (role === 'em' || String(ch.name || '').startsWith('UnicastRTP/')) {
      console.log(`[TAP] StasisStart ignored (EM): name=${ch.name} id=${ch.id} uuid=${uuid}`);
      return;
    }

    // métrica de snoop activo (uno por canal snoop)
    gTapSnoopActive.inc();

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
      cTapErrors.inc({ place: 'stasis_start', gw });
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
      const name = String(ch?.name || '');
      const isEm = name.startsWith('UnicastRTP/');

      // si el canal que termina es un snoop, decrementamos
      if (!isEm) {
        gTapSnoopActive.dec();
      }
      // (externalMedia ya se descuenta en cleanupSession vía emMeta)

      console.log(`[TAP] StasisEnd (global) channel=${channelId} uuid=${uuid}`);
      await cleanupSession(uuid, 'global-stasis-end');
    }
  });

  ari.start(TAP_APP_NAME);
  console.log(`[TAP] Listening ARI app: ${TAP_APP_NAME}`);

  // HTTP /start_tap + /metrics
  const port = Number(TAP_HTTP_PORT);
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);

    // Endpoint Prometheus
    if (parsed.pathname === '/metrics') {
      res.statusCode = 200;
      res.setHeader('Content-Type', register.contentType);
      return res.end(await register.metrics());
    }

    if (parsed.pathname !== '/start_tap') {
      res.statusCode = 404; return res.end('Not found');
    }

    const chan = parsed.query.chan;
    const uuid = parsed.query.uuid;
    const gw   = normalizeGw(parsed.query.gw);

    // Campos usados para Deepgram (widget) y/o MTI (metadatos de agente)
    const exten      = parsed.query.exten || '';
    const caller     = parsed.query.caller || '';
    const callername = parsed.query.callername || '';

    // Campos específicos MTI (opcionales, string opaco)
    // Si no vienen, usamos fallback razonable:
    //  - agent_extension: exten
    //  - agent_username / agent_id: vacío
    const agent_extension = parsed.query.agent_extension || exten || '';
    const agent_username  = parsed.query.agent_username  || '';
    const agent_id        = parsed.query.agent_id        || '';

    if (!chan || !uuid) {
      res.statusCode = 400; return res.end('Missing chan or uuid');
    }

    console.log(
      `[TAP] /start_tap chan=${chan} uuid=${uuid} gw=${gw} ` +
      `exten=${exten} caller=${caller} agent_extension=${agent_extension} agent_username=${agent_username} agent_id=${agent_id}`
    );

    // Guardamos metadatos MTI para usarlos más tarde cuando creemos el EM y llamemos a mti-gw /register
    if (gw === 'mti') {
      mtiAgentByUuid.set(uuid, {
        agent_extension,
        agent_username,
        agent_id
      });
    }

  try {
    if (gw === 'mti') {
      await snoopChannelCompat(ari, {
        channelId: chan,
        app: TAP_APP_NAME,
        spy: 'both',
        appArgs: `${uuid},snoop,mti`
      });
    } else if (gw === 'deepgram') {
      const baseArgs = `${uuid},snoop,deepgram,${exten},${caller},${callername}`;

      await snoopChannelCompat(ari, {
        channelId: chan,
        app: TAP_APP_NAME,
        spy: 'in',
        appArgs: `${baseArgs},in`
      });

      await snoopChannelCompat(ari, {
        channelId: chan,
        app: TAP_APP_NAME,
        spy: 'out',
        appArgs: `${baseArgs},out`
      });
    } else {
      await snoopChannelCompat(ari, {
        channelId: chan,
        app: TAP_APP_NAME,
        spy: 'both',
        appArgs: `${uuid},snoop,mti`
      });
    }

    res.statusCode = 200;
    res.end('OK');
  } catch (err) {
    console.error('[TAP] ❌ Error creating SnoopChannel:', err?.message || err);
    cTapErrors.inc({ place: 'start_tap', gw });
    res.statusCode = 500;
    res.end('ERROR');
  }

  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[TAP] HTTP listening on :${port} (/start_tap, /metrics)`);
    console.log(`[TAP] MTI dynamic RTP range ${RTP_START}-${RTP_END}`);
    console.log(`[TAP] MTI register target http://${MTI_HTTP_HOST}:${MTI_HTTP_PORT}`);
    console.log(`[TAP] Deepgram RTP host IN  ${RTP_HOST_DEEPGRAM_IN  || '(not set)'}`);
    console.log(`[TAP] Deepgram RTP host OUT ${RTP_HOST_DEEPGRAM_OUT || '(not set)'}`);
    console.log(`[TAP] Deepgram register target http://${DG_HTTP_HOST}:${DG_HTTP_PORT}`);
  });
})();
