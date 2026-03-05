import { useState, useRef, useEffect, useCallback } from "react";

const API = "http://localhost:8000";
const fmt = (s) => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

function Waveform({ isPlaying, progress }) {
  const heights = useRef(Array.from({ length: 50 }, () => 5 + Math.random() * 28));
  return (
    <div style={{ display:"flex", alignItems:"center", gap:"2px", height:"34px" }}>
      {heights.current.map((h, i) => {
        const active = isPlaying && i / 50 < progress;
        return (
          <div key={i} style={{
            width:"3px", borderRadius:"2px",
            height: `${active ? h : Math.max(3, h * 0.28)}px`,
            background: active ? "#f59e0b" : "rgba(245,158,11,0.18)",
            transition: "height 0.12s ease, background 0.25s",
            animation: active ? `wv ${0.3+Math.random()*0.5}s ease-in-out infinite alternate` : "none",
          }}/>
        );
      })}
    </div>
  );
}

function Ring({ pct, size=42, stroke=3.5 }) {
  const r = (size-stroke)/2, c = 2*Math.PI*r;
  return (
    <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(245,158,11,0.12)" strokeWidth={stroke}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#f59e0b" strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={c*(1-pct/100)} strokeLinecap="round"
        style={{ transition:"stroke-dashoffset 0.4s ease" }}/>
    </svg>
  );
}

const STAGES = ["uploading","dubbing","downloading","muxing","lipsync"];
const STAGE_LABEL = {
  uploading:"Uploading", dubbing:"Dubbing", downloading:"Downloading",
  muxing:"Muxing", lipsync:"Lip Sync",
};

