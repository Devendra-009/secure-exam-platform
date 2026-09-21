const API = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://127.0.0.1:5000/api' : '');

if (!API && !import.meta.env.DEV) {
  throw new Error('VITE_API_URL is required for a production build.');
}

export function getToken() {
  return localStorage.getItem('secureExamToken');
}

export function setToken(token) {
  if (token) localStorage.setItem('secureExamToken', token);
  else localStorage.removeItem('secureExamToken');
}

export function isNetworkError(error) {
  return error?.isNetworkError === true;
}

export async function request(path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 12_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    ...(options.headers || {}),
  };

  try {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

    if (!response.ok) {
      const error = new Error(data.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError' || error instanceof TypeError) {
      const networkError = new Error('Network error. Check your connection and make sure the SecureExam API is running.');
      networkError.isNetworkError = true;
      networkError.cause = error;
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export { API };
