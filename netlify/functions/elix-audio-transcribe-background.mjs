import { parseBody } from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';
import { runGeminiLiveAudio, finalizeTranscript } from './_shared/live-audio.mjs';

const MAX_SECONDS = 60;
const INPUT_RATE = 16000;
const MAX_BYTES = MAX_SECONDS * INPUT_RATE * 2 + 4096;

function validateAudio(body) {
  const b64 = String(body.audio_base64 || '').trim();
  if (!b64) {
    const err = new Error('No se recibió audio para transcribir.');
    err.statusCode = 400;
    throw err;
  }
  const approxBytes = Math.floor(b64.length * 0.75);
  if (approxBytes > MAX_BYTES) {
    const err = new Error(`El dictado supera el límite seguro de ${MAX_SECONDS} segundos por solicitud.`);
    err.statusCode = 413;
    throw err;
  }
  return b64;
}

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const audioBase64 = validateAudio(body);

    await setJob(jobId, {
      status: 'running',
      provider: 'elix',
      engine: 'elix-audio-transcribe',
      progress: 'Elix AI transcribiendo tu voz.',
      started_at: new Date().toISOString(),
    });

    const { collector } = await runGeminiLiveAudio({
      modelEnv: 'GEMINI_TRANSCRIBE_LIVE_MODEL',
      modelLabel: 'Gemini 3.5 Transcribe Live',
      instruction: 'Transcribe con máxima fidelidad el audio recibido. Conserva el idioma original. No traduzcas, no resumas, no expliques y no añadas comentarios. Devuelve únicamente la transcripción fiel, con puntuación natural cuando sea clara.',
      responseModality: 'TEXT',
      audioBase64,
      inputRate: INPUT_RATE,
      timeoutMs: 150000,
    });

    const text = finalizeTranscript(collector);
    if (!text) {
      const err = new Error('Elix AI no pudo obtener texto reconocible del audio.');
      err.statusCode = 502;
      throw err;
    }

    await setJob(jobId, {
      status: 'done',
      provider: 'elix',
      engine: 'elix-audio-transcribe',
      result: { text },
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('elix-audio-transcribe-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error',
          provider: 'elix',
          engine: 'elix-audio-transcribe',
          error: error?.message || 'Error interno al transcribir audio.',
          upstream_status: Number(error?.statusCode) || 500,
          finished_at: new Date().toISOString(),
        });
      } catch (storeError) {
        console.error('No se pudo guardar el error del job de transcripción:', storeError);
      }
    }
  }
};
