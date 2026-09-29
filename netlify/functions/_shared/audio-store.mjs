import { connectLambda, getStore } from '@netlify/blobs';

const STORE_NAME = 'elix-ai-audio-v1';
const TRANSFER_RX = /^elixaudio-[A-Za-z0-9_-]{20,120}$/;
const OUTPUT_RX = /^elixout-[A-Za-z0-9_-]{20,120}$/;
const MAX_CHUNKS = 200;

export function connectAudioStore(event) {
  connectLambda(event);
}

function store() {
  return getStore(STORE_NAME);
}

export function assertTransferId(value) {
  const id = String(value || '').trim();
  if (!TRANSFER_RX.test(id)) {
    const err = new Error('Identificador de audio temporal inválido.');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

export function assertOutputId(value) {
  const id = String(value || '').trim();
  if (!OUTPUT_RX.test(id)) {
    const err = new Error('Identificador de audio traducido inválido.');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

export function assertChunkCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CHUNKS) {
    const err = new Error('Cantidad de fragmentos de audio inválida.');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function inputChunkKey(id, index) {
  return `input/${id}/chunk-${String(index).padStart(4, '0')}`;
}

function inputManifestKey(id) {
  return `input/${id}/manifest`;
}

function outputDataKey(id) {
  return `output/${id}/data`;
}

function outputMetaKey(id) {
  return `output/${id}/meta`;
}

export async function putInputChunk({ transferId, index, totalChunks, chunk }) {
  const id = assertTransferId(transferId);
  const total = assertChunkCount(totalChunks);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= total) {
    const err = new Error('Índice de fragmento de audio inválido.');
    err.statusCode = 400;
    throw err;
  }

  const data = String(chunk || '');
  if (!data) {
    const err = new Error('El fragmento de audio está vacío.');
    err.statusCode = 400;
    throw err;
  }
  // 140k caracteres Base64 dejan margen amplio frente al límite HTTP de la Function.
  if (data.length > 140000) {
    const err = new Error('El fragmento de audio es demasiado grande.');
    err.statusCode = 413;
    throw err;
  }

  if (i === 0) {
    await store().setJSON(inputManifestKey(id), {
      transfer_id: id,
      total_chunks: total,
      created_at: new Date().toISOString(),
    });
  }

  await store().set(inputChunkKey(id, i), data);
  return { transfer_id: id, index: i, total_chunks: total };
}

export async function readInputTransfer(transferId, expectedChunks) {
  const id = assertTransferId(transferId);
  const expected = assertChunkCount(expectedChunks);
  const manifest = await store().get(inputManifestKey(id), { type: 'json' });
  if (!manifest) {
    const err = new Error('No se encontró el audio temporal para traducir.');
    err.statusCode = 404;
    throw err;
  }
  const total = assertChunkCount(manifest.total_chunks);
  if (total !== expected) {
    const err = new Error('El audio temporal está incompleto o no coincide con la solicitud.');
    err.statusCode = 400;
    throw err;
  }

  const parts = [];
  for (let i = 0; i < total; i++) {
    const part = await store().get(inputChunkKey(id, i), { type: 'text' });
    if (typeof part !== 'string' || !part.length) {
      const err = new Error(`Falta el fragmento ${i + 1} de ${total} del audio temporal.`);
      err.statusCode = 400;
      throw err;
    }
    parts.push(part);
  }
  return parts.join('');
}

export async function deleteInputTransfer(transferId, totalChunks) {
  const id = assertTransferId(transferId);
  const total = assertChunkCount(totalChunks);
  const keys = [inputManifestKey(id)];
  for (let i = 0; i < total; i++) keys.push(inputChunkKey(id, i));
  await Promise.allSettled(keys.map(key => store().delete(key)));
}

export async function putOutputAudio({ outputId, buffer, mimeType, lifetimeMs = 6 * 60 * 60 * 1000 }) {
  const id = assertOutputId(outputId);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!data.length) {
    const err = new Error('El audio traducido está vacío.');
    err.statusCode = 500;
    throw err;
  }
  const mime = String(mimeType || 'audio/wav').trim() || 'audio/wav';
  const expiresAt = new Date(Date.now() + Math.max(5 * 60 * 1000, Number(lifetimeMs) || 0)).toISOString();

  // Guardamos Base64 únicamente en Blobs, nunca dentro del JSON del job.
  await store().set(outputDataKey(id), data.toString('base64'));
  await store().setJSON(outputMetaKey(id), {
    output_id: id,
    mime_type: mime,
    bytes: data.length,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  });
  return { output_id: id, mime_type: mime, bytes: data.length, expires_at: expiresAt };
}

export async function getOutputAudio(outputId) {
  const id = assertOutputId(outputId);
  const meta = await store().get(outputMetaKey(id), { type: 'json' });
  if (!meta) return null;

  const expires = Date.parse(String(meta.expires_at || ''));
  if (Number.isFinite(expires) && Date.now() > expires) {
    await Promise.allSettled([
      store().delete(outputMetaKey(id)),
      store().delete(outputDataKey(id)),
    ]);
    return null;
  }

  const base64 = await store().get(outputDataKey(id), { type: 'text' });
  if (typeof base64 !== 'string' || !base64.length) return null;
  return { ...meta, base64 };
}
