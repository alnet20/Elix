import {
  json,
  onlyPost,
  parseBody,
  readJsonResponse,
  upstreamMessage,
  fetchWithTimeout,
} from './_shared/utils.mjs';

const MODELS = [
  process.env.GROQ_ROUTER_MODEL,
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
].filter(Boolean);

function extractJson(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); } catch {}
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(clean.slice(a, b + 1)); } catch {}
  }
  return null;
}

function uniqueModels() {
  return [...new Set(MODELS)].filter(Boolean);
}

async function askGroq(apiKey, system, user, maxTokens = 520) {
  const failures = [];
  for (const model of uniqueModels()) {
    try {
      const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          max_tokens: maxTokens,
        }),
      }, 14000);

      const data = await readJsonResponse(response);
      if (!response.ok) {
        failures.push(`${model}: ${upstreamMessage(data, `${response.status} ${response.statusText}`)}`);
        continue;
      }
      const content = String(data?.choices?.[0]?.message?.content || '').trim();
      const parsed = extractJson(content);
      if (!parsed) {
        failures.push(`${model}: respuesta JSON inválida`);
        continue;
      }
      return { ok: true, parsed };
    } catch (error) {
      failures.push(`${model}: ${error?.message || error}`);
    }
  }
  return { ok: false, reason: failures.join(' | ') || 'Router no disponible.' };
}

function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return null;
  const allowedIntent = new Set(['export_current', 'export_named', 'generate_then_export', 'none']);
  const allowedScope = new Set(['full_chat', 'last_answer', 'selection', 'generated_answer']);
  const intent = allowedIntent.has(String(d.intent || '')) ? String(d.intent) : 'none';
  const format = String(d.format || '').toLowerCase() === 'pdf' ? 'pdf' : 'docx';
  let exportScope = allowedScope.has(String(d.export_scope || '')) ? String(d.export_scope) : null;
  if (!exportScope) exportScope = intent === 'generate_then_export' ? 'generated_answer' : 'full_chat';
  return {
    intent,
    format,
    export_scope: exportScope,
    target_title: d.target_title == null ? null : String(d.target_title).trim() || null,
    chat_id: d.chat_id == null ? null : String(d.chat_id).trim() || null,
    clean_prompt: d.clean_prompt == null ? null : String(d.clean_prompt).trim() || null,
    selection_query: d.selection_query == null ? null : String(d.selection_query).trim() || null,
  };
}

function normalizeSelection(d, validIndices) {
  if (!d || typeof d !== 'object') return null;
  const valid = new Set(validIndices.map(Number));
  const raw = Array.isArray(d.message_indices) ? d.message_indices : [];
  const messageIndices = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && valid.has(n)))].sort((a,b)=>a-b);
  return {
    message_indices: messageIndices,
    reason: d.reason == null ? null : String(d.reason).slice(0, 300),
  };
}

