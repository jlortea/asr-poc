🧩 Overview
This repository contains a Proof of Concept (PoC) developed to validate the integration of Asterisk with a real-time speech-to-text (ASR) engine using:
- Asterisk ARI
- SnoopChannel
- ExternalMedia
- RTP forwarding to a Node.js gateway
- WebSocket streaming to the ASR engine

The goal of this PoC was to demonstrate technical feasibility: capturing bidirectional audio from a phone call, forwarding it to an external ASR engine, and receiving real-time transcripts.
This PoC is not intended for production. It has been replaced by a more complete and robust architecture in the new project, but is preserved here as a reference.

🏗️ Architecture
The PoC uses the following flow:

┌────────────┐
│ Asterisk   │
│   (SIP)    │
└──────┬─────┘
       │ RTP audio stream (PJSIP)
       ▼
┌─────────────────────┐
│   SnoopChannel (ARI)│  ← taps the call audio
└─────────┬───────────┘
          │
          ▼
┌────────────────────────────┐
│ ExternalMedia (RTP/SLIN16) │ ← forwards RTP to Node.js
└─────────┬──────────────────┘
          │ UDP RTP
          ▼
┌────────────────────────────┐
│ ASR Gateway (Node.js)      │ ← RTP → WebSocket
│ Sends audio to ASR engine  │
└────────────────────────────┘

📦 Repository Contents
asr-poc/
│
├── docker-compose.yml       → Asterisk + ASR Gateway orchestration
├── .env                     → Environment variables (ARI, ports, hosts...)
│
├── server/
│   ├── asr-gw.js            → RTP → WebSocket gateway (Deepgram/Whisper/etc.)
│   └── ari-controller.js    → ARI logic (Snoop + ExternalMedia)
│
└── dialplan/
    └── extensions.conf      → Asterisk dialplan used in the PoC

⚙️ Prerequisites
- Docker + Docker Compose
- Node.js 18+ (only required if running manually)
- Asterisk 18+ with ARI enabled
- An ASR backend supporting WebSocket streaming
(Deepgram, Whisper.cpp server, OpenAI Realtime, etc.)


🚀 How to Run the PoC

1️⃣ Configure the environment

Create or edit .env:
---------------------------------------
# Asterisk ARI
ARI_URL=http://asterisk:8088/ari
ARI_USER=asterisk
ARI_PASS=asterisk

# ARI app name for this PoC
ARI_APP=asr-poc

# RTP port used by Asterisk ExternalMedia
RTP_PORT=40000

# ASR WebSocket endpoint
ASR_WS_URL=wss://api.deepgram.com/v1/listen
ASR_API_KEY=<API_KEY>
--------------------------------------

2️⃣ Start the system
docker compose up --build

This will start:
- Asterisk (with ARI)
- ASR Gateway (Node.js)

3️⃣ Demo call flow
1. A call arrives at Asterisk
2. Dialplan answers and retrieves the channel uniqueid
3. Stasis() is invoked with that UID
4. ARI creates a SnoopChannel
5. ARI creates ExternalMedia → sends RTP SLIN16 16kHz to Node
6. asr-gw.js converts RTP to WebSocket
7. Transcriptions appear in the console

📞 Dialplan Used in the PoC
File: dialplan/extensions.conf
--------------------------------------
exten => 1000,1,NoOp(ASR PoC demo)
    same => n,Answer()
    same => n,Set(CALL_UID=${CHANNEL(uniqueid)})
    same => n,Stasis(${ARI_APP},${CALL_UID})
    same => n,Hangup()
--------------------------------------

🤖 How It Works (Internals)
✔️ Asterisk triggers a Stasis apps
The ARI controller receives the call’s unique identifier as argument.

✔️ A SnoopChannel is created
Captures both directions of the conversation audio.

✔️ ExternalMedia is created
Asterisk sends raw RTP (SLIN16/16000Hz) to the Node gateway.

✔️ ASR Gateway (Node.js)
- Receives RTP packets
- Reassembles frames
- Sends PCM to the ASR WebSocket API
- Prints received transcripts

🧪 PoC Limitations
This project is a simplified PoC and has known limitations:
- No support for multiple ASR engines
- Does not manage concurrent sessions robustly
- No advanced RTP/Jitter/SSRC handling
- Minimal cleanup logic
- No production-level retry, reconnection or buffering
  
These issues have been solved in the evolved project.

📚 Key Learnings from This PoC
- ARI Snoop is excellent for passive call tapping
- ExternalMedia is the correct mechanism for RTP forwarding
- Real ASR engines work well with raw PCM16 audio
- A dedicated session manager is mandatory for reliability
- RTP/SSRC lifecycle is trickier than expected

🏁 Project Status
This project is archived.

The new and fully maintained implementation is available in:

➡️ realtime-transcription
(With TAP manager, multi-gateway support, MTI integration, stable session lifecycle, retries, etc.)
