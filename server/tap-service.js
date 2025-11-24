// tap-service.js
// Microservicio que:
//  1) expone /start_tap (HTTP) para que el dialplan lo llame con CURL()
//  2) usa ARI para crear un SnoopChannel sobre el canal real
//  3) crea un bridge por llamada y mete ahí:
//       - el canal Snoop/*
//       - uno o varios ExternalMedia hacia gateways RTP (mti, deepgram)
//  4) NO entra en bucle porque solo trata como "snoop" a los canales Snoop/*
//
// Gateways soportados (por configuración .env):
//   - mti      → RTP_HOST_MTI      (cliente AudioSocket MTI)
//   - deepgram → RTP_HOST_DEEPGRAM (tu gateway Deepgram)

const http   = require('http');
const url    = require('url');
const client = require('ari-client');

const {
  ARI_URL,
  ARI_USER,
  ARI_PASS,
  TAP_APP_NAME,
  TAP_HTTP_PORT,
  RTP_HOST_MTI,        // ej: "192.168.1.65:40010"
  RTP_HOST_DEEPGRAM    // ej: "192.168.1.65:40000"
} = process.env;

if (!ARI_URL || !ARI_USER || !ARI_PASS || !TAP_APP_NAME || !TAP_HTTP_PORT) {
  console.error('[TAP] ❌ Faltan variables de entorno (ARI_URL, ARI_USER, ARI_PASS, TAP_APP_NAME, TAP_HTTP_PORT)');
  process.exit(1);
}

// Mapa de gateways disponibles
const GATEWAYS = {
  mti: {
    name: 'mti',
    rtpHost: RTP_HOST_MTI || null
  },
  deepgram: {
    name: 'deepgram',
    rtpHost: RTP_HOST_DEEPGRAM || null
  }
};

// Estado por sesión TAP (uuid)
const sessions   = new Map(); // uuid -> { bridge, snoopId, emIds: [], ari }
const chan2uuid  = new Map(); // channelId -> uuid (índice inverso para cleanup)

const mapChan = (uuid, channelId) => {
  if (!uuid || !channelId) return;
  chan2uuid.set(channelId, uuid);
};

const unmapChan = (channelId) => {
  if (!channelId) return;
  chan2uuid.delete(channelId);
};

const findUuidByChannel = (channelId) => chan2uuid.get(channelId);

// Limpieza de una sesión completa (bridge + snoop + EMs)
const cleanupSession = async (uuid, why = 'cleanup') => {
  const sess = sessions.get(uuid);
  if (!sess) return; // idempotente

  console.log(`[TAP] cleanup uuid=${uuid} reason=${why}`);

  const { bridge, snoopId, emIds, ari } = sess;

  // Destruye bridge
  if (bridge) {
    try {
      await bridge.destroy().catch(() => {});
    } catch (_) {}
  }

  // Helper: cuelga canal si sigue vivo
  const hangupIfAlive = async (channelId, label) => {
    if (!channelId) return;
    try {
      const ch = await ari.channels.get({ channelId }).catch(() => null);
      if (ch) {
        console.log(`[TAP] Hanging up ${label} channelId=${channelId} uuid=${uuid}`);
        await ch.hangup().catch(() => {});
      }
    } catch (_) {}
  };

  await hangupIfAlive(snoopId, 'snoop');

  if (Array.isArray(emIds)) {
    for (const emId of emIds) {
      await hangupIfAlive(emId, 'externalMedia');
    }
  }

  // Limpia índices inversos
  if (snoopId) unmapChan(snoopId);
  if (Array.isArray(emIds)) {
    for (const emId of emIds) {
      if (emId) unmapChan(emId);
    }
  }

  sessions.delete(uuid);
};

