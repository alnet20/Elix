import { json, onlyPost, parseBody, handleError } from './_shared/utils.mjs';
import { connectJobStore, assertJobId, getJob } from './_shared/jobs.mjs';

export const handler = async (event) => {
  connectJobStore(event);
  const preflight = onlyPost(event);
  if (preflight) return preflight;

  try {
    const { job_id } = parseBody(event);
    const id = assertJobId(job_id);
    const job = await getJob(id);

    // Puede ocurrir durante el primer instante antes de que el background escriba el estado.
    if (!job) return json(200, { job_id: id, status: 'queued' });
    return json(200, job);
  } catch (error) {
    return handleError(error);
  }
};
