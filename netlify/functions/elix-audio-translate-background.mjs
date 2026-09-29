import { randomUUID } from 'node:crypto';
import { parseBody } from './_shared/utils.mjs';
import { connectJobStore, assertJobId, setJob } from './_shared/jobs.mjs';
import {
  assertTransferId,
  assertChunkCount,
  readInputTransfer,
  deleteInputTransfer,
  putOutputAudio,
} from './_shared/audio-store.mjs';
import { runGeminiLiveTranslate, finalizeTranslatedAudio } from './_shared/live-translate.mjs';

const MAX_SECONDS = 30;
const INPUT_RATE = 16000;
const MAX_BYTES = MAX_SECONDS * INPUT_RATE * 2 + 4096;
const LANG_RX = /^[\p{L}\p{M} .,'’()\-]{2,80}$/u;

const TARGET_LANGUAGE_CODES = new Map([
  ['español', 'es'], ['english', 'en'], ['français', 'fr'], ['deutsch', 'de'],
  ['italiano', 'it'], ['português', 'pt'], ['中文', 'zh'], ['日本語', 'ja'],
  ['한국어', 'ko'], ['العربية', 'ar'], ['русский', 'ru'], ['हिन्दी', 'hi'],
  ['nederlands', 'nl'], ['polski', 'pl'], ['türkçe', 'tr'], ['bahasa indonesia', 'id'],
  ['українська', 'uk'], ['tiếng việt', 'vi'],
]);

function targetLanguageCode(target) {
  const raw = String(target || '').trim();
  const direct = raw.match(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/) ? raw : '';
  return direct || TARGET_LANGUAGE_CODES.get(raw.toLocaleLowerCase('und')) || '';
}

function validate(body) {
  const target = String(body.target_language || '').trim();
  if (!target || !LANG_RX.test(target)) {
    const err = new Error('Selecciona un idioma de destino válido.');
    err.statusCode = 400;
    throw err;
  }

  const transferRaw = String(body.audio_transfer_id || '').trim();
  const directB64 = String(body.audio_base64 || '').trim();
  if (!transferRaw && !directB64) {
    const err = new Error('No se recibió audio para traducir.');
    err.statusCode = 400;
    throw err;
  }

  if (transferRaw) {
    return {
      target,
      transferId: assertTransferId(transferRaw),
      totalChunks: assertChunkCount(body.audio_chunks),
      directB64: '',
    };
  }

  const approxBytes = Math.floor(directB64.length * 0.75);
  if (approxBytes > MAX_BYTES) {
    const err = new Error(`La traducción de audio admite hasta ${MAX_SECONDS} segundos por solicitud.`);
    err.statusCode = 413;
    throw err;
  }
  return { target, transferId: '', totalChunks: 0, directB64 };
}

function outputId() {
  return `elixout-${randomUUID()}`.replace(/[^A-Za-z0-9_-]/g, '');
}

export const handler = async (event) => {
  // connectJobStore configura @netlify/blobs para esta invocación; el almacén
  // de audio comparte esa misma conexión, pero usa un Store independiente.
  connectJobStore(event);
  let jobId = '';
  let transferId = '';
  let totalChunks = 0;

  try {
    const body = parseBody(event);
    jobId = assertJobId(body.job_id);
    const validated = validate(body);
    transferId = validated.transferId;
    totalChunks = validated.totalChunks;

    await setJob(jobId, {
      status: 'running',
      provider: 'elix',
      engine: 'elix-audio-translate',
      progress: `Elix AI traduciendo el audio a ${validated.target}.`,
      started_at: new Date().toISOString(),
    });

    const audioBase64 = transferId
      ? await readInputTransfer(transferId, totalChunks)
      : validated.directB64;

    const approxBytes = Math.floor(audioBase64.length * 0.75);
    if (!approxBytes) {
      const err = new Error('El audio recibido está vacío.');
      err.statusCode = 400;
      throw err;
    }
    if (approxBytes > MAX_BYTES) {
      const err = new Error(`El audio supera el límite seguro de ${MAX_SECONDS} segundos.`);
      err.statusCode = 413;
      throw err;
    }

    const instruction = `Traduce fielmente todo el contenido hablado del audio al idioma de destino: ${validated.target}. Mantén el significado, nombres propios, cifras, unidades y tono comunicativo. No resumas ni añadas información. Devuelve únicamente el audio hablado de la traducción, sin introducciones ni comentarios.`;
    const targetCode = targetLanguageCode(validated.target);
    if (!targetCode) {
      const err = new Error('El idioma seleccionado todavía no tiene un código compatible para Live Translate.');
      err.statusCode = 400;
      throw err;
    }

    const { collector } = await runGeminiLiveTranslate({
      instruction,
      targetLanguageCode: targetCode,
      audioBase64,
      inputRate: INPUT_RATE,
      timeoutMs: 180000,
    });

    const audio = finalizeTranslatedAudio(collector);
    const translatedText = [...(collector?.text || []), ...(collector?.transcripts || [])]
      .map(s => String(s || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    const outId = outputId();
    await putOutputAudio({ outputId: outId, buffer: audio.buffer, mimeType: audio.mimeType });

    await setJob(jobId, {
      status: 'done',
      provider: 'elix',
      engine: 'elix-audio-translate',
      result: {
        audio_id: outId,
        audio_url: `/.netlify/functions/elix-audio-result?id=${encodeURIComponent(outId)}`,
        mime_type: audio.mimeType,
        target_language: validated.target,
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
  } finally {
    if (transferId && totalChunks) {
      try { await deleteInputTransfer(transferId, totalChunks); }
      catch (cleanupError) { console.warn('Elix AI no pudo limpiar fragmentos temporales de audio:', cleanupError?.message || cleanupError); }
    }
  }
};
