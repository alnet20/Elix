import { parseBody } from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';
import { runGeminiLiveAudio, finalizeAudio } from './_shared/live-audio.mjs';

const MAX_SECONDS = 30;
const INPUT_RATE = 16000;
const MAX_BYTES = MAX_SECONDS * INPUT_RATE * 2 + 4096;
const LANG_RX = /^[\p{L}\p{M} .,'’()\-]{2,80}$/u;

function validate(body) {
  const b64 = String(body.audio_base64 || '').trim();
  const target = String(body.target_language || '').trim();
  if (!b64) {
    const err = new Error('No se recibió audio para traducir.');
    err.statusCode = 400;
    throw err;
  }
  if (!target || !LANG_RX.test(target)) {
    const err = new Error('Selecciona un idioma de destino válido.');
    err.statusCode = 400;
    throw err;
  }
  const approxBytes = Math.floor(b64.length * 0.75);
  if (approxBytes > MAX_BYTES) {
    const err = new Error(`La traducción de audio admite hasta ${MAX_SECONDS} segundos por solicitud en esta versión segura.`);
    err.statusCode = 413;
    throw err;
  }
  return { b64, target };
}

export const handler = async (event) => {
  connectJobStore(event);
  let jobId = '';
  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const { b64: audioBase64, target } = validate(body);

    await setJob(jobId, {
      status: 'running',
      provider: 'elix',
      engine: 'elix-audio-translate',
      progress: `Elix AI traduciendo el audio a ${target}.`,
      started_at: new Date().toISOString(),
    });

    const instruction = `Traduce fielmente todo el contenido hablado del audio al idioma de destino: ${target}. Mantén el significado, nombres propios, cifras, unidades y tono comunicativo. No resumas ni añadas información. Devuelve únicamente el audio hablado de la traducción, sin introducciones ni comentarios.`;

    const { collector } = await runGeminiLiveAudio({
      modelEnv: 'GEMINI_TRANSLATE_LIVE_MODEL',
      modelLabel: 'Gemini 3.5 Live Translate',
      instruction,
      responseModality: 'AUDIO',
      audioBase64,
      inputRate: INPUT_RATE,
      timeoutMs: 180000,
    });

    const audio = finalizeAudio(collector);
    const translatedText = [...(collector?.text || []), ...(collector?.transcripts || [])]
      .map(s => String(s || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    await setJob(jobId, {
      status: 'done',
      provider: 'elix',
      engine: 'elix-audio-translate',
      result: {
        audio_base64: audio.buffer.toString('base64'),
        mime_type: audio.mimeType,
        target_language: target,
        text: translatedText || '',
      },
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('elix-audio-translate-background', error);
    if (jobId) {
      try {
        await setJob(jobId, {
          status: 'error',
          provider: 'elix',
          engine: 'elix-audio-translate',
          error: error?.message || 'Error interno al traducir audio.',
          upstream_status: Number(error?.statusCode) || 500,
          finished_at: new Date().toISOString(),
        });
      } catch (storeError) {
        console.error('No se pudo guardar el error del job de traducción:', storeError);
      }
    }
  }
};