export default function App() {
  const [apiKey, setApiKey]           = useState(() => window.localStorage.getItem("el_api_key") || "");
  const [plan, setPlan]               = useState(null);
  const [uploadId, setUploadId]       = useState(null);
  const [videoUrl, setVideoUrl]       = useState(null);
  const [uploading, setUploading]     = useState(false);
  const [uploadPct, setUploadPct]     = useState(0);
  const [dragOver, setDragOver]       = useState(false);

  const [isPlaying, setIsPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [volume, setVolume]           = useState(0.85);
  const [playMode, setPlayMode]       = useState("original");

  const [languages, setLanguages]     = useState([]);
  const [targetLang, setTargetLang]   = useState("es");
  const [targetAccent, setTargetAccent] = useState("");
  const [lipSync, setLipSync]         = useState(false);
  const [numSpeakers, setNumSpeakers] = useState(0);

  const [jobId, setJobId]             = useState(null);
  const [job, setJob]                 = useState(null);
  const [polling, setPolling]         = useState(false);
  const [health, setHealth]           = useState(null);

  const videoRef    = useRef(null);
  const dubbedRef   = useRef(null);
  const fileRef     = useRef(null);
  const pollRef     = useRef(null);

  const headersWithKey = useCallback(() => (
    apiKey ? { "X-EL-API-Key": apiKey } : {}
  ), [apiKey]);

  const refreshHealth = useCallback(() => {
    fetch(`${API}/health`, { headers: headersWithKey() })
      .then(r => r.json())
      .then(d => {
        setHealth(d);
        setPlan(d.plan || null);
      })
      .catch(()=>{});
  }, [headersWithKey]);

  // Load languages & health
  useEffect(() => {
    refreshHealth();
    fetch(`${API}/languages`).then(r=>r.json()).then(d=>setLanguages(d.languages||[])).catch(()=>{});
  }, [refreshHealth]);

  // Playback sync
  useEffect(() => {
    const v = playMode==="dubbed" ? dubbedRef.current : videoRef.current;
    if (!v) return;
    isPlaying ? v.play().catch(()=>{}) : v.pause();
  }, [isPlaying, playMode]);

  useEffect(() => {
    [videoRef, dubbedRef].forEach(r => { if (r.current) r.current.volume = volume; });
  }, [volume]);

  // Poll job
  useEffect(() => {
    if (!jobId || !polling) return;
    pollRef.current = setInterval(async () => {
      try {
        const data = await fetch(`${API}/job/${jobId}`).then(r=>r.json());
        setJob(data);
        if (data.status==="done" || data.status==="error") {
          setPolling(false);
          clearInterval(pollRef.current);
          if (data.status==="done" && data.output_video_url && dubbedRef.current) {
            dubbedRef.current.src = API + data.output_video_url;
            dubbedRef.current.load();
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [jobId, polling]);

  // Upload handler
  const handleFile = useCallback(async (file) => {
    if (!file?.type.startsWith("video/")) return;
    setVideoUrl(URL.createObjectURL(file));
    setJob(null); setJobId(null); setPlayMode("original");
    setUploading(true); setUploadPct(0);

    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = e => { if (e.lengthComputable) setUploadPct(Math.round(e.loaded/e.total*100)); };
    xhr.onload = () => {
      try { const d = JSON.parse(xhr.responseText); setUploadId(d.upload_id); }
      catch {}
      setUploading(false);
    };
    xhr.onerror = () => setUploading(false);
    xhr.open("POST", `${API}/upload`);
    Object.entries(headersWithKey()).forEach(([k,v]) => xhr.setRequestHeader(k, v));
    xhr.send(form);
  }, []);

  const startDub = useCallback(async () => {
    if (!uploadId) return;
    const form = new FormData();
    form.append("upload_id", uploadId);
    form.append("target_language", targetLang);
    form.append("lip_sync", lipSync);
    form.append("num_speakers", numSpeakers);
    // ElevenLabs requires watermark=true for non-Creator+ subscriptions
    form.append("watermark", "true");
    if (targetAccent) {
      form.append("target_accent", targetAccent);
    }
    const { job_id } = await fetch(`${API}/dub`, {
      method:"POST",
      body:form,
      headers: headersWithKey(),
    }).then(r=>r.json());
    setJobId(job_id);
    setJob({ status:"queued", progress:0, stage_label:"Queued…" });
    setPolling(true);
  }, [uploadId, targetLang, lipSync, numSpeakers, headersWithKey]);

  const seek = (t) => {
    setCurrentTime(t);
    [videoRef, dubbedRef].forEach(r => { if (r.current) r.current.currentTime = t; });
  };

  const lang        = languages.find(l => l.code === targetLang);
  const isDone      = job?.status === "done";
  const isError     = job?.status === "error";
  const isRunning   = job && !isDone && !isError;
  const curStageIdx = STAGES.indexOf(job?.status);

  return (
    <div style={{ minHeight:"100vh", background:"#07070a", fontFamily:"'DM Sans',sans-serif", color:"#e8e2d9", padding:"28px 16px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@700;800&display=swap');
        @keyframes fadeUp  { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin    { to{transform:rotate(360deg)} }
        @keyframes shimmer { 0%,100%{opacity:.4} 50%{opacity:1} }
        @keyframes glow    { 0%,100%{box-shadow:0 0 16px rgba(245,158,11,.2)} 50%{box-shadow:0 0 34px rgba(245,158,11,.55)} }
        @keyframes wv      { from{opacity:.6} to{opacity:1} }
        * { box-sizing:border-box; }
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-thumb{background:rgba(245,158,11,.28);border-radius:2px}
        .card  { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.07); border-radius:18px; }
        .lp    { border:1px solid rgba(255,255,255,.08); border-radius:10px; cursor:pointer; transition:all .15s; padding:7px 5px; text-align:center; background:rgba(255,255,255,.02); }
        .lp:hover { border-color:rgba(245,158,11,.4); background:rgba(245,158,11,.07); transform:translateY(-1px); }
        .lp.on  { border-color:#f59e0b; background:rgba(245,158,11,.12); }
        .seg   { border-radius:9px; cursor:pointer; padding:9px 11px; border:1px solid transparent; transition:all .2s; }
        .seg:hover { background:rgba(245,158,11,.05); }
        .seg.on{ background:rgba(245,158,11,.1); border-color:rgba(245,158,11,.28); }
        .tog   { border-radius:12px; cursor:pointer; position:relative; transition:background .2s; flex-shrink:0; }
        .tog-t { position:absolute; top:3px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.4); transition:left .2s; }
        .pbtn  { border:none; border-radius:14px; cursor:pointer; font-family:'Syne',sans-serif; font-weight:700; transition:all .2s; }
        .pbtn:hover:not(:disabled){ transform:translateY(-1px); }
        .pbtn:disabled{ opacity:.4; cursor:default; }
        .gbtn  { background:transparent; border:1px solid rgba(255,255,255,.1); border-radius:9px; color:#e8e2d9; cursor:pointer; transition:all .15s; font-family:'DM Sans',sans-serif; }
        .gbtn:hover{ background:rgba(245,158,11,.08); border-color:rgba(245,158,11,.35); }
      `}</style>

      {/* Ambient */}
      <div style={{position:"fixed",top:"-15%",left:"-8%",width:"460px",height:"460px",borderRadius:"50%",background:"radial-gradient(circle,rgba(245,158,11,.055) 0%,transparent 70%)",pointerEvents:"none"}}/>
      <div style={{position:"fixed",bottom:"-18%",right:"-8%",width:"520px",height:"520px",borderRadius:"50%",background:"radial-gradient(circle,rgba(245,158,11,.03) 0%,transparent 70%)",pointerEvents:"none"}}/>

      {/* Header */}
      <div style={{textAlign:"center",marginBottom:"32px",animation:"fadeUp .5s ease"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:"8px",marginBottom:"8px"}}>
          <div style={{width:"7px",height:"7px",borderRadius:"50%",background:"#f59e0b",boxShadow:"0 0 10px #f59e0b",animation:"shimmer 2s ease infinite"}}/>
          <span style={{fontFamily:"'Syne',sans-serif",fontSize:"10px",letterSpacing:"3.5px",textTransform:"uppercase",color:"rgba(245,158,11,.8)"}}>ElevenLabs Dubbing Studio</span>
          <div style={{width:"7px",height:"7px",borderRadius:"50%",background:"#f59e0b",boxShadow:"0 0 10px #f59e0b",animation:"shimmer 2s ease 1s infinite"}}/>
        </div>
        <h1 style={{fontFamily:"'Syne',sans-serif",fontSize:"clamp(24px,3.5vw,42px)",fontWeight:"800",margin:"0 0 6px",letterSpacing:"-1px",lineHeight:1.1}}>
          Speak Every Language.<br/>
          <span style={{background:"linear-gradient(90deg,#f59e0b,#fbbf24)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Sound Like You.</span>
        </h1>
        <p style={{color:"rgba(232,226,217,.38)",fontSize:"13px",fontWeight:"300",margin:0}}>
          Powered exclusively by ElevenLabs voice cloning + Wav2Lip
        </p>
      </div>

      {/* Health + API key strip */}
      {health && (
        <div style={{maxWidth:"920px",margin:"0 auto 18px",display:"flex",flexDirection:"column",gap:"8px",animation:"fadeUp .5s .1s ease both"}}>
          <div style={{display:"flex",gap:"8px",justifyContent:"center",flexWrap:"wrap"}}>
            {[
              ["ElevenLabs API Key", health.elevenlabs_key],
              ["ElevenLabs Connected", health.elevenlabs_connected],
              ["Plan", !!plan],
              ["FFmpeg", health.ffmpeg],
              ["Wav2Lip", health.wav2lip],
            ].map(([n, ok]) => (
              <div key={n} style={{display:"flex",alignItems:"center",gap:"5px",background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:"20px",padding:"4px 11px"}}>
                <div style={{width:"6px",height:"6px",borderRadius:"50%",background:ok?"#22c55e":"#ef4444",boxShadow:ok?"0 0 6px #22c55e":"0 0 6px #ef4444"}}/>
                <span style={{fontSize:"11px",color:"rgba(232,226,217,.5)"}}>
                  {n}{n==="Plan" && plan ? `: ${plan}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{maxWidth:"920px",margin:"0 auto",display:"flex",flexDirection:"column",gap:"14px",animation:"fadeUp .5s .15s ease both"}}>

        {/* ── Video Player Card ── */}
        <div className="card">
          {/* Drop / video area */}
          <div
            style={{position:"relative",height:"320px",borderRadius:"18px 18px 0 0",overflow:"hidden",background:"#0b0b0e",display:"flex",alignItems:"center",justifyContent:"center",cursor:videoUrl?"default":"pointer",border:dragOver?"1px solid rgba(245,158,11,.5)":"none"}}
            onClick={()=>!videoUrl&&fileRef.current?.click()}
            onDragOver={e=>{e.preventDefault();setDragOver(true)}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);handleFile(e.dataTransfer.files[0]);}}
          >
            <div style={{position:"absolute",inset:0,backgroundImage:"linear-gradient(rgba(245,158,11,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(245,158,11,.022) 1px,transparent 1px)",backgroundSize:"38px 38px",pointerEvents:"none"}}/>

            <video ref={videoRef} src={videoUrl||undefined}
              style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",display:videoUrl&&playMode==="original"?"block":"none"}}
              onTimeUpdate={e=>setCurrentTime(e.target.currentTime)}
              onLoadedMetadata={e=>setDuration(e.target.duration)}
              onEnded={()=>setIsPlaying(false)}/>

            <video ref={dubbedRef}
              style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",display:isDone&&playMode==="dubbed"?"block":"none"}}
              onTimeUpdate={e=>setCurrentTime(e.target.currentTime)}
              onEnded={()=>setIsPlaying(false)}/>

            {!videoUrl && !uploading && (
              <div style={{textAlign:"center",zIndex:1}}>
                <div style={{width:"60px",height:"60px",borderRadius:"50%",border:"1px solid rgba(245,158,11,.3)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px",background:"rgba(245,158,11,.06)"}}>
                  <svg width="22" height="22" fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                </div>
                <p style={{color:"rgba(232,226,217,.6)",fontSize:"14px",margin:"0 0 3px",fontWeight:"500"}}>Drop your video here</p>
                <p style={{color:"rgba(232,226,217,.22)",fontSize:"12px",margin:0}}>MP4, MOV, WebM, MKV</p>
              </div>
            )}

            {uploading && (
              <div style={{position:"absolute",inset:0,background:"rgba(7,7,10,.85)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:"12px",zIndex:10}}>
                <Ring pct={uploadPct} size={54} stroke={4}/>
                <span style={{fontSize:"13px",color:"rgba(232,226,217,.65)"}}>Uploading… {uploadPct}%</span>
              </div>
            )}

            {/* Click-to-play overlay */}
            {videoUrl && !uploading && (
              <div onClick={e=>{e.stopPropagation();setIsPlaying(p=>!p);}}
                style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,.22)",opacity:0,transition:"opacity .2s",cursor:"pointer",zIndex:5}}
                onMouseEnter={e=>e.currentTarget.style.opacity="1"}
                onMouseLeave={e=>e.currentTarget.style.opacity="0"}>
                <div style={{width:"60px",height:"60px",borderRadius:"50%",background:"rgba(245,158,11,.92)",display:"flex",alignItems:"center",justifyContent:"center",animation:"glow 2s ease infinite"}}>
                  {isPlaying
                    ?<svg width="16" height="16" viewBox="0 0 24 24" fill="#07070a"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    :<svg width="16" height="16" viewBox="0 0 24 24" fill="#07070a" style={{marginLeft:"3px"}}><polygon points="5,3 19,12 5,21"/></svg>}
                </div>
              </div>
            )}

            {/* Mode toggle */}
            {isDone && (
              <div style={{position:"absolute",top:"12px",left:"12px",display:"flex",gap:"5px",zIndex:6}}>
                {["original","dubbed"].map(m=>(
                  <button key={m} onClick={e=>{e.stopPropagation();setPlayMode(m);setIsPlaying(false);}}
                    style={{padding:"5px 11px",borderRadius:"20px",border:`1px solid ${playMode===m?"#f59e0b":"rgba(255,255,255,.14)"}`,background:playMode===m?"rgba(245,158,11,.2)":"rgba(7,7,10,.75)",color:playMode===m?"#f59e0b":"rgba(232,226,217,.55)",fontSize:"11px",fontWeight:"600",cursor:"pointer",letterSpacing:".5px",textTransform:"uppercase"}}>
                    {m}
                  </button>
                ))}
              </div>
            )}

            {isDone && (
              <div style={{position:"absolute",top:"12px",right:"12px",background:"rgba(245,158,11,.14)",border:"1px solid rgba(245,158,11,.38)",borderRadius:"20px",padding:"4px 12px",display:"flex",alignItems:"center",gap:"5px",backdropFilter:"blur(8px)",zIndex:6}}>
                <div style={{width:"6px",height:"6px",borderRadius:"50%",background:"#f59e0b",animation:"shimmer 1.5s ease infinite"}}/>
                <span style={{fontSize:"11px",fontWeight:"600",color:"#f59e0b",letterSpacing:".5px"}}>DUBBED · {lang?.flag} {lang?.label?.toUpperCase()}</span>
              </div>
            )}

            <input ref={fileRef} type="file" accept="video/*" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
          </div>

          {/* Player controls */}
          <div style={{padding:"16px 20px"}}>
            <div style={{height:"3px",background:"rgba(255,255,255,.07)",borderRadius:"2px",marginBottom:"13px",cursor:"pointer",position:"relative"}}
              onClick={e=>{const r=e.currentTarget.getBoundingClientRect();seek(((e.clientX-r.left)/r.width)*(duration||0));}}>
              <div style={{height:"100%",width:`${duration?currentTime/duration*100:0}%`,background:"linear-gradient(90deg,#d97706,#f59e0b)",borderRadius:"2px",transition:"width .1s linear",position:"relative"}}>
                <div style={{position:"absolute",right:"-5px",top:"-4px",width:"11px",height:"11px",borderRadius:"50%",background:"#f59e0b",boxShadow:"0 0 8px rgba(245,158,11,.8)"}}/>
              </div>
            </div>

            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"center",gap:"7px"}}>
                <button className="gbtn" style={{width:"33px",height:"33px",padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}
                  onClick={()=>seek(Math.max(0,currentTime-10))}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 100-6"/></svg>
                </button>
                <button onClick={()=>setIsPlaying(p=>!p)}
                  style={{width:"42px",height:"42px",borderRadius:"50%",border:"none",background:videoUrl?"#f59e0b":"rgba(245,158,11,.3)",cursor:videoUrl?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",animation:isPlaying?"glow 2s ease infinite":"none"}}>
                  {isPlaying
                    ?<svg width="12" height="12" viewBox="0 0 24 24" fill="#07070a"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    :<svg width="12" height="12" viewBox="0 0 24 24" fill="#07070a" style={{marginLeft:"2px"}}><polygon points="5,3 19,12 5,21"/></svg>}
                </button>
                <button className="gbtn" style={{width:"33px",height:"33px",padding:0,display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)"}}
                  onClick={()=>seek(Math.min(duration,currentTime+10))}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 100-6"/></svg>
                </button>
                <span style={{fontSize:"12px",color:"rgba(232,226,217,.38)",fontVariantNumeric:"tabular-nums",marginLeft:"3px"}}>
                  {fmt(currentTime)} / {fmt(duration)}
                </span>
              </div>

              <div style={{display:"flex",alignItems:"center",gap:"11px"}}>
                <Waveform isPlaying={isPlaying} progress={duration?currentTime/duration:0}/>
                <div style={{display:"flex",alignItems:"center",gap:"5px"}}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="rgba(232,226,217,.38)"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
                  <input type="range" min="0" max="1" step="0.01" value={volume} onChange={e=>setVolume(+e.target.value)} style={{width:"64px",accentColor:"#f59e0b",cursor:"pointer"}}/>
                </div>
                {videoUrl && (
                  <button className="gbtn" style={{padding:"5px 9px",fontSize:"11px"}}
                    onClick={()=>{setVideoUrl(null);setUploadId(null);setJob(null);setJobId(null);setPlayMode("original");fileRef.current?.click();}}>
                    ↩ Change
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Bottom grid ── */}
        <div style={{display:"grid",gridTemplateColumns:"320px 1fr",gap:"14px"}}>

          {/* Config panel */}
          <div style={{display:"flex",flexDirection:"column",gap:"11px"}}>

            {/* API key settings */}
            <div className="card" style={{padding:"12px 14px",display:"flex",flexDirection:"column",gap:"8px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:"6px"}}>
                <span style={{fontSize:"12px",fontWeight:"600"}}>ElevenLabs API Key</span>
                {plan && <span style={{fontSize:"11px",color:"rgba(232,226,217,.45)"}}>{plan}</span>}
              </div>
              <input
                type="password"
                placeholder="sk_..."
                value={apiKey}
                onChange={e => {
                  setApiKey(e.target.value.trim());
                  window.localStorage.setItem("el_api_key", e.target.value.trim());
                }}
                style={{width:"100%",padding:"6px 8px",borderRadius:"8px",border:"1px solid rgba(255,255,255,.14)",background:"rgba(7,7,10,.9)",color:"#e8e2d9",fontSize:"12px"}}
              />
              <button
                className="gbtn"
                style={{padding:"5px 8px",fontSize:"11px",alignSelf:"flex-start"}}
                onClick={refreshHealth}
              >
                Check plan & connection
              </button>
            </div>

            {/* Language + accent */}
            <div className="card" style={{padding:"17px 18px",display:"flex",flexDirection:"column",gap:"10px"}}>
              <div>
                <div style={{display:"flex",alignItems:"center",gap:"7px",marginBottom:"10px"}}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                  <span style={{fontFamily:"'Syne',sans-serif",fontSize:"12px",fontWeight:"700",letterSpacing:".5px"}}>Target Language</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:"5px"}}>
                  {languages.map(l=>(
                    <div key={l.code} className={`lp ${targetLang===l.code?"on":""}`} onClick={()=>setTargetLang(l.code)} title={l.label}>
                      <div style={{fontSize:"18px",lineHeight:1}}>{l.flag}</div>
                      <div style={{fontSize:"9px",marginTop:"3px",color:targetLang===l.code?"#f59e0b":"rgba(232,226,217,.32)",fontWeight:"600"}}>{l.code.toUpperCase()}</div>
                    </div>
                  ))}
                </div>
                {lang && (
                  <div style={{marginTop:"8px",padding:"7px 11px",background:"rgba(245,158,11,.06)",borderRadius:"9px",display:"flex",alignItems:"center",gap:"7px"}}>
                    <span style={{fontSize:"16px"}}>{lang.flag}</span>
                    <span style={{fontSize:"12px",color:"rgba(232,226,217,.55)"}}>Dubbing to <span style={{color:"#f59e0b",fontWeight:"500"}}>{lang.label}</span></span>
                  </div>
                )}
              </div>
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"4px"}}>
                  <span style={{fontSize:"11px",fontWeight:"600",color:"rgba(232,226,217,.8)"}}>Target accent (optional)</span>
                </div>
                <select
                  value={targetAccent}
                  onChange={e=>setTargetAccent(e.target.value)}
                  style={{width:"100%",marginTop:"2px",padding:"6px 8px",borderRadius:"8px",border:"1px solid rgba(255,255,255,.14)",background:"rgba(7,7,10,.9)",color:"#e8e2d9",fontSize:"12px"}}
                >
                  <option value="">Let ElevenLabs decide</option>
                  <option value="hi-IN">Hindi · India</option>
                  <option value="en-IN">Indian English accent</option>
                  <option value="en-US">English · US</option>
                  <option value="en-GB">English · UK</option>
                  <option value="ja-JP">Japanese · Japan</option>
                </select>
                <p style={{marginTop:"5px",fontSize:"10px",color:"rgba(232,226,217,.35)"}}>
                  Voice gender and grammar are chosen automatically by ElevenLabs and may not always match the original speaker.
                </p>
              </div>
            </div>

            {/* Options */}
            <div className="card" style={{padding:"15px 18px",display:"flex",flexDirection:"column",gap:"12px"}}>
              {/* Lip sync toggle */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div>
                  <div style={{fontSize:"13px",fontWeight:"500"}}>Lip Sync</div>
                  <div style={{fontSize:"11px",color:"rgba(232,226,217,.35)",marginTop:"1px"}}>Wav2Lip mouth animation</div>
                </div>
                <div className="tog" style={{width:"40px",height:"22px",background:lipSync?"#f59e0b":"rgba(255,255,255,.1)"}} onClick={()=>setLipSync(p=>!p)}>
                  <div className="tog-t" style={{left:lipSync?"21px":"3px"}}/>
                </div>
              </div>
              {/* Speakers */}
              <div>
                <div style={{fontSize:"13px",fontWeight:"500",marginBottom:"7px"}}>Number of Speakers</div>
                <div style={{display:"flex",gap:"6px"}}>
                  {[0,1,2,3,4].map(n=>(
                    <button key={n} onClick={()=>setNumSpeakers(n)}
                      style={{flex:1,padding:"6px 0",border:`1px solid ${numSpeakers===n?"#f59e0b":"rgba(255,255,255,.1)"}`,borderRadius:"8px",background:numSpeakers===n?"rgba(245,158,11,.12)":"transparent",color:numSpeakers===n?"#f59e0b":"rgba(232,226,217,.45)",fontSize:"12px",fontWeight:"600",cursor:"pointer",transition:"all .15s"}}>
                      {n===0?"Auto":n}
                    </button>
                  ))}
                </div>
                <p style={{fontSize:"10px",color:"rgba(232,226,217,.25)",margin:"5px 0 0"}}>Auto = ElevenLabs detects automatically</p>
              </div>
            </div>

            {/* Dub button */}
            <button className="pbtn"
              style={{width:"100%",padding:"15px",fontSize:"14px",letterSpacing:".4px",display:"flex",alignItems:"center",justifyContent:"center",gap:"9px",background:uploadId&&!isRunning?"linear-gradient(135deg,#d97706,#f59e0b,#fbbf24)":"rgba(245,158,11,.2)",color:uploadId&&!isRunning?"#07070a":"rgba(245,158,11,.6)",boxShadow:uploadId&&!isRunning?"0 4px 22px rgba(245,158,11,.28)":"none"}}
              disabled={!uploadId||isRunning}
              onClick={startDub}>
              {isRunning ? (
                <><div style={{width:"15px",height:"15px",border:"2px solid rgba(245,158,11,.25)",borderTopColor:"#f59e0b",borderRadius:"50%",animation:"spin .7s linear infinite"}}/>{job?.stage_label||"Processing…"}</>
              ) : isDone ? (
                <><span>✓</span>Re-Dub Video</>
              ) : (
                <>{uploadId ? `🌍 Dub to ${lang?.label||targetLang}` : "Upload a video first"}</>
              )}
            </button>

            {isDone && (
              <div style={{marginTop:"8px",display:"flex",flexDirection:"column",gap:"6px"}}>
                {job.output_video_url && (
                  <a href={API+job.output_video_url} download style={{textDecoration:"none"}}>
                    <button style={{width:"100%",padding:"12px",borderRadius:"13px",border:"1px solid rgba(245,158,11,.32)",background:"rgba(245,158,11,.06)",cursor:"pointer",color:"#f59e0b",fontFamily:"'Syne',sans-serif",fontSize:"13px",fontWeight:"700",display:"flex",alignItems:"center",justifyContent:"center",gap:"8px",animation:"fadeUp .4s ease",letterSpacing:".3px"}}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                      Download Dubbed Video
                    </button>
                  </a>
                )}
                {job.dubbed_audio_url && (
                  <a href={API+job.dubbed_audio_url} download style={{textDecoration:"none"}}>
                    <button style={{width:"100%",padding:"10px",borderRadius:"11px",border:"1px solid rgba(245,158,11,.24)",background:"rgba(245,158,11,.03)",cursor:"pointer",color:"#fbbf24",fontFamily:"'Syne',sans-serif",fontSize:"12px",fontWeight:"700",display:"flex",alignItems:"center",justifyContent:"center",gap:"6px",animation:"fadeUp .4s .05s ease",letterSpacing:".25px"}}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      Download Audio Only
                    </button>
                  </a>
                )}
              </div>
            )}

            {isError && (
              <div style={{padding:"11px 13px",borderRadius:"11px",background:"rgba(239,68,68,.08)",border:"1px solid rgba(239,68,68,.22)",fontSize:"12px",color:"#fca5a5",lineHeight:"1.5"}}>
                ❌ {job.error}
              </div>
            )}
          </div>

          {/* Pipeline progress + transcript placeholder */}
          <div style={{display:"flex",flexDirection:"column",gap:"11px"}}>

            {/* Pipeline card */}
            {job && (
              <div className="card" style={{padding:"18px 20px",animation:"fadeUp .3s ease"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"16px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
                    {isRunning && <div style={{width:"8px",height:"8px",borderRadius:"50%",background:"#f59e0b",animation:"shimmer 1s ease infinite"}}/>}
                    {isDone && <span style={{fontSize:"16px"}}>✅</span>}
                    {isError && <span style={{fontSize:"16px"}}>❌</span>}
                    <span style={{fontFamily:"'Syne',sans-serif",fontSize:"13px",fontWeight:"700",color:isDone?"#22c55e":isError?"#ef4444":"rgba(245,158,11,.9)"}}>
                      {job.stage_label}
                    </span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:"9px"}}>
                    <Ring pct={job.progress} size={40} stroke={3}/>
                    <span style={{fontSize:"14px",fontVariantNumeric:"tabular-nums",color:"rgba(245,158,11,.85)",fontWeight:"600"}}>{job.progress}%</span>
                  </div>
                </div>

                {/* Stage pipeline */}
                <div style={{display:"flex",gap:"5px",marginBottom:"12px"}}>
                  {STAGES.map((s,i)=>{
                    const done=i<curStageIdx, active=i===curStageIdx;
                    return (
                      <div key={s} style={{flex:1,display:"flex",flexDirection:"column",gap:"5px",alignItems:"center"}}>
                        <div style={{width:"100%",height:"3px",borderRadius:"2px",background:done?"#f59e0b":active?"rgba(245,158,11,.45)":"rgba(255,255,255,.06)",transition:"background .4s",animation:active?"shimmer 1.2s ease infinite":"none"}}/>
                        <span style={{fontSize:"9px",color:done||active?"rgba(245,158,11,.7)":"rgba(232,226,217,.2)",fontWeight:"500",letterSpacing:".2px"}}>
                          {STAGE_LABEL[s]}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {isDone && (
                  <div style={{padding:"10px 13px",background:"rgba(34,197,94,.07)",border:"1px solid rgba(34,197,94,.2)",borderRadius:"10px",fontSize:"12px",color:"#86efac"}}>
                    🎉 ElevenLabs dubbed your video to <strong>{lang?.label}</strong> successfully.
                    {job.output_video_url && (
                      <span> &nbsp;<a href={API+job.output_video_url} download style={{color:"#f59e0b",textDecoration:"none",fontWeight:"500"}}>Download video</a></span>
                    )}
                    {job.dubbed_audio_url && (
                      <span> &nbsp;<a href={API+job.dubbed_audio_url} download style={{color:"#f59e0b",textDecoration:"none",fontWeight:"500"}}>Download audio only</a></span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Info card when idle */}
            {!job && (
              <div className="card" style={{padding:"24px 22px",flex:1,display:"flex",flexDirection:"column",justifyContent:"center",gap:"16px"}}>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:"14px",fontWeight:"700",color:"rgba(232,226,217,.5)",marginBottom:"4px"}}>How it works</div>
                {[
                  ["1", "Upload", "Drop any MP4, MOV, or WebM video"],
                  ["2", "Choose", "Pick your target language"],
                  ["3", "Dub",    "ElevenLabs clones voice + translates"],
                  ["4", "Export","Download the final dubbed video"],
                ].map(([n, title, desc])=>(
                  <div key={n} style={{display:"flex",gap:"12px",alignItems:"flex-start"}}>
                    <div style={{width:"24px",height:"24px",borderRadius:"50%",background:"rgba(245,158,11,.1)",border:"1px solid rgba(245,158,11,.25)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:"11px",fontWeight:"700",color:"#f59e0b"}}>{n}</div>
                    <div>
                      <div style={{fontSize:"13px",fontWeight:"500",marginBottom:"1px"}}>{title}</div>
                      <div style={{fontSize:"12px",color:"rgba(232,226,217,.35)"}}>{desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{display:"flex",justifyContent:"center",gap:"20px",flexWrap:"wrap",padding:"4px 0 8px"}}>
          {["ElevenLabs Voice Cloning","Neural Translation","Wav2Lip Sync","15+ Languages","FFmpeg Muxing"].map(f=>(
            <div key={f} style={{display:"flex",alignItems:"center",gap:"5px"}}>
              <div style={{width:"3px",height:"3px",borderRadius:"50%",background:"rgba(245,158,11,.45)"}}/>
              <span style={{fontSize:"11px",color:"rgba(232,226,217,.25)"}}>{f}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}