# MTI Mediagateway
### Asterisk → MTI Gateway → MTI Server (Prometheus + Grafana)

This project provides a fully containerized system that allows **tapping live calls from Asterisk**, routing audio to:

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
│   ├── mti-debug-server.js      # Local fake MTI server for debugging the MTI flow
│   ├── mti-gw.js                # RTP→MTI TCP gateway + metrics
│   ├── tap-service.js           # Asterisk ARI tap logic + ExternalMedia + routing + metrics
|   └── ari
|       └── ari-client.js        # A custom native ARI adapter
└── tap-package.json             # Dependencies template for tap-service
```

---

# 🧩 High-Level Architecture

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

---

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

---

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

## Widget hosted by deepgram-gw
WIDGET_PORT=8080

## Endianness / testing
SWAP_ENDIAN=1
DUMP_WAV=0

## MTI
MTI_HOST=127.0.0.1
MTI_PORT=9092
MTI_GW_HTTP_PORT=9093

---

# Complete Secuence Diagram
```mermaid
sequenceDiagram
    autonumber

    participant U as User or PSTN
    participant A as Asterisk PBX
    participant T as tap-service
    participant G as mti-gw
    participant M as MTI Server

    rect rgb(245,245,245)
    note over A: Dialplan trigger<br>Invokes tap-service when the call starts or enters a given context<br>Example: CURL to /start_tap with chan and uuid
    U->>A: Incoming or outgoing SIP call
    A->>A: Generate CHANNEL(uniqueid)<br>UUID = Asterisk UNIQUEID
    A->>T: HTTP GET /start_tap?chan=...&uuid=...&gw=mti&agent_extension=...&agent_username=...&agent_id=...<br>tap-service HTTP port: 3200
    T-->>A: HTTP 200 OK (or non-200 on failure)
    end

    rect rgb(245,245,245)
    note over T,A: ARI control plane<br>tap-service duplicates audio best-effort without affecting call continuity
    T->>A: ARI connect (REST/WebSocket depending on client)<br>Asterisk ARI port: 8088
    T->>A: ARI create SnoopChannel (spy=both) for chan
    T->>A: ARI create Mixing Bridge
    T->>A: ARI add SnoopChannel to Bridge
    T->>T: Allocate dynamic RTP UDP port for this call<br>Example range: 41000-41999 (1 UDP port = 1 call)
    T->>G: HTTP GET /register?uuid=...&port=...&agent_extension=...&agent_username=...&agent_id=...<br>mti-gw HTTP port: 9093
    G-->>T: HTTP 200 OK (registered) or 4xx/5xx (rejected)
    end

    rect rgb(245,245,245)
    note over T,A: Media injection into gateway<br>ExternalMedia sends RTP (SLIN16) to the allocated UDP port on mti-gw
    T->>A: ARI create ExternalMedia(format=slin16, external_host=RTP_HOST_MTI:port)
    A-->>G: RTP over UDP to port (dynamic per call)<br>Payload: SLIN16 PCM 16kHz 16-bit LE mono
    end

    rect rgb(245,245,245)
    note over G: mti-gw internal state machine (per call)<br>IDLE -> REGISTERED -> TCP_CONNECTING -> TCP_CONNECTED -> STREAMING -> ENDED<br>Any state -> FAILED (on TCP/UDP errors)<br>STREAMING -> ENDED (on unregister or inactivity timeout)
    end

    rect rgb(245,245,245)
    note over G,M: MTI session over TCP (1 socket per call)<br>Framing: [TYPE 1B][LEN 2B big-endian][PAYLOAD nB]<br>Types: 0x01 START, 0x12 AUDIO(640B), 0x00 END
    G->>M: TCP connect (1 per call)<br>Destination: MTI_HOST:MTI_PORT
    G->>M: START frame (0x01)<br>LEN = bytes(payload)<br>PAYLOAD UTF-8 JSON e.g.<br>{"call_uuid":"...","agent_extension":"...","agent_username":"...","agent_id":"..."}
    loop While RTP packets arrive
        G->>G: Strip RTP header, extract payload, append to buffer
        G->>G: Chunk buffer into exact 640-byte audio frames (20ms)<br>320 samples -> 640 bytes
        G->>M: AUDIO frame (0x12)<br>LEN = 0x0280<br>PAYLOAD = 640 bytes PCM
    end
    end

    rect rgb(245,245,245)
    note over T,G: Control endpoints used (summary)<br>tap-service: GET /start_tap (from Asterisk dialplan)<br>mti-gw: GET /register, GET /unregister<br>Both expose GET /metrics (Prometheus)
    end

    rect rgb(245,245,245)
    note over A,T: Cleanup is best-effort<br>Even if MTI fails, Asterisk call must continue normally
    alt Normal call hangup
        U->>A: Hang up
        T->>A: ARI detects original channel hangup
        T->>G: HTTP GET /unregister?uuid=... (or by port)<br>mti-gw HTTP port: 9093
        G->>M: END frame (0x00)<br>LEN = 0
        G->>M: TCP close (client closes socket)
        G-->>T: HTTP 200 OK
        T->>A: ARI cleanup: destroy ExternalMedia, Bridge, SnoopChannel
    else RTP inactivity timeout in mti-gw
        note over G: Inactivity = no RTP packets received (not silence detection)<br>Gateway timeout example: 8s<br>MTI server inactivity timeout may be longer (e.g., 300s)
        G->>M: END frame (0x00) if possible
        G->>M: TCP close
        G->>G: Transition to ENDED/FAILED and release UDP port
        T->>A: Call continues (tap is best-effort)
    else MTI closes socket or TCP error
        note over G: If MTI closes the socket: session is failed<br>No retry, no reconnect with same UUID
        G->>G: Transition to FAILED, stop streaming
        G->>M: TCP close (if not already)
        G->>G: Cleanup session and release UDP port
        T->>A: Call continues (no PBX impact)
    else Register rejected (e.g., concurrency limit)
        note over G: If /register is rejected (e.g., >5 concurrent sessions)<br>No MTI analysis for that call
        G-->>T: HTTP 429/503 (example)
        T->>A: Optionally skip ExternalMedia and cleanup ARI objects for tap
        A->>A: Call continues normally
    end
    end

    rect rgb(245,245,245)
    note over T,G: Observability (Prometheus)<br>Scrape /metrics on tap-service and mti-gw<br>Key metrics: sessions_active, sessions_created_total, sessions_ended_total{reason}, rtp_packets_total, tcp_errors_total
    end
    ```

---

# 📞 Asterisk Integration

See:

`asterisk/extensions.conf`

Contains a **real working example**:

-   Generates call UUID from `${UNIQUEID}`
    
-   Calls `/start_tap` via `CURL()`
    
-   Passes caller info, extension, metadata
    
-   Continues your call flow normally after tapping
    

This file is **a template**, not a mandatory dialplan.

---

# ▶️ Running the Full Stack

From repo root:

`docker compose up -d --build`

Check logs:

`docker compose logs -f`

## Services

| Service     | URL                     |
|-------------|--------------------------|
| TAP         | http://\<host\>:3200     |
| MTI-GW      | http://\<host\>:9093     |
| Prometheus  | http://\<host\>:9090     |
| Grafana     | http://\<host\>:3000     |

---

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
