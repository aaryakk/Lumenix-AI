    // ---------------------------------------------------------
    // 5. GPU VIDEO PROXY ROUTES (Securely injects X-Lumenix-Secret)
    // ---------------------------------------------------------
    if (path.startsWith('/video/')) {
      const gpuBase = (env.VIDEO_BACKEND_URL || '').trim().replace(/\/$/, '');
      if (!gpuBase) {
        return jsonResponse({
          online: false,
          error: 'GPU Notebook Offline: VIDEO_BACKEND_URL is not set in Cloudflare Worker.',
        }, path === '/video/status' ? 200 : 503);
      }

      const gpuHeaders = {
        'Content-Type': 'application/json',
        'X-Lumenix-Secret': env.VIDEO_API_SECRET || '',
      };

      try {
        if (request.method === 'GET' && path === '/video/status') {
          const r = await fetch(`${gpuBase}/health`, { headers: gpuHeaders });
          if (!r.ok) return jsonResponse({ online: false, error: 'GPU notebook is unreachable or sleeping.' });
          return jsonResponse(await r.json());
        }

        if (request.method === 'POST' && path === '/video/start') {
          const r = await fetch(`${gpuBase}/jobs/start`, {
            method: 'POST',
            headers: gpuHeaders,
            body: await request.text(),
          });
          return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
        }

        if (request.method === 'GET' && path === '/video/job') {
          const id = url.searchParams.get('id') || '';
          const r = await fetch(`${gpuBase}/jobs/status/${encodeURIComponent(id)}`, { headers: gpuHeaders });
          return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
        }

        if (request.method === 'POST' && path === '/video/stitch') {
          const r = await fetch(`${gpuBase}/stitch`, {
            method: 'POST',
            headers: gpuHeaders,
            body: await request.text(),
          });
          return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
        }

        if (request.method === 'GET' && path === '/video/file') {
          const id = url.searchParams.get('id') || '';
          const r = await fetch(`${gpuBase}/file/${encodeURIComponent(id)}`, { headers: gpuHeaders });
          return new Response(r.body, {
            status: r.status,
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Disposition': `attachment; filename="lumenix-${id}.mp4"`,
              ...CORS_HEADERS,
            },
          });
        }
      } catch {
        return jsonResponse({
          online: false,
          error: 'Colab/Kaggle GPU session appears offline or timed out.',
        }, path === '/video/status' ? 200 : 503);
      }
    }