
export interface GpuStatus {
  online: boolean;
  error?: string;
  gpu?: string;
  vramFreeGb?: number;
  model?: string;
  activeJobs?: number;
}

interface GenerateShotPayload {
  mode: 'text-to-video' | 'image-to-video';
  prompt: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
  frames: 49 | 73 | 97;
  image?: string;
}

interface GenerateShotResult {
  success: boolean;
  jobId?: string;
  videoUrl?: string;
  lastFrame?: string;
  error?: string;
}

interface StitchPayload {
  shotIds: string[];
  transition: 'fade' | 'wipeleft' | 'slideup' | 'circleopen';
  subtitles: string[];
  voiceoverText?: string;
  voiceoverAudioBase64?: string;
  musicAudioBase64?: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
}

interface StitchResult {
  success: boolean;
  videoUrl?: string;
  error?: string;
}

async function apiRequest<T>(
  baseUrl: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}${endpoint}`,
    {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'Content-Type': 'application/json' }
        : {},
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.detail || data.error || 'Backend request failed');
  }

  return data as T;
}

export async function checkGpuStatus(
  proxyUrl: string
): Promise<GpuStatus> {
  try {
    return await apiRequest<GpuStatus>(
      proxyUrl,
      '/health'
    );
  } catch (error) {
    return {
      online: false,
      error: error instanceof Error
        ? error.message
        : 'GPU backend unavailable',
    };
  }
}

export async function generateSingleShot(
  proxyUrl: string,
  payload: GenerateShotPayload,
  onProgress?: (message: string) => void
): Promise<GenerateShotResult> {
  try {
    onProgress?.('Submitting generation request...');

    const result = await apiRequest<GenerateShotResult>(
      proxyUrl,
      '/generate',
      payload
    );

    if (!result.success || !result.jobId) {
      return {
        success: false,
        error: result.error || 'Generation failed',
      };
    }

    onProgress?.('Generation request submitted');

    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error
        ? error.message
        : 'Unknown generation error',
    };
  }
}

export async function stitchFinalMp4(
  proxyUrl: string,
  payload: StitchPayload
): Promise<StitchResult> {
  try {
    return await apiRequest<StitchResult>(
      proxyUrl,
      '/stitch',
      payload
    );
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error
        ? error.message
        : 'Video stitching failed',
    };
  }
  }
