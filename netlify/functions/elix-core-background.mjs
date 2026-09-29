import {
  parseBody,
  requireEnv,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
  isRetryableStatus,
  sleep,
} from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';

const MODEL = 'deepseek-reasoner';
const TOTAL_BUDGET_MS = 13 * 60 * 1000;

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw new Error('No hay mensajes para procesar.');

    const maxTokens = Math.max(1, Math.min(Number(body.max_tokens) || 30000, 30000));
    const apiKey = requireEnv('DEEPSEEK_API_KEY');
    const deadline = Date.now() + TOTAL_BUDGET_MS;

    await setJob(jobId, {
      status: 'running',
      provider: 'elix',
      engine: 'elix-core',
      progress: 'Elix AI procesando la solicitud.',
      started_at: new Date().toISOString(),
    });

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 15000) break;

      await setJob(jobId, {
        status: 'running',
        provider: 'elix',
        engine: 'elix-core',
        attempt,
        progress: attempt === 1 ? 'Elix AI analizando.' : 'Elix AI reintentando el análisis.',
      });

      try {
        const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens }),
        }, Math.max(10000, remaining - 10000));

        const data = await readJsonResponse(response);
        if (response.ok) {
          await setJob(jobId, {
            status: 'done',
            provider: 'elix',
            engine: 'elix-core',
            result: data,
            finished_at: new Date().toISOString(),
          });
          return;
        }

        const msg = `Elix AI: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`;
        const err = new Error(msg);
        err.statusCode = response.status;
        lastError = err;
        if (!isRetryableStatus(response.status) || attempt === 2) throw err;
      } catch (error) {
        lastError = error;
        if (attempt === 2 || !isRetryableStatus(error?.statusCode || 502)) throw error;
      }

      const pause = Math.min(4000, Math.max(500, deadline - Date.now() - 15000));
      if (pause > 0) await sleep(pause);
    }

    throw lastError || new Error('Elix AI no pudo completar la respuesta dentro del tiempo disponible.');
  } catch (error) {
    console.error('elix-core-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error',
          provider: 'elix',
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
