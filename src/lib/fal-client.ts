export interface FalImageResult {
  url: string;
  width: number;
  height: number;
}

export async function generateImage(prompt: string): Promise<FalImageResult> {
  const response = await fetch('/fal/fal-ai/flux-pro/v1.1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      image_size: 'landscape_16_9',
      num_images: 1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`FAL API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const image = data.images?.[0];
  if (!image) {
    throw new Error('No image returned from FAL API');
  }

  return {
    url: image.url,
    width: image.width || 1024,
    height: image.height || 576,
  };
}

export interface FalVideoResult {
  url: string;
}

/**
 * Generate a video from an image using FAL MiniMax queue API.
 * Handles the full submit → poll → result cycle in one call.
 * Returns the video URL when complete.
 */
export async function generateVideo(
  imageUrl: string,
  prompt: string,
  onProgress?: (msg: string) => void,
  maxWaitMs = 600000
): Promise<FalVideoResult> {
  // Step 1: Submit job
  onProgress?.('Submitting video job...')

  const submitRes = await fetch('/fal-queue/fal-ai/minimax/video-01-live/image-to-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, prompt }),
  });

  if (!submitRes.ok) {
    const errorText = await submitRes.text().catch(() => 'Unknown error');
    throw new Error(`Video submit error (${submitRes.status}): ${errorText}`);
  }

  const submitData = await submitRes.json();
  const requestId = submitData.request_id;
  if (!requestId) throw new Error('No request_id in queue response');

  // Use the actual URLs from FAL's response, converted to proxy paths
  // FAL returns: https://queue.fal.run/fal-ai/minimax/requests/{id}/status
  // We convert to: /fal-queue/fal-ai/minimax/requests/{id}/status
  const toProxyPath = (url: string) => '/fal-queue' + new URL(url).pathname;
  const statusPath = submitData.status_url
    ? toProxyPath(submitData.status_url)
    : `/fal-queue/fal-ai/minimax/requests/${requestId}/status`;
  const responsePath = submitData.response_url
    ? toProxyPath(submitData.response_url)
    : `/fal-queue/fal-ai/minimax/requests/${requestId}`;

  onProgress?.(`Job queued (${requestId.slice(0, 8)}), polling ${statusPath}`);

  const start = Date.now();
  let lastLog = 0;

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 8000)); // Wait 8s between polls

    let statusData: Record<string, unknown>;
    try {
      const res = await fetch(statusPath);
      if (!res.ok) {
        // Non-fatal - retry
        onProgress?.(`Poll returned ${res.status}, retrying...`);
        continue;
      }
      statusData = await res.json();
    } catch {
      onProgress?.('Poll network error, retrying...');
      continue;
    }

    const status = statusData.status as string;

    if (status === 'COMPLETED') {
      // Fetch result
      try {
        const resultRes = await fetch(responsePath);
        if (!resultRes.ok) throw new Error(`Result fetch error: ${resultRes.status}`);
        const result = await resultRes.json();
        const videoUrl = result.video?.url;
        if (!videoUrl) throw new Error('No video URL in result');
        onProgress?.('Video ready!');
        return { url: videoUrl };
      } catch (err) {
        throw new Error(`Failed to fetch video result: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    if (status === 'FAILED') {
      throw new Error(`Video generation failed: ${(statusData.error as string) || 'Unknown error'}`);
    }

    // Throttle progress logs to once per 15s
    const now = Date.now();
    if (now - lastLog > 15000) {
      const elapsed = Math.round((now - start) / 1000);
      onProgress?.(`${status || 'IN_PROGRESS'} (${elapsed}s elapsed)`);
      lastLog = now;
    }
  }

  throw new Error('Video generation timed out (10 min)');
}

/**
 * Generate SFX audio via ElevenLabs Sound Generation API.
 * Returns a blob URL for the generated audio.
 */
export async function generateSfx(
  prompt: string,
  durationSeconds: number
): Promise<{ url: string; duration: number }> {
  const response = await fetch('/elevenlabs/v1/sound-generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: Math.min(durationSeconds, 30),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`ElevenLabs error (${response.status}): ${errorText}`);
  }

  const blob = await response.blob();
  // Convert to data URL so it survives localStorage persistence (blob URLs expire on refresh)
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return { url, duration: durationSeconds };
}

export async function uploadImage(file: File): Promise<string> {
  // Step 1: Get presigned URL
  const initiateRes = await fetch('/fal-storage/storage/upload/initiate?storage_type=fal-cdn-v3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_name: file.name,
      content_type: file.type,
    }),
  });

  if (!initiateRes.ok) {
    throw new Error(`Upload initiate failed: ${initiateRes.status}`);
  }

  const { upload_url, file_url } = await initiateRes.json();

  // Step 2: Upload file to presigned URL
  const uploadRes = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!uploadRes.ok) {
    throw new Error(`File upload failed: ${uploadRes.status}`);
  }

  return file_url;
}
