 
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
    setShots((prev) => [...prev, {
      id: Date.now().toString(),
      prompt: '',
      subtitle: '',
      frames: 73
    }]);
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

      const useI2V =
        (mode === 'image-to-video' && Boolean(chainedImage)) ||
        (chainConsistency && i > 0 && Boolean(chainedImage));

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
            ? {
                ...item,
                generatedJobId: res.jobId,
                previewUrl: res.videoUrl,
                lastFrame: res.lastFrame,
                statusText: 'Rendered',
              }
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
    <div className="space-y-6 rounded-2xl bg-slate-950 p-4 text-white">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Film /> Lumenix Video Studio
        </h2>
        <button
          onClick={refreshGpu}
          disabled={busy}
          className="rounded-lg bg-slate-800 p-2"
        >
          <RefreshCw size={18} />
        </button>
      </div>

      <div className="rounded-xl bg-slate-900 p-3">
        <div className="flex items-center gap-2">
          {gpu.online ? (
            <CheckCircle2 className="text-green-400" />
          ) : (
            <AlertCircle className="text-red-400" />
          )}
          <span>
            {gpu.online ? 'GPU Online' : 'GPU Offline'}
          </span>
        </div>
        {gpu.error && (
          <p className="mt-1 text-sm text-slate-400">{gpu.error}</p>
        )}
      </div>

      <div>
        <label className="mb-2 block">Aspect Ratio</label>
        <select
          value={aspectRatio}
          onChange={(e) => setAspectRatio(e.target.value as any)}
          className="w-full rounded-lg bg-slate-800 p-3"
        >
          <option value="9:16">9:16 Shorts / Reels</option>
          <option value="16:9">16:9 YouTube</option>
          <option value="1:1">1:1 Square</option>
        </select>
      </div>

      <div>
        <label className="mb-2 block">Generation Mode</label>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as any)}
          className="w-full rounded-lg bg-slate-800 p-3"
        >
          <option value="text-to-video">Text to Video</option>
          <option value="image-to-video">Image to Video</option>
        </select>
      </div>

      <div>
        <label className="mb-2 block">Reference Image</label>
        <input
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setRefImage(await fileToBase64(file));
          }}
          className="w-full rounded-lg bg-slate-800 p-3"
        />
      </div>

      <div>
        <label className="mb-2 block">Character Consistency</label>
        <input
          value={characterLock}
          onChange={(e) => setCharacterLock(e.target.value)}
          placeholder="Describe the character appearance..."
          className="w-full rounded-lg bg-slate-800 p-3"
        />
        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={chainConsistency}
            onChange={(e) => setChainConsistency(e.target.checked)}
          />
          Maintain character consistency between shots
        </label>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-semibold">Video Shots</h3>
          <button
            onClick={addShot}
            disabled={shots.length >= 5 || busy}
            className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 disabled:opacity-40"
          >
            <Plus size={16} /> Add Shot
          </button>
        </div>

        {shots.map((shot, index) => (
          <div key={shot.id} className="space-y-3 rounded-xl bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold">Shot {index + 1}</h4>
              <button
                onClick={() => removeShot(shot.id)}
                disabled={shots.length <= 1 || busy}
                className="text-red-400 disabled:opacity-30"
              >
                <Trash2 size={18} />
              </button>
            </div>

            <textarea
              value={shot.prompt}
              onChange={(e) =>
                setShots((prev) =>
                  prev.map((s) =>
                    s.id === shot.id ? { ...s, prompt: e.target.value } : s
                  )
                )
              }
              placeholder="Describe this video scene..."
              rows={3}
              className="w-full rounded-lg bg-slate-800 p-3"
            />

            <input
              value={shot.subtitle}
              onChange={(e) =>
                setShots((prev) =>
                  prev.map((s) =>
                    s.id === shot.id ? { ...s, subtitle: e.target.value } : s
                  )
                )
              }
              placeholder="Subtitle (optional)"
              className="w-full rounded-lg bg-slate-800 p-3"
            />

            <select
              value={shot.frames}
              onChange={(e) =>
                setShots((prev) =>
                  prev.map((s) =>
                    s.id === shot.id
                      ? { ...s, frames: Number(e.target.value) as 49 | 73 | 97 }
                      : s
                  )
                )
              }
              className="w-full rounded-lg bg-slate-800 p-3"
            >
              <option value={49}>49 Frames</option>
              <option value={73}>73 Frames</option>
              <option value={97}>97 Frames</option>
            </select>

            {shot.previewUrl && (
              <video
                src={shot.previewUrl}
                controls
                className="w-full rounded-lg"
              />
            )}

            {shot.statusText && (
              <p className="text-sm text-green-400">{shot.statusText}</p>
            )}
          </div>
        ))}
      </div>

      <div>
        <label className="mb-2 block">Transition</label>
        <select
          value={transition}
          onChange={(e) => setTransition(e.target.value as any)}
          className="w-full rounded-lg bg-slate-800 p-3"
        >
          <option value="fade">Fade</option>
          <option value="wipeleft">Wipe Left</option>
          <option value="slideup">Slide Up</option>
          <option value="circleopen">Circle Open</option>
        </select>
      </div>

      <div>
        <label className="mb-2 block">Voiceover Text</label>
        <textarea
          value={voiceoverText}
          onChange={(e) => setVoiceoverText(e.target.value)}
          placeholder="Enter narration..."
          rows={3}
          className="w-full rounded-lg bg-slate-800 p-3"
        />
      </div>

      <div>
        <label className="mb-2 block">Voiceover Audio</label>
        <input
          type="file"
          accept="audio/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setVoiceoverAudio(await fileToBase64(file));
          }}
        />
      </div>

      <div>
        <label className="mb-2 block">Background Music</label>
        <input
          type="file"
          accept="audio/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setMusicAudio(await fileToBase64(file));
          }}
        />
      </div>

      {errorMsg && (
        <div className="rounded-lg bg-red-950 p-3 text-red-300">
          <AlertCircle className="mr-2 inline" size={18} />
          {errorMsg}
        </div>
      )}

      {progressMsg && (
        <p className="text-sm text-indigo-300">{progressMsg}</p>
      )}

      <button
        onClick={handleGenerateSequence}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 p-4 font-bold disabled:opacity-50"
      >
        {busy ? (
          <RefreshCw className="animate-spin" />
        ) : (
          <Sparkles />
        )}
        {busy ? 'Generating Video...' : 'Generate Final Video'}
      </button>

      {finalMp4Url && (
        <div className="space-y-3 rounded-xl bg-slate-900 p-4">
          <h3 className="font-bold text-green-400">
            Video Generated Successfully!
          </h3>
          <video
            src={finalMp4Url}
            controls
            className="w-full rounded-lg"
          />
          <a
            href={finalMp4Url}
            download="lumenix-video.mp4"
            className="flex items-center justify-center gap-2 rounded-lg bg-green-600 p-3 font-semibold"
          >
            <Download size={18} /> Download MP4
          </a>
        </div>
      )}
    </div>
  );
}
