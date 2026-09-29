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
  // Este helper es exclusivo de Live Translate. No utiliza GEMINI_LIVE_WS_URL
  // para no alterar ni depender del endpoint del dictado que ya funciona.
  const base = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
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

  const outputTranscript =
    server.outputTranscription?.text ||
    server.output_transcription?.text ||
    message.outputTranscription?.text ||
    '';
  if (typeof outputTranscript === 'string' && outputTranscript.trim()) {
    collector.transcripts.push(outputTranscript);
  }
}

function turnComplete(message) {
  const server = message?.serverContent || message?.server_content || {};
  return Boolean(server.turnComplete || server.turn_complete || server.generationComplete || server.generation_complete);
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
  instruction,
  targetLanguageCode,
  audioBase64,
  inputRate = 16000,
  timeoutMs = 180000,
}) {
  const apiKey = getGeminiApiKey();
  const model = requireTranslateModel();
  const ws = await openSocket(endpoint(apiKey));
  const collector = { text: [], transcripts: [], audio: [], audioMime: '', lastAudioAt: 0 };

  let finished = false;
  let setupDone = false;
  let activityEnded = false;
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
    const detail = `setup: ${setupDone ? 'confirmado' : 'no confirmado'} · actividad: ${activityEnded ? 'cerrada' : 'abierta'} · audio salida: ${collector.audio.length} chunks`;
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

    if (turnComplete(message)) {
      if (collector.audio.length) finishOk();
      else finishError(Object.assign(new Error('Live Translate terminó el turno sin devolver audio traducido.'), { statusCode: 502 }));
    }
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
      `actividad: ${activityEnded ? 'cerrada' : 'abierta'}`,
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

  // Para audio pregrabado cerramos el turno de forma explícita. Con VAD automático,
  // un archivo que termina inmediatamente después de la voz puede quedarse esperando
  // silencio indefinidamente. Manual activityStart/activityEnd evita ese caso.
  const setup = {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      temperature: 0,
    },
    systemInstruction: {
      parts: [{ text: String(instruction || '') }],
    },
    translationConfig: {
      targetLanguageCode: String(targetLanguageCode || '').trim(),
    },
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: true,
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

  // Marca explícitamente el comienzo de la intervención hablada.
  ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));

  const bytesPerSecond = Math.max(1, Number(inputRate) || 16000) * 2;
  const chunkMs = 100;
  const chunkBytes = Math.max(320, Math.round(bytesPerSecond * (chunkMs / 1000)));

  for (let offset = 0; offset < audio.length && !finished; offset += chunkBytes) {
    const startedAt = Date.now();
    const chunk = audio.subarray(offset, Math.min(audio.length, offset + chunkBytes)).toString('base64');

    // La forma "audio" corresponde al envío de audio en tiempo real del protocolo
    // Live actual; se mantiene exclusivamente dentro de este helper de traducción.
    ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${inputRate}`,
          data: chunk,
        },
      },
    }));

    const elapsed = Date.now() - startedAt;
    const wait = chunkMs - elapsed;
    if (wait > 0 && offset + chunkBytes < audio.length && !finished) await delay(wait);
  }

  if (!finished) {
    ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    activityEnded = true;
  }

  // Algunos turnos de audio entregan todos los chunks pero no un turnComplete
  // inmediato. Solo cerramos por silencio DESPUÉS de haber recibido audio de salida.
  const quietWatcher = setInterval(() => {
    if (finished || !activityEnded || !collector.audio.length || !collector.lastAudioAt) return;
    if (Date.now() - collector.lastAudioAt > 2200) finishOk();
  }, 250);

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
