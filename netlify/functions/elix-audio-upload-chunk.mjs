import { json, onlyPost, parseBody, handleError } from './_shared/utils.mjs';
import {
  connectAudioStore,
  assertTransferId,
  assertChunkCount,
  putInputChunk,
  deleteInputTransfer,
} from './_shared/audio-store.mjs';

export const handler = async (event) => {
  connectAudioStore(event);
  const preflight = onlyPost(event);
  if (preflight) return preflight;

  try {
    const body = parseBody(event);
    const action = String(body.action || 'upload').trim().toLowerCase();
    const transferId = assertTransferId(body.transfer_id);
    const totalChunks = assertChunkCount(body.total_chunks);

    if (action === 'cleanup') {
      await deleteInputTransfer(transferId, totalChunks);
      return json(200, { ok: true, cleaned: true });
    }
    if (action !== 'upload') return json(400, { error: 'Acción de audio no válida.' });

    const saved = await putInputChunk({
      transferId,
      index: body.index,
      totalChunks,
      chunk: body.chunk,
    });
    return json(200, { ok: true, ...saved });
  } catch (error) {
    return handleError(error);
  }
};
