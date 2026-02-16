export interface ClaudeStreamEvent {
  type: 'thinking' | 'text' | 'done' | 'error';
  text: string;
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT = `You are an AI creative assistant for a video production canvas tool. You help users create stories, scripts, characters, scenes, and storyboards.

The user has a canvas with drag-and-drop nodes (script, visual assets, audio blocks) and a shot-based timeline. You can:
- Suggest creative ideas for scripts, characters, and scenes
- Help refine dialogue and narration
- Suggest image generation prompts for visual assets
- Help organize shots in the timeline

When the user asks to generate an image, respond with a clear prompt description prefixed with [IMAGE_PROMPT]: followed by the prompt text. The system will automatically generate the image.

Be concise and creative. Use markdown for formatting.`;

/**
 * Non-streaming Claude call for structured data extraction.
 * Returns the full text response.
 */
export async function callClaude(
  messages: ClaudeMessage[],
  options?: { system?: string; maxTokens?: number }
): Promise<string> {
  const response = await fetch('/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: options?.maxTokens ?? 8000,
      system: options?.system ?? SYSTEM_PROMPT,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Claude API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.content
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');
}

export async function* streamClaude(
  messages: ClaudeMessage[],
  options?: { enableThinking?: boolean; budgetTokens?: number; system?: string; maxTokens?: number }
): AsyncGenerator<ClaudeStreamEvent> {
  const enableThinking = options?.enableThinking ?? true;
  const budgetTokens = options?.budgetTokens ?? 5000;

  const body: Record<string, unknown> = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: options?.maxTokens ?? 8000,
    system: options?.system ?? SYSTEM_PROMPT,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  };

  if (enableThinking) {
    body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
  }

  let response: Response;
  try {
    response = await fetch('/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    yield { type: 'error', text: `Network error: ${err instanceof Error ? err.message : 'Failed to connect'}` };
    return;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    yield { type: 'error', text: `API error (${response.status}): ${errorText}` };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', text: 'No response body' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { type: 'done', text: '' };
            return;
          }

          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'thinking_delta') {
                yield { type: 'thinking', text: event.delta.thinking };
              } else if (event.delta?.type === 'text_delta') {
                yield { type: 'text', text: event.delta.text };
              }
            } else if (event.type === 'message_stop') {
              yield { type: 'done', text: '' };
              return;
            } else if (event.type === 'error') {
              yield { type: 'error', text: event.error?.message || 'Stream error' };
              return;
            }
          } catch {
            // Skip non-JSON lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done', text: '' };
}
