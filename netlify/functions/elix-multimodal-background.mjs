import {
  parseBody,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
  isRetryableStatus,
  sleep,
} from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const TOTAL_BUDGET_MS = 13 * 60 * 1000;
const PER_ATTEMPT_MAX_MS = 6 * 60 * 1000;
const MAX_INLINE_BYTES = 2.6 * 1024 * 1024;

function getGeminiApiKey() {
  const candidates = [
    ['GEMINI_API_KEY', process.env.GEMINI_API_KEY],
    ['GOOGLE_API_KEY', process.env.GOOGLE_API_KEY],
    ['GOOGLE_GEMINI_API_KEY', process.env.GOOGLE_GEMINI_API_KEY],
  ];
  for (const [name, value] of candidates) {
    const v = String(value || '').trim();
    if (v) return { name, value: v };
  }
  const err = new Error('Elix AI no puede leer GEMINI_API_KEY en el entorno de ejecución de Netlify Functions. Verifica que la variable esté disponible para Functions/producción y vuelve a desplegar el sitio.');
  err.statusCode = 500;
  throw err;
}

function hasInlineData(payload) {
  return Array.isArray(payload?.contents) && payload.contents.some(content =>
    Array.isArray(content?.parts) && content.parts.some(part => part?.inlineData?.data)
  );
}

function inlineBytes(payload) {
  let total = 0;
  for (const content of Array.isArray(payload?.contents) ? payload.contents : []) {
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      const data = String(part?.inlineData?.data || '');
      if (data) total += Math.floor(data.length * 0.75);
    }
  }
  return total;
}

async function geminiRequest({ model, apiKey, payload, timeout, mode = 'query' }) {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const url = mode === 'query' ? `${base}?key=${encodeURIComponent(apiKey)}` : base;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (mode === 'header') headers['x-goog-api-key'] = apiKey;
  return await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }, timeout);
}

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const payload = body.payload;
    if (!payload || typeof payload !== 'object') throw new Error('Falta el contenido para Elix AI.');

    const bytes = inlineBytes(payload);
    if (bytes > MAX_INLINE_BYTES) {
      const err = new Error('El archivo visual supera el tamaño seguro de procesamiento. Elix AI debe optimizarlo antes de enviarlo.');
      err.statusCode = 413;
      throw err;
    }

    const { value: apiKey } = getGeminiApiKey();
    const baseModel = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const visionModel = String(process.env.GEMINI_VISION_MODEL || baseModel).trim() || baseModel;
    const model = hasInlineData(payload) ? visionModel : baseModel;
    const deadline = Date.now() + TOTAL_BUDGET_MS;

    await setJob(jobId, {
      status: 'running',
      provider: 'elix',
      engine: 'elix-multimodal',
      progress: hasInlineData(payload) ? 'Elix AI preparando contenido visual.' : 'Elix AI procesando contenido.',
      started_at: new Date().toISOString(),
    });

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 15000) break;
      await setJob(jobId, {
        status: 'running', provider: 'elix', engine: 'elix-multimodal', attempt,
        progress: attempt === 1 ? 'Elix AI analizando contenido.' : 'Elix AI reintentando el análisis.',
      });

      try {
        const timeout = Math.max(10000, Math.min(PER_ATTEMPT_MAX_MS, remaining - 10000));
        // Primero usamos exactamente el esquema ?key= que ya funcionaba en el proyecto original.
        let response = await geminiRequest({ model, apiKey, payload, timeout, mode: 'query' });
        let data = await readJsonResponse(response);

        // Compatibilidad adicional: si un proxy/política rechaza el query param, reintentamos con x-goog-api-key.
        if (!response.ok && [401, 403].includes(response.status)) {
          response = await geminiRequest({ model, apiKey, payload, timeout, mode: 'header' });
          data = await readJsonResponse(response);
        }

        if (response.ok) {
          await setJob(jobId, {
            status: 'done', provider: 'elix', engine: 'elix-multimodal',
            result: { ...data, _elix_model: 'Elix AI' }, finished_at: new Date().toISOString(),
          });
          return;
        }

        const detail = upstreamMessage(data, `${response.status} ${response.statusText}`);
        const err = new Error(`Elix AI: ${detail}`);
        err.statusCode = response.status;
        lastError = err;

        if ([401, 403].includes(response.status) || !isRetryableStatus(response.status) || attempt === 2) throw err;
      } catch (error) {
        lastError = error;
        const status = Number(error?.statusCode || 0);
        if ([401, 403, 413].includes(status) || attempt === 2 || !isRetryableStatus(status || 502)) throw error;
      }

      const pause = Math.min(3000, Math.max(500, deadline - Date.now() - 15000));
      if (pause > 0) await sleep(pause);
    }

    throw lastError || new Error('Elix AI no pudo completar el análisis dentro del tiempo disponible.');
  } catch (error) {
    console.error('elix-multimodal-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error', provider: 'elix', engine: 'elix-multimodal',
          error: error?.message || 'Error interno en Elix AI.',
          upstream_status: Number(error?.statusCode) || 500,
          finished_at: new Date().toISOString(),
        });
      } catch (storeError) {
        console.error('No se pudo guardar el error del job Elix:', storeError);
      }
    }
  }
};
