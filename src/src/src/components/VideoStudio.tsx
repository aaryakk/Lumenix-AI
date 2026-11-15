import React, { useState, useEffect } from 'react';
import {
  Video, RefreshCw, AlertCircle, CheckCircle2, Plus, Trash2,
  Upload, Download, Sparkles, Lock, Music, Mic, Film
} from 'lucide-react';
import {
  checkGpuStatus, generateSingleShot, stitchFinalMp4, GpuStatus
} from '../adapters/videoAdapter';

interface ShotSlot {
  id: string;
  prompt: string;
  subtitle: string;
  frames: 49 | 73 | 97;
  generatedJobId?: string;
  previewUrl?: string;
  lastFrame?: string;
  statusText?: string;
}

interface Props {
  proxyUrl: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function VideoStudio({ proxyUrl }: Props) {
  const [gpu, setGpu] = useState<GpuStatus>({ online: false, error: 'Checking GPU...' });
  const [aspectRatio, setAspectRatio] = useState<'9:16' | '16:9' | '1:1'>('9:16');
  const [mode, setMode] = useState<'text-to-video' | 'image-to-video'>('text-to-video');
  const [characterLock, setCharacterLock] = useState('');
  const [refImage, setRefImage] = useState<string | undefined>();
  const [chainConsistency, setChainConsistency] = useState(true);

  const [shots, setShots] = useState<ShotSlot[]>([
    { id: '1', prompt: '', subtitle: '', frames: 73 },
    { id: '2', prompt: '', subtitle: '', frames: 73 },
    { id: '3', prompt: '', subtitle: '', frames: 73 },
  ]);

  const [transition, setTransition] = useState<'fade' | 'wipeleft' | 'slideup' | 'circleopen'>('fade');
  const [voiceoverText, setVoiceoverText] = useState('');
  const [voiceoverAudio, setVoiceoverAudio] = useState<string | undefined>();
  const [musicAudio, setMusicAudio] = useState<string | undefined>();

  const [busy, setBusy] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [finalMp4Url, setFinalMp4Url] = useState<string | null>(null);

  const refreshGpu = async () => {
    setGpu(await checkGpuStatus(proxyUrl));
  };

  useEffect(() => {
    refreshGpu();
  }, [proxyUrl]);

  const addShot = () => {
    if (shots.length >= 5) return;
    setShots((prev) => [...prev, { id: Date.now().toString(), prompt: '', subtitle: '', frames: 73 }]);
  };

  const removeShot = (id: string) => {
    if (shots.length <= 1) return;
    setShots((prev) => prev.filter((s) => s.id !== id));
  };

  const handleGenerateSequence = async () => {
    setErrorMsg('');
    setFinalMp4Url(null);
    if (!gpu.online) {
      setErrorMsg('Your free Colab/Kaggle GPU notebook is offline. Start it and update VIDEO_BACKEND_URL in Cloudflare Worker.');
      return;
    }

    const validShots = shots.filter((s) => s.prompt.trim());
    if (validShots.length === 0) {
      setErrorMsg('Enter a prompt for at least 1 shot.');
      return;
    }

    setBusy(true);
    let chainedImage = refImage;
    const completedIds: string[] = [];
    const completedSubs: string[] = [];

    for (let i = 0; i < validShots.length; i++) {
      const s = validShots[i];
      const fullPrompt = [
        s.prompt.trim(),
        characterLock ? `Character Consistency: ${characterLock}` : '',
        'cinematic lighting, smooth realistic camera motion',
      ].filter(Boolean).join(', ');

      const useI2V = (mode === 'image-to-video' && Boolean(chainedImage)) || (chainConsistency && i > 0 && Boolean(chainedImage));

      const res = await generateSingleShot(
        proxyUrl,
        {
          mode: useI2V ? 'image-to-video' : 'text-to-video',
          prompt: fullPrompt,
          aspectRatio,
          frames: s.frames,
          image: useI2V ? chainedImage : undefined,
        },
        (msg) => setProgressMsg(`Shot ${i + 1}/${validShots.length}: ${msg}`)
      );

      if (!res.success || !res.jobId) {
        setBusy(false);
        setErrorMsg(`Shot ${i + 1} failed: ${res.error}`);
        return;
      }

      if (chainConsistency && res.lastFrame) {
        chainedImage = res.lastFrame;
      }

      completedIds.push(res.jobId);
      completedSubs.push(s.subtitle);
      setShots((prev) =>
        prev.map((item) =>
          item.id === s.id
            ? { ...item, generatedJobId: res.jobId, previewUrl: res.videoUrl, lastFrame: res.lastFrame, statusText: 'Rendered' }
            : item
        )
      );
    }

    setProgressMsg('Stitching shots with transitions, subtitles & audio into MP4...');
    const stitched = await stitchFinalMp4(proxyUrl, {
      shotIds: completedIds,
      transition,
      subtitles: completedSubs,
      voiceoverText: voiceoverText.trim() || undefined,
      voiceoverAudioBase64: voiceoverAudio,
      musicAudioBase64: musicAudio,
      aspectRatio,
    });

    setBusy(false);
    setProgressMsg('');
    if (!stitched.success || !stitched.videoUrl) {
      setErrorMsg(stitched.error || 'Failed to assemble final MP4.');
      return;
    }
    setFinalMp4Url(stitched.videoUrl);
  };

  return (
    <div className="space-y-6">
      {/* Live GPU Status Bar */}
      <div className={`p-4 rounded-2xl border flex flex-wrap items-center justify-between gap-3 ${
        gpu.online ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-rose-400/40 bg-rose-500/10'
      }`}>
        <div className="flex items-center gap-3 text-xs">
          {gpu.online ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <AlertCircle className="w-5 h-5 text-rose-400" />}
          <div>
            <p className="font-bold">{gpu.online ? `GPU Online: ${gpu.gpu} (${gpu.vramFreeGb} GB free)` : 'GPU Notebook Offline'}</p>
            <p className="opacity-75">{gpu.online ? `Model: ${gpu.model} • Active Queue: ${gpu.activeJobs}` : gpu.error}</p>
          </div>
        </div>
        <button onClick={refreshGpu} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/10 text-xs font-medium">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh Status
        </button>
      </div>

      {/* Format & Mode Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex gap-2">
          {([
            { r: '9:16', label: '9:16 (480×854)' },
            { r: '16:9', label: '16:9 (704×396)' },
            { r: '1:1', label: '1:1 (512×512)' },
          ] as const).map((item) => (
            <button
              key={item.r}
              onClick={() => setAspectRatio(item.r)}
              className={`flex-1 py-2 px-2 rounded-xl text-[11px] font-medium border ${
                aspectRatio === item.r ? 'border-cyan-400 bg-cyan-500/20' : 'border-white/15'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          {(['text-to-video', 'image-to-video'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-2 rounded-xl text-xs font-medium border ${
                mode === m ? 'border-purple-400 bg-purple-500/20' : 'border-white/15'
              }`}
            >
              {m === 'text-to-video' ? 'Text-to-Video' : 'Image-to-Video'}
            </button>
          ))}
        </div>
      </div>

      {/* Character Consistency Lock */}
      <div className="p-4 rounded-2xl bg-black/25 border border-white/15 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold flex items-center gap-1.5 text-cyan-300"><Lock className="w-3.5 h-3.5" /> Character & Scene Consistency Lock</span>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={chainConsistency} onChange={(e) => setChainConsistency(e.target.checked)} />
            Chain Shot Frames Automatically
          </label>
        </div>
        <input
          value={characterLock}
          onChange={(e) => setCharacterLock(e.target.value)}
          placeholder="Lock appearance across all shots (e.g., 'Boy in navy hoodie with glowing cyan glasses, rainy neon alley')"
          className="w-full px-3 py-2.5 rounded-xl bg-black/30 border border-white/15 text-xs"
        />
        <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-cyan-400/40 text-xs cursor-pointer">
          <Upload className="w-4 h-4 text-cyan-400" />
          <span>{refImage ? 'Reference Image Locked' : 'Optional: Upload Character Reference Image (I2V)'}</span>
          <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setRefImage(await fileToBase64(f));
          }} />
        </label>
      </div>

