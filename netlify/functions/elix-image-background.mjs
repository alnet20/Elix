import {
  parseBody,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
  isRetryableStatus,
  sleep,
} from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';

const DEFAULT_MODEL = String(process.env.MUSE_IMAGE_MODEL || process.env.META_IMAGE_MODEL || 'muse-image-1.0').trim() || 'muse-image-1.0';
const TOTAL_BUDGET_MS = 13 * 60 * 1000;
const PER_ATTEMPT_MAX_MS = 6 * 60 * 1000;

function getImageApiKey() {
  const candidates = [
    ['META_IMAGE_API_KEY', process.env.META_IMAGE_API_KEY],
    ['MODEL_API_KEY', process.env.MODEL_API_KEY],
    ['META_API_KEY', process.env.META_API_KEY],
    ['MUSE_IMAGE_API_KEY', process.env.MUSE_IMAGE_API_KEY],
    ['HF_API_KEY', process.env.HF_API_KEY],
    ['HUGGINGFACE_API_KEY', process.env.HUGGINGFACE_API_KEY],
    ['HUGGING_FACE_API_KEY', process.env.HUGGING_FACE_API_KEY],
  ];
  for (const [name, value] of candidates) {
    const v = String(value || '').trim();
    if (v) return { name, value: v };
  }
  const err = new Error('Elix AI no puede leer la credencial de generación de imágenes. Si usas Meta Developer, configura META_IMAGE_API_KEY o MODEL_API_KEY y vuelve a desplegar el sitio.');
  err.statusCode = 500;
  throw err;
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function resolveConfig() {
  const model = DEFAULT_MODEL;
  const explicitUrl = String(process.env.MUSE_IMAGE_API_URL || process.env.META_IMAGE_API_URL || '').trim();
  const provider = String(process.env.MUSE_IMAGE_PROVIDER || 'meta').trim().toLowerCase();

  if (!explicitUrl && (provider === 'meta' || provider === 'openai')) {
    return {
      model,
      url: 'https://api.meta.ai/v1/images/generations',
      mode: 'openai',
      provider: 'meta',
    };
  }

  const url = explicitUrl || `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;
  let mode = 'huggingface';
  let resolvedProvider = provider || 'huggingface';
  if (provider === 'openai') mode = 'openai';
  else if (provider === 'huggingface') mode = 'huggingface';
  else if (/api\.meta\.ai\/v1\/images\/generations/i.test(url)) {
    mode = 'openai';
    resolvedProvider = 'meta';
  } else if (/\/images\/generations/i.test(url)) mode = 'openai';
  else if (/api-inference\.huggingface\.co/i.test(url)) mode = 'huggingface';
  return { model, url, mode, provider: resolvedProvider };
}

async function parseImageResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.startsWith('image/')) {
    const arr = new Uint8Array(await response.arrayBuffer());
    return { mime_type: contentType.split(';')[0], image_base64: Buffer.from(arr).toString('base64') };
  }
  const data = await readJsonResponse(response);
  return { json: data, contentType };
}

async function maybeFetchImageUrl(url, timeout) {
  const response = await fetchWithTimeout(url, { method: 'GET', headers: { 'Accept': 'image/*,application/octet-stream' } }, timeout);
  const parsed = await parseImageResponse(response);
  if (!response.ok) {
    const detail = parsed?.json ? upstreamMessage(parsed.json, `${response.status} ${response.statusText}`) : `${response.status} ${response.statusText}`;
    const err = new Error(`Elix AI: ${detail}`);
    err.statusCode = response.status;
    throw err;
  }
  if (parsed?.image_base64) return parsed;
  throw new Error('Elix AI recibió una URL de imagen, pero no pudo descargar una imagen válida.');
}

async function requestHuggingFace({ url, apiKey, prompt, width, height, timeout }) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'image/*,application/json',
    },
    body: JSON.stringify({
      inputs: prompt,
      options: { wait_for_model: true, use_cache: false },
      parameters: {
        width,
        height,
        guidance_scale: clamp(process.env.MUSE_GUIDANCE_SCALE, 1, 20, 7),
        num_inference_steps: clamp(process.env.MUSE_STEPS, 10, 80, 28),
        negative_prompt: String(process.env.MUSE_NEGATIVE_PROMPT || 'blurry, low quality, watermark, distorted text, deformed anatomy').trim(),
      }
    })
  }, timeout);
  const parsed = await parseImageResponse(response);
  if (response.ok && parsed?.image_base64) return parsed;
  const detail = parsed?.json ? upstreamMessage(parsed.json, `${response.status} ${response.statusText}`) : `${response.status} ${response.statusText}`;
  const err = new Error(`Elix AI: ${detail}`);
  err.statusCode = response.status;
  throw err;
}

async function requestOpenAICompatible({ url, apiKey, model, prompt, width, height, timeout }) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: `${width}x${height}`,
      response_format: 'b64_json',
    })
  }, timeout);
  const parsed = await parseImageResponse(response);
  if (!response.ok) {
    const detail = parsed?.json ? upstreamMessage(parsed.json, `${response.status} ${response.statusText}`) : `${response.status} ${response.statusText}`;
    const err = new Error(`Elix AI: ${detail}`);
    err.statusCode = response.status;
    throw err;
  }
  const data = parsed?.json?.data?.[0] || parsed?.json?.images?.[0] || parsed?.json?.image || null;
  const b64 = data?.b64_json || data?.base64 || parsed?.json?.b64_json || parsed?.json?.base64 || null;
  const imageUrl = data?.url || parsed?.json?.url || null;
  if (b64) return { image_base64: String(b64), mime_type: 'image/png' };
  if (imageUrl) return await maybeFetchImageUrl(String(imageUrl), timeout);
  throw new Error('Elix AI no recibió una imagen válida del servicio de generación.');
}

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new Error('Falta el prompt de imagen para Elix AI.');

    const width = clamp(body.width, 512, 1536, 1024);
    const height = clamp(body.height, 512, 1536, 1024);
    const { value: apiKey } = getImageApiKey();
    const { model, url, mode } = resolveConfig();
    const deadline = Date.now() + TOTAL_BUDGET_MS;

    await setJob(jobId, {
      status: 'running', provider: 'elix', engine: 'elix-image',
      progress: 'Elix AI preparando la imagen.', started_at: new Date().toISOString(),
    });

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 15000) break;
      await setJob(jobId, {
        status: 'running', provider: 'elix', engine: 'elix-image', attempt,
        progress: attempt === 1 ? 'Elix AI generando imagen.' : 'Elix AI reintentando la generación de imagen.',
      });
      try {
        const timeout = Math.max(15000, Math.min(PER_ATTEMPT_MAX_MS, remaining - 10000));
        const result = mode === 'openai'
          ? await requestOpenAICompatible({ url, apiKey, model, prompt, width, height, timeout })
          : await requestHuggingFace({ url, apiKey, prompt, width, height, timeout });
        await setJob(jobId, {
          status: 'done', provider: 'elix', engine: 'elix-image',
          result: { ...result, width, height, model: 'Elix AI Images' }, finished_at: new Date().toISOString(),
        });
        return;
      } catch (error) {
        lastError = error;
        const status = Number(error?.statusCode || 0);
        if ([400, 401, 403].includes(status) || attempt === 2 || !isRetryableStatus(status || 502)) throw error;
      }
      const pause = Math.min(4000, Math.max(600, deadline - Date.now() - 15000));
      if (pause > 0) await sleep(pause);
    }

    throw lastError || new Error('Elix AI no pudo completar la generación de la imagen dentro del tiempo disponible.');
  } catch (error) {
    console.error('elix-image-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error', provider: 'elix', engine: 'elix-image',
          error: error?.message || 'Error interno en Elix AI al generar la imagen.',
          upstream_status: Number(error?.statusCode) || 500,
          finished_at: new Date().toISOString(),
        });
      } catch (storeError) {
        console.error('No se pudo guardar el error del job de imagen Elix:', storeError);
      }
    }
  }
};
