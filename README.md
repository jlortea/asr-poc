# Deitu – Realtime Transcription Tap  
### Asterisk → Deepgram / MTI → Prometheus + Grafana

This project provides a fully containerized system that allows **tapping live calls from Asterisk**, routing audio to:

- **Deepgram** (real-time speech-to-text)
- **MTI** (custom TCP-based STT service)

…while exposing **full observability via Prometheus + Grafana**.

The system is:

- **Non-intrusive** → uses ARI snoops; the existing call path is untouched  
- **Pluggable** → freely choose STT engine per call  
- **Observable** → dashboards included

---

# 📁 Repository Structure

```text
.
├── asterisk
│   └── extensions.conf          # Sample Asterisk dialplan for tap integration
├── docker-compose.yml           # Full stack: TAP + Deepgram-GW + MTI-GW + Prometheus + Grafana
├── docs
│   └── grafana
│       ├── Deepgram-GW.json     # Deepgram gateway detailed dashboard
│       └── STT-Overview.json    # Combined STT overview dashboard
├── gw-package.json              # Dependencies template for gateway containers
├── prometheus
│   └── prometheus.yml           # Prometheus scrape configuration
├── public
│   └── widget.html              # Browser-side transcription widget
├── server
│   ├── deepgram-gw.js           # RTP→Deepgram WebSocket gateway + widget + metrics
│   ├── mti-debug-server.js      # Local fake MTI server for debugging the MTI flow
│   ├── mti-gw.js                # RTP→MTI TCP gateway + metrics
│   ├── tap-service.js           # Asterisk ARI tap logic + ExternalMedia + routing + metrics
|   └── ari
|       └── ari-client.js        # A custom native ARI adapter
└── tap-package.json             # Dependencies template for tap-service
```

# 🧩 High-Level Architecture

## 🔷 Deepgram Path (default)

`Asterisk → TAP service → Deepgram-GW → Deepgram Cloud → Browser widget`

Steps:

1.  **Asterisk** receives a call → the dialplan calls:
    
    `http://<host>:3200/start_tap?chan=...&uuid=...&gw=deepgram&caller=...&exten=...`
    
2.  **tap-service**:
    
    -   Creates **two ARI snoops** (IN = caller, OUT = agent)
        
    -   Creates **ExternalMedia** channels pointed at deepgram-gw RTP ports
        
    -   Sends `/register` to deepgram-gw
        
3.  **deepgram-gw**:
    
    -   Receives IN/OUT RTP
        
    -   Streams to Deepgram WebSocket API
        
    -   Emits transcripts to the browser widget (Socket.IO)
        
    -   Serves `public/widget.html`
        
4.  **Widget** displays:
    
    -   Timestamp
        
    -   Speaker diarization (caller/agent)
        
    -   Partial & final messages
        

## 🔶 MTI Path

`Asterisk → TAP → mti-gw → TCP framing → MTI server`

1.  TAP creates **one snoop (both)** and one external RTP channel.
    
2.  TAP allocates a **dynamic UDP port** and registers it at mti-gw.
    
3.  mti-gw:
    
    -   Binds UDP on that port
        
    -   Frames SLIN16 as START (0x01), AUDIO (0x12), END (0x00)
        
    -   Sends it to MTI via TCP
       

### New START frame payload (JSON UTF-8):
```text
{
  "call_uuid": "<asterisk-uniqueid>",
  "agent_extension": "<exten>",
  "agent_username": "<string>",
  "agent_id": "<string>"
}
```
 

You can test the protocol using:

`node server/mti-debug-server.js`


## Deepgram Web Widget (new UI)

The widget (public/widget.html) now includes:

### Layout

- Header bar with reload button (SVG)

- Gray background container

- Responsive full-width layout with padded margins

### Message Alignment

- Agent messages: right aligned

- Client messages: left aligned with a light background

- BOT suggestions: centered with white background

### Additional Features

- Autoscroll to the bottom on every update

- Two toggles at the top:

    - Show/Hide Transcription

    - Show/Hide Generative Assistant

- Logic based on:

    - type=agent

    - type=caller

    - type=bot

- call-start now supports:

    - from

    - to
for correct display of caller/callee depending on incoming or outgoing calls.

# 🔌 ARI Client Implementation

This project **no longer uses `node-ari-client`**.

A custom **native ARI adapter** is now implemented in:
`server/ari/ari-client.js`


### Why this change?

Some Asterisk deployments (e.g. iVoz / proxied setups) expose ARI under an
**HTTP prefix**, for example:
`http://<host>:8088/asterisk`


The swagger-based `node-ari-client` **breaks in these scenarios** because it
cannot correctly resolve prefixed ARI paths.

### What is used instead?

The TAP service now uses a **minimal native ARI adapter** based on:

- ARI REST (HTTP)
- ARI Events WebSocket (WS)

This adapter:

- Preserves **any HTTP prefix** (`/asterisk`)
- Does **not depend on swagger**
- Keeps the **same API surface** used by `tap-service`
  (`snoopChannel`, `externalMedia`, `Bridge`, `on(Stasis*)`, etc.)

No changes are required in the Asterisk dialplan.

### ARI WebSocket endpoint differences (DEV / PRO)

Depending on the Asterisk configuration, the ARI **WebSocket endpoint may differ**:

| Environment | Working WS endpoint |
|------------|---------------------|
| DEV        | `/ari/events`       |
| PRO        | `/ws`               |

Examples:

DEV: `ws://<host>:8088/ari/events?app=deitu-mti-tap&api_key=user:pass`

PRO (with HTTP prefix): `ws://<host>:8088/asterisk/ws?app=deitu-mti-tap&api_key=user:pass`


The ARI adapter **auto-detects and builds the correct WS URL** based on
`ARI_URL`, so **no environment-specific code changes are required**.



# 📊 Observability (Prometheus + Grafana)

## Prometheus

Runs at:

`http://<host>:9090`

Scrapes metrics from:

-   deepgram-gw
    
-   tap-service
    
-   mti-gw
    
-   itself
    

## Grafana

Runs at:

`http://<host>:3000`

Import dashboards from `docs/grafana/`:

-   `STT-Overview.json` → combined view
    
-   `Deepgram-GW.json` → detailed view
    

### Important Metrics

**Deepgram-GW**

-   `dg_sessions_active`
    
-   `rate(dg_rtp_packets_total[30s])`
    
-   `dg_ws_reconnects_total`
    
-   `dg_zero_frames_total{dir="in"|"out"}`
    

**TAP**

-   `tap_sessions_active`
    
-   `tap_em_channels_active{gw,dir}`
    
-   `tap_gateway_http_errors_total{gw,op}`
    
-   `tap_errors_total{place,gw}`
    
-   `tap_mti_ports_in_use`
    

**MTI-GW**

-   `mti_sessions_active`
    
-   `mti_rtp_packets_total`
    
-   `mti_tcp_errors_total`
    
-   `mti_sessions_ended_total{reason}`

# ⚙️ Environment Variables (`.env`)

Create `.env` in the project root:
## Asterisk ARI
ARI_URL=http://192.168.1.66:8088
ARI_USER=poctest
ARI_PASS=your_ari_password
TAP_APP_NAME=deitu-mti-tap
TAP_HTTP_PORT=3200

## TAP → MTI RTP dynamic range
RTP_HOST_MTI=192.168.1.65
MTI_RTP_START=41000
MTI_RTP_END=41999

## TAP → Deepgram RTP fixed ports
RTP_HOST_DEEPGRAM_IN=192.168.1.65:40000
RTP_HOST_DEEPGRAM_OUT=192.168.1.65:40001

## Deepgram API
DEEPGRAM_API_KEY=your_key
DG_LANGUAGE=es
DG_INTERIM=true
DG_PUNCTUATE=true
DG_SMART_FORMAT=true
DG_DIARIZE=true

## Widget hosted by deepgram-gw
WIDGET_PORT=8080

## Endianness / testing
SWAP_ENDIAN=1
DUMP_WAV=0

## MTI
MTI_HOST=127.0.0.1
MTI_PORT=9092
MTI_GW_HTTP_PORT=9093

## GENERATIVE ASSISTANT
GENERATIVE_ASSISTANT=true
SHOW_TRANSCRIPTION=true
GEN_ASS_ENGINE=n8n
GEN_ASS_URL=https://pericles.irontec.com/webhook/2c750cb7-ccfe-48ec-b467-2a358358206f
GEN_ASS_AUTH=
GEN_ASS_NAME=BOT
GEN_ASS_INTERVAL=10
GEN_ASS_TAIL_CHARS=2000
GEN_ASS_MIN_CHARS=120


# 📞 Asterisk Integration

See:

`asterisk/extensions.conf`

Contains a **real working example**:

-   Generates call UUID from `${UNIQUEID}`
    
-   Calls `/start_tap` via `CURL()`
    
-   Passes caller info, extension, metadata
    
-   Continues your call flow normally after tapping
    

This file is **a template**, not a mandatory dialplan.

# ▶️ Running the Full Stack

From repo root:

`docker compose up -d --build`

Check logs:

`docker compose logs -f`

## Services

| Service     | URL                     |
|-------------|--------------------------|
| TAP         | http://\<host\>:3200     |
| Deepgram-GW | http://\<host\>:18080    |
| MTI-GW      | http://\<host\>:9093     |
| Prometheus  | http://\<host\>:9090     |
| Grafana     | http://\<host\>:3000     |


# 🖥️ Live Widget

Open in browser:

`http://<docker-host>:18080/widget.html?uuid=<room>`

Where `<room>` is usually:

-   the **extension** of the agent, or
    
-   any room name you configured in the dialplan
    

Example:

`http://192.168.1.65:18080/widget.html?uuid=agente`

# 🧪 MTI Debug Server

Start:

`node server/mti-debug-server.js`

Shows:

-   START frames
    
-   AUDIO frames (size 640 = 20ms)
    
-   END frames
    
-   Connection lifecycle
    

Helpful to test mti-gw end-to-end.

# 🧱 Development Notes

To add new Node dependencies:

1.  Edit the correct package file:
    
    -   `tap-package.json`
        
    -   or `gw-package.json`
        
2.  Rebuild:
    

`docker compose up -d --build`

# 🧾 Notes

- v2.0.0+: Replaced `node-ari-client` with a native ARI REST + WebSocket adapter
- v2.0.1+: Improved HTTP prefix compatibility
- v2.0.2+: Stable ARI WS autodetection for DEV and PRO


# 📄 License

No license is included.  
Default: **All rights reserved**.