// Parse lista de gateways desde query o args
function parseGwList(raw) {
  if (!raw) return ['mti']; // por defecto solo mti
  if (Array.isArray(raw)) raw = raw[0];
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Crea ExternalMedia para un gateway concreto siguiendo el patrón oficial:
//   - se crea un Channel() local
//   - se engancha a su 'StasisStart' para meterlo al bridge
//   - se llama a externalMedia({ app: TAP_APP_NAME, ... })
//   - el id del canal EM es externalChannel.id
async function createExternalMediaForGw(ari, uuid, bridge, gwName) {
  const gw = GATEWAYS[gwName];
  if (!gw) {
    console.warn(`[TAP] Gateway desconocido gw=${gwName} uuid=${uuid}`);
    return null;
  }
  if (!gw.rtpHost) {
    console.warn(`[TAP] Gateway ${gwName} sin RTP_HOST configurado (ignorado) uuid=${uuid}`);
    return null;
  }

  console.log(`[TAP] ExternalMedia → gw=${gwName} host=${gw.rtpHost} uuid=${uuid}`);

  // Creamos un objeto Channel específico para este EM
  const externalChannel = ari.Channel();

  // Cuando este canal EM entre en Stasis(TAP_APP_NAME), lo añadimos al bridge
  externalChannel.on('StasisStart', async (_evt, emChan) => {
    try {
      await bridge.addChannel({ channel: emChan.id });
      console.log(`[TAP] EM channel ${emChan.id} añadido al bridge ${bridge.id} gw=${gwName} uuid=${uuid}`);
    } catch (err) {
      console.error(`[TAP] Error añadiendo EM ${emChan.id} al bridge ${bridge.id}:`, err?.message || err);
    }
  });

  // Lanzamos el ExternalMedia real
  await externalChannel.externalMedia({
    app: TAP_APP_NAME,                    // misma app ARI
    appArgs: `${uuid},em,${gwName}`,      // por si quieres loguear/filtrar después
    external_host: gw.rtpHost,            // ej: "192.168.1.65:40010"
    format: 'slin16',
    transport: 'udp',
    encapsulation: 'rtp'
    // direction: 'both' // opcional según versión de Asterisk
  });

  // externalChannel.id es el id que usará Asterisk para el canal UnicastRTP/...
  mapChan(uuid, externalChannel.id);
  return externalChannel.id;
}

(async () => {
  const ari = await client.connect(ARI_URL, ARI_USER, ARI_PASS);
  console.log('[TAP] Conectado a ARI en', ARI_URL, 'como', ARI_USER);

  // === 1) Manejo de la app ARI TAP_APP_NAME ===
  ari.on('StasisStart', async (evt, ch) => {
    const app = evt.application;
    if (app !== TAP_APP_NAME) return;  // ignoramos otras apps

    // *** CLAVE PARA EVITAR BUCLES ***
    // Solo tratamos como "snoop" a canales cuyo nombre empieza por Snoop/
    // (los ExternalMedia entran con nombre UnicastRTP/...)
    if (!ch.name || !ch.name.startsWith('Snoop/')) {
      console.log(`[TAP] StasisStart ignorado (no-Snoop): name=${ch.name} id=${ch.id}`);
      return;
    }

    const args   = evt.args || [];
    const uuid   = args[0] || '(sin-uuid)';
    const gwArg  = args[1] || 'mti';      // ej: "mti" o "mti,deepgram"
    const gwList = parseGwList(gwArg);

    console.log(`[TAP] StasisStart role=snoop ch=${ch.id} uuid=${uuid} gw=[${gwList.join(',')}]`);

    // Registramos el canal snoop -> uuid
    mapChan(uuid, ch.id);

    try {
      let sess = sessions.get(uuid);
      if (sess && sess.bridge) {
        console.log(`[TAP] Sesión ya existente para uuid=${uuid}, reusando bridge.`);
      } else {
        sess = { bridge: null, snoopId: ch.id, emIds: [], ari };
        sessions.set(uuid, sess);
      }

      // 1) Creamos bridge si no existe
      if (!sess.bridge) {
        const bridge = ari.Bridge();
        await bridge.create({ type: 'mixing' });
        sess.bridge = bridge;
        sessions.set(uuid, sess);
        console.log(`[TAP] Bridge creado ${bridge.id} para uuid=${uuid}`);
      }

      const bridge = sess.bridge;

      // 2) Añadimos el snoop al bridge
      await bridge.addChannel({ channel: ch.id });
      console.log('[TAP] Snoop añadido al bridge');

      // 3) Creamos ExternalMedia para cada gateway
      for (const gwName of gwList) {
        const emId = await createExternalMediaForGw(ari, uuid, bridge, gwName).catch(err => {
          console.error(`[TAP] Error creando ExternalMedia para gw=${gwName} uuid=${uuid}:`, err?.message || err);
          return null;
        });
        if (emId) {
          sess.emIds.push(emId);
        }
      }

      sessions.set(uuid, sess);

      // 4) Limpieza cuando el snoop salga de Stasis
      ch.on('StasisEnd', () => {
        console.log(`[TAP] StasisEnd (snoop) channel=${ch.id} uuid=${uuid}`);
        cleanupSession(uuid, 'snoop-stasis-end');
      });

    } catch (err) {
      console.error('[TAP] ❌ Error en flujo TAP (snoop):', err?.message || err);
      await cleanupSession(uuid, 'exception');
    }
  });

  // Limpieza adicional basada en eventos globales
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
  console.log(`[TAP] Escuchando app ARI: ${TAP_APP_NAME}`);

  // === 2) HTTP /start_tap → crea SnoopChannel ===
  const port = Number(TAP_HTTP_PORT);
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname !== '/start_tap') {
      res.statusCode = 404;
      return res.end('Not found');
    }

    const chan    = parsed.query.chan;
    const uuid    = parsed.query.uuid;
    const gwParam = parsed.query.gw || 'mti';  // por defecto
    const gwList  = parseGwList(gwParam);

    if (!chan || !uuid) {
      res.statusCode = 400;
      return res.end('Missing chan or uuid');
    }

    console.log(`[TAP] /start_tap chan=${chan} uuid=${uuid} gw=${gwParam}`);

    try {
      await ari.channels.snoopChannel({
        channelId: chan,
        app: TAP_APP_NAME,
        spy: 'both',
        whisper: 'none',
        appArgs: `${uuid},${gwList.join(',')}` // args[0]=uuid, args[1]=lista gateways
      });

      res.statusCode = 200;
      res.end('OK');
    } catch (err) {
      console.error('[TAP] ❌ Error en /start_tap snoopChannel:', err?.message || err);
      res.statusCode = 500;
      res.end('ERROR');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[TAP] HTTP server escuchando en :${port} (/start_tap)`);
  });
})();
