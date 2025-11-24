// tap-service.js (OPCIÓN 2 DEFINITIVA + FIX ExternalMedia app real)
//  1) expone /start_tap (HTTP)
//  2) crea SnoopChannel sobre el canal real
//  3) crea bridges + ExternalMedia
//  4) Para MTI usa puerto RTP dinámico por llamada:
//       - reserva puerto en rango
//       - registra (uuid,puerto) en mti-gw por HTTP
//       - ExternalMedia → RTP_HOST_MTI:PUERTO
//
// FIX:
//   ExternalMedia debe entrar a una app ARI EXISTENTE (TAP_APP_NAME),
//   si no Asterisk lo cuelga al instante => Channel not found.
//   Lo ignoramos en StasisStart por nombre UnicastRTP/ o role=em.

const http   = require('http');
const url    = require('url');
const client = require('ari-client');

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
  MTI_RTP_END
} = process.env;

if (!ARI_URL || !ARI_USER || !ARI_PASS || !TAP_APP_NAME || !TAP_HTTP_PORT) {
  console.error('[TAP] ❌ Missing env (ARI_URL, ARI_USER, ARI_PASS, TAP_APP_NAME, TAP_HTTP_PORT)');
  process.exit(1);
}

const GATEWAYS = {
  mti: {
    name: 'mti',
    rtpHost: RTP_HOST_MTI || null,
    dynamicPort: true
  },
  deepgram: {
    name: 'deepgram',
    rtpHost: RTP_HOST_DEEPGRAM || null,
    dynamicPort: false
  }
};

const MTI_HTTP_HOST = MTI_GW_HTTP_HOST || 'mti-gw';
const MTI_HTTP_PORT = Number(MTI_GW_HTTP_PORT || 9093);

const RTP_START = Number(MTI_RTP_START || 41000);
const RTP_END   = Number(MTI_RTP_END   || 41999);

const usedPorts = new Set();

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

const sessions = new Map();   // uuid -> { bridge, snoopId, emIds, emMeta, ari }
const chan2uuid = new Map();  // channelId -> uuid

const mapChan = (uuid, channelId) => {
  if (!uuid || !channelId) return;
  chan2uuid.set(channelId, uuid);
};
const unmapChan = (channelId) => {
  if (!channelId) return;
  chan2uuid.delete(channelId);
};
const findUuidByChannel = (channelId) => chan2uuid.get(channelId);

const cleanupSession = async (uuid, why = 'cleanup') => {
  const sess = sessions.get(uuid);
  if (!sess) return;

  console.log(`[TAP] cleanup uuid=${uuid} reason=${why}`);

  const { bridge, snoopId, emIds, emMeta, ari } = sess;

  if (emMeta) {
    for (const [emId, meta] of emMeta.entries()) {
      if (meta?.gwName === 'mti' && meta?.rtpPort) {
        try {
          await mtiHttp('/unregister', { port: meta.rtpPort });
          console.log(`[TAP] Unregistered MTI port=${meta.rtpPort} uuid=${uuid}`);
        } catch (e) {
          console.warn(`[TAP] unregister MTI failed port=${meta.rtpPort}: ${e.message}`);
        } finally {
          freePort(meta.rtpPort);
        }
      }
    }
  }

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

function parseGwList(raw) {
  if (!raw) return ['mti'];
  if (Array.isArray(raw)) raw = raw[0];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

// retry directo sobre addChannel
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

async function createExternalMediaForGw(ari, uuid, bridge, gwName, sess) {
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

    console.log(`[TAP] MTI reserved port=${rtpPort} and registered uuid=${uuid}`);
  }

  console.log(`[TAP] ExternalMedia → gw=${gwName} host=${externalHost} uuid=${uuid}`);

  // 👇 APP REAL: entra en TAP_APP_NAME con role=em
  const em = await ari.channels.externalMedia({
    app: TAP_APP_NAME,
    appArgs: `${uuid},em,${gwName}`,
    external_host: externalHost,
    format: 'slin16',
    transport: 'udp',
    encapsulation: 'rtp'
  });

  await addToBridgeWithRetry(bridge, em.id);

  if (!sess.emMeta) sess.emMeta = new Map();
  sess.emMeta.set(em.id, { gwName, rtpPort });

  console.log(`[TAP] EM added to bridge em.id=${em.id} gw=${gwName} uuid=${uuid}`);

  return em.id;
}

(async () => {
  const ari = await client.connect(ARI_URL, ARI_USER, ARI_PASS);
  console.log('[TAP] Connected to ARI', ARI_URL, 'user', ARI_USER);

  ari.on('StasisStart', async (evt, ch) => {
    const app = evt.application;
    if (app !== TAP_APP_NAME) return;

    const args = evt.args || [];
    const uuid = args[0] || '(no-uuid)';
    const role = args[1] || 'snoop';
    const gwArg = args[2] || 'mti';

    // ExternalMedia entra aquí también, pero lo ignoramos
    if (role === 'em' || String(ch.name || '').startsWith('UnicastRTP/')) {
      console.log(`[TAP] StasisStart ignored (EM): name=${ch.name} id=${ch.id} uuid=${uuid}`);
      return;
    }

    const gwList = parseGwList(gwArg);

    console.log(`[TAP] StasisStart role=snoop ch=${ch.id} uuid=${uuid} gw=[${gwList.join(',')}]`);

    mapChan(uuid, ch.id);

    try {
      let sess = sessions.get(uuid);
      if (!sess) {
        sess = { bridge: null, snoopId: ch.id, emIds: [], emMeta: new Map(), ari };
        sessions.set(uuid, sess);
      }

      if (!sess.bridge) {
        const bridge = ari.Bridge();
        await bridge.create({ type: 'mixing' });
        sess.bridge = bridge;
        console.log(`[TAP] Bridge created id=${bridge.id} uuid=${uuid}`);
      }

      const bridge = sess.bridge;

      await bridge.addChannel({ channel: ch.id });
      console.log('[TAP] Snoop added to bridge');

      for (const gwName of gwList) {
        const emId = await createExternalMediaForGw(ari, uuid, bridge, gwName, sess);
        if (emId) {
          sess.emIds.push(emId);
          mapChan(uuid, emId);
        }
      }

      sessions.set(uuid, sess);

      ch.on('StasisEnd', () => {
        console.log(`[TAP] StasisEnd (snoop) ch=${ch.id} uuid=${uuid}`);
        cleanupSession(uuid, 'snoop-stasis-end');
      });

    } catch (err) {
      console.error('[TAP] ❌ Error in TAP flow:', err?.message || err);
      await cleanupSession(uuid, 'exception');
    }
  });

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

  const port = Number(TAP_HTTP_PORT);
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname !== '/start_tap') {
      res.statusCode = 404; return res.end('Not found');
    }

    const chan = parsed.query.chan;
    const uuid = parsed.query.uuid;
    const gwParam = parsed.query.gw || 'mti';

    if (!chan || !uuid) {
      res.statusCode = 400; return res.end('Missing chan or uuid');
    }

    console.log(`[TAP] /start_tap chan=${chan} uuid=${uuid} gw=${gwParam}`);

    try {
      await ari.channels.snoopChannel({
        channelId: chan,
        app: TAP_APP_NAME,
        spy: 'both',
        appArgs: `${uuid},snoop,${gwParam}`
      });

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
  });
})();
