// ari-app.js
// ARI app: crea bridge, origina al agente y añade ExternalMedia por RTP/UDP (Plan B)
const client = require('ari-client');

const {
  ARI_URL,
  ARI_USER,
  ARI_PASS,
  APP_NAME,
  RTP_HOST
} = process.env;

if (!ARI_URL || !RTP_HOST || !APP_NAME) {
  console.error('❌ Faltan variables de entorno requeridas (ARI_URL, RTP_HOST, APP_NAME)');
  process.exit(1);
}

// Estado por llamada
const handled = new Set();        // channel.id entrante ya montado
const bridges = new Map();        // callUid -> bridge
const outs = new Map();           // callUid -> out channel id
const ems = new Map();            // callUid -> externalMedia id
const chan2uid = new Map();       // channelId -> callUid  (índice inverso)
const timers = new Map();         // callUid -> timeout id (seguridad)

(async () => {
  const ari = await client.connect(ARI_URL, ARI_USER, ARI_PASS);

  const mapChan = (uid, channelId) => {
    if (channelId) chan2uid.set(channelId, uid);
  };

  const findUidByChannel = (channelId) => chan2uid.get(channelId);

  const disarmTimer = (uid) => {
    const t = timers.get(uid);
    if (t) { clearTimeout(t); timers.delete(uid); }
  };

  const armSafetyTimer = (uid, ms = 120000) => { // 120s opcional de seguridad
    disarmTimer(uid);
    timers.set(uid, setTimeout(() => cleanupByUid(uid, 'safety-timeout'), ms));
  };

  // Utilidad limpieza por callUid
  const cleanupByUid = async (uid, why = 'cleanup') => {
    const bridge = bridges.get(uid);
    const emId = ems.get(uid);
    const outId = outs.get(uid);
    console.log(`[ARI] cleanup uid=${uid} reason=${why}`);

    disarmTimer(uid);

    try { if (bridge) await bridge.destroy().catch(()=>{}); } catch {}
    try { if (emId) await ari.channels.get({ channelId: emId }).then(ch => ch.hangup()).catch(()=>{}); } catch {}
    try { if (outId) await ari.channels.get({ channelId: outId }).then(ch => ch.hangup()).catch(()=>{}); } catch {}

    // Limpia índices inversos
    if (emId) chan2uid.delete(emId);
    if (outId) chan2uid.delete(outId);
    // No conocemos aquí el incomingId, pero cuando llega StasisStart lo metemos (ver abajo)
    for (const [cid, u] of chan2uid.entries()) if (u === uid) chan2uid.delete(cid);

    bridges.delete(uid);
    ems.delete(uid);
    outs.delete(uid);
  };

  ari.on('StasisStart', async (evt, ch) => {
    const args = evt.args || [];

    // 1) Ignorar ExternalMedia (sin args)
    if (args.length === 0) {
      return;
    }

    // 2) Rama "joined": es el agente que acabamos de originar
    if (args[0] === 'joined') {
      const callUid = args[1];
      if (!callUid) return;

      try {
        const bridge = bridges.get(callUid);
        if (!bridge) return;

        await ch.answer().catch(()=>{});
        await bridge.addChannel({ channel: ch.id });
        mapChan(callUid, ch.id);
        console.log(`[ARI] agent ${ch.id} added to bridge uid=${callUid}`);
        armSafetyTimer(callUid); // rearma el watchdog
      } catch (e) {
        console.error('[ARI] error adding agent to bridge:', e?.message || e);
        await cleanupByUid(callUid, 'agent-join-error');
      }
      return;
    }

    // 3) Entrante real: args = [target, callUid, lang]
    const incomingId = ch.id;
    if (handled.has(incomingId)) return;
    handled.add(incomingId);

    const target  = args[0] || 'PJSIP/agente';
    const callUid = args[1] || incomingId;
    const lang    = args[2] || 'es';

    mapChan(callUid, incomingId);
    console.log(`[ARI] StasisStart incoming ch=${incomingId} uid=${callUid} → target=${target}`);

    try {
      // Bridge
      const bridge = ari.Bridge();
      await bridge.create({ type: 'mixing' });
      await bridge.addChannel({ channel: incomingId });
      bridges.set(callUid, bridge);
      console.log('[ARI] bridge created & incoming added');

      // Originate al agente
      const out = ari.Channel();
      outs.set(callUid, out.id);
      mapChan(callUid, out.id);
      out.originate({
        endpoint: target,
        app: APP_NAME,
        appArgs: `joined,${callUid},${lang}`,
        callerId: 'ASR Test',
        timeout: 25
      }).then(() => console.log('[ARI] originate sent'))
        .catch(err => {
          console.error('[ARI] originate error:', err?.message || err);
          cleanupByUid(callUid, 'originate-failed');
        });

      // ExternalMedia → RTP/UDP hacia el gateway
      console.log(`[ARI] creating ExternalMedia RTP → ${RTP_HOST}`);
      const em = await ari.channels.externalMedia({
        app: APP_NAME,
        external_host: RTP_HOST,   // ej. 192.168.1.65:40000
        format: 'slin16',
        transport: 'udp',
        encapsulation: 'rtp'
      });
      ems.set(callUid, em.id);
      mapChan(callUid, em.id);
      console.log('[ARI] externalMedia channel id=', em.id);

      await bridge.addChannel({ channel: em.id });
      console.log('[ARI] externalMedia added to bridge');

      // Limpiezas simétricas: si cuelga cualquiera ⇒ teardown
      ch.on('ChannelDestroyed', async () => cleanupByUid(callUid, 'incoming hangup'));
      em.on('ChannelDestroyed', async () => cleanupByUid(callUid, 'externalMedia hangup'));
      out.on('ChannelDestroyed', async () => cleanupByUid(callUid, 'agent hangup'));

      // Watchdog general
      armSafetyTimer(callUid);

    } catch (err) {
      console.error('[ARI] flow error:', err?.message || err);
      await cleanupByUid(callUid, 'exception');
    }
  });

  // Cuelgue asíncrono (por cualquier lado) → localizamos uid y limpiamos
  ari.on('ChannelHangupRequest', async (ev) => {
    const uid = findUidByChannel(ev.channel.id);
    if (uid) await cleanupByUid(uid, 'hangup-request');
  });

  ari.on('StasisEnd', async (ev, ch) => {
    const uid = findUidByChannel(ch.id);
    if (uid) await cleanupByUid(uid, 'stasis-end');
  });

  ari.start(APP_NAME);
})();
