import { get, post, put, del, postForm } from './api';
import type {
  AuthResponse, Episode, Character, BackendAsset, StoryboardFrame,
  Keyframe, VideoShot, Scene, Prop, EditResult, ReviewNote,
  Version, VersionDiff, AiChatResponse, AiIssue, AiSuggestion,
  Template, JobStatus, UploadResponse,
} from '@/types/backend';

export const api = {
  // === Auth ===
  auth: {
    register: (data: { email: string; name: string; password: string }) =>
      post<AuthResponse>('/auth/register', data),
    login: (data: { username: string; password: string }) => {
      const formData = new FormData();
      formData.append('username', data.username);
      formData.append('password', data.password);
      return postForm<AuthResponse>('/auth/login', formData);
    },
    logout: () => post<void>('/auth/logout'),
  },

  // === Uploads ===
  uploads: {
    uploadFiles: (files: File[]) => {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      return postForm<UploadResponse[]>('/uploads/files', fd);
    },
    uploadImage: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return postForm<UploadResponse>('/images', fd);
    },
  },

  // === Scripts ===
  scripts: {
    generate: (projectId: string, data: { inspiration: string; file_ids?: string[]; settings?: Record<string, unknown> }) =>
      post<{ episodes: Episode[] }>(`/projects/${projectId}/scripts`, data),
  },

  // === Characters ===
  characters: {
    generate: (projectId: string, data: { episodes: Episode[]; language?: string; character_material_system_prompt?: string }) =>
      post<{ characters: Character[] }>(`/projects/${projectId}/characters`, data),
    stylize: (projectId: string, charId: string, data: Record<string, unknown>) =>
      post<Character>(`/projects/${projectId}/characters/${charId}/image_stylizations`, data),
    fineTune: (projectId: string, charId: string, data: Record<string, unknown>) =>
      post<Character>(`/projects/${projectId}/characters/${charId}/image_fine_tuning`, data),
    regenerate: (projectId: string, charId: string, data: { prompt?: string; gacha?: boolean }) =>
      post<Character>(`/projects/${projectId}/characters/${charId}/regenerate`, data),
  },

  // === Assets ===
  assets: {
    get: (projectId: string, timestamp?: string) =>
      get<{ assets: BackendAsset[] }>(`/projects/${projectId}/assets`, { timestamp }),
    editImage: (projectId: string, data: Record<string, unknown>) =>
      post<BackendAsset>(`/projects/${projectId}/asset_edit`, data),
  },

  // === Storyboards ===
  storyboards: {
    list: (projectId: string, episodeNumber?: number) =>
      get<{ frames: StoryboardFrame[] }>(`/projects/${projectId}/storyboards`, { episode_number: episodeNumber }),
    create: (projectId: string, data: { beat_number: number; prompt?: string; panel_count?: number }) =>
      post<StoryboardFrame>(`/projects/${projectId}/storyboards`, data),
    get: (projectId: string, frameId: string) =>
      get<StoryboardFrame>(`/projects/${projectId}/storyboards/${frameId}`),
    update: (projectId: string, frameId: string, data: Partial<StoryboardFrame>) =>
      put<StoryboardFrame>(`/projects/${projectId}/storyboards/${frameId}`, data),
    delete: (projectId: string, frameId: string) =>
      del<void>(`/projects/${projectId}/storyboards/${frameId}`),
    generate: (projectId: string, frameId: string, data: Record<string, unknown>) =>
      post<StoryboardFrame>(`/projects/${projectId}/storyboards/${frameId}/generate`, data),
    batchGenerate: (projectId: string, data: Record<string, unknown>) =>
      post<{ frames: StoryboardFrame[] }>(`/projects/${projectId}/storyboards/batch-generate`, data),
  },

  // === Keyframes ===
  keyframes: {
    list: (projectId: string, episodeId: string | number, language?: string, timestamp?: string) =>
      get<{ keyframes: Keyframe[] }>(`/projects/${projectId}/episodes/${episodeId}/keyframes`, { language, timestamp }),
    regenerate: (projectId: string, episodeId: string | number, keyframeId: string, data: { prompt?: string }) =>
      post<Keyframe>(`/projects/${projectId}/episodes/${episodeId}/keyframes/${keyframeId}/regenerate`, data),
    fineTune: (projectId: string, episodeId: string | number, keyframeId: string, data: Record<string, unknown>) =>
      post<Keyframe>(`/projects/${projectId}/episodes/${episodeId}/keyframes/${keyframeId}/fine_tuning`, data),
  },

  // === Video Shots ===
  shots: {
    list: (projectId: string, episodeIndex: number, language: string) =>
      get<{ shots: VideoShot[] }>(`/projects/${projectId}/shots`, { episode_index: episodeIndex, language }),
    regenerate: (projectId: string, data: Record<string, unknown>) =>
      post<VideoShot>(`/projects/${projectId}/shots/regenerate`, data),
  },

  // === Scenes ===
  scenes: {
    list: (projectId: string) =>
      get<{ scenes: Scene[] }>(`/projects/${projectId}/scenes`),
    create: (projectId: string, data: { name: string; description?: string; prompt?: string }) =>
      post<Scene>(`/projects/${projectId}/scenes`, data),
    get: (projectId: string, sceneId: string) =>
      get<Scene>(`/projects/${projectId}/scenes/${sceneId}`),
    update: (projectId: string, sceneId: string, data: Partial<Scene>) =>
      put<Scene>(`/projects/${projectId}/scenes/${sceneId}`, data),
    delete: (projectId: string, sceneId: string) =>
      del<void>(`/projects/${projectId}/scenes/${sceneId}`),
    generate: (projectId: string, sceneId: string, data: Record<string, unknown>) =>
      post<Scene>(`/projects/${projectId}/scenes/${sceneId}/generate`, data),
  },

  // === Props ===
  props: {
    list: (projectId: string) =>
      get<{ props: Prop[] }>(`/projects/${projectId}/props`),
    create: (projectId: string, data: { name: string; description?: string; prompt?: string }) =>
      post<Prop>(`/projects/${projectId}/props`, data),
    get: (projectId: string, propId: string) =>
      get<Prop>(`/projects/${projectId}/props/${propId}`),
    update: (projectId: string, propId: string, data: Partial<Prop>) =>
      put<Prop>(`/projects/${projectId}/props/${propId}`, data),
    delete: (projectId: string, propId: string) =>
      del<void>(`/projects/${projectId}/props/${propId}`),
    generate: (projectId: string, propId: string, data: Record<string, unknown>) =>
      post<Prop>(`/projects/${projectId}/props/${propId}/generate`, data),
  },

  // === Edit Pipeline ===
  edits: {
    concat: (projectId: string, episodeId: string | number, data: Record<string, unknown>) =>
      post<EditResult>(`/projects/${projectId}/episodes/${episodeId}/edits/concat`, data),
    stt: (projectId: string, episodeId: string | number, data: Record<string, unknown>) =>
      post<EditResult>(`/projects/${projectId}/episodes/${episodeId}/edits/stt`, data),
    music: (projectId: string, episodeId: string | number, data: Record<string, unknown>) =>
      post<EditResult>(`/projects/${projectId}/episodes/${episodeId}/edits/music`, data),
    compose: (projectId: string, episodeId: string | number, data: Record<string, unknown>) =>
      post<EditResult>(`/projects/${projectId}/episodes/${episodeId}/edits/compose`, data),
    render: (projectId: string, episodeId: string | number, editId: string) =>
      post<EditResult>(`/projects/${projectId}/episodes/${episodeId}/edits/${editId}/render`),
    downloadVideo: (projectId: string, episodeId: string | number, editId: string) =>
      get<Blob>(`/projects/${projectId}/episodes/${episodeId}/edits/${editId}/download_video`),
    downloadAll: (projectId: string, episodeId: string | number, editId: string, jobId: string) =>
      get<Blob>(`/projects/${projectId}/episodes/${episodeId}/edits/${editId}/download_all`, { job_id: jobId }),
  },

  // === Reviews ===
  reviews: {
    listNotes: (projectId: string, versionId?: string, statusFilter?: string) =>
      get<{ notes: ReviewNote[] }>(`/projects/${projectId}/reviews/notes`, { version_id: versionId, status: statusFilter }),
    createNote: (projectId: string, data: { content: string; timecode?: number; version_id?: string }) =>
      post<ReviewNote>(`/projects/${projectId}/reviews/notes`, data),
    getNote: (projectId: string, noteId: string) =>
      get<ReviewNote>(`/projects/${projectId}/reviews/notes/${noteId}`),
    updateNote: (projectId: string, noteId: string, data: { content: string }) =>
      put<ReviewNote>(`/projects/${projectId}/reviews/notes/${noteId}`, data),
    deleteNote: (projectId: string, noteId: string) =>
      del<void>(`/projects/${projectId}/reviews/notes/${noteId}`),
    resolveNote: (projectId: string, noteId: string) =>
      post<ReviewNote>(`/projects/${projectId}/reviews/notes/${noteId}/resolve`),
    reopenNote: (projectId: string, noteId: string) =>
      post<ReviewNote>(`/projects/${projectId}/reviews/notes/${noteId}/reopen`),
    replyToNote: (projectId: string, noteId: string, data: { content: string }) =>
      post<ReviewNote>(`/projects/${projectId}/reviews/notes/${noteId}/replies`, data),
    cutAtTimecode: (projectId: string, data: { timecode: number }) =>
      post<void>(`/projects/${projectId}/reviews/cut-at-timecode`, data),
  },

  // === Versions ===
  versions: {
    list: (projectId: string) =>
      get<{ versions: Version[] }>(`/projects/${projectId}/versions`),
    create: (projectId: string, data: { name: string; data?: Record<string, unknown> }) =>
      post<Version>(`/projects/${projectId}/versions`, data),
    get: (projectId: string, versionId: string) =>
      get<Version>(`/projects/${projectId}/versions/${versionId}`),
    setCurrent: (projectId: string, versionId: string) =>
      post<Version>(`/projects/${projectId}/versions/${versionId}/set-current`),
    diff: (projectId: string, versionId: string, compareTo: string) =>
      get<VersionDiff>(`/projects/${projectId}/versions/${versionId}/diff`, { compare_to: compareTo }),
    render: (projectId: string, data: { version_id?: string }) =>
      post<EditResult>(`/projects/${projectId}/versions/render`, data),
    download: (projectId: string, versionId: string) =>
      post<Blob>(`/projects/${projectId}/versions/${versionId}/download`),
  },

  // === AI Agents ===
  aiAgents: {
    chat: (data: { agent_type: string; message: string; context?: Record<string, unknown> }) =>
      post<AiChatResponse>('/ai-agents/chat', data),
    listIssues: (pageContext?: string, severity?: string, resolved?: boolean) =>
      get<{ issues: AiIssue[] }>('/ai-agents/issues', { page_context: pageContext, severity, resolved }),
    fixIssue: (issueId: string, data: Record<string, unknown>) =>
      post<AiIssue>(`/ai-agents/issues/${issueId}/fix`, data),
    ignoreIssue: (issueId: string, data: { reason?: string }) =>
      post<AiIssue>(`/ai-agents/issues/${issueId}/ignore`, data),
    listSuggestions: (agentType?: string, statusFilter?: string) =>
      get<{ suggestions: AiSuggestion[] }>('/ai-agents/suggestions', { agent_type: agentType, status: statusFilter }),
    applySuggestion: (suggestionId: string, data: Record<string, unknown>) =>
      post<AiSuggestion>(`/ai-agents/suggestions/${suggestionId}/apply`, data),
    analyze: (data: { page_context: string; item_type: string; item_id: string }) =>
      post<{ issues: AiIssue[]; suggestions: AiSuggestion[] }>('/ai-agents/analyze', data),
  },

  // === Templates ===
  templates: {
    list: (category?: string, search?: string) =>
      get<{ templates: Template[] }>('/templates', { category, search }),
    get: (templateId: string) =>
      get<Template>(`/templates/${templateId}`),
  },

  // === Export Jobs ===
  jobs: {
    getStatus: (projectId: string, jobId: string) =>
      get<JobStatus>(`/projects/${projectId}/jobs/${jobId}`),
  },

  // === Voice Feedback ===
  // Sends a recorded audio clip about a single element. Backend transcribes
  // + plans via Gemini-3 (TokenRouter) and stores a `new_prompt` on the job.
  // The frontend polls /projects/{id}/progress.voice_feedback_jobs and runs
  // its own local regeneration once the new_prompt is available.
  voiceFeedback: {
    submit: (
      projectId: string,
      data: {
        audio: Blob;
        elementKind: 'character' | 'scene' | 'prop' | 'keyframe' | 'shot';
        elementId: string;
        elementContext?: Record<string, unknown>;
      },
    ) => {
      const fd = new FormData();
      const filename =
        data.audio.type.includes('webm') ? 'recording.webm'
        : data.audio.type.includes('mp3') ? 'recording.mp3'
        : 'recording.wav';
      fd.append('audio', data.audio, filename);
      fd.append('element_kind', data.elementKind);
      fd.append('element_id', data.elementId);
      fd.append('element_context', JSON.stringify(data.elementContext ?? {}));
      return postForm<{ job_id: string; status: string }>(
        `/projects/${projectId}/voice-feedback`,
        fd,
      );
    },

    // Frontend-only path: audio → TokenRouter Gemini 3 Flash → revised prompt.
    // No backend project required. Used by canvas nodes / any element without a
    // server-side id. Returns the plan synchronously (one round-trip, ~3-6s).
    revise: async (data: {
      audio: Blob;
      elementKind: string;
      elementContext?: Record<string, unknown>;
    }): Promise<{
      new_prompt: string;
      user_intent: string;
      transcript: string;
      key_changes?: string[];
      preserve?: string[];
      severity?: string;
    }> => {
      const fd = new FormData();
      const filename =
        data.audio.type.includes('webm') ? 'recording.webm'
        : data.audio.type.includes('mp3') ? 'recording.mp3'
        : 'recording.wav';
      fd.append('audio', data.audio, filename);
      fd.append('element_kind', data.elementKind);
      fd.append('element_context', JSON.stringify(data.elementContext ?? {}));
      // Hits the vite plugin endpoint directly — no /api/v1 prefix, no auth.
      const res = await fetch('/providers/voice-revise', { method: 'POST', body: fd });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`voice-revise ${res.status}: ${errText.slice(0, 300)}`);
      }
      return res.json();
    },

    // Text-only variant of revise() — skips transcription, sends typed feedback
    // straight to the prompt-revision LLM. Same response shape so callers can
    // reuse whatever they did with the voice plan. Used by the edit panel's
    // "给 AI 反馈" tab.
    textRevise: async (data: {
      text: string;
      elementKind: string;
      elementContext?: Record<string, unknown>;
    }): Promise<{
      new_prompt: string;
      user_intent: string;
      transcript: string;
      key_changes?: string[];
      preserve?: string[];
      severity?: string;
    }> => {
      const res = await fetch('/providers/text-revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: data.text,
          element_kind: data.elementKind,
          element_context: data.elementContext ?? {},
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`text-revise ${res.status}: ${errText.slice(0, 300)}`);
      }
      return res.json();
    },
  },

  // === Art-style RAG ===
  // Wraps the local prompt_rag FastAPI service (see ~/repos/prompt_rag/serve.py).
  // Returns nearest-neighbor reference prompts + their generated media URLs so
  // the user can pick a real-world art example to anchor a shot's style.
  artRag: {
    search: async (data: {
      query: string;
      topK?: number;
      taskCategory?: string;
      taskType?: 't2i' | 'i2i' | 't2v' | 'i2v' | 'v2v';
      modelName?: string;
      outputMediaType?: 'image' | 'video';
    }): Promise<{
      corpus_count?: number;
      source_path?: string;
      hits: Array<{
        id: string;
        prompt: string;
        similarity: number;
        output_media_url: string;
        output_media_type: string | null;
        task_category: string;
        task_type: string;
        model_name: string;
        source_name: string;
        source_url: string;
      }>;
    }> => {
      const res = await fetch('/providers/art-rag-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: data.query,
          top_k: data.topK ?? 5,
          task_category: data.taskCategory ?? null,
          task_type: data.taskType ?? null,
          model_name: data.modelName ?? null,
          output_media_type: data.outputMediaType ?? null,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`art-rag-search ${res.status}: ${errText.slice(0, 300)}`);
      }
      return res.json();
    },
  },

  // === Project Progress ===
  // Polled by the canvas/table to show inline status for in-flight regens
  // and voice-feedback jobs.
  progress: {
    get: (projectId: string) =>
      get<{
        total_episodes: number;
        scripts: { reviewed: number; pending: number };
        storyboard: { completed: number; generating: number; pending: number; failed: number };
        shots: { completed: number; generating: number; pending: number; failed: number };
        failed_episodes: Array<{
          episode_id: string;
          episode_number: number;
          stage: string;
          error: string;
        }>;
        voice_feedback_jobs: Array<{
          job_id: string;
          element_kind: string;
          element_id: string;
          status: string;
          phase?: string;
          progress: number;
          transcript?: string;
          user_intent?: string;
          new_prompt?: string;
          downstream_job_id?: string;
          error?: string | null;
          created_at: string;
          updated_at: string;
        }>;
      }>(`/projects/${projectId}/progress`),
  },
};
