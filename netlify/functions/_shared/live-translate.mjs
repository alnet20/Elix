import WebSocket from 'ws';

function getGeminiApiKey() {
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_GEMINI_API_KEY,
  ];
  for (const value of candidates) {
    const v = String(value || '').trim();
    if (v) return v;
  }
  const err = new Error('Elix AI no puede leer GEMINI_API_KEY en Netlify Functions.');
  err.statusCode = 500;
  throw err;
}

function requireTranslateModel() {
  const model = String(process.env.GEMINI_TRANSLATE_LIVE_MODEL || '').trim();
  if (model) return model.replace(/^models\//, '');
  const err = new Error('Falta GEMINI_TRANSLATE_LIVE_MODEL en Netlify.');
  err.statusCode = 500;
  throw err;
}

function endpoint(apiKey) {
  // Endpoint oficial documentado para Gemini 3.5 Live Translate por WebSocket.
  // Es exclusivo de este helper y no modifica el endpoint usado por el dictado.
  const base = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  return `${base}?key=${encodeURIComponent(apiKey)}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMessage(data) {
  try {
    if (typeof data === 'string') return JSON.parse(data);
    if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString('utf8'));
    if (ArrayBuffer.isView(data)) return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
    if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8'));
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function extractServerContent(message, collector) {
  if (!message || typeof message !== 'object') return;
  const server = message.serverContent || message.server_content || {};
  const turn = server.modelTurn || server.model_turn || {};
  const parts = Array.isArray(turn.parts) ? turn.parts : [];

  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.trim()) {
      collector.text.push(part.text);
    }
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      const mime = String(inline.mimeType || inline.mime_type || '');
      if (mime.toLowerCase().startsWith('audio/')) {
        collector.audio.push(Buffer.from(String(inline.data), 'base64'));
        if (!collector.audioMime && mime) collector.audioMime = mime;
        collector.lastAudioAt = Date.now();
      }
    }
  }

  const inputTranscript =
    server.inputTranscription?.text ||
    server.input_transcription?.text ||
    message.inputTranscription?.text ||
    '';
  if (typeof inputTranscript === 'string' && inputTranscript.trim()) {
    collector.inputTranscripts.push(inputTranscript);
  }

  const outputTranscript =
    server.outputTranscription?.text ||
    server.output_transcription?.text ||
    message.outputTranscription?.text ||
    '';
  if (typeof outputTranscript === 'string' && outputTranscript.trim()) {
    collector.transcripts.push(outputTranscript);
  }
}

function setupComplete(message) {
  return Boolean(message?.setupComplete || message?.setup_complete);
}

function remoteError(message) {
  const error = message?.error;
  if (!error) return null;
  const detail = typeof error === 'string' ? error : (error.message || error.status || JSON.stringify(error));
  const err = new Error(`Elix AI: ${detail}`);
  err.statusCode = 502;
  return err;
}

function parsePcmRate(mime, fallback = 24000) {
  const m = String(mime || '').match(/rate\s*=\s*(\d+)/i);
  const n = Number(m?.[1] || fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pcm16ToWav(pcm, sampleRate = 24000) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const out = Buffer.alloc(44 + data.length);
  out.write('RIFF', 0, 4, 'ascii');
  out.writeUInt32LE(36 + data.length, 4);
  out.write('WAVE', 8, 4, 'ascii');
  out.write('fmt ', 12, 4, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 4, 'ascii');
  out.writeUInt32LE(data.length, 40);
  data.copy(out, 44);
  return out;
}

async function openSocket(url, timeoutMs = 15000) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(Object.assign(new Error('Elix AI no pudo abrir la conexión de traducción de audio.'), { statusCode: 504 }));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Elix AI no pudo conectar con Live Translate.'), { statusCode: 502 }));
    }, { once: true });
  });
}

export async function runGeminiLiveTranslate({
  targetLanguageCode,
  audioBase64,
  inputRate = 16000,
  timeoutMs = 180000,
}) {
  const apiKey = getGeminiApiKey();
  const model = requireTranslateModel();
  const ws = await openSocket(endpoint(apiKey));
  const collector = {
    text: [],
    inputTranscripts: [],
    transcripts: [],
    audio: [],
    audioMime: '',
    lastAudioAt: 0,
  };

  let finished = false;
  let setupDone = false;
  let inputFinished = false;
  let resolveRun;
  let rejectRun;

  const done = new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const finishOk = () => {
    if (finished) return;
    finished = true;
    clearTimeout(hardTimer);
    try { ws.close(); } catch {}
    resolveRun({ model, collector });
  };

  const finishError = error => {
    if (finished) return;
    finished = true;
    clearTimeout(hardTimer);
    try { ws.close(); } catch {}
    rejectRun(error);
  };

  const hardTimer = setTimeout(() => {
    const detail = [
      `setup: ${setupDone ? 'confirmado' : 'no confirmado'}`,
      `entrada: ${inputFinished ? 'enviada' : 'en curso'}`,
      `transcripción entrada: ${collector.inputTranscripts.length ? 'sí' : 'no'}`,
      `transcripción salida: ${collector.transcripts.length ? 'sí' : 'no'}`,
      `audio salida: ${collector.audio.length} chunks`,
    ].join(' · ');
    console.error('Elix AI · Live Translate timeout:', detail);
    finishError(Object.assign(new Error(`Elix AI agotó el tiempo de procesamiento de audio (${detail}).`), { statusCode: 504 }));
  }, timeoutMs);

  ws.addEventListener('message', event => {
    const message = parseMessage(event.data);
    if (!message) return;

    const upstream = remoteError(message);
    if (upstream) {
      finishError(upstream);
      return;
    }

    if (setupComplete(message)) {
      setupDone = true;
      return;
    }

    extractServerContent(message, collector);
  });

  ws.addEventListener('close', event => {
    if (finished) return;
    if (collector.audio.length) {
      finishOk();
      return;
    }
    const code = Number(event?.code || 0);
    const reason = String(event?.reason || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    const detail = [
      `código ${code || 'desconocido'}`,
      reason ? `motivo: ${reason}` : '',
      `modelo: ${model}`,
      `setup: ${setupDone ? 'confirmado' : 'no confirmado'}`,
    ].filter(Boolean).join(' · ');
    console.error('Elix AI · Live Translate cierre remoto:', detail);
    finishError(Object.assign(new Error(`Live Translate cerró la conexión sin devolver audio (${detail}).`), {
      statusCode: 502,
      wsCode: code || undefined,
      wsReason: reason || undefined,
    }));
  });

  ws.addEventListener('error', event => {
    if (finished) return;
    const detail = String(event?.error?.message || event?.message || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    finishError(Object.assign(new Error(detail ? `Se interrumpió Live Translate: ${detail}` : 'Se interrumpió Live Translate.'), { statusCode: 502 }));
  });

  // Estructura oficial de Google para gemini-3.5-live-translate-preview:
  // translationConfig va DENTRO de generationConfig. Live Translate no usa
  // systemInstruction: se configura exclusivamente con el idioma objetivo.
  const setup = {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: {
        targetLanguageCode: String(targetLanguageCode || '').trim(),
        echoTargetLanguage: false,
      },
    },
  };

  ws.send(JSON.stringify({ setup }));

  const setupDeadline = Date.now() + 12000;
  while (!setupDone && Date.now() < setupDeadline && !finished) await delay(50);
  if (!setupDone && !finished) {
    finishError(Object.assign(new Error('Live Translate no confirmó la configuración del modelo.'), { statusCode: 502 }));
  }
  if (finished) return await done;

  const audio = Buffer.from(String(audioBase64 || ''), 'base64');
  if (!audio.length) {
    finishError(Object.assign(new Error('El audio está vacío.'), { statusCode: 400 }));
    return await done;
  }

  // Google recomienda PCM16 mono 16 kHz, little-endian, en chunks de 100 ms.
  const bytesPerSecond = Math.max(1, Number(inputRate) || 16000) * 2;
  const chunkMs = 100;
  const chunkBytes = Math.max(320, Math.round(bytesPerSecond * (chunkMs / 1000)));

  for (let offset = 0; offset < audio.length && !finished; offset += chunkBytes) {
    const startedAt = Date.now();
    const chunk = audio.subarray(offset, Math.min(audio.length, offset + chunkBytes)).toString('base64');

    ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          data: chunk,
          mimeType: `audio/pcm;rate=${inputRate}`,
        },
      },
    }));

    const elapsed = Date.now() - startedAt;
    const wait = chunkMs - elapsed;
    if (wait > 0 && offset + chunkBytes < audio.length && !finished) await delay(wait);
  }

  inputFinished = true;

  // Live Translate funciona como flujo continuo, no por turnos. Para un archivo
  // pregrabado, terminamos cuando ya se envió todo el audio y la salida dejó de
  // crecer durante un intervalo breve. No se envían activityStart/activityEnd.
  const quietWatcher = setInterval(() => {
    if (finished || !inputFinished || !collector.audio.length || !collector.lastAudioAt) return;
    if (Date.now() - collector.lastAudioAt > 1800) finishOk();
  }, 200);

  try {
    return await done;
  } finally {
    clearInterval(quietWatcher);
    clearTimeout(hardTimer);
    try { ws.close(); } catch {}
  }
}

export function finalizeTranslatedAudio(collector) {
  const chunks = Array.isArray(collector?.audio) ? collector.audio.filter(Boolean) : [];
  if (!chunks.length) {
    const err = new Error('Live Translate no devolvió audio traducido.');
    err.statusCode = 502;
    throw err;
  }

  const mime = String(collector.audioMime || 'audio/pcm;rate=24000');
  const joined = Buffer.concat(chunks);

  if (/audio\/(?:wav|x-wav)/i.test(mime)) {
    return { buffer: joined, mimeType: 'audio/wav' };
  }
  if (/audio\/pcm/i.test(mime) || !mime) {
    const rate = parsePcmRate(mime, 24000);
    return { buffer: pcm16ToWav(joined, rate), mimeType: 'audio/wav' };
  }
  return { buffer: joined, mimeType: mime };
}