export const handler = async (event) => {
  const preflight = onlyPost(event);
  if (preflight) return preflight;

  try {
    const body = parseBody(event);
    const mode = String(body.mode || 'classify');
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();

    // Groq nunca debe ser un punto único de fallo. El navegador tiene respaldo local.
    if (!apiKey) return json(200, { ok: false, fallback: true, reason: 'Router inteligente no disponible.' });

    if (mode === 'select_messages') {
      const chat = body.chat && typeof body.chat === 'object' ? body.chat : null;
      const messages = Array.isArray(chat?.messages) ? chat.messages.slice(0, 160) : [];
      if (!chat || !messages.length) return json(200, { ok: false, fallback: true, reason: 'No hay mensajes para seleccionar.' });

      const lines = messages.map(m => {
        const index = Number(m.index);
        const role = String(m.role || '') === 'assistant' ? 'ELIX' : 'USUARIO';
        const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
        return `[M${index}] ${role}: ${text}`;
      }).join('\n');

      const system = `Eres el selector determinista de fragmentos para exportación de Elix AI. NO respondas al usuario. Devuelve SOLO JSON válido.

Tu tarea es elegir qué mensajes del chat deben entrar al archivo solicitado.
- Respeta literalmente peticiones como: "solo la parte sobre...", "desde que hablamos de X hasta Y", "solo tu explicación de...", "solo las respuestas sobre...".
- Si se pide una explicación concreta, selecciona únicamente los mensajes necesarios. Incluye el mensaje del usuario que da contexto cuando sea útil, salvo que pida explícitamente "solo tu respuesta" o "solo la respuesta de Elix".
- No incluyas mensajes no relacionados solo por estar cerca.
- Los índices permitidos son únicamente los que aparecen como [M#].
- Si no puedes identificar una selección fiable, devuelve message_indices vacío.

Esquema exacto: {"message_indices":[0,1],"reason":"texto breve"}`;

      const user = `ORDEN ORIGINAL:\n${String(body.text || '')}\n\nSELECCIÓN PEDIDA:\n${String(body.selection_query || body.text || '')}\n\nCHAT: ${String(chat.title || '')}\n\nMENSAJES:\n${lines}`;
      const r = await askGroq(apiKey, system, user, 700);
      if (!r.ok) return json(200, { ok: false, fallback: true, reason: r.reason });
      const normalized = normalizeSelection(r.parsed, messages.map(m => Number(m.index)));
      if (!normalized) return json(200, { ok: false, fallback: true, reason: 'Selección inválida.' });
      return json(200, { ok: true, model: 'Elix Router', selection: normalized });
    }

    const text = String(body.text || '').trim();
    if (!text) {
      return json(200, { ok: true, decision: normalizeDecision({ intent:'none', format:'docx', export_scope:'full_chat' }) });
    }

    const chats = Array.isArray(body.chats) ? body.chats.slice(0, 80) : [];
    const currentId = String(body.current_chat_id || '');
    const currentTitle = String(body.current_chat_title || '');
    const chatList = chats.map(c => {
      const preview = String(c.preview || '').replace(/\s+/g, ' ').slice(0, 650);
      return `- ${String(c.id || '')}: ${String(c.title || '')}${preview ? ` | muestra: ${preview}` : ''}`;
    }).join('\n') || '(sin chats listados)';

    const system = `Eres el router determinista de órdenes de exportación de Elix AI. NO redactes contenido y NO respondas al usuario. Devuelve SOLO un objeto JSON válido.

Clasifica en UNA intención:
1. export_current: exportar contenido YA EXISTENTE del chat actual.
2. export_named: exportar contenido YA EXISTENTE de otro chat identificado por título o tema.
3. generate_then_export: primero hay que CREAR/INVESTIGAR/EXPLICAR/RESOLVER/ANALIZAR contenido nuevo y, al terminar, exportarlo.
4. none: no existe una orden real de exportación.

Además decide export_scope:
- full_chat: chat completo. Ej.: "todo el chat", "chat completo", "esta conversación en Word".
- last_answer: solo la última respuesta ya existente. Ej.: "pásame tu última respuesta a Word", "convierte eso a docx" cuando "eso" se refiere a la respuesta anterior.
- selection: una parte concreta de un chat. Ej.: "solo la parte donde hablamos de números irracionales", "solo tu explicación sobre mitosis", "desde la pregunta de X hasta la tabla". En este caso selection_query debe describir exactamente qué fragmento seleccionar.
- generated_answer: solo el contenido NUEVO que se va a generar. Es el valor normal para generate_then_export.

Reglas críticas:
- Tolera errores de escritura de Word/DOCX: dox, dovx, dcx, wodr, wrd, wrod, doc y similares. Tolera errores parecidos de PDF.
- Frases naturales como "que me lo des en formato de Word", "me lo das en Word", "quiero recibirlo en un archivo de Word", "dame la respuesta en formato Word" o equivalentes SON órdenes reales de creación/exportación de archivo aunque no aparezcan las palabras "exportar" o "descargar".
- Si el usuario pide una tarea intelectual nueva y además un archivo, SIEMPRE generate_then_export. clean_prompt debe contener SOLO la tarea intelectual, eliminando por completo Word/DOCX/PDF/exportar/descargar/archivo y también cláusulas como "que me lo des en formato de Word".
- En generate_then_export usa export_scope="generated_answer", salvo que el usuario pida explícitamente que al final se exporte TODO EL CHAT.
- Si pide un chat existente por nombre o por tema, usa export_named. Usa el catálogo para asociarlo; si hay coincidencia fiable, devuelve chat_id y target_title exactos.
- Si pide solo una sección, usa export_scope="selection" y conserva en selection_query la descripción de esa sección.
- Si dice "solo tu última respuesta", "solo lo anterior" o "eso en Word" sin una tarea nueva, usa last_answer.
- Para export_current/export_named, clean_prompt=null.
- Para generate_then_export, clean_prompt nunca debe mencionar exportación ni formatos de archivo.
- format="docx" para Word/doc/docx/dox/dovx y "pdf" para PDF.

Esquema exacto:
{"intent":"export_current|export_named|generate_then_export|none","format":"docx|pdf","export_scope":"full_chat|last_answer|selection|generated_answer","target_title":null|string,"chat_id":null|string,"clean_prompt":null|string,"selection_query":null|string}`;

    const user = `TEXTO DEL USUARIO:\n${text}\n\nCHAT ACTUAL: ${currentId} | ${currentTitle}\n\nCATÁLOGO DE CHATS:\n${chatList}`;
    const r = await askGroq(apiKey, system, user, 620);
    if (!r.ok) return json(200, { ok: false, fallback: true, reason: r.reason });
    const parsed = normalizeDecision(r.parsed);
    if (!parsed) return json(200, { ok: false, fallback: true, reason: 'Clasificación inválida.' });
    return json(200, { ok: true, model: 'Elix Router', decision: parsed });
  } catch (error) {
    console.error('elix-export-router', error);
    return json(200, { ok: false, fallback: true, reason: error?.message || 'Router no disponible.' });
  }
};
