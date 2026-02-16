const BASE_URL = '/api/v1';
const TOKEN_KEY = 'storyverse_access_token';

let authToken: string | null = null;

// Restore token from localStorage on module load
try {
  const stored = localStorage.getItem(TOKEN_KEY);
  if (stored) authToken = stored;
} catch { /* ignore */ }

export function setAuthToken(token: string | null) {
  authToken = token;
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch { /* ignore */ }
}

export function getAuthToken(): string | null {
  return authToken;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { params?: Record<string, string | number | boolean | undefined>; isFormData?: boolean }
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  if (options?.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      if (value !== undefined) url.searchParams.set(key, String(value));
    });
  }

  const headers: Record<string, string> = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (!options?.isFormData) headers['Content-Type'] = 'application/json';

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: options?.isFormData ? (body as FormData) : body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, error.detail || res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// ─── Health check with 30s TTL cache ───

let _backendAvailable: boolean | null = null;
let _healthCheckTime = 0;
const HEALTH_TTL = 30_000;

export async function isBackendAvailable(): Promise<boolean> {
  const now = Date.now();
  if (_backendAvailable !== null && now - _healthCheckTime < HEALTH_TTL) {
    return _backendAvailable;
  }
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    _backendAvailable = res.ok;
  } catch {
    _backendAvailable = false;
  }
  _healthCheckTime = now;
  return _backendAvailable;
}

export function resetHealthCache() {
  _backendAvailable = null;
  _healthCheckTime = 0;
}

// ─── Auto-login with dev credentials ───

const DEV_USERNAME = 'admin';
const DEV_PASSWORD = 'admin';

export async function ensureAuth(): Promise<void> {
  if (authToken) return;
  try {
    const formData = new FormData();
    formData.append('username', DEV_USERNAME);
    formData.append('password', DEV_PASSWORD);
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      body: formData,
    });
    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        setAuthToken(data.access_token);
      }
    }
  } catch { /* auth optional — fallback path doesn't need it */ }
}

// ─── HTTP helpers ───

export const get = <T>(path: string, params?: Record<string, string | number | boolean | undefined>) =>
  request<T>('GET', path, undefined, { params });

export const post = <T>(path: string, body?: unknown) =>
  request<T>('POST', path, body);

export const put = <T>(path: string, body?: unknown) =>
  request<T>('PUT', path, body);

export const del = <T>(path: string) =>
  request<T>('DELETE', path);

export const postForm = <T>(path: string, formData: FormData) =>
  request<T>('POST', path, formData, { isFormData: true });
