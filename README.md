# 🎙️ ElevenLabs Dubbing Studio

A fully functional video dubbing app using **only ElevenLabs** for voice cloning, translation, and dubbing — plus optional Wav2Lip for lip sync.

---

## ⚙️ Setup

### 1. Prerequisites

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows → https://ffmpeg.org/download.html
```

### 2. Backend

```bash
cd backend

python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

pip install -r requirements.txt

# Add your key
cp .env.example .env
# Open .env and replace: ELEVENLABS_API_KEY=your_actual_key_here
```

### 3. Get your ElevenLabs API key

1. Go to → **https://elevenlabs.io/app/settings/api-keys**
2. Click **Create API Key**
3. Copy and paste into `backend/.env`

```env
ELEVENLABS_API_KEY=sk_abc123yourkeyhere
```

### 4. Frontend

```bash
cd frontend
npm install
```

---

## 🚀 Run

```bash
# Terminal 1 — backend
cd backend && source venv/bin/activate
uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd frontend && npm run dev
```

Open **http://localhost:5173**

---

## 🎬 Usage

1. Drop a video file onto the player
2. Select a target language (15 available)
3. Optionally set number of speakers (0 = auto)
4. Click **Dub** — ElevenLabs handles everything:
   - Voice cloning
   - Translation
   - Speech synthesis with timing
5. Toggle **Original / Dubbed** playback
6. Download the final MP4

---

## 👄 Optional: Wav2Lip (Lip Sync)

```bash
cd backend
git clone https://github.com/Rudrabha/Wav2Lip.git
cd Wav2Lip && pip install -r requirements.txt

# Download model checkpoint:
# https://github.com/Rudrabha/Wav2Lip#getting-the-weights
# Place at: backend/Wav2Lip/checkpoints/wav2lip_gan.pth
```

> Wav2Lip needs a GPU for good performance. CPU works but is slow.

---

## 📡 API

| Method | Endpoint         | Description            |
|--------|-----------------|------------------------|
| GET    | /health         | Check all services      |
| POST   | /upload         | Upload a video          |
| POST   | /dub            | Start dubbing job       |
| GET    | /job/{id}       | Poll job status         |
| GET    | /voices         | List ElevenLabs voices  |
| GET    | /languages      | Supported languages     |
| GET    | /outputs/{file} | Download result         |

---

## 🌍 Languages

Spanish · French · German · Japanese · Portuguese · Chinese · Arabic · Hindi · Korean · Italian · Russian · Dutch · Polish · Turkish · Swedish