import {
  parseBody,
  requireEnv,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
} from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';

const ATTEMPT_TIMEOUT_MS = 60 * 1000;

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const q = String(body.query || '').trim();
    if (!q) throw new Error('La consulta de búsqueda está vacía.');

    const apiKey = requireEnv('TAVILY_API_KEY');
    const payload = {
      query: q,
      search_depth: 'advanced',
      max_results: 8,
      include_answer: false,
      include_raw_content: false,
    };

    await setJob(jobId, {
      status: 'running',
      provider: 'elix',
      progress: 'Elix AI buscando fuentes.',
      started_at: new Date().toISOString(),
    });

    let response = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    }, ATTEMPT_TIMEOUT_MS);
    let data = await readJsonResponse(response);

    // Compatibilidad con cuentas/implementaciones que acepten api_key en el body.
    if (!response.ok && [400, 401, 403, 422].includes(response.status)) {
      await setJob(jobId, {
        status: 'running',
        provider: 'elix',
        progress: 'Elix AI reintentando la búsqueda.',
      });

      response = await fetchWithTimeout('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, ...payload }),
      }, ATTEMPT_TIMEOUT_MS);
      data = await readJsonResponse(response);
    }

    if (!response.ok) {
      const err = new Error(`Elix AI: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`);
      err.statusCode = response.status;
      throw err;
    }

    await setJob(jobId, {
      status: 'done',
      provider: 'elix',
      result: data,
      result_count: Array.isArray(data?.results) ? data.results.length : 0,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('elix-search-background', error);
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
