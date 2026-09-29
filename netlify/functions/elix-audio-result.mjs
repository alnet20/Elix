import { connectAudioStore, assertOutputId, getOutputAudio } from './_shared/audio-store.mjs';

function response(statusCode, body = '', headers = {}, isBase64Encoded = false) {
  return { statusCode, headers, body, isBase64Encoded };
}

function parseRange(value, size) {
  const m = String(value || '').match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return null;
  let start = m[1] ? Number(m[1]) : null;
  let end = m[2] ? Number(m[2]) : null;

  if (start == null && end != null) {
    const suffix = Math.min(size, end);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = start == null ? 0 : start;
    end = end == null ? size - 1 : Math.min(end, size - 1);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end };
}

export const handler = async (event) => {
  connectAudioStore(event);
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) {
    return response(405, 'Método no permitido.', { Allow: 'GET, HEAD' });
  }

  try {
    const id = assertOutputId(event.queryStringParameters?.id);
    const stored = await getOutputAudio(id);
    if (!stored) return response(404, 'Audio no encontrado o expirado.', { 'Cache-Control': 'no-store' });

    const full = Buffer.from(stored.base64, 'base64');
    const mime = String(stored.mime_type || 'audio/wav');
    const common = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': 'inline; filename="Elix-AI-audio-traducido.wav"',
    };

    const range = parseRange(event.headers?.range || event.headers?.Range, full.length);
    if (range) {
      const chunk = full.subarray(range.start, range.end + 1);
      const headers = {
        ...common,
        'Content-Range': `bytes ${range.start}-${range.end}/${full.length}`,
        'Content-Length': String(chunk.length),
      };
      return method === 'HEAD'
        ? response(206, '', headers)
        : response(206, chunk.toString('base64'), headers, true);
    }

    const headers = { ...common, 'Content-Length': String(full.length) };
    return method === 'HEAD'
      ? response(200, '', headers)
      : response(200, full.toString('base64'), headers, true);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    return response(status, error?.message || 'No se pudo recuperar el audio.', {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
};
