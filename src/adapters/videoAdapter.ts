
export interface GpuStatus {
  online: boolean;
  model?: string;
  gpu?: string;
  vramFreeGb?: number;
  activeJobs?: number;
  error?: string;
}

export interface ShotJobInput {
  mode: 'text-to-video' | 'image-to-video';
  prompt: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
  frames: 49 | 73 | 97;
  image?: string;
}

export interface StitchInput {
  shotIds: string[];
  transition: 'fade' | 'wipeleft' | 'slideup' | 'circleopen';
  subtitles: string[];
  voiceoverText?: string;
  voiceoverAudioBase64?: string;
  musicAudioBase64?: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
}

function cleanBase(proxyUrl: string) {
  return (proxyUrl || import.meta.env.VITE_LUMENIX_PROXY_URL || '')
    .trim()
    .replace(/\/$/, '');
}

export async function checkGpuStatus(proxyUrl: string): Promise<GpuStatus> {
  const base = cleanBase(proxyUrl);
  if (!base) return { online: false, error: 'Backend URL is not configured.' };

  try {
    const res = await fetch(`${base}/video/status`);
    if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch {
    return { online: false, error: 'Could not reach video backend.' };
  }
}

export async function generateSingleShot(
  proxyUrl: string,
  input: ShotJobInput,
  onProgress: (msg: string) => void
): Promise<{
  success: boolean;
  jobId?: string;
  videoUrl?: string;
  lastFrame?: string;
  error?: string;
}> {
  const base = cleanBase(proxyUrl);
  if (!base) return { success: false, error: 'Backend URL is missing.' };

  try {
    onProgress('Submitting video job...');

    const startRes = await fetch(`${base}/video/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    const startData = await startRes.json();

    if (!startRes.ok || !startData.jobId) {
      return {
        success: false,
        error: startData.error || startData.detail || 'Job rejected.',
      };
    }

    const jobId = startData.jobId;

    for (let i = 0; i < 90; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));

      const pollRes = await fetch(
        `${base}/video/job?id=${encodeURIComponent(jobId)}`
      );
      const pollData = await pollRes.json();

      if (!pollRes.ok) {
        return { success: false, error: pollData.error || 'Status check failed.' };
      }

      if (pollData.status === 'failed') {
        return { success: false, error: pollData.error || 'Rendering failed.' };
      }

      if (pollData.status === 'completed') {
        return {
          success: true,
          jobId,
          videoUrl: `${base}/video/file?id=${encodeURIComponent(jobId)}`,
          lastFrame: pollData.lastFrame,
        };
      }

      onProgress(pollData.progress || `Rendering (${(i + 1) * 3}s)...`);
    }

    return { success: false, error: 'Generation timed out after 4.5 minutes.' };
  } catch {
    return { success: false, error: 'Backend connection lost.' };
  }
}

export async function stitchFinalMp4(
  proxyUrl: string,
  input: StitchInput
): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
  const base = cleanBase(proxyUrl);
  if (!base) return { success: false, error: 'Backend URL is missing.' };

  try {
    const res = await fetch(`${base}/video/stitch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    const data = await res.json();

    if (!res.ok || !data.finalId) {
      return {
        success: false,
        error: data.detail || data.error || 'MP4 stitching failed.',
      };
    }

    return {
      success: true,
      videoUrl: `${base}/video/file?id=${encodeURIComponent(data.finalId)}`,
    };
  } catch {
    return { success: false, error: 'Network error during MP4 stitching.' };
  }
}
