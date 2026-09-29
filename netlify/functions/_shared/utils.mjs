export function json(statusCode, data, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(data),
  };
}

export function onlyPost(event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Método no permitido.' }, { Allow: 'POST, OPTIONS' });
  }
  return null;
}

export function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    const err = new Error('El cuerpo de la solicitud no es JSON válido.');
    err.statusCode = 400;
    throw err;
  }
}

export function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    const err = new Error(`Elix AI no tiene disponible una credencial requerida del servicio.`);
    err.statusCode = 500;
    throw err;
  }
  return value;
}

export async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function upstreamMessage(data, fallback = 'Elix AI recibió un error del servicio conectado.') {
  const detail = data?.error?.message ?? data?.detail ?? data?.error ?? data?.message ?? data?.raw;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  try {
    if (detail != null) return JSON.stringify(detail);
  } catch {}
  return fallback;
}

export function isRetryableStatus(status) {
  const n = Number(status || 0);
  return n === 408 || n === 409 || n === 425 || n === 429 || n >= 500;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const err = new Error(`Tiempo de espera agotado tras ${Math.round(timeoutMs / 1000)} s.`);
      err.statusCode = 504;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function handleError(error) {
  console.error(error);
  const statusCode = Number(error?.statusCode) || 500;
  return json(statusCode, { error: error?.message || 'Error interno de Elix AI.' });
}
