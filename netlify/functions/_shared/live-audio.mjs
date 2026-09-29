import WebSocket from 'ws';

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
  const err = new Error('Elix AI no puede leer GEMINI_API_KEY en Netlify Functions.');
  err.statusCode = 500;
  throw err;
}

function requireModel(envName, label) {
  const value = String(process.env[envName] || '').trim();
  if (value) return value;
  const err = new Error(`Falta ${envName}. Configura en Netlify el ID API exacto de ${label}.`);
  err.statusCode = 500;
  throw err;
}

function liveEndpoint(apiKey) {
  const configured = String(process.env.GEMINI_LIVE_WS_URL || '').trim();
  const base = configured || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  return `${base}${base.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
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

function extractTextAndAudio(message, collector) {
  if (!message || typeof message !== 'object') return;

  const server = message.serverContent || message.server_content || {};
  const modelTurn = server.modelTurn || server.model_turn || {};
  const parts = Array.isArray(modelTurn.parts) ? modelTurn.parts : [];

  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.trim()) collector.text.push(part.text);
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      const mime = String(inline.mimeType || inline.mime_type || '');
      if (mime.toLowerCase().startsWith('audio/')) {
        collector.audio.push(Buffer.from(String(inline.data), 'base64'));
        if (!collector.audioMime && mime) collector.audioMime = mime;
      }
    }
  }

  const transcriptCandidates = [
    server.inputTranscription?.text,
    server.input_transcription?.text,
    server.outputTranscription?.text,
    server.output_transcription?.text,
    message.inputTranscription?.text,
    message.outputTranscription?.text,
    message.transcription?.text,
  ];
  for (const t of transcriptCandidates) {
    if (typeof t === 'string' && t.trim()) collector.transcripts.push(t);
  }
}

function detectTurnComplete(message) {
  const server = message?.serverContent || message?.server_content || {};
  return Boolean(
    server.turnComplete ||
    server.turn_complete ||
    server.generationComplete ||
    server.generation_complete
  );
}

function detectSetupComplete(message) {
  return Boolean(message?.setupComplete || message?.setup_complete);
}

function detectRemoteError(message) {
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
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
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
      reject(Object.assign(new Error('Elix AI no pudo abrir la conexión de audio con Gemini Live.'), { statusCode: 504 }));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Elix AI no pudo conectar con Gemini Live.'), { statusCode: 502 }));
    }, { once: true });
  });
}

async function runLiveOnce({
  apiKey,
  model,
  instruction,
  responseModality,
  audioBase64,
  inputRate = 16000,
  timeoutMs = 150000,
  schema = 'mediaChunks',
}) {
  const ws = await openSocket(liveEndpoint(apiKey));
  const collector = { text: [], transcripts: [], audio: [], audioMime: '' };
  let finished = false;
  let setupDone = false;
  let firstContentAt = 0;
  let resolveRun, rejectRun;

  const donePromise = new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const hardTimer = setTimeout(() => {
    if (finished) return;
    finished = true;
    try { ws.close(); } catch {}
    rejectRun(Object.assign(new Error('Elix AI agotó el tiempo de procesamiento de audio.'), { statusCode: 504 }));
  }, timeoutMs);

  ws.addEventListener('message', event => {
    const message = parseMessage(event.data);
    if (!message) return;

    const remoteError = detectRemoteError(message);
    if (remoteError && !finished) {
      finished = true;
      clearTimeout(hardTimer);
      try { ws.close(); } catch {}
      rejectRun(remoteError);
      return;
    }

    if (detectSetupComplete(message)) setupDone = true;

    const before = collector.text.length + collector.transcripts.length + collector.audio.length;
    extractTextAndAudio(message, collector);
    const after = collector.text.length + collector.transcripts.length + collector.audio.length;
    if (after > before && !firstContentAt) firstContentAt = Date.now();

    if (detectTurnComplete(message) && !finished) {
      finished = true;
      clearTimeout(hardTimer);
      try { ws.close(); } catch {}
      resolveRun(collector);
    }
  });

  ws.addEventListener('close', () => {
    if (finished) return;
    const hasData = collector.text.length || collector.transcripts.length || collector.audio.length;
    finished = true;
    clearTimeout(hardTimer);
    if (hasData) resolveRun(collector);
    else rejectRun(Object.assign(new Error('Gemini Live cerró la conexión sin devolver contenido de audio.'), { statusCode: 502 }));
  });

  ws.addEventListener('error', () => {
    if (finished) return;
    finished = true;
    clearTimeout(hardTimer);
    rejectRun(Object.assign(new Error('Se interrumpió la conexión de audio con Gemini Live.'), { statusCode: 502 }));
  });

  const cleanModel = String(model || '').replace(/^models\//, '');
  ws.send(JSON.stringify({
    setup: {
      model: `models/${cleanModel}`,
      generationConfig: {
        responseModalities: [responseModality],
        temperature: 0,
      },
      systemInstruction: {
        parts: [{ text: instruction }],
      },
    },
  }));

  const setupDeadline = Date.now() + 12000;
  while (!setupDone && Date.now() < setupDeadline && !finished) await delay(50);
  if (!setupDone && !finished) {
    finished = true;
    clearTimeout(hardTimer);
    try { ws.close(); } catch {}
    throw Object.assign(new Error('Gemini Live no confirmó la configuración del modelo.'), { statusCode: 502 });
  }

  const audio = Buffer.from(String(audioBase64 || ''), 'base64');
  if (!audio.length) {
    finished = true;
    clearTimeout(hardTimer);
    try { ws.close(); } catch {}
    throw Object.assign(new Error('El audio está vacío.'), { statusCode: 400 });
  }

  const chunkBytes = 32000; // ~1 s de PCM16 mono a 16 kHz
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    if (finished) break;
    const chunk = audio.subarray(offset, Math.min(audio.length, offset + chunkBytes)).toString('base64');
    const realtimeInput = schema === 'audio'
      ? { audio: { mimeType: `audio/pcm;rate=${inputRate}`, data: chunk } }
      : { mediaChunks: [{ mimeType: `audio/pcm;rate=${inputRate}`, data: chunk }] };
    ws.send(JSON.stringify({ realtimeInput }));
    if ((offset / chunkBytes) % 6 === 5) await delay(8);
  }

  if (!finished) {
    ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  // Si el servidor no emite turnComplete pero ya devolvió contenido,
  // un cierre controlado tras un breve silencio evita esperar indefinidamente.
  const quietWatcher = setInterval(() => {
    if (finished || !firstContentAt) return;
    if (Date.now() - firstContentAt > 4500) {
      firstContentAt = Date.now(); // solo extiende si llegan más mensajes; el close resolverá si hay datos
    }
  }, 1000);

  try {
    return await donePromise;
  } finally {
    clearInterval(quietWatcher);
    clearTimeout(hardTimer);
    try { ws.close(); } catch {}
  }
}

export async function runGeminiLiveAudio({
  modelEnv,
  modelLabel,
  instruction,
  responseModality,
  audioBase64,
  inputRate = 16000,
  timeoutMs = 150000,
}) {
  const { value: apiKey } = getGeminiApiKey();
  const model = requireModel(modelEnv, modelLabel);
  let lastError = null;

  // Compatibilidad entre las dos formas de audio usadas por revisiones de Gemini Live.
  for (const schema of ['mediaChunks', 'audio']) {
    try {
      const collector = await runLiveOnce({
        apiKey, model, instruction, responseModality,
        audioBase64, inputRate, timeoutMs, schema,
      });
      return { model, collector };
    } catch (error) {
      lastError = error;
      const status = Number(error?.statusCode || 0);
      if ([400, 401, 403].includes(status)) break;
    }
  }
  throw lastError || new Error('Elix AI no pudo procesar el audio.');
}

export function finalizeTranscript(collector) {
  const candidates = [...(collector?.transcripts || []), ...(collector?.text || [])]
    .map(s => String(s || '').trim())
    .filter(Boolean);
  return candidates.join(' ').replace(/\s+/g, ' ').trim();
}

export function finalizeAudio(collector) {
  const chunks = Array.isArray(collector?.audio) ? collector.audio.filter(Boolean) : [];
  if (!chunks.length) {
    const err = new Error('Gemini Live no devolvió audio traducido.');
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