      {/* 3–5 Shots Storyboard */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold flex items-center gap-2"><Film className="w-4 h-4 text-purple-400" /> Multi-Shot Sequence ({shots.length}/5 Shots)</h3>
          {shots.length < 5 && (
            <button onClick={addShot} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white/10 text-xs"><Plus className="w-3.5 h-3.5" /> Add Shot</button>
          )}
        </div>

        {shots.map((shot, idx) => (
          <div key={shot.id} className="p-4 rounded-2xl bg-black/25 border border-white/15 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-cyan-300">Shot {idx + 1}</span>
              <div className="flex items-center gap-2">
                <select
                  value={shot.frames}
                  onChange={(e) => setShots((prev) => prev.map((s) => (s.id === shot.id ? { ...s, frames: Number(e.target.value) as any } : s)))}
                  className="px-2.5 py-1 rounded-lg bg-black/40 border border-white/15 text-[11px]"
                >
                  <option value={49}>2 sec (49 frames)</option>
                  <option value={73}>3 sec (73 frames)</option>
                  <option value={97}>4 sec (97 frames)</option>
                </select>
                {shots.length > 1 && (
                  <button onClick={() => removeShot(shot.id)} className="text-rose-400"><Trash2 className="w-4 h-4" /></button>
                )}
              </div>
            </div>
            <textarea
              value={shot.prompt}
              onChange={(e) => setShots((prev) => prev.map((s) => (s.id === shot.id ? { ...s, prompt: e.target.value } : s)))}
              rows={2}
              placeholder={`Shot ${idx + 1} visual action & camera movement...`}
              className="w-full p-3 rounded-xl bg-black/30 border border-white/15 text-xs"
            />
            <input
              value={shot.subtitle}
              onChange={(e) => setShots((prev) => prev.map((s) => (s.id === shot.id ? { ...s, subtitle: e.target.value } : s)))}
              placeholder="Optional subtitle text for this shot..."
              className="w-full px-3 py-2 rounded-xl bg-black/30 border border-white/15 text-xs"
            />
            {shot.previewUrl && (
              <video src={shot.previewUrl} controls className="rounded-xl max-h-48 border border-white/15" />
            )}
          </div>
        ))}
      </div>

      {/* Post-Production: Transitions, Voiceover & Music */}
      <div className="p-4 rounded-2xl bg-black/25 border border-white/15 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[11px] opacity-70 mb-1">Shot Transition</label>
            <select value={transition} onChange={(e) => setTransition(e.target.value as any)} className="w-full px-3 py-2 rounded-xl bg-black/40 border border-white/15 text-xs">
              <option value="fade">Crossfade</option>
              <option value="wipeleft">Wipe Left</option>
              <option value="slideup">Slide Up</option>
              <option value="circleopen">Circle Open</option>
            </select>
          </div>
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-white/15 text-xs cursor-pointer self-end">
            <Mic className="w-4 h-4 text-emerald-400" />
            <span>{voiceoverAudio ? 'Voiceover Audio Added' : 'Upload Voiceover (Optional)'}</span>
            <input type="file" accept="audio/*" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setVoiceoverAudio(await fileToBase64(f));
            }} />
          </label>
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-white/15 text-xs cursor-pointer self-end">
            <Music className="w-4 h-4 text-pink-400" />
            <span>{musicAudio ? 'Background Music Added' : 'Upload Music (Optional)'}</span>
            <input type="file" accept="audio/*" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setMusicAudio(await fileToBase64(f));
            }} />
          </label>
        </div>

        <input
          value={voiceoverText}
          onChange={(e) => setVoiceoverText(e.target.value)}
          placeholder="OR type English narration text for automatic open-source Piper TTS voiceover..."
          className="w-full px-3 py-2.5 rounded-xl bg-black/30 border border-white/15 text-xs"
        />
      </div>

      {/* Generate & Stitch Button */}
      <button
        onClick={handleGenerateSequence}
        disabled={busy || !gpu.online}
        className="w-full py-4 rounded-2xl font-bold text-sm text-white bg-gradient-to-r from-violet-600 via-purple-600 to-blue-600 disabled:opacity-40 flex items-center justify-center gap-2 shadow-lg shadow-purple-500/25"
      >
        {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {busy ? progressMsg : 'Generate Shots & Export Final MP4'}
      </button>

      {errorMsg && (
        <div className="p-4 rounded-2xl border border-rose-400/40 bg-rose-500/10 text-rose-200 text-xs flex gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
          <span>{errorMsg}</span>
        </div>
      )}

      {finalMp4Url && (
        <div className="p-4 rounded-2xl border border-emerald-400/40 bg-emerald-500/10 space-y-3">
          <p className="text-xs font-bold text-emerald-300">Final Combined Video Ready (MP4 • 24 FPS)</p>
          <video src={finalMp4Url} controls className="rounded-2xl max-h-96 mx-auto border border-white/15" />
          <a
            href={finalMp4Url}
            download={`lumenix-video-${Date.now()}.mp4`}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-cyan-500/25 text-cyan-200 text-xs font-semibold"
          >
            <Download className="w-4 h-4" /> Download Final MP4
          </a>
        </div>
      )}
    </div>
  );
      }
