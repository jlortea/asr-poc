// server/ari/ari-client.js
// Minimal ARI adapter (REST + WebSocket) that works with Asterisk HTTP prefixes (e.g. /asterisk).
// Provides a subset of node-ari-client API used by tap-service.js.
//
// Supported:
// - ari.on(event, fn)
// - ari.start(appName)  -> opens WS events stream
// - ari.channels.snoopChannel({...})
// - ari.channels.externalMedia({...})
// - ari.channels.get({channelId}) -> returns Channel object with hangup() + on(...)
// - ari.Bridge() -> { create({type}), addChannel({channel}), destroy() }

'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const EventEmitter = require('events');
const WebSocket = require('ws');

function joinUrl(base, path) {
  if (!base.endsWith('/')) base += '/';
  if (path.startsWith('/')) path = path.slice(1);
  return base + path;
}

function buildAriWsUrl(httpBase, { appName, user, pass }) {
  // Build a WS URL that preserves any HTTP prefix in httpBase (e.g. /asterisk)
  // Example:
  //   http://host:8088/asterisk  -> ws://host:8088/asterisk/ari/events?...&subscribeAll=true
  const u = new URL(httpBase);

  // switch protocol
  u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';

  // normalize base path (keep prefix if any)
  const basePath = u.pathname.replace(/\/+$/, ''); // "" or "/asterisk"
  u.pathname = `${basePath}/ari/events`;

  // query string
  const qs = new URLSearchParams({
    app: appName,
    api_key: `${user}:${pass}`,
    subscribeAll: 'true'
  });
  u.search = qs.toString();

  return u.toString();
}

class AriChannel extends EventEmitter {
  constructor(adapter, data) {
    super();
    this._adapter = adapter;
    this.id = data?.id;
    this.name = data?.name;
    this.json = data || {};
  }
  async hangup() {
    if (!this.id) return;
    await this._adapter._requestJson('DELETE', `/ari/channels/${encodeURIComponent(this.id)}`);
  }
}

class AriBridge {
  constructor(adapter) {
    this._adapter = adapter;
    this.id = null;
    this.json = {};
  }
  async create({ type = 'mixing' } = {}) {
    const res = await this._adapter._requestJson('POST', `/ari/bridges`, { type });
    this.id = res?.id || this.id;
    this.json = res || {};
    return this;
  }
  async addChannel({ channel }) {
    if (!this.id) throw new Error('Bridge not created');
    await this._adapter._requestJson('POST', `/ari/bridges/${encodeURIComponent(this.id)}/addChannel`, { channel });
  }
  async destroy() {
    if (!this.id) return;
    await this._adapter._requestJson('DELETE', `/ari/bridges/${encodeURIComponent(this.id)}`);
  }
}

class AriAdapter extends EventEmitter {
  constructor({ baseUrl, user, pass }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // may include /asterisk prefix
    this.user = user;
    this.pass = pass;

    this._http = this.baseUrl.startsWith('https://') ? https : http;
    this._basic = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');

    // Per-channel emitters (so code can do: ch.on('StasisEnd', ...))
    this._channels = new Map(); // id -> AriChannel

    this.channels = {
      snoopChannel: (p) => this._snoopChannel(p),
      externalMedia: (p) => this._externalMedia(p),
      get: (p) => this._getChannel(p)
    };
  }

  Bridge() {
    return new AriBridge(this);
  }

  async start(appName) {
    // ARI events WS: <base-with-prefix>/ari/events?app=...&api_key=user:pass&subscribeAll=true
    const wsUrl = buildAriWsUrl(this.baseUrl, {
      appName,
      user: this.user,
      pass: this.pass
    });

    this._ws = new WebSocket(wsUrl);
    this._ws.on('open', () => this.emit('_ws_open'));
    this._ws.on('error', (err) => this.emit('error', err));
    this._ws.on('close', () => this.emit('_ws_close'));

    this._ws.on('message', (buf) => {
      let ev;
      try { ev = JSON.parse(buf.toString('utf8')); } catch { return; }
      const type = ev?.type;
      if (!type) return;

      // attach channel object (when present)
      const chData = ev?.channel;
      const ch = chData?.id ? this._getOrCreateChannelFromEvent(chData) : null;

      // emit on ari (global)
      // match node-ari-client signature: (event, channel)
      this.emit(type, ev, ch);

      // emit on channel emitter too (when present)
      if (ch) ch.emit(type, ev, ch);
    });
  }

  _getOrCreateChannelFromEvent(chData) {
    const id = chData.id;
    let ch = this._channels.get(id);
    if (!ch) {
      ch = new AriChannel(this, chData);
      this._channels.set(id, ch);
    } else {
      // refresh basic fields
      ch.name = chData.name || ch.name;
      ch.json = chData;
    }
    return ch;
  }

  async _getChannel({ channelId }) {
    const res = await this._requestJson('GET', `/ari/channels/${encodeURIComponent(channelId)}`);
    const ch = this._getOrCreateChannelFromEvent(res);
    return ch;
  }

  async _snoopChannel({ channelId, app, spy = 'both', appArgs = '' }) {
    const res = await this._requestJson(
      'POST',
      `/ari/channels/${encodeURIComponent(channelId)}/snoop`,
      { app, spy, appArgs }
    );
    return this._getOrCreateChannelFromEvent(res);
  }

  async _externalMedia({ app, appArgs = '', external_host, format = 'slin16', transport = 'udp', encapsulation = 'rtp' }) {
    const res = await this._requestJson(
      'POST',
      `/ari/channels/externalMedia`,
      { app, appArgs, external_host, format, transport, encapsulation }
    );
    return this._getOrCreateChannelFromEvent(res);
  }

  async _requestJson(method, path, queryObj) {
    const u = new URL(joinUrl(this.baseUrl, path));
    if (queryObj && typeof queryObj === 'object') {
      for (const [k, v] of Object.entries(queryObj)) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, String(v));
      }
    }

    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: {
        'Authorization': `Basic ${this._basic}`,
        'Accept': 'application/json'
      },
      timeout: 4000
    };

    return new Promise((resolve, reject) => {
      const req = this._http.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (!data) return resolve(null);
            try { return resolve(JSON.parse(data)); }
            catch { return resolve(data); }
          }
          const err = new Error(`ARI ${method} ${u.pathname} -> ${res.statusCode} ${data || ''}`.trim());
          err.statusCode = res.statusCode;
          err.body = data;
          reject(err);
        });
      });
      req.on('timeout', () => req.destroy(new Error('ARI request timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}

async function connectAri(baseUrl, user, pass) {
  return new AriAdapter({ baseUrl, user, pass });
}

module.exports = { connectAri };
