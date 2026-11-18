
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

  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(
      `Backend returned HTML/non-JSON (${response.status}). Check API URL: ${baseUrl}${endpoint}. Response: ${text.slice(0, 150)}`
    );
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.detail || data.error || 'Backend request failed'
    );
  }

  return data as T;
}
