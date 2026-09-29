
        window.MathJax = {
            tex: {
                inlineMath: [['$', '$'], ['\\(', '\\)']],
                displayMath: [['$$', '$$'], ['\\[', '\\]']],
                processEscapes: true,
                processEnvironments: true
            },
            options: {
                skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
            }
        };
    


        // ==========================================
        // 1. BACKEND ELIX AI — SIN CLAVES PRIVADAS EN EL FRONTEND
        // ==========================================
        const ELIX_API_BASE = '/.netlify/functions';

        async function elixBackend(nombre, payload = {}) {
            const response = await fetch(`${ELIX_API_BASE}/${nombre}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            let data = {};
            try { data = await response.json(); } catch (_) {}

            if (!response.ok) {
                const mensaje = data?.error || data?.message || `${response.status} ${response.statusText}`;
                const error = new Error(mensaje || 'Error del backend de Elix.');
                error.status = response.status;
                throw error;
            }
            return data;
        }

        function elixNuevoJobId() {
            const uuid = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
                ? globalThis.crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
            return `elix-${uuid}`.replace(/[^a-zA-Z0-9_-]/g, '');
        }

        function elixFormatoEspera(ms) {
            const total = Math.max(0, Math.floor(ms / 1000));
            const min = Math.floor(total / 60);
            const seg = String(total % 60).padStart(2, '0');
            return min > 0 ? `${min}:${seg}` : `${total}s`;
        }

        async function elixBackground(nombre, payload = {}, opciones = {}) {
            const jobId = elixNuevoJobId();
            const etiqueta = opciones.etiqueta || 'Elix procesando';
            // Las tareas background de Elix AI pueden trabajar más que una llamada síncrona.
            // Dejamos margen antes del límite de ejecución de background.
            const maxWaitMs = Number(opciones.maxWaitMs) > 0 ? Number(opciones.maxWaitMs) : 14 * 60 * 1000;
            const inicio = Date.now();

            const inicioResponse = await fetch(`${ELIX_API_BASE}/${nombre}-background`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, job_id: jobId })
            });

            if (!inicioResponse.ok) {
                let data = {};
                try { data = await inicioResponse.json(); } catch (_) {}
                const mensaje = data?.error || data?.message || `${inicioResponse.status} ${inicioResponse.statusText}`;
                const error = new Error(mensaje || `No se pudo iniciar ${etiqueta}.`);
                error.status = inicioResponse.status;
                throw error;
            }

            // El resultado vive en el almacén de tareas de Elix AI; esta petición solo consulta el estado,
            // por lo que nunca mantiene abierta una Function durante todo el razonamiento.
            while (true) {
                const elapsed = Date.now() - inicio;
                if (elapsed > maxWaitMs) {
                    throw new Error(`${etiqueta} excedió el tiempo máximo de procesamiento de Elix AI.`);
                }

                if (typeof setCargando === 'function') {
                    setCargando(true, `${etiqueta} · ${elixFormatoEspera(elapsed)}`);
                }

                const estado = await elixBackend('elix-job-status', { job_id: jobId });

                if (estado?.status === 'done') {
                    return estado.result;
                }

                if (estado?.status === 'error') {
                    const error = new Error(estado?.error || `${etiqueta} no pudo completarse.`);
                    error.status = estado?.upstream_status || 500;
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, elapsed < 15000 ? 1200 : 2200));
            }
        }

        window.elixBackend = elixBackend;
        window.elixBackground = elixBackground;
        // ==========================================

        let chats = []; 
        let currentChatId = null;

        const directivasThinking = {
            low: `Instrucción de respuesta RÁPIDA:
Prioriza velocidad, precisión y utilidad inmediata.
Responde directamente a la solicitud sin introducciones innecesarias, repeticiones ni conclusiones redundantes.
Identifica rápidamente qué pide el usuario y entrega la solución más simple que sea correcta.

REGLAS:
- Si la pregunta es sencilla, responde de forma breve y directa.
- Si requiere cálculo, muestra únicamente las operaciones indispensables para verificar el resultado.
- Si requiere explicación, incluye solo los conceptos necesarios para comprender la respuesta.
- No desarrolles análisis extensos ni explores alternativas salvo que sean necesarias.
- No inventes datos, valores, fuentes ni supuestos.
- Si falta un dato indispensable, indícalo claramente.
- Respeta cualquier directiva académica, matemática o de formato recibida junto con esta instrucción.
- Evita frases de relleno como "claro", "por supuesto", "a continuación" o resúmenes de lo que el usuario acaba de pedir.

Objetivo: producir la respuesta correcta con la menor cantidad de texto y pasos innecesarios posible.`,
            medium: `Instrucción de respuesta ESTÁNDAR:
Resuelve la solicitud con un equilibrio óptimo entre rigor, claridad, profundidad y eficiencia.
Analiza cuidadosamente el problema antes de responder y presenta únicamente el razonamiento necesario para que la solución sea comprensible y verificable.

REGLAS:
- Identifica con precisión el objetivo principal de la solicitud.
- Organiza la respuesta de forma lógica y progresiva.
- Explica los pasos relevantes cuando el problema lo requiera, evitando detalles obvios o redundantes.
- En problemas matemáticos, científicos o técnicos, muestra fórmulas, sustituciones, unidades y resultados cuando aporten valor.
- Distingue claramente entre datos proporcionados, resultados calculados, supuestos e inferencias.
- No inventes información, fuentes, cifras, autores ni referencias.
- Si existen varias interpretaciones razonables, utiliza la más probable y señala brevemente el supuesto adoptado.
- Si falta información esencial para obtener una respuesta fiable, indícalo explícitamente.
- Adapta la extensión de la respuesta a la dificultad real del problema: una pregunta sencilla debe seguir teniendo una respuesta sencilla.
- Respeta estrictamente cualquier directiva académica, bibliográfica, matemática o de formato recibida junto con esta instrucción.
- Evita introducciones genéricas, repeticiones del enunciado y conclusiones que solo repitan lo ya explicado.

Objetivo: entregar una respuesta técnicamente sólida, clara y suficientemente desarrollada, sin llegar al nivel de exhaustividad de los modos Riguroso o Profundo.`,
            high: "Instrucción CRÍTICA: Eres un modelo estrictamente técnico y formal. NO debes hacer nada intuitivo ni inventar información. Basa tu respuesta EXCLUSIVAMENTE en literatura científica de alto nivel (mínimo revistas científicas Q3, libros formales o tesis). Enfócate única y exclusivamente en responder lo que pide el prompt de forma técnica, sin suposiciones.",
            max: "Instrucción CRÍTICA MÁXIMA e inquebrantable: Eres el nivel de rigor máximo estrictamente técnico y formal. NO debes hacer nada intuitivo ni inventar información. Basa tu respuesta EXCLUSIVAMENTE en literatura científica del más alto nivel solo revistas de primer nivel revisadas por pares (ej. Science, Nature) o literatura de universidades de élite (MIT, Harvard). MINIMO debes usar 10 fuentes bibliográficas para tu respuesta. CERO literatura de tesis. Enfócate única y exclusivamente en responder lo que pide el prompt de forma técnica, sin suposiciones. Debes redactar la respuesta con lenguaje científico de alto nivel y sin cometer ningún error de redacción, grámática u ortografía."
        };

        window.onload = () => {
            let chatsNuevos = [];
            let chatsAntiguos = [];

            try { chatsNuevos = JSON.parse(localStorage.getItem('cienciaChatsData')) || []; } catch(e) { }
            try { chatsAntiguos = JSON.parse(localStorage.getItem('quimicaChatsPro')) || []; } catch(e) { }

            if (chatsAntiguos.length > 0) {
                const esNuevaSinMensajes = chatsNuevos.length === 0 || (chatsNuevos.length === 1 && chatsNuevos[0].messages.length === 0);
                if (esNuevaSinMensajes) {
                    chats = chatsAntiguos; 
                    guardarEnLocal();      
                } else {
                    chats = chatsNuevos;
                }
            } else {
                chats = chatsNuevos;
            }

            if (chats.length === 0) crearNuevoChat();
            else seleccionarChat(chats[0].id);
        };

        function crearNuevoChat() {
            const newChat = { id: Date.now().toString(), title: "Nuevo Análisis", messages: [] };
            chats.unshift(newChat);
            guardarEnLocal();
            seleccionarChat(newChat.id);
        }

        function seleccionarChat(id) {
            currentChatId = id;
            renderizarListaChats();
            renderizarMensajesActuales();
        }

        function renombrarChat(id, event) {
            event.stopPropagation();
            const chat = chats.find(c => c.id === id);
            if (!chat) return;
            const nuevoNombre = prompt("Nuevo nombre del análisis:", chat.title);
            if (nuevoNombre && nuevoNombre.trim() !== "") {
                chat.title = nuevoNombre.trim();
                guardarEnLocal();
                renderizarListaChats();
            }
        }

        function eliminarChat(id, event) {
            event.stopPropagation();
            if (!confirm("¿Deseas eliminar este análisis?")) return;
            chats = chats.filter(c => c.id !== id);
            guardarEnLocal();
            if (chats.length === 0) crearNuevoChat();
            else seleccionarChat(chats[0].id);
        }

        function obtenerChatActual() { return chats.find(c => c.id === currentChatId); }
        function guardarEnLocal() { localStorage.setItem('cienciaChatsData', JSON.stringify(chats)); }

        // ESTA ES LA FUNCIÓN MEJORADA QUE PROTEGE LAS ECUACIONES MATEMÁTICAS (CORREGIDA)
        function formatTextoMarkdown(text) { 
            if (!text) return '';
            
            let procesado = text;
            
            // 1. Convertir delimitadores de LaTeX a los estándar ($$ y $)
            procesado = procesado.replace(/\\\[/g, '$$$$').replace(/\\\]/g, '$$$$');
            procesado = procesado.replace(/\\\(/g, '$').replace(/\\\)/g, '$');

            // 2. Extraer y proteger las ecuaciones matemáticas
            const mathBlocks = [];
            let counter = 0;

            // Busca tanto bloques $$...$$ como $...$ y entornos \begin...\end (Corregido para que markdown no interfiera)
            procesado = procesado.replace(/\$\$[\s\S]*?\$\$|\$[\s\S]*?\$|\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/g, (match) => {
                const id = `MATHBLOCKPLACEHOLDER${counter}END`;
                mathBlocks.push(match);
                counter++;
                return id;
            });

            // 3. Procesar el texto limpio con Markdown
            let htmlFormateado = typeof marked !== 'undefined' ? marked.parse(procesado) : procesado;

            // 4. Devolver las ecuaciones exactas a su lugar
            mathBlocks.forEach((math, index) => {
                // Se usa una función () => math para evitar que JS elimine símbolos $
                htmlFormateado = htmlFormateado.replace(`MATHBLOCKPLACEHOLDER${index}END`, () => math);
            });

            return htmlFormateado; 
        }

        function escapeHTML(str) { return (str || '').replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)); }

        function renderizarListaChats() {
            const listDiv = document.getElementById('chat-list');
            listDiv.innerHTML = '';
            chats.forEach(chat => {
                const item = document.createElement('div');
                item.className = `chat-item ${chat.id === currentChatId ? 'active' : ''}`;
                item.onclick = () => seleccionarChat(chat.id);
                
                item.innerHTML = `
                    <span class="chat-item-title" title="${escapeHTML(chat.title)}">${escapeHTML(chat.title)}</span>
                    <div class="chat-actions">
                        <button class="btn-action-chat" title="Renombrar" onclick="renombrarChat('${chat.id}', event)">✏️</button>
                        <button class="btn-action-chat delete" title="Eliminar" onclick="eliminarChat('${chat.id}', event)">🗑️</button>
                    </div>
                `;
                listDiv.appendChild(item);
            });
        }

        function renderizarMensajesActuales() {
            const chatContainer = document.getElementById('chat-history');
            chatContainer.innerHTML = '';
            const chatActual = obtenerChatActual();
            
            if (!chatActual || chatActual.messages.length === 0) {
                chatContainer.innerHTML = `
                    <div style="text-align:center; margin-top:10%; color:var(--text-secondary);">
                        <h2 style="color: var(--accent-color);">🧬 Elix AI</h2>
                        <p>Análisis académico, lectura de documentos e imágenes, búsqueda y exportación profesional en un solo espacio.</p>
                    </div>`;
                return;
            }
            chatActual.messages.forEach(msg => {
                if (msg.role === 'system') return; 
                agregarMensajeUI(msg.role, msg.displayContent || msg.content, msg.reasoning, msg.attachments || [], msg.generatedImage || null);
            });
        }

        function agregarMensajeUI(rol, texto, razonamiento = null, adjuntos = [], generatedImage = null) {
            const chatContainer = document.getElementById('chat-history');
            if (chatContainer.innerHTML.includes("🧬 Elix AI")) chatContainer.innerHTML = '';
            const row = document.createElement('div');
            const isUser = rol === 'user';
            row.className = `message-row ${isUser ? 'user' : 'ai'}`;

            let bloqueReasoningHTML = '';
            if (!isUser && razonamiento) {
                bloqueReasoningHTML = `<details class="thinking-box"><summary>🧠 Elix AI (Razonamiento)</summary><div class="thinking-text">${formatTextoMarkdown(razonamiento)}</div></details>`;
            }

            const textoFormateado = isUser ? escapeHTML(texto).replace(/\n/g, '<br>') : formatTextoMarkdown(texto);
            const adjuntosHTML = Array.isArray(adjuntos) && adjuntos.length
                ? `<div class="elix-message-attachments">${adjuntos.map(a => `<span class="elix-message-file" title="${escapeHTML(a.name || 'Archivo')}">📎 ${escapeHTML(a.name || 'Archivo')}</span>`).join('')}</div>`
                : '';

            let imagenHTML = '';
            if (generatedImage && generatedImage.dataUrl) {
                const alt = escapeHTML(generatedImage.alt || generatedImage.prompt || 'Imagen generada por Elix AI');
                const downloadName = escapeHTML(generatedImage.filename || 'elix-ai-imagen.png');
                imagenHTML = `
                    <div class="elix-generated-image-box" style="margin-top:12px; border:1px solid #2a2f3a; border-radius:16px; overflow:hidden; background:#0a0f1b;">
                        <img src="${generatedImage.dataUrl}" alt="${alt}" style="display:block; width:100%; height:auto; max-width:min(100%,820px); background:#0b1020;" loading="lazy">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-top:1px solid #22262e; flex-wrap:wrap;">
                            <div style="font-size:.78rem; color:#aab3c5; line-height:1.45;">🖼️ Imagen generada por Elix AI${generatedImage.width && generatedImage.height ? ` · ${generatedImage.width}×${generatedImage.height}` : ''}</div>
                            <a href="${generatedImage.dataUrl}" download="${downloadName}" style="display:inline-flex; align-items:center; gap:6px; padding:8px 12px; border-radius:999px; text-decoration:none; background:#215cff; color:#fff; font-size:.78rem; font-weight:600;">Descargar imagen</a>
                        </div>
                    </div>`;
            }
            row.innerHTML = `<div class="avatar ${isUser ? 'avatar-user' : 'avatar-ai'}">${isUser ? 'U' : 'E'}</div><div class="message-content">${adjuntosHTML}${bloqueReasoningHTML}<div>${textoFormateado}</div>${imagenHTML}</div>`;
            chatContainer.appendChild(row);
            chatContainer.scrollTop = chatContainer.scrollHeight;

            if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise([row]).catch(err => console.log(err));
        }

        function autoResize(textarea) { textarea.style.height = 'auto'; textarea.style.height = (textarea.scrollHeight < 150 ? textarea.scrollHeight : 150) + 'px'; }
        
        function setCargando(estado, texto = "Elix AI procesando...") {
            document.getElementById('loading-text').innerText = texto;
            document.getElementById('loading').style.display = estado ? 'flex' : 'none';
            document.getElementById('btn-send').disabled = estado;
        }

        // ==========================================
        // 2. TAVILY (ELIX WEB SEARCH)
        // ==========================================
        async function buscarFuentesElix(query) {
            const consulta = String(query || '').trim();
            if (!consulta) throw new Error('La consulta de búsqueda está vacía.');
            const data = await elixBackground('elix-search', { query: consulta }, { etiqueta: '🌍 Elix AI buscando fuentes' });
            const resultados = Array.isArray(data?.results) ? data.results : [];
            if (!resultados.length) throw new Error('Elix AI no encontró resultados para esta consulta.');
            return resultados.map((r, i) => {
                const titulo = r?.title || `Resultado ${i + 1}`;
                const url = r?.url || '';
                const contenido = r?.content || r?.snippet || '';
                return `Fuente ${i + 1} (${titulo}${url ? ` - ${url}` : ''}): ${contenido}`;
            }).join('\n\n');
        }

        window.buscarFuentesElix = buscarFuentesElix;

        async function generarQueryBusqueda(query) {
            try {
                const prompt = `Extrae únicamente las palabras clave principales de búsqueda académica/web (máximo 6 palabras clave en español o inglés) para buscar fuentes relevantes en la web. No agregues explicaciones ni comillas. Solicitud: "${query}"`;
                const data = await elixBackground('elix-multimodal', { payload: {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 30 }
                }});
                return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || query;
            } catch (e) {
                return query;
            }
        }

        // ==========================================
        // 3. GEMINI COMO ROUTER (DECISIÓN DE BÚSQUEDA)
        // ==========================================
        async function elixFlashEvaluaBusqueda(query, academicMode) {
            if (String(academicMode || 'none').toLowerCase() !== 'none') return true;
            try {
                const prompt = `Actúa como un enrutador inteligente de búsqueda científica y web. Responde ÚNICAMENTE SI o NO. Responde SI si la solicitud requiere bibliografía, fuentes, información actualizada o internet. Solicitud: "${query}"`;
                const data = await elixBackground('elix-multimodal', { payload: {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.0, maxOutputTokens: 5 }
                }});
                const respuesta = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim().toUpperCase() || '';
                return respuesta.startsWith('SI');
            } catch (e) {
                console.warn('Elix AI continuó sin búsqueda automática:', e);
                return false;
            }
        }

        // ==========================================
        // 4. FLUJO PRINCIPAL (ELIX PRO + DEEPSEEK CITATIONS)
        // ==========================================
        async function enviarMensaje() {
            const inputField = document.getElementById('user-input');
            let peticionOriginal = inputField.value.trim();
            // El router de exportación puede conservar visible la orden completa del usuario,
            // pero entregar al motor principal únicamente la tarea limpia (sin "hazme un Word/PDF").
            let peticionModeloElix = String(window.ELIX_PROMPT_MODELO_LIMPIO || peticionOriginal).trim();
            const exportacionSolicitadaElix = null;
            const contextoArchivosElix = String(window.ELIX_CONTEXT_ARCHIVOS_PENDIENTE || '');
            const adjuntosElix = Array.isArray(window.ELIX_ADJUNTOS_EN_ENVIO) ? window.ELIX_ADJUNTOS_EN_ENVIO : [];
            if (!peticionOriginal && contextoArchivosElix) peticionOriginal = 'Analiza los archivos adjuntos.';
            if (!peticionModeloElix && contextoArchivosElix) peticionModeloElix = 'Analiza los archivos adjuntos.';
            if (!peticionModeloElix) peticionModeloElix = peticionOriginal;
            const nivelThinking = document.getElementById('thinking-level').value;
            const academicMode = document.getElementById('academic-mode').value;

            if (!peticionOriginal) return;

            inputField.value = '';
            inputField.style.height = 'auto';
            agregarMensajeUI('user', peticionOriginal, null, adjuntosElix);

            const chatActual = obtenerChatActual();
            if (chatActual.messages.length === 0) {
                chatActual.title = peticionOriginal.substring(0, 25) + "...";
                renderizarListaChats();
            }

            setCargando(true, "⚡ Elix AI evaluando la solicitud...");
            
            let contextoWeb = "";
            const requiereInternet = await window.elixFlashEvaluaBusqueda(peticionModeloElix, academicMode);
            
            if (requiereInternet) {
                setCargando(true, "🌍 Elix AI buscando fuentes...");
                try {
                    const queryOptimizada = await window.generarQueryBusqueda(peticionModeloElix);
                    contextoWeb = await window.buscarFuentesElix(queryOptimizada);
                } catch (e) {
                    console.warn("Aviso de búsqueda web:", e);
                    const detalle = e?.message || String(e);
                    setCargando(true, `⚠️ Elix AI: ${detalle}`);
                    await new Promise(resolve => setTimeout(resolve, 1400));
                }
            }

            let promptEnriquecido = `[DIRECTIVA DE SISTEMA: ${directivasThinking[nivelThinking]}]\n`;
            promptEnriquecido += `[REGLA DE FORMATO MATEMÁTICO: Escribe TODAS las ecuaciones en formato LaTeX puro. Usa SIEMPRE "$$" para ecuaciones en bloque y "$" para ecuaciones en línea. ESTÁ ESTRICTAMENTE PROHIBIDO usar corchetes o paréntesis como delimitadores matemáticos.]\n\n`;
            
            if (academicMode !== "none") {
                let especificidadAPA = academicMode === "apa7" ? "Aplica rigurosamente las normas APA 7ma Edición." : "";
                promptEnriquecido += `[DIRECTIVA ACADÉMICA ESTRICTA]: Integra citas en el texto y genera las Referencias Bibliográficas al final en formato ${academicMode.toUpperCase()}. ${especificidadAPA} ESTÁ ESTRICTAMENTE PROHIBIDO RESUMIR O RECORTAR LA INFORMACIÓN. Mantén toda tu explicación técnica y paso a paso original, limitándote únicamente a incorporar el rigor bibliográfico sin sacrificar ni una letra de tu análisis.\n\n`;
            }

            if (contextoWeb) promptEnriquecido += `[INFORMACIÓN ACTUALIZADA / BIBLIOGRAFÍA ENCONTRADA EN LA WEB]:\n${contextoWeb}\n\n[FIN DE LA INFORMACIÓN WEB]\n\nUtiliza la información anterior si es relevante para citar y respaldar tu respuesta académica a la siguiente solicitud:\n`;
            if (contextoArchivosElix) {
                promptEnriquecido += `\n[CONTEXTO DE ARCHIVOS PROCESADO POR ELIX AI]:\n${contextoArchivosElix}\n[FIN DEL CONTEXTO DE ARCHIVOS]\n\n`;
            }
            promptEnriquecido += peticionModeloElix;

            chatActual.messages.push({ role: 'user', content: promptEnriquecido, displayContent: peticionOriginal, attachments: adjuntosElix });
            guardarEnLocal();

            setCargando(true, "🧠 Elix AI analizando y redactando...");

            try {
                const mensajesParaAPI = chatActual.messages.map(m => ({ role: m.role, content: m.content }));
                
                const data = await elixBackground('elix-core', {
                    messages: mensajesParaAPI,
                    max_tokens: 30000
                }, { etiqueta: '🧠 Elix AI analizando y redactando' });
                
                let respuestaFinal = data.choices[0].message.content;
                let razonamiento = data.choices[0].message.reasoning_content || null;

                chatActual.messages.push({ 
                    role: 'assistant', 
                    content: respuestaFinal,
                    reasoning: razonamiento
                });
                
                guardarEnLocal();
                agregarMensajeUI('assistant', respuestaFinal, razonamiento);


            } catch (error) {
                // Si el usuario detuvo la respuesta, dejamos que el módulo de STOP
                // restaure el prompt sin mostrar un falso error.
                if (error && error.name === 'AbortError') throw error;
                console.error(error);
                const detalle = String(error?.message || 'No se pudo completar la respuesta.');
                const mensajeError = `⚠️ Elix AI no pudo completar esta respuesta: ${detalle}`;
                chatActual.messages.push({
                    role: 'assistant',
                    content: mensajeError,
                    reasoning: null,
                    isError: true
                });
                guardarEnLocal();
                agregarMensajeUI('assistant', mensajeError);
            } finally {
                setCargando(false);
            }
        }

        // ==========================================
        // 5. ELIX FLASH LEYENDO ARCHIVOS
        // ==========================================
        async function procesarArchivoConElix(event) {
            const file = event.target.files[0];
            if (!file) return;
            setCargando(true, `✨ Elix AI leyendo ${file.name}...`);
            try {
                const reader = new FileReader();
                const dataUrl = await new Promise((resolve, reject) => {
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo.'));
                    reader.readAsDataURL(file);
                });
                const base64Data = String(dataUrl).split(',')[1] || '';
                const data = await elixBackground('elix-multimodal', { payload: {
                    contents: [{ parts: [
                        { text: 'Eres un extractor de datos de precisión. Extrae textualmente todo el contenido científico, ecuaciones y datos de este documento. Preséntalo de forma limpia en texto plano.' },
                        { inlineData: { data: base64Data, mimeType: file.type || 'application/octet-stream' } }
                    ]}]
                }});
                const texto = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
                const inputField = document.getElementById('user-input');
                inputField.value += `[Contexto del documento ${file.name} procesado por Elix AI]:\n${texto}\n\n`;
                autoResize(inputField);
            } catch (error) {
                console.error(error);
                alert('No se pudo procesar el archivo con Elix AI.');
            } finally {
                setCargando(false);
                event.target.value = '';
            }
        }

        // PDF se mantiene como única exportación.

        function exportarPDFSoloRespuestas() { window.print(); }
    


        (function() {
            // 1. STOP INTEGRADO EN EL MISMO BOTÓN DE ENVIAR
            const btnSend = document.getElementById('btn-send');
            const SEND_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
            const STOP_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`;

            let abortController = null;
            let solicitudActiva = false;

            function actualizarBotonEnvio(estaGenerando) {
                solicitudActiva = estaGenerando;
                btnSend.classList.toggle('is-stopping', estaGenerando);
                btnSend.innerHTML = estaGenerando ? STOP_ICON : SEND_ICON;
                btnSend.title = estaGenerando ? 'Detener respuesta' : 'Enviar mensaje';
                btnSend.setAttribute('aria-label', estaGenerando ? 'Detener respuesta' : 'Enviar mensaje');
                // Durante una respuesta debe seguir siendo clicable para poder detenerla.
                btnSend.disabled = false;
            }

            const originalSetCargando = setCargando;
            setCargando = function(estado, texto) {
                originalSetCargando(estado, texto);

                // Solo convertimos Enviar en STOP cuando la carga pertenece al chat.
                // Otros procesos auxiliares conservan el comportamiento original.
                if (estado && abortController) {
                    actualizarBotonEnvio(true);
                } else if (!estado) {
                    actualizarBotonEnvio(false);
                }
            };

            // Interceptar los fetch del flujo del chat para poder abortarlos.
            const originalFetch = window.fetch;
            window.fetch = async function(...args) {
                if (abortController) {
                    args[1] = args[1] || {};
                    args[1].signal = abortController.signal;
                }
                return await originalFetch.apply(this, args);
            };

            // Envolver enviarMensaje: si ya está generando, el mismo botón detiene.
            const originalEnviarMensaje = enviarMensaje;
            enviarMensaje = async function() {
                if (solicitudActiva && abortController) {
                    abortController.abort();
                    return;
                }

                abortController = new AbortController();
                try {
                    await originalEnviarMensaje();
                } catch (error) {
                    if (error && error.name === 'AbortError') {
                        const chatActual = obtenerChatActual();
                        if (chatActual && chatActual.messages.length > 0) {
                            const lastMsg = chatActual.messages[chatActual.messages.length - 1];
                            if (lastMsg.role === 'user') {
                                const input = document.getElementById('user-input');
                                input.value = lastMsg.displayContent || lastMsg.content;
                                autoResize(input);

                                // Mantiene el comportamiento anterior: al detener, el prompt
                                // vuelve al editor y se retira del historial incompleto.
                                chatActual.messages.pop();
                                guardarEnLocal();
                            }
                        }
                        renderizarMensajesActuales();
                        setCargando(false);
                    } else {
                        console.error(error);
                    }
                } finally {
                    abortController = null;
                    actualizarBotonEnvio(false);
                }
            };

            actualizarBotonEnvio(false);

            // 2. LÁPIZ DE EDICIÓN RESILIENTE (se conserva la lógica existente)
            const originalAgregarMensajeUI = agregarMensajeUI;
            agregarMensajeUI = function(rol, texto, razonamiento, adjuntos, generatedImage) {
                originalAgregarMensajeUI(rol, texto, razonamiento, adjuntos, generatedImage);

                if (rol === 'user') {
                    const container = document.getElementById('chat-history');
                    const row = container.lastElementChild;

                    if (row && row.classList.contains('user')) {
                        const btnEdit = document.createElement('button');
                        btnEdit.className = 'btn-edit-prompt';
                        btnEdit.innerHTML = '✏️';
                        btnEdit.title = 'Editar este mensaje';

                        btnEdit.onclick = function() {
                            const chatActual = obtenerChatActual();
                            if (!chatActual) return;

                            const targetText = (texto || '').trim();
                            const idx = chatActual.messages.findIndex(m =>
                                m.role === 'user' &&
                                ((m.displayContent || '').trim() === targetText || (m.content || '').trim() === targetText)
                            );

                            if (idx !== -1) {
                                chatActual.messages.splice(idx);
                                guardarEnLocal();
                            } else {
                                chatActual.messages.pop();
                                guardarEnLocal();
                            }

                            const input = document.getElementById('user-input');
                            input.value = texto;
                            autoResize(input);
                            input.focus();
                            renderizarMensajesActuales();
                        };
                        row.appendChild(btnEdit);
                    }
                }
            };

            // Inyectar lápices en historiales viejos al cargar la app.
            setTimeout(() => {
                if (obtenerChatActual()?.messages.length > 0) {
                    renderizarMensajesActuales();
                }
            }, 600);
        })();
    


        (function() {
            // 3. Interceptar a la fuerza los clics del menú lateral (Fase de Captura)
            // Esto anula el código roto anterior y hace que el lápiz y la papelera funcionen.
            document.addEventListener('click', function(e) {
                const btnRenombrar = e.target.closest('[onclick*="renombrar"]');
                const btnEliminar = e.target.closest('[onclick*="eliminar"]');

                if (btnRenombrar) {
                    e.preventDefault();
                    e.stopPropagation(); // Detiene el error nativo de Electron
                    
                    // Extrae el ID del chat
                    const match = btnRenombrar.getAttribute('onclick').match(/['"]([^'"]+)['"]/);
                    if (match) mostrarModalRenombrar(match[1]);
                    return;
                }

                if (btnEliminar) {
                    e.preventDefault();
                    e.stopPropagation(); // Detiene el error nativo de Electron
                    
                    const match = btnEliminar.getAttribute('onclick').match(/['"]([^'"]+)['"]/);
                    if (match) mostrarModalEliminar(match[1]);
                    return;
                }
            }, true); // 'true' asegura que atrapemos el clic antes de que el HTML original actúe

            function mostrarModalRenombrar(id) {
                const chat = chats.find(c => c.id === id);
                if (!chat) return;

                const overlay = document.createElement('div');
                overlay.className = 'elix-modal-overlay';
                overlay.innerHTML = `
                    <div class="elix-modal-box">
                        <h3 style="margin:0;color:#fafafa;font-size:1.05rem;">Renombrar Análisis</h3>
                        <input type="text" id="modal-input-nombre" value="${chat.title}" style="width:100%;background:#09090b;border:1px solid #3f3f46;color:#fafafa;padding:12px;border-radius:8px;outline:none;">
                        <div style="display:flex;justify-content:flex-end;gap:12px;">
                            <button id="modal-btn-cancelar" style="background:transparent;color:#a1a1aa;border:none;padding:8px 16px;cursor:pointer;">Cancelar</button>
                            <button id="modal-btn-guardar" style="background:#3b82f6;color:white;border:none;padding:8px 16px;cursor:pointer;border-radius:6px;">Guardar</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(overlay);

                const input = document.getElementById('modal-input-nombre');
                input.focus(); 
                input.select();

                document.getElementById('modal-btn-cancelar').onclick = () => overlay.remove();
                document.getElementById('modal-btn-guardar').onclick = () => {
                    if (input.value.trim()) {
                        chat.title = input.value.trim();
                        guardarEnLocal();
                        renderizarListaChats();
                    }
                    overlay.remove();
                };
            }

            function mostrarModalEliminar(id) {
                const overlay = document.createElement('div');
                overlay.className = 'elix-modal-overlay';
                overlay.innerHTML = `
                    <div class="elix-modal-box">
                        <h3 style="margin:0;color:#fafafa;font-size:1.05rem;">Eliminar Análisis</h3>
                        <p style="margin:0;color:#a1a1aa;font-size:0.95rem;">¿Estás seguro? Esta acción no se puede deshacer.</p>
                        <div style="display:flex;justify-content:flex-end;gap:12px;">
                            <button id="modal-btn-cancelar2" style="background:transparent;color:#a1a1aa;border:none;padding:8px 16px;cursor:pointer;">Cancelar</button>
                            <button id="modal-btn-eliminar" style="background:#ef4444;color:white;border:none;padding:8px 16px;cursor:pointer;border-radius:6px;">Eliminar</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(overlay);

                document.getElementById('modal-btn-cancelar2').onclick = () => overlay.remove();
                document.getElementById('modal-btn-eliminar').onclick = () => {
                    chats = chats.filter(c => c.id !== id);
                    guardarEnLocal();
                    if (chats.length === 0) crearNuevoChat();
                    else seleccionarChat(chats[0].id);
                    overlay.remove();
                };
            }
        })();
    


    (function() {
        // Mejorar la etiqueta meta viewport para bloquear zoom táctil en la app
        const metaViewport = document.querySelector('meta[name="viewport"]');
        if(metaViewport) {
            metaViewport.content = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
        }

        // Inyectar botón de menú en la barra superior
        const topBar = document.querySelector('.top-bar');
        const titleElement = document.querySelector('.app-title');
        
        const menuBtn = document.createElement('button');
        menuBtn.className = 'btn-mobile-menu';
        menuBtn.innerHTML = '☰';
        topBar.insertBefore(menuBtn, titleElement);

        // Crear el overlay para cerrar el menú tocando fuera
        const overlay = document.createElement('div');
        overlay.className = 'mobile-overlay';
        document.body.appendChild(overlay);

        const sidebar = document.querySelector('.sidebar');

        // Lógica para abrir/cerrar
        function toggleMenu() {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('open');
        }

        menuBtn.addEventListener('click', toggleMenu);
        overlay.addEventListener('click', toggleMenu);

        // Cerrar menú automáticamente al elegir un chat o crear uno nuevo en el celular
        const originalSeleccionarChat = seleccionarChat;
        window.seleccionarChat = function(id) {
            originalSeleccionarChat(id);
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('open');
                overlay.classList.remove('open');
            }
        };

        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                sidebar.classList.remove('open');
                overlay.classList.remove('open');
            }
        });
    })();



(function(){
    'use strict';

    /* =========================================================
       A) NÚCLEO AUXILIAR ELIX AI — LECTURA, ROUTER Y ADJUNTOS
       ========================================================= */
    async function llamarElixMultimodal(payload, etiqueta = 'Elix AI') {
        // Nombre conservado solo por compatibilidad interna. La interfaz y las funciones desplegadas son Elix.
        const data = await elixBackground('elix-multimodal', { payload }, { etiqueta });
        const texto = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (!texto.trim() && !data?.candidates?.length) {
            throw new Error(`${etiqueta}: Elix AI devolvió una respuesta vacía.`);
        }
        return { data, model: 'Elix AI', text: texto };
    }
    window.llamarElixMultimodal = llamarElixMultimodal;

    window.elixFlashEvaluaBusqueda = async function(query, academicMode) {
        const q = String(query || '').trim();
        const qLower = q.toLowerCase();
        const modo = String(academicMode || 'none').toLowerCase();

        const soloFuentesAportadas =
            /(solo|únicamente|unicamente|exclusivamente).{0,40}(bibliograf[ií]a|fuentes|referencias).{0,50}(proporcionad|adjunt|incluid|dadas)/i.test(q) ||
            /(no|sin).{0,20}(buscar|b[uú]squeda|internet|web).{0,30}(fuera|extern|adicional)/i.test(q);

        if (soloFuentesAportadas) return false;
        if (modo !== 'none') return true;

        const señalesWeb = [
            'internet','web','buscar','busca','investiga','investigar',
            'fuente','fuentes','bibliografía','bibliografia','referencia','referencias',
            'artículo','articulo','paper','papers','doi','revista','journal',
            'actual','actualizado','actualizada','reciente','recientes','último','ultimo',
            'noticia','noticias','hoy','este año','2026'
        ];
        if (señalesWeb.some(x => qLower.includes(x))) return true;

        try {
            const prompt = `Actúa como un enrutador de búsqueda web para Elix AI.
Responde ÚNICAMENTE SI o NO.
Responde SI si la solicitud necesita información externa, bibliografía, datos actuales o verificación en internet.
Solicitud: ${q}`;
            const r = await llamarElixMultimodal({
                contents:[{parts:[{text:prompt}]}],
                generationConfig:{temperature:0, maxOutputTokens:8}
            }, 'Elix AI · evaluación');
            return (r.text || '').trim().toUpperCase().startsWith('SI');
        } catch (e) {
            console.warn('Elix AI continuó sin búsqueda automática.', e);
            return false;
        }
    };

    window.generarQueryBusqueda = async function(query) {
        try {
            const prompt = `Extrae únicamente hasta 6 palabras clave principales de búsqueda académica/web, en español o inglés. No agregues explicaciones ni comillas. Solicitud: ${query}`;
            const r = await llamarElixMultimodal({
                contents:[{parts:[{text:prompt}]}],
                generationConfig:{temperature:0.1, maxOutputTokens:40}
            }, 'Elix AI · búsqueda');
            return r.text.trim() || query;
        } catch (e) {
            console.warn('Elix AI usará la consulta original.', e);
            return query;
        }
    };

    const ELIX_INLINE_MAX_BYTES = 2.0 * 1024 * 1024; // documentos binarios enviados en una sola petición
    const ELIX_IMAGEN_OBJETIVO_BYTES = 1.15 * 1024 * 1024;
    const ELIX_IMAGEN_REINTENTO_BYTES = 620 * 1024;
    const ELIX_IMAGEN_MAX_LADO = 2048;
    const ELIX_IMAGEN_REINTENTO_LADO = 1400;
    const ELIX_TEXTO_CHUNK = 18000;
    let elixAdjuntosPendientes = [];
    let elixMiniProcesando = false;
    const elixPreviewUrls = new Map();

    function elixExtension(nombre=''){
        const limpio=String(nombre||'').toLowerCase();
        const punto=limpio.lastIndexOf('.');
        return punto>=0 ? limpio.slice(punto+1) : '';
    }

    function elixMimePorExtension(nombre='', fallback='application/octet-stream'){
        const ext=elixExtension(nombre);
        const mapa={
            pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif',
            bmp:'image/bmp', svg:'image/svg+xml', heic:'image/heic', heif:'image/heif', avif:'image/avif', txt:'text/plain', md:'text/markdown', csv:'text/csv', json:'application/json',
            docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls:'application/vnd.ms-excel'
        };
        return mapa[ext] || fallback;
    }

    function elixTamano(bytes){
        const n=Number(bytes||0);
        if(n<1024) return `${n} B`;
        if(n<1024*1024) return `${(n/1024).toFixed(1)} KB`;
        return `${(n/(1024*1024)).toFixed(1)} MB`;
    }

    function elixIconoArchivo(file){
        if(String(file.type||'').startsWith('image/')) return '🖼️';
        const ext=elixExtension(file.name);
        if(ext==='pdf') return '📕';
        if(ext==='docx') return '📘';
        if(ext==='pptx') return '📙';
        if(ext==='xlsx'||ext==='xls'||ext==='csv') return '📗';
        return '📄';
    }

    function elixCrearBandejaAdjuntos(){
        let tray=document.getElementById('elix-attachment-tray');
        if(tray) return tray;
        const textareaContainer=document.querySelector('.textarea-container');
        if(!textareaContainer) return null;
        tray=document.createElement('div');
        tray.id='elix-attachment-tray';
        tray.className='elix-attachment-tray';
        textareaContainer.parentNode.insertBefore(tray, textareaContainer);
        return tray;
    }

    function elixLiberarPreview(file){
        const url=elixPreviewUrls.get(file);
        if(url){
            try { URL.revokeObjectURL(url); } catch(_){}
            elixPreviewUrls.delete(file);
        }
    }

    function elixRenderAdjuntos(){
        const tray=elixCrearBandejaAdjuntos();
        if(!tray) return;
        tray.innerHTML='';
        tray.classList.toggle('has-files', elixAdjuntosPendientes.length>0);

        elixAdjuntosPendientes.forEach((file, index)=>{
            const card=document.createElement('div');
            card.className='elix-attachment-card';
            let visual='';
            if(String(file.type||'').startsWith('image/')){
                let url=elixPreviewUrls.get(file);
                if(!url){
                    url=URL.createObjectURL(file);
                    elixPreviewUrls.set(file,url);
                }
                visual=`<img class="elix-attachment-thumb" src="${url}" alt="">`;
            } else {
                visual=`<div class="elix-attachment-icon">${elixIconoArchivo(file)}</div>`;
            }
            card.innerHTML=`${visual}<div class="elix-attachment-meta"><div class="elix-attachment-name" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</div><div class="elix-attachment-size">${elixTamano(file.size)}</div></div><button class="elix-attachment-remove" type="button" title="Quitar archivo" aria-label="Quitar archivo">×</button>`;
            const previewImg=card.querySelector('.elix-attachment-thumb');
            if(previewImg) previewImg.onerror=()=>{ const icon=document.createElement('div'); icon.className='elix-attachment-icon'; icon.textContent='🖼️'; previewImg.replaceWith(icon); };
            card.querySelector('.elix-attachment-remove').onclick=()=>{
                const quitado=elixAdjuntosPendientes[index];
                if(quitado) elixLiberarPreview(quitado);
                elixAdjuntosPendientes.splice(index,1);
                elixRenderAdjuntos();
            };
            tray.appendChild(card);
        });
    }

    window.elixSeleccionarArchivos = function(event){
        const nuevos=Array.from(event.target.files || []);
        for(const file of nuevos){
            const duplicado=elixAdjuntosPendientes.some(f=>f.name===file.name && f.size===file.size && f.lastModified===file.lastModified);
            if(!duplicado) elixAdjuntosPendientes.push(file);
        }
        event.target.value='';
        elixRenderAdjuntos();
    };

    function elixLimpiarAdjuntosPendientes(){
        elixAdjuntosPendientes.forEach(elixLiberarPreview);
        elixAdjuntosPendientes=[];
        elixRenderAdjuntos();
    }

    function elixArchivoADataURL(file){
        return new Promise((resolve,reject)=>{
            const reader=new FileReader();
            reader.onload=()=>resolve(String(reader.result||''));
            reader.onerror=()=>reject(reader.error || new Error(`No se pudo leer ${file.name || 'el archivo'}`));
            reader.readAsDataURL(file);
        });
    }

    async function elixBlobAInlineData(blob, nombre='archivo'){
        const dataUrl=await elixArchivoADataURL(blob);
        return {
            data:String(dataUrl).split(',')[1] || '',
            mimeType:blob.type || elixMimePorExtension(nombre)
        };
    }

    async function elixCargarImagenLocal(file){
        let bitmap=null;
        if(typeof createImageBitmap==='function') {
            try {
                try { bitmap=await createImageBitmap(file,{imageOrientation:'from-image'}); }
                catch(_) { bitmap=await createImageBitmap(file); }
                if(bitmap?.width && bitmap?.height) {
                    return { source:bitmap, width:bitmap.width, height:bitmap.height, close:()=>{ try{bitmap.close?.();}catch(_){} } };
                }
            } catch(_) {}
        }

        const url=URL.createObjectURL(file);
        try {
            const img=await new Promise((resolve,reject)=>{
                const el=new Image();
                el.onload=()=>resolve(el);
                el.onerror=()=>reject(new Error('El navegador no pudo decodificar esta imagen.'));
                el.src=url;
            });
            if(!img.naturalWidth || !img.naturalHeight) throw new Error('La imagen no tiene dimensiones válidas.');
            return {source:img,width:img.naturalWidth,height:img.naturalHeight,close:()=>URL.revokeObjectURL(url)};
        } catch(error) {
            URL.revokeObjectURL(url);
            throw error;
        }
    }

    function elixCanvasAJpeg(canvas,calidad){
        return new Promise((resolve,reject)=>{
            canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo preparar la imagen para Elix AI.')),'image/jpeg',calidad);
        });
    }

    async function elixOptimizarImagen(file,perfil='normal'){
        const agresivo=perfil==='reintento';
        const maxSide=agresivo ? ELIX_IMAGEN_REINTENTO_LADO : ELIX_IMAGEN_MAX_LADO;
        const targetBytes=agresivo ? ELIX_IMAGEN_REINTENTO_BYTES : ELIX_IMAGEN_OBJETIVO_BYTES;
        const cargada=await elixCargarImagenLocal(file);
        try {
            let scale=Math.min(1,maxSide/Math.max(cargada.width,cargada.height));
            let width=Math.max(1,Math.round(cargada.width*scale));
            let height=Math.max(1,Math.round(cargada.height*scale));
            let calidad=agresivo ? .78 : .90;
            let blob=null;

            for(let ronda=0;ronda<5;ronda++){
                const canvas=document.createElement('canvas');
                canvas.width=width;
                canvas.height=height;
                const ctx=canvas.getContext('2d',{alpha:false});
                if(!ctx) throw new Error('El navegador no pudo preparar el lienzo de imagen.');
                ctx.fillStyle='#ffffff';
                ctx.fillRect(0,0,width,height);
                ctx.imageSmoothingEnabled=true;
                ctx.imageSmoothingQuality='high';
                ctx.drawImage(cargada.source,0,0,width,height);

                for(let intento=0;intento<5;intento++){
                    blob=await elixCanvasAJpeg(canvas,calidad);
                    if(blob.size<=targetBytes || calidad<=.58) break;
                    calidad=Math.max(.58,calidad-.08);
                }
                if(blob && blob.size<=targetBytes) break;
                width=Math.max(480,Math.round(width*.82));
                height=Math.max(320,Math.round(height*.82));
                calidad=agresivo ? .72 : .82;
            }

            if(!blob) throw new Error('No se pudo normalizar la imagen.');
            return new File([blob],`${String(file.name||'imagen').replace(/\.[^.]+$/,'')}.jpg`,{
                type:'image/jpeg',
                lastModified:file.lastModified || Date.now()
            });
        } finally {
            cargada.close?.();
        }
    }

    async function elixLeerImagen(file, solicitud, etiquetaExtra=''){
        const prompt=`Eres la capa de lectura multimodal de Elix AI. Examina la imagen completa con máxima fidelidad.
Extrae y describe todo lo necesario para responder después la solicitud del usuario: texto visible, tablas, ecuaciones, símbolos, gráficos, diagramas, etiquetas, unidades, relaciones espaciales y cualquier detalle relevante.
No inventes datos y no resuelvas todavía la solicitud final. Si algo no es legible, indícalo.
Archivo: ${file.name}${etiquetaExtra ? ` · ${etiquetaExtra}` : ''}
Solicitud posterior del usuario: ${solicitud || 'Analizar el archivo adjunto.'}`;

        let ultimoError=null;
        const perfiles=['normal','reintento'];
        for(let intento=0;intento<perfiles.length;intento++){
            try {
                setCargando(true,intento===0 ? `🖼️ Elix AI preparando ${file.name}...` : `🖼️ Elix AI optimizando nuevamente ${file.name}...`);
                const optimizada=await elixOptimizarImagen(file,perfiles[intento]);
                const inline=await elixBlobAInlineData(optimizada,optimizada.name);
                if(!inline.data) throw new Error('La imagen quedó vacía al prepararla.');

                const r=await llamarElixMultimodal({
                    contents:[{parts:[{text:prompt},{inlineData:inline}]}],
                    generationConfig:{temperature:0,maxOutputTokens:8192}
                }, `🖼️ Elix AI leyendo ${file.name}`);
                const texto=String(r.text||'').trim();
                if(!texto) throw new Error('Elix AI no obtuvo contenido legible de la imagen.');
                return texto;
            } catch(error) {
                if(error?.name==='AbortError') throw error;
                ultimoError=error;
                const msg=String(error?.message||error);
                const noReintentar=Number(error?.status)===401 || /credencial requerida|no tiene disponible una credencial/i.test(msg);
                if(noReintentar || intento===perfiles.length-1) break;
            }
        }

        const detalle=String(ultimoError?.message||ultimoError||'No fue posible analizar la imagen.')
            .replace(/Gemini|DeepSeek|Groq|Tavily|Netlify/gi,'Elix AI')
            .replace(/gemini-[\w.-]+/gi,'Elix AI');
        throw new Error(`${file.name}: ${detalle}`);
    }

    function elixTextoDesdeXML(xmlTexto){
        const xml=new DOMParser().parseFromString(xmlTexto,'application/xml');
        if(xml.querySelector('parsererror')) return '';
        const bloques=[];
        const elementos=Array.from(xml.getElementsByTagName('*'));
        const parrafos=elementos.filter(n=>n.localName==='p');
        if(parrafos.length){
            for(const p of parrafos){
                const ts=Array.from(p.getElementsByTagName('*')).filter(n=>n.localName==='t' || n.localName==='v');
                const s=ts.map(n=>n.textContent||'').join(' ').replace(/\s+/g,' ').trim();
                if(s) bloques.push(s);
            }
            return bloques.join('\n');
        }
        return elementos.filter(n=>n.localName==='t' || n.localName==='v').map(n=>n.textContent||'').join(' ').replace(/\s+/g,' ').trim();
    }

    async function elixExtraerDOCX(file){
        if(typeof JSZip==='undefined') throw new Error('El lector de documentos no está disponible.');
        const zip=await JSZip.loadAsync(await file.arrayBuffer());
        const candidatos=Object.keys(zip.files)
            .filter(n=>/^word\/(document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/i.test(n))
            .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
        const partes=[];
        for(const nombre of candidatos){
            const xml=await zip.file(nombre)?.async('string');
            if(!xml) continue;
            const t=elixTextoDesdeXML(xml);
            if(t) partes.push(`[${nombre}]\n${t}`);
        }
        return partes.join('\n\n');
    }

    async function elixExtraerPPTX(file){
        if(typeof JSZip==='undefined') throw new Error('El lector de presentaciones no está disponible.');
        const zip=await JSZip.loadAsync(await file.arrayBuffer());
        const nombres=Object.keys(zip.files)
            .filter(n=>/^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+|charts\/chart\d+)\.xml$/i.test(n))
            .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
        const partes=[];
        for(const nombre of nombres){
            const xml=await zip.file(nombre)?.async('string');
            if(!xml) continue;
            const t=elixTextoDesdeXML(xml);
            if(t) partes.push(`[${nombre}]\n${t}`);
        }
        return partes.join('\n\n');
    }

    async function elixExtraerExcel(file){
        if(typeof XLSX==='undefined') throw new Error('El lector de hojas de cálculo no está disponible.');
        const wb=XLSX.read(await file.arrayBuffer(),{type:'array',cellFormula:true,cellText:true,cellDates:true});
        const partes=[];
        for(const nombre of wb.SheetNames){
            const ws=wb.Sheets[nombre];
            const csv=XLSX.utils.sheet_to_csv(ws,{blankrows:false});
            const formulas=XLSX.utils.sheet_to_formulae(ws);
            partes.push(`=== HOJA: ${nombre} ===\n${csv}${formulas.length?`\n\n[FÓRMULAS]\n${formulas.join('\n')}`:''}`);
        }
        return partes.join('\n\n');
    }

    async function elixExtraerTextoPDF(file){
        if(typeof pdfjsLib==='undefined') throw new Error('El lector PDF no está disponible.');
        try { pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'; } catch(_){}
        const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
        const paginas=[];
        for(let n=1;n<=pdf.numPages;n++){
            const page=await pdf.getPage(n);
            const content=await page.getTextContent();
            const texto=content.items.map(i=>String(i.str||'')).join(' ').replace(/\s+/g,' ').trim();
            paginas.push(`=== PÁGINA ${n} ===\n${texto || '[Sin texto extraíble]'}`);
        }
        return paginas.join('\n\n');
    }

    async function elixExtraerTextoLocal(file){
        const ext=elixExtension(file.name);
        if(ext==='docx') return await elixExtraerDOCX(file);
        if(ext==='pptx') return await elixExtraerPPTX(file);
        if(ext==='xlsx'||ext==='xls') return await elixExtraerExcel(file);
        if(ext==='pdf') return await elixExtraerTextoPDF(file);
        if(['txt','csv','md','json'].includes(ext) || String(file.type||'').startsWith('text/')) return await file.text();
        throw new Error(`Formato no soportado para extracción: ${file.name}`);
    }

    function elixPartirTexto(texto,maxChars=ELIX_TEXTO_CHUNK){
        const s=String(texto||'');
        if(!s) return [''];
        const partes=[];
        let pos=0;
        while(pos<s.length){
            let fin=Math.min(pos+maxChars,s.length);
            if(fin<s.length){
                const salto=s.lastIndexOf('\n',fin);
                if(salto>pos+Math.floor(maxChars*.6)) fin=salto;
            }
            partes.push(s.slice(pos,fin));
            pos=fin;
        }
        return partes;
    }

    async function elixLeerTextoConElix(file, bruto, solicitud){
        const partes=elixPartirTexto(bruto);
        const salidas=[];
        for(let i=0;i<partes.length;i++){
            setCargando(true,`📎 Elix AI leyendo ${file.name} (${i+1}/${partes.length})...`);
            const prompt=`Eres la capa documental de Elix AI. Convierte el fragmento siguiente en contexto fiel y estructurado para el motor principal.
NO resumas de forma destructiva: conserva cifras, nombres, fórmulas, tablas, encabezados, referencias, relaciones y detalles que puedan ser necesarios para la solicitud posterior.
No inventes ni corrijas silenciosamente. Si el fragmento ya está claro, conserva su información esencial de forma casi textual.
Archivo: ${file.name}
Fragmento: ${i+1} de ${partes.length}
Solicitud posterior del usuario: ${solicitud || 'Analizar el archivo adjunto.'}

CONTENIDO EXTRAÍDO:
${partes[i]}`;
            const r=await llamarElixMultimodal({
                contents:[{parts:[{text:prompt}]}],
                generationConfig:{temperature:0}
            }, `📎 Elix AI leyendo ${file.name}`);
            salidas.push(`[${file.name} · fragmento ${i+1}/${partes.length}]\n${r.text.trim() || partes[i]}`);
        }
        return salidas.join('\n\n');
    }

    async function elixExtraerImagenesOffice(file){
        const ext=elixExtension(file.name);
        if(!['docx','pptx','xlsx'].includes(ext) || typeof JSZip==='undefined') return [];
        try {
            const zip=await JSZip.loadAsync(await file.arrayBuffer());
            const rx = ext==='docx' ? /^word\/media\//i : ext==='pptx' ? /^ppt\/media\//i : /^xl\/media\//i;
            const nombres=Object.keys(zip.files).filter(n=>rx.test(n) && !zip.files[n].dir);
            const imagenes=[];
            for(const nombre of nombres){
                const e=elixExtension(nombre);
                if(!['png','jpg','jpeg','webp','gif','bmp'].includes(e)) continue;
                const blob=await zip.file(nombre)?.async('blob');
                if(!blob) continue;
                imagenes.push(new File([blob], `${file.name} · ${nombre.split('/').pop()}`, {type:elixMimePorExtension(nombre,'image/png')}));
            }
            return imagenes;
        } catch(_) {
            return [];
        }
    }

    async function elixLeerPDFGrande(file,solicitud){
        if(typeof pdfjsLib==='undefined') return await elixLeerTextoConElix(file, await elixExtraerTextoPDF(file), solicitud);
        try { pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'; } catch(_){}
        const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
        const salidas=[];
        for(let n=1;n<=pdf.numPages;n++){
            setCargando(true,`📕 Elix AI leyendo ${file.name} · página ${n}/${pdf.numPages}...`);
            const page=await pdf.getPage(n);
            const viewport=page.getViewport({scale:1.35});
            const canvas=document.createElement('canvas');
            canvas.width=Math.max(1,Math.ceil(viewport.width));
            canvas.height=Math.max(1,Math.ceil(viewport.height));
            const ctx=canvas.getContext('2d',{alpha:false});
            ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
            await page.render({canvasContext:ctx,viewport}).promise;
            const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.84));
            const content=await page.getTextContent();
            const texto=content.items.map(i=>String(i.str||'')).join(' ').replace(/\s+/g,' ').trim();
            const inline=await elixBlobAInlineData(blob || new Blob(),`${file.name}-p${n}.jpg`);
            const prompt=`Eres la capa de lectura PDF de Elix AI. Esta es la página ${n} de ${pdf.numPages} del archivo ${file.name}.
Lee la página VISUALMENTE y utiliza también el texto extraído como apoyo. Conserva texto, tablas, ecuaciones, gráficos, diagramas, pies de figura, unidades y datos relevantes. No inventes y no resuelvas aún la solicitud final.
Solicitud posterior: ${solicitud || 'Analizar el PDF adjunto.'}
Texto extraído automáticamente (puede estar incompleto): ${texto || '[sin texto extraíble]'}`;
            const r=await llamarElixMultimodal({
                contents:[{parts:[{text:prompt},{inlineData:inline}]}],
                generationConfig:{temperature:0}
            }, `📕 Elix AI leyendo ${file.name}`);
            salidas.push(`=== ${file.name} · PÁGINA ${n}/${pdf.numPages} ===\n${r.text.trim()}`);
        }
        return salidas.join('\n\n');
    }

    async function elixProcesarArchivo(file, solicitud){
        const ext=elixExtension(file.name);
        const esImagen=String(file.type||'').startsWith('image/') || ['png','jpg','jpeg','webp','gif','bmp'].includes(ext);
        if(esImagen) return await elixLeerImagen(file,solicitud);

        if(ext==='pdf' || file.type==='application/pdf'){
            if(file.size <= ELIX_INLINE_MAX_BYTES){
                setCargando(true,`📕 Elix AI leyendo ${file.name}...`);
                const inline=await elixBlobAInlineData(file,file.name);
                const prompt=`Eres la capa de lectura PDF de Elix AI. Lee el documento COMPLETO de forma visual y textual.
Entrega contexto fiel para responder después la solicitud del usuario. Conserva texto, tablas, ecuaciones, figuras, diagramas, unidades, referencias y datos necesarios; no inventes y no resuelvas todavía la solicitud final.
Archivo: ${file.name}
Solicitud posterior: ${solicitud || 'Analizar el PDF adjunto.'}`;
                const r=await llamarElixMultimodal({
                    contents:[{parts:[{text:prompt},{inlineData:inline}]}],
                    generationConfig:{temperature:0}
                }, `📕 Elix AI leyendo ${file.name}`);
                return r.text.trim();
            }
            return await elixLeerPDFGrande(file,solicitud);
        }

        const bruto=await elixExtraerTextoLocal(file);
        if(!String(bruto||'').trim()) throw new Error(`${file.name} no contiene contenido extraíble.`);
        const textoProcesado=await elixLeerTextoConElix(file,bruto,solicitud);

        const imagenes=await elixExtraerImagenesOffice(file);
        if(!imagenes.length) return textoProcesado;
        const visuales=[];
        for(let i=0;i<imagenes.length;i++){
            setCargando(true,`🖼️ Elix AI leyendo elementos visuales de ${file.name} (${i+1}/${imagenes.length})...`);
            const lectura=await elixLeerImagen(imagenes[i],solicitud,`elemento visual ${i+1}/${imagenes.length} de ${file.name}`);
            visuales.push(`[ELEMENTO VISUAL ${i+1}/${imagenes.length}]\n${lectura}`);
        }
        return `${textoProcesado}\n\n=== ELEMENTOS VISUALES DEL ARCHIVO ===\n${visuales.join('\n\n')}`;
    }

    async function elixProcesarAdjuntos(files,solicitud){
        const resultados=[];
        for(let i=0;i<files.length;i++){
            const file=files[i];
            setCargando(true,`📎 Elix AI preparando ${file.name} (${i+1}/${files.length})...`);
            const salida=await elixProcesarArchivo(file,solicitud);
            resultados.push(`===== ARCHIVO ${i+1}/${files.length}: ${file.name} =====\n${salida}`);
        }
        return resultados.join('\n\n');
    }

    // Se acopla al envío existente. Sin adjuntos, el flujo original queda intacto.
    // Groq SOLO enruta solicitudes de exportación; nunca redacta el contenido académico.
    const elixEnviarMensajeExistente = window.enviarMensaje;

    function elixUltimaRespuestaNueva(chat, desdeIndice){
        if(!chat) return null;
        const nuevos=(chat.messages||[]).map((m,index)=>({m,index})).slice(Math.max(0,desdeIndice||0));
        return [...nuevos].reverse().find(x=>x.m?.role==='assistant' && !x.m?.isError && String(x.m?.content||'').trim()) || null;
    }

    async function elixEjecutarExportacionExistente(det, ordenVisible){
        const resuelto=elixResolverChatExportacion(det);
        if(!resuelto.found || !resuelto.chat){
            agregarMensajeUI('user',ordenVisible,null,[]);
            agregarMensajeUI('assistant','No encontré con suficiente seguridad el chat que quieres exportar. Escribe una parte más clara del nombre o del tema.',null,[]);
            return;
        }

        const paquete=await elixResolverPaqueteExportacion(det,resuelto.chat,ordenVisible);
        if(!paquete?.mensajes?.length){
            agregarMensajeUI('user',ordenVisible,null,[]);
            agregarMensajeUI('assistant','No pude identificar con suficiente seguridad la parte exacta que quieres exportar. Indica el tema, la última respuesta o pide el chat completo.',null,[]);
            return;
        }

        const input=document.getElementById('user-input');
        if(input){ input.value=''; input.style.height='auto'; }
        agregarMensajeUI('user',ordenVisible,null,[]);
        const nombreFormato=det.format==='docx' ? 'Word' : 'PDF';
        agregarMensajeUI('assistant',`Preparando tu ${nombreFormato}. En breve comenzará la descarga.`,null,[]);
        try{
            setCargando(true,`📄 Elix AI preparando ${nombreFormato}...`);
            await window.elixExportarDocumento('chat',det.format,resuelto.chat.id,paquete.mensajes,paquete.titulo,{presentation:paquete.presentation});
        }catch(error){
            console.error('Elix AI · exportación directa:',error);
            agregarMensajeUI('assistant',`No se pudo preparar el ${nombreFormato}. Inténtalo nuevamente.`,null,[]);
        }finally{
            setCargando(false);
        }
    }

    async function elixGenerarYExportar(det, ordenVisible){
        const input=document.getElementById('user-input');
        const clean=String(det?.clean_prompt||'').trim();
        if(!clean){
            agregarMensajeUI('assistant','No pude identificar qué contenido quieres generar antes de exportarlo. Escribe nuevamente la solicitud.',null,[]);
            return;
        }

        const chatAntes=obtenerChatActual();
        const indiceAntes=(chatAntes?.messages||[]).length;
        window.ELIX_PROMPT_MODELO_LIMPIO=clean;

        try{
            // Los adjuntos se interpretan con la tarea limpia; nunca con la instrucción de Word/PDF.
            if(elixAdjuntosPendientes.length){
                const snapshot=[...elixAdjuntosPendientes];
                const metadata=snapshot.map(f=>({name:f.name,size:f.size,type:f.type||'',lastModified:f.lastModified||0}));
                elixMiniProcesando=true;
                setCargando(true,'📎 Elix AI preparando archivos...');
                const contexto=await elixProcesarAdjuntos(snapshot,clean);
                window.ELIX_CONTEXT_ARCHIVOS_PENDIENTE=contexto;
                window.ELIX_ADJUNTOS_EN_ENVIO=metadata;
                elixLimpiarAdjuntosPendientes();
                elixMiniProcesando=false;
                setCargando(false);
            }

            // El usuario ve su orden completa; el núcleo recibe solo clean_prompt.
            if(input){ input.value=ordenVisible; }
            await elixEnviarMensajeExistente();

            const chatDespues=obtenerChatActual();
            const nueva=elixUltimaRespuestaNueva(chatDespues,indiceAntes);
            if(!nueva) return; // No exportar si el modelo falló o fue detenido.

            const nombreFormato=det.format==='docx' ? 'Word' : 'PDF';
            const scope=String(det.export_scope||'generated_answer');
            let mensajesExportar=[];
            let presentation='answer';
            let titulo=(chatDespues?.title || 'Respuesta de Elix AI').replace(/\.\.\.$/,'');

            if(scope==='full_chat'){
                mensajesExportar=elixMensajesVisibles(chatDespues).map(x=>x.m);
                presentation='chat';
            }else{
                // Comportamiento profesional por defecto: exportar solo el contenido recién generado.
                mensajesExportar=[nueva.m];
                presentation='answer';
                titulo=elixTituloDesdePrompt(clean) || titulo;
            }

            agregarMensajeUI('assistant',`Contenido terminado. Preparando tu ${nombreFormato}...`,null,[]);
            setCargando(true,`📄 Elix AI preparando ${nombreFormato}...`);
            await window.elixExportarDocumento('chat',det.format,chatDespues?.id || currentChatId,mensajesExportar,titulo,{presentation});
        }catch(error){
            if(error?.name==='AbortError') throw error;
            console.error('Elix AI · generar y exportar:',error);
            agregarMensajeUI('assistant','No se pudo completar la generación y exportación. Inténtalo nuevamente.',null,[]);
        }finally{
            window.ELIX_PROMPT_MODELO_LIMPIO='';
            window.ELIX_CONTEXT_ARCHIVOS_PENDIENTE='';
            window.ELIX_ADJUNTOS_EN_ENVIO=[];
            elixMiniProcesando=false;
            setCargando(false);
            if(input && input.value===ordenVisible){ input.value=''; input.style.height='auto'; }
        }
    }

    /* =========================================================
       C) GENERACIÓN DE IMÁGENES — ELIX AI IMAGES (MUSE)
       ========================================================= */
    function elixNormalizarImagenTexto(s=''){
        return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
    }

    function elixPareceSolicitudImagen(texto, tieneAdjuntos=false){
        const t=elixNormalizarImagenTexto(texto);
        if(!t) return false;
        if(/(analiza|describe|interpreta|explica|resume|resuelve|lee|extrae|que dice)/.test(t)
            && /(imagen|foto|captura|adjunt)/.test(t)
            && !/(crea|crear|genera|generar|haz|hacer|disena|diseña|dibuja|ilustra|renderiza|poster|infografia|diagrama)/.test(t)) {
            return false;
        }
        const objeto = /(imagen|infografia|poster|póster|ilustracion|ilustración|render|dibujo|diagrama|esquema|banner|portada|afiche|foto|fotografia|fotografía|wallpaper|thumbnail|miniatura|meme)/.test(t);
        const accion = /(crea|crear|genera|generar|haz|hacer|disena|diseña|dibuja|ilustra|renderiza|produce|elabora|arma|prepara)/.test(t);
        if(/^(imagen|infografia|poster|diagrama|ilustracion|render|dibujo)/.test(t)) return true;
        if(objeto && accion) return true;
        if(/(genera|crea|haz).{0,26}(de eso|de esto|basad[oa] en|a partir de|con base en)/.test(t) && objeto) return true;
        return false;
    }

    function elixResolverTamanoImagen(texto=''){
        const t=elixNormalizarImagenTexto(texto);
        if(/(9:16|vertical|portrait|retrato|story|historia|infografia|poster|afiche)/.test(t)) return { width:1024, height:1536 };
        if(/(16:9|21:9|horizontal|landscape|banner|panoram|cabecera|header)/.test(t)) return { width:1536, height:1024 };
        if(/(4:3)/.test(t)) return { width:1365, height:1024 };
        if(/(3:4)/.test(t)) return { width:1024, height:1365 };
        return { width:1024, height:1024 };
    }

    function elixResumenContextoImagen(chat, limite=6){
        const visibles=elixMensajesVisibles(chat).slice(-limite);
        return visibles.map(x=>`${x.m.role==='user'?'Usuario':'Elix AI'}: ${elixContenidoVisibleMensaje(x.m).replace(/\s+/g,' ').slice(0,1400)}`).join('\n');
    }

    function elixSolicitudApuntaAlContexto(texto=''){
        return /(eso|esto|anterior|arriba|chat|conversacion|conversación|lo de arriba|última respuesta|ultima respuesta|basad[oa] en el chat|a partir del chat|de lo anterior)/i.test(String(texto||''));
    }

    function elixConstruirPromptImagen(chat, solicitud, contextoArchivos=''){
        const pedido=String(solicitud||'').trim();
        const piezas=[];
        piezas.push('Crea una sola imagen final de alta calidad, bien compuesta y visualmente profesional. Debe respetar fielmente la intención del usuario.');
        piezas.push('Evita marcas de agua, artefactos visuales, manos deformes, bordes innecesarios y texto ilegible.');
        const norm=elixNormalizarImagenTexto(pedido);
        if(/infografia/.test(norm)) piezas.push('Diseña una infografía científica clara y atractiva, con jerarquía visual limpia, secciones bien definidas, iconografía pertinente y texto en español grande y legible.');
        else if(/diagrama|esquema/.test(norm)) piezas.push('Diseña un diagrama o esquema técnico claro, bien etiquetado en español, con relaciones visuales nítidas y organización ordenada.');
        else if(/poster|póster|afiche|portada|banner/.test(norm)) piezas.push('Diseña una pieza gráfica de aspecto profesional, con composición fuerte, tipografía legible y alto impacto visual.');
        else if(/foto|fotografia|fotografía|realista|realismo/.test(norm)) piezas.push('El resultado debe verse realista y de alta definición, con iluminación cuidada y detalle fino.');
        else piezas.push('El resultado debe verse pulido, detallado, con composición clara y buena legibilidad visual.');
        if(contextoArchivos) piezas.push(`Usa además este contexto de archivos o imágenes adjuntas como base conceptual:
${String(contextoArchivos).slice(0,12000)}`);
        if(elixSolicitudApuntaAlContexto(pedido) || pedido.length < 180){
            const contextoChat=elixResumenContextoImagen(chat, 6);
            if(contextoChat) piezas.push(`Contexto reciente del chat que debes usar como referencia:
${contextoChat}`);
        }
        piezas.push(`Solicitud exacta del usuario: ${pedido}`);
        piezas.push('Mantén el idioma español cuando el usuario pida texto dentro de la imagen.');
        return piezas.join('\n\n');
    }

    async function elixCompactarDataUrlGenerada(dataUrl){
        try{
            if(!String(dataUrl||'').startsWith('data:image/')) return String(dataUrl||'');
            const img=await new Promise((resolve,reject)=>{
                const el=new Image();
                el.onload=()=>resolve(el);
                el.onerror=()=>reject(new Error('No se pudo cargar la imagen generada.'));
                el.src=dataUrl;
            });
            let w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
            const max=1600;
            if(Math.max(w,h)>max){ const s=max/Math.max(w,h); w=Math.max(1,Math.round(w*s)); h=Math.max(1,Math.round(h*s)); }
            const canvas=document.createElement('canvas');
            canvas.width=w; canvas.height=h;
            const ctx=canvas.getContext('2d');
            if(!ctx) return dataUrl;
            ctx.drawImage(img,0,0,w,h);
            const out=canvas.toDataURL('image/jpeg',0.9);
            return out.length < String(dataUrl).length ? out : dataUrl;
        }catch(_){ return dataUrl; }
    }

    async function elixGenerarImagenChat(ordenVisible, contextoArchivos='', adjuntosMeta=[]){
        const chatActual=obtenerChatActual();
        const inputField=document.getElementById('user-input');
        const orden=String(ordenVisible||'').trim();
        if(!orden) return;
        if(inputField){ inputField.value=''; inputField.style.height='auto'; }
        agregarMensajeUI('user',orden,null,adjuntosMeta,null);
        if (chatActual.messages.length === 0) {
            chatActual.title = orden.substring(0, 25) + '...';
            renderizarListaChats();
        }
        const promptImagen=elixConstruirPromptImagen(chatActual, orden, contextoArchivos);
        const size=elixResolverTamanoImagen(orden);
        chatActual.messages.push({ role:'user', content:`[SOLICITUD DE IMAGEN ELIX AI]
${promptImagen}`, displayContent:orden, attachments:adjuntosMeta });
        guardarEnLocal();
        try{
            setCargando(true,'🎨 Elix AI preparando la imagen...');
            const data=await elixBackground('elix-image', {
                prompt:promptImagen,
                original_request:orden,
                width:size.width,
                height:size.height
            }, { etiqueta:'🎨 Elix AI generando imagen', maxWaitMs: 14*60*1000 });
            let dataUrl='';
            const mime=String(data?.mime_type||'image/png');
            if(data?.image_base64) dataUrl=`data:${mime};base64,${data.image_base64}`;
            else if(data?.data_url) dataUrl=String(data.data_url||'');
            if(!dataUrl) throw new Error('Elix AI no devolvió una imagen utilizable.');
            dataUrl = await elixCompactarDataUrlGenerada(dataUrl);
            const nombreBase=(orden || 'imagen-elix').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60) || 'imagen-elix';
            const ext=mime.includes('jpeg') ? 'jpg' : (mime.includes('webp') ? 'webp' : 'png');
            const msgText=/infografia|infografía/i.test(orden) ? 'Aquí tienes la imagen solicitada. He preparado la composición para que sea clara y visualmente sólida.' : 'Aquí tienes la imagen solicitada.';
            const generatedImage={ dataUrl, mimeType:mime, width:Number(data?.width)||size.width, height:Number(data?.height)||size.height, prompt:orden, alt:orden, filename:`${nombreBase}.${ext}` };
            const assistantMsg={ role:'assistant', content:msgText, reasoning:null, generatedImage };
            chatActual.messages.push(assistantMsg);
            guardarEnLocal();
            agregarMensajeUI('assistant', msgText, null, [], generatedImage);
        }catch(error){
            console.error('Elix AI no pudo generar la imagen:', error);
            const detalle=String(error?.message || error)
                .replace(/Meta|Hugging ?Face|Groq|DeepSeek|Gemini|Tavily|Netlify/gi,'Elix AI')
                .replace(/facebook\/muse[\w.-]*/gi,'Elix AI Images');
            const mensaje=`⚠️ Elix AI no pudo generar la imagen: ${detalle}`;
            chatActual.messages.push({ role:'assistant', content:mensaje, reasoning:null, isError:true });
            guardarEnLocal();
            agregarMensajeUI('assistant', mensaje);
        }finally{
            setCargando(false);
        }
    }

    window.enviarMensaje = async function(){
        if(elixMiniProcesando) return;

        const input=document.getElementById('user-input');
        const ordenDirecta=(input?.value || '').trim();
        const decision=(ordenDirecta && typeof window.elixDetectarSolicitudExportacionInteligente==='function')
            ? await window.elixDetectarSolicitudExportacionInteligente(ordenDirecta)
            : null;

        if(decision?.intent==='export_current' || decision?.intent==='export_named'){
            return await elixEjecutarExportacionExistente(decision,ordenDirecta);
        }

        if(decision?.intent==='generate_then_export'){
            return await elixGenerarYExportar(decision,ordenDirecta);
        }

        const esImagen = ordenDirecta ? elixPareceSolicitudImagen(ordenDirecta, elixAdjuntosPendientes.length > 0) : false;
        if(esImagen && !elixAdjuntosPendientes.length){
            return await elixGenerarImagenChat(ordenDirecta,'',[]);
        }

        if(!elixAdjuntosPendientes.length) return await elixEnviarMensajeExistente();

        const solicitud=ordenDirecta || 'Analiza los archivos adjuntos.';
        const snapshot=[...elixAdjuntosPendientes];
        const metadata=snapshot.map(f=>({name:f.name,size:f.size,type:f.type||'',lastModified:f.lastModified||0}));

        elixMiniProcesando=true;
        try{
            setCargando(true,'📎 Elix AI preparando archivos...');
            const contexto=await elixProcesarAdjuntos(snapshot,solicitud);
            elixLimpiarAdjuntosPendientes();
            elixMiniProcesando=false;
            setCargando(false);

            if(esImagen){
                return await elixGenerarImagenChat(solicitud, contexto, metadata);
            }

            window.ELIX_CONTEXT_ARCHIVOS_PENDIENTE=contexto;
            window.ELIX_ADJUNTOS_EN_ENVIO=metadata;
            if(input && !input.value.trim()) input.value=solicitud;
            return await elixEnviarMensajeExistente();
        } catch(error){
            console.error('Elix AI no pudo procesar los adjuntos:',error);
            setCargando(false);
            const detalle=String(error?.message || error)
                .replace(/Gemini|DeepSeek|Groq|Tavily|Netlify|Meta|Hugging ?Face/gi,'Elix AI')
                .replace(/gemini-[\w.-]+/gi,'Elix AI')
                .replace(/facebook\/muse[\w.-]*/gi,'Elix AI Images');
            alert(`No se pudieron procesar los adjuntos con Elix AI.

${detalle}`);
        } finally {
            elixMiniProcesando=false;
            window.ELIX_CONTEXT_ARCHIVOS_PENDIENTE='';
            window.ELIX_ADJUNTOS_EN_ENVIO=[];
        }
    };

    elixCrearBandejaAdjuntos();

    /* =========================================================
       B) ROUTER DE EXPORTACIÓN POR ORDEN DE TEXTO — WORD / PDF
       Groq interpreta la intención; Elix ejecuta la orden localmente.
       ========================================================= */
    function elixNombreSeguro(s){
        return String(s||'Elix-AI')
            .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
            .replace(/[^a-zA-Z0-9._-]+/g,'-')
            .replace(/^-+|-+$/g,'').slice(0,70) || 'Elix-AI';
    }

    function elixTituloDesdePrompt(s=''){
        const limpio=String(s||'').replace(/\s+/g,' ').trim();
        if(!limpio) return 'Respuesta de Elix AI';
        return limpio.slice(0,74).replace(/[.!?,:;\-]+$/,'').trim() || 'Respuesta de Elix AI';
    }

    function elixObtenerChatExportable(chatId=null){
        const id=String(chatId||currentChatId||'');
        return chats.find(c=>String(c.id)===id) || obtenerChatActual();
    }

    function elixContenidoVisibleMensaje(m){
        return m?.role==='user' ? String(m.displayContent || m.content || '') : String(m?.content || '');
    }

    function elixMensajesVisibles(chat){
        return (chat?.messages||[]).map((m,index)=>({m,index})).filter(x=>x.m?.role==='user'||x.m?.role==='assistant');
    }

    function elixMensajesExportables(scope='chat',chatId=null){
        return elixMensajesVisibles(elixObtenerChatExportable(chatId)).map(x=>x.m);
    }

    function elixNormalizarExportacion(s=''){
        return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    }

    function elixDistancia(a='',b=''){
        a=String(a); b=String(b);
        const dp=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
        for(let i=0;i<=a.length;i++) dp[i][0]=i;
        for(let j=0;j<=b.length;j++) dp[0][j]=j;
        for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++)
            dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
        return dp[a.length][b.length];
    }

    function elixFormatoExportacionLocal(texto){
        const n=elixNormalizarExportacion(texto);
        const tokens=n.split(/\s+/).filter(Boolean);

        // IMPORTANTE: no usar distancia de Levenshtein sobre cualquier palabra del prompt.
        // Palabras normales como "por" podían parecerse artificialmente a "pdf" y activar
        // el router de exportación en consultas académicas que no pedían ningún archivo.
        const pdfAliases=new Set(['pdf','pfd','pdff']);
        const wordAliases=new Set([
            'word','docx','doc','dox','dovx','dcx','dcox','doxc','doxx','docc','docs',
            'wrd','wodr','wrod','worrd'
        ]);

        if(tokens.some(t=>pdfAliases.has(t))) return 'pdf';
        if(tokens.some(t=>wordAliases.has(t))) return 'docx';
        return null;
    }

    function elixPareceOrdenExportacion(texto){
        const n=elixNormalizarExportacion(texto);
        if(!n) return false;

        const format=elixFormatoExportacionLocal(texto);
        const accionFuerte=/\b(exporta|exportar|convierte|convertir|transforma|transformar|descarga|descargar|guardame|guardar|guarda)\b/.test(n);
        const accionEntrega=/\b(hazme|dame|damelo|entregame|pasame|devuelveme|mandame|preparame|generame|creame|quiero|necesito)\b/.test(n);
        const objetoExistente=/\b(chat|conversacion|historial|respuesta|mensaje|parte|fragmento|seccion|seleccion|lo anterior|eso)\b/.test(n);

        // Verbos inequívocos de exportación + referencia a chat/documento: consultar al router
        // aunque el usuario haya escrito muy mal el formato.
        if(accionFuerte && objetoExistente) return true;

        // Si reconocemos un formato, exigimos además intención real de entrega/exportación.
        // Así "analiza este PDF" o "qué es Word" siguen siendo preguntas normales.
        if(format && (accionFuerte || accionEntrega || objetoExistente)) return true;

        // Formas breves naturales sin verbo explícito: "chat en Word", "la última respuesta en docx".
        if(format && /\b(chat|conversacion|historial|ultima respuesta|ultimo mensaje|parte|fragmento|seccion)\b/.test(n)) return true;

        return false;
    }

    function elixTituloObjetivoLocal(texto){
        const n=elixNormalizarExportacion(texto);
        const formato='(?:word|docx|dox|dovx|dcx|wrd|wodr|wrod|doc|pdf|pfd)';
        const rx=new RegExp('(?:chat|conversacion|historial)\\s+(?:de|sobre|llamado|llamada|titulado|titulada)\\s+(.+?)(?:\\s+(?:a|en|como)\\s+(?:formato\\s+)?'+formato+'\\b|$)','i');
        const m=n.match(rx);
        if(!m) return null;
        let q=String(m[1]||'').trim();
        q=q.replace(/\b(todo|toda|el|la|un|una|chat|conversacion|historial|completo|completa|entero|entera|actual|este|esta)\b/g,' ').replace(/\s+/g,' ').trim();
        return q.length>=3 ? q : null;
    }

    function elixLimpiarPromptExportacionLocal(texto){
        let s=String(texto||'').trim();
        s=s.replace(/\s+(?:(?:y\s+(?:luego|despues|después|al\s+final))|y|,)?\s*(?:por\s+favor\s+)?(?:hazme|haz|dame|damelo|dámelo|entregame|entrégame|entregamelo|entrégamelo|pasame|pásame|pasamelo|pásamelo|devuelveme|devuélveme|devuelvemelo|devuélvemelo|mandame|mándame|mandamelo|mándamelo|genera|crea|prepara|exporta|convierte|transforma|guardame|guárdame|guardamelo|guárdamelo|descargame|descárgame|descargamelo|descárgamelo)\s+(?:esto\s+|eso\s+|lo\s+)?(?:en|a|como)?\s*(?:un\s+|una\s+|formato\s+)?(?:word|docx|dox|dovx|dcx|wrd|wodr|wrod|doc|pdf|pfd)(?:\s+(?:de|con)\s+(?:esto|eso|lo anterior))?[.!?\s]*$/i,'').trim();
        const inicial=s.match(/^(?:hazme|haz|dame|quiero|necesito|genera|crea|prepara)\s+(?:un\s+|una\s+)?(?:word|docx|dox|dovx|doc|pdf)\s+(?:sobre|de)\s+(.+)$/i);
        if(inicial) s=`Desarrolla ${inicial[1].trim()}`;
        return s;
    }

    function elixScopeLocal(texto){
        const n=elixNormalizarExportacion(texto);
        if(/(ultima|ultimo)\s+(respuesta|mensaje)|solo\s+(tu|la)\s+(respuesta|explicacion)\s+(anterior|ultima)|\b(eso|lo anterior)\b/.test(n)) return 'last_answer';
        if(/solo\s+(la\s+)?parte|parte\s+(donde|en que|sobre)|desde\s+.+\s+hasta|solo\s+(lo|las|los)\s+.+\s+sobre|fragmento|seccion/.test(n)) return 'selection';
        return 'full_chat';
    }

    function elixClasificarExportacionLocal(texto){
        const format=elixFormatoExportacionLocal(texto);
        if(!format) return null;
        const n=elixNormalizarExportacion(texto);
        const hayAccion=/(dame|entrega|export|genera|crea|descarg|guarda|haz|prepara|pasa|convierte|convert|transform|devuel|manda|quiero|necesito)/.test(n);
        const hayChat=/(chat|conversacion|historial)/.test(n);
        if(!hayAccion && !hayChat) return null;

        const objetivo=elixTituloObjetivoLocal(texto);
        const scope=elixScopeLocal(texto);
        const clean=elixLimpiarPromptExportacionLocal(texto);
        const referenciaExistente=/(todo\s+el\s+chat|este\s+chat|chat\s+actual|la\s+conversacion|esta\s+conversacion|todo\s+el\s+historial|historial\s+actual|todo\s+lo\s+anterior|lo\s+anterior|ultima\s+respuesta|solo\s+la\s+parte)/.test(n);
        const palabras=n.split(/\s+/).filter(Boolean);
        const contenido=palabras.filter(w=>!/(hazme|haz|dame|entrega|exporta|exportar|convierte|convertir|transforma|transformar|descarga|descargar|prepara|word|docx|dox|dovx|doc|pdf|pfd|chat|conversacion|historial|todo|este|esta|actual|en|a|un|una|de|lo|por|favor)/.test(w));

        if(objetivo){
            return {intent:'export_named',format,export_scope:scope,target:'named',target_title:objetivo,chat_id:null,clean_prompt:null,selection_query:scope==='selection'?texto:null,source:'local-fallback'};
        }
        // Si al quitar la cláusula de exportación queda una tarea sustantiva, primero se genera el contenido.
        if(!referenciaExistente && clean && clean!==String(texto||'').trim()){
            return {intent:'generate_then_export',format,export_scope:'generated_answer',target:'current',target_title:null,chat_id:null,clean_prompt:clean,selection_query:null,source:'local-fallback'};
        }
        if(referenciaExistente || !clean || clean===String(texto||'').trim() || contenido.length<=1){
            return {intent:'export_current',format,export_scope:scope,target:'current',target_title:null,chat_id:null,clean_prompt:null,selection_query:scope==='selection'?texto:null,source:'local-fallback'};
        }
        return {intent:'generate_then_export',format,export_scope:'generated_answer',target:'current',target_title:null,chat_id:null,clean_prompt:clean||String(texto||'').trim(),selection_query:null,source:'local-fallback'};
    }

    function elixVistaPreviaChat(chat){
        const visibles=elixMensajesVisibles(chat);
        if(!visibles.length) return '';
        const muestras=[];
        for(const x of visibles.slice(0,2)) muestras.push(elixContenidoVisibleMensaje(x.m));
        for(const x of visibles.slice(-2)) muestras.push(elixContenidoVisibleMensaje(x.m));
        return muestras.join(' | ').replace(/\s+/g,' ').slice(0,620);
    }

    function elixSimilitudTitulo(a,b){
        const na=elixNormalizarExportacion(a), nb=elixNormalizarExportacion(b);
        if(!na||!nb) return 0;
        if(na===nb) return 1;
        if(na.includes(nb)||nb.includes(na)) return .92;
        const A=new Set(na.split(' ').filter(x=>x.length>2));
        const B=new Set(nb.split(' ').filter(x=>x.length>2));
        let inter=0; for(const x of A) if(B.has(x)) inter++;
        const union=new Set([...A,...B]).size||1;
        const jac=inter/union;
        const d=elixDistancia(na,nb), lev=1-(d/Math.max(na.length,nb.length,1));
        return Math.max(jac,lev*.85);
    }

    function elixResolverChatExportacion(det){
        if(!det || det.target!=='named') return {chat:elixObtenerChatExportable(currentChatId),found:true};
        if(det.chat_id){
            const byId=chats.find(c=>String(c.id)===String(det.chat_id));
            if(byId) return {chat:byId,found:true};
        }
        const q=String(det.target_title||'').trim();
        if(!q) return {chat:null,found:false};
        let best=null,bestScore=0;
        for(const c of chats){
            const score=Math.max(elixSimilitudTitulo(q,c.title||''), elixSimilitudTitulo(q,elixVistaPreviaChat(c))*.78);
            if(score>bestScore){bestScore=score;best=c;}
        }
        return best && bestScore>=.44 ? {chat:best,found:true} : {chat:null,found:false};
    }

    function elixNormalizarDecisionRouter(d,texto){
        if(!d || typeof d!=='object') return null;
        const allowedIntent=new Set(['export_current','export_named','generate_then_export','none']);
        const allowedScope=new Set(['full_chat','last_answer','selection','generated_answer']);
        const intent=allowedIntent.has(String(d.intent||'')) ? String(d.intent) : 'none';
        if(intent==='none') return null;
        const format=String(d.format||'').toLowerCase()==='pdf' ? 'pdf' : 'docx';
        const export_scope=allowedScope.has(String(d.export_scope||'')) ? String(d.export_scope) : (intent==='generate_then_export'?'generated_answer':'full_chat');
        const clean=String(d.clean_prompt||'').trim();
        return {
            intent, format, export_scope,
            target:intent==='export_named'?'named':'current',
            target_title:String(d.target_title||'').trim()||null,
            chat_id:d.chat_id||null,
            clean_prompt:intent==='generate_then_export' ? (clean || elixLimpiarPromptExportacionLocal(texto)) : null,
            selection_query:String(d.selection_query||'').trim()||null,
            source:String(d.source||'groq')
        };
    }

    async function elixConsultarRouterGroq(texto){
        try{
            const payload={
                mode:'classify',
                text:String(texto||''),
                current_chat_id:String(currentChatId||''),
                current_chat_title:String(obtenerChatActual()?.title||''),
                chats:(chats||[]).slice(0,80).map(c=>({id:String(c.id),title:String(c.title||''),preview:elixVistaPreviaChat(c)}))
            };
            const r=await elixBackend('elix-export-router',payload);
            if(!r?.ok || !r?.decision) return null;
            return elixNormalizarDecisionRouter({...r.decision,source:'groq'},texto);
        }catch(e){
            console.warn('Elix AI usó clasificación local de exportación.',e);
            return null;
        }
    }

    async function elixConsultarSeleccionGroq(det,chat,ordenVisible){
        try{
            const payload={
                mode:'select_messages',
                text:String(ordenVisible||''),
                selection_query:String(det?.selection_query||ordenVisible||''),
                chat:{
                    id:String(chat?.id||''),
                    title:String(chat?.title||''),
                    messages:elixMensajesVisibles(chat).slice(0,160).map(x=>({index:x.index,role:x.m.role,text:elixContenidoVisibleMensaje(x.m).slice(0,4000)}))
                }
            };
            const r=await elixBackend('elix-export-router',payload);
            const idx=Array.isArray(r?.selection?.message_indices) ? r.selection.message_indices.map(Number).filter(Number.isInteger) : [];
            return [...new Set(idx)].sort((a,b)=>a-b);
        }catch(e){
            console.warn('Elix AI usó selección local de fragmentos.',e);
            return [];
        }
    }

    function elixSeleccionLocal(chat,query,ordenVisible=''){
        const visibles=elixMensajesVisibles(chat);
        const q=elixNormalizarExportacion(query||ordenVisible);
        const stop=new Set(['solo','parte','donde','cuando','sobre','desde','hasta','chat','conversacion','word','docx','dox','dovx','pdf','exporta','convierte','transforma','dame','pasame','respuesta','explicacion','mensaje','los','las','del','una','uno','que','con','por','para','este','esta','eso']);
        const terms=q.split(/\s+/).filter(x=>x.length>2&&!stop.has(x));
        if(!terms.length) return [];
        const soloAssistant=/(solo\s+(tu|la)\s+(respuesta|explicacion)|solo\s+elix)/.test(q);
        const scored=[];
        for(const x of visibles){
            if(soloAssistant && x.m.role!=='assistant') continue;
            const t=elixNormalizarExportacion(elixContenidoVisibleMensaje(x.m));
            if(!t) continue;
            let hits=0; for(const term of terms) if(t.includes(term)) hits++;
            const score=hits/terms.length;
            if(score>0) scored.push({x,score});
        }
        if(!scored.length) return [];
        const best=Math.max(...scored.map(s=>s.score));
        if(best<.34) return [];
        const selected=new Set(scored.filter(s=>s.score>=Math.max(.34,best*.72)).map(s=>s.x.index));
        if(!soloAssistant){
            for(const idx of [...selected]){
                const pos=visibles.findIndex(v=>v.index===idx);
                const cur=visibles[pos];
                if(cur?.m.role==='assistant' && pos>0 && visibles[pos-1].m.role==='user') selected.add(visibles[pos-1].index);
                if(cur?.m.role==='user' && pos+1<visibles.length && visibles[pos+1].m.role==='assistant') selected.add(visibles[pos+1].index);
            }
        }
        return [...selected].sort((a,b)=>a-b);
    }

    async function elixResolverPaqueteExportacion(det,chat,ordenVisible){
        const visibles=elixMensajesVisibles(chat);
        if(!visibles.length) return {mensajes:[],titulo:chat?.title||'Elix AI',presentation:'chat'};
        const scope=String(det?.export_scope||'full_chat');
        if(scope==='last_answer'){
            const last=[...visibles].reverse().find(x=>x.m.role==='assistant' && !x.m.isError && String(x.m.content||'').trim());
            return {mensajes:last?[last.m]:[],titulo:`${chat?.title||'Elix AI'} — última respuesta`,presentation:'answer'};
        }
        if(scope==='selection'){
            let indices=await elixConsultarSeleccionGroq(det,chat,ordenVisible);
            if(!indices.length) indices=elixSeleccionLocal(chat,det?.selection_query||ordenVisible,ordenVisible);
            const set=new Set(indices.map(Number));
            const mensajes=visibles.filter(x=>set.has(x.index)).map(x=>x.m);
            return {mensajes,titulo:`${chat?.title||'Elix AI'} — selección`,presentation:mensajes.length===1&&mensajes[0]?.role==='assistant'?'answer':'chat'};
        }
        return {mensajes:visibles.map(x=>x.m),titulo:chat?.title||'Conversación Elix AI',presentation:'chat'};
    }

    window.elixDetectarSolicitudExportacion=function(texto){ return elixClasificarExportacionLocal(texto); };
    window.elixDetectarSolicitudExportacionInteligente=async function(texto){
        if(!elixPareceOrdenExportacion(texto)) return null;
        const viaGroq=await elixConsultarRouterGroq(texto);
        return viaGroq || elixClasificarExportacionLocal(texto);
    };

    function elixWordXml(s){
        // XML 1.0 no permite determinados caracteres de control.
        // Quitarlos aquí evita que una respuesta válida produzca un DOCX reparable.
        return String(s??'')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'')
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
    }

    function elixWordAttr(s){ return elixWordXml(String(s??'')); }

    function elixWordRunTexto(texto, formato={}){
        const partes=String(texto??'').split('\n');
        const props=[];

        // WordprocessingML exige un orden concreto dentro de w:rPr.
        // Mantenerlo evita reparaciones silenciosas o avisos de contenido ilegible.
        if(formato.code) props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>');
        if(formato.bold) props.push('<w:b/>');
        if(formato.italic) props.push('<w:i/>');
        if(formato.color) props.push(`<w:color w:val="${elixWordAttr(formato.color)}"/>`);
        if(formato.code) props.push('<w:sz w:val="19"/>');
        if(formato.underline) props.push('<w:u w:val="single"/>');
        if(formato.sup) props.push('<w:vertAlign w:val="superscript"/>');
        else if(formato.sub) props.push('<w:vertAlign w:val="subscript"/>');

        const rPr=props.length?`<w:rPr>${props.join('')}</w:rPr>`:'';
        return partes.map((p,i)=>`${i?'<w:r><w:br/></w:r>':''}<w:r>${rPr}<w:t xml:space="preserve">${elixWordXml(p)}</w:t></w:r>`).join('');
    }

    function elixWordMarcadoresMatematicos(markdown){
        let texto=String(markdown||'')
            .replace(/\\\[/g,'$$$$').replace(/\\\]/g,'$$$$')
            .replace(/\\\(/g,'$').replace(/\\\)/g,'$');
        const maths=[];
        texto=texto.replace(/\$\$[\s\S]*?\$\$|\$[^\n$]+?\$|\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/g,(m)=>{
            const display=m.startsWith('$$') || m.startsWith('\\begin');
            const tex=m.startsWith('$$') ? m.slice(2,-2) : (m.startsWith('$') ? m.slice(1,-1) : m);
            const token=`ELIXWORDMATH${maths.length}TOKEN`;
            maths.push({tex,display});
            return token;
        });
        let html=typeof marked!=='undefined' ? marked.parse(texto) : `<p>${escapeHTML(texto).replace(/\n/g,'<br>')}</p>`;
        maths.forEach((m,i)=>{
            const token=`ELIXWORDMATH${i}TOKEN`;
            const repl=`<span class="elix-word-math" data-display="${m.display?'1':'0'}" data-tex="${encodeURIComponent(m.tex)}"></span>`;
            html=html.split(token).join(repl);
        });
        return html;
    }

    let elixWordMathFramePromise=null;
    async function elixWordMathFrame(){
        if(elixWordMathFramePromise) return elixWordMathFramePromise;
        elixWordMathFramePromise=(async()=>{
            const fuentes=[
                'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js',
                'https://unpkg.com/mathjax@3/es5/tex-svg.js'
            ];
            let ultimoError=null;
            for(const src of fuentes){
                try{
                    const resultado=await new Promise((resolve,reject)=>{
                        const frame=document.createElement('iframe');
                        frame.setAttribute('aria-hidden','true');
                        frame.style.cssText='position:fixed;left:-100000px;top:0;width:900px;height:700px;border:0;opacity:0;pointer-events:none;';
                        frame.srcdoc=`<!doctype html><html><head><meta charset="utf-8"><script>window.MathJax={tex:{inlineMath:[[\'$\',\'$\'],[\'\\\\(\',\'\\\\)\']],displayMath:[[\'$$\',\'$$\'],[\'\\\\[\',\'\\\\]\']],processEscapes:true},svg:{fontCache:\'local\'},startup:{typeset:false}};<\/script><script src="${src}"><\/script></head><body></body></html>`;
                        document.body.appendChild(frame);
                        const inicio=Date.now();
                        let terminado=false;
                        const finalizar=(ok,error)=>{
                            if(terminado) return; terminado=true;
                            if(ok) resolve({frame,win:frame.contentWindow});
                            else { frame.remove(); reject(error); }
                        };
                        const revisar=()=>{
                            const win=frame.contentWindow;
                            if(win?.MathJax?.tex2svgPromise) return finalizar(true);
                            if(Date.now()-inicio>9000) return finalizar(false,new Error(`No se pudo cargar MathJax desde ${src}`));
                            setTimeout(revisar,120);
                        };
                        frame.onload=revisar;
                        setTimeout(revisar,180);
                    });
                    return resultado;
                }catch(error){ ultimoError=error; }
            }
            elixWordMathFramePromise=null;
            throw ultimoError || new Error('No se pudo iniciar el renderizador matemático de Word.');
        })();
        return elixWordMathFramePromise;
    }

    function elixWordMedidaSvgPx(valor, exPx=7.25){
        const s=String(valor||'').trim().toLowerCase();
        const n=parseFloat(s);
        if(!Number.isFinite(n)) return null;
        if(s.endsWith('ex')) return n*exPx;
        if(s.endsWith('em')) return n*(exPx*2);
        if(s.endsWith('pt')) return n*(96/72);
        if(s.endsWith('pc')) return n*16;
        if(s.endsWith('in')) return n*96;
        if(s.endsWith('cm')) return n*(96/2.54);
        if(s.endsWith('mm')) return n*(96/25.4);
        if(s.endsWith('px') || /^-?\d+(\.\d+)?$/.test(s)) return n;
        return null;
    }

    async function elixWordSvgAPng(svg, display=false){
        const clone=svg.cloneNode(true);
        clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
        clone.setAttribute('xmlns:xlink','http://www.w3.org/1999/xlink');

        const vb=(clone.getAttribute('viewBox')||'0 0 1000 300').trim().split(/\s+/).map(Number);
        let vw=Math.abs(vb[2]||1000), vh=Math.abs(vb[3]||300);
        if(!Number.isFinite(vw)||vw<=0) vw=1000;
        if(!Number.isFinite(vh)||vh<=0) vh=300;
        const ratio=Math.max(.05,Math.min(80,vw/vh));

        // MathJax expresa normalmente width/height en ex. Convertir esas medidas
        // a píxeles físicos da una escala equivalente al texto de Word (11 pt),
        // evitando fórmulas gigantes y conservando matrices/fracciones altas.
        const exPx=display ? 7.6 : 7.15;
        let w=elixWordMedidaSvgPx(clone.getAttribute('width'),exPx);
        let h=elixWordMedidaSvgPx(clone.getAttribute('height'),exPx);

        if(!(w>0) || !(h>0)){
            h=display ? 20 : 14;
            w=h*ratio;
        }
        // Corrige medidas anómalas sin alterar la proporción.
        if(!(w>0) || !Number.isFinite(w)) w=(display?20:14)*ratio;
        if(!(h>0) || !Number.isFinite(h)) h=display?20:14;

        const maxW=display ? 560 : 320;
        const maxH=display ? 54 : 30;
        let scale=Math.min(1,maxW/w,maxH/h);
        if(scale<1){ w*=scale; h*=scale; }

        // No se fuerza una altura grande: una variable simple debe verse como texto.
        const minH=display ? 8 : 7;
        if(h<minH){ const up=minH/h; h*=up; w*=up; }
        if(w>maxW){ const down=maxW/w; w*=down; h*=down; }

        // Raster de alta resolución; el tamaño físico en Word se conserva pequeño.
        const renderScale=4;
        clone.setAttribute('width',String(Math.max(1,Math.round(w*renderScale))));
        clone.setAttribute('height',String(Math.max(1,Math.round(h*renderScale))));
        clone.style.width=`${Math.max(1,Math.round(w*renderScale))}px`;
        clone.style.height=`${Math.max(1,Math.round(h*renderScale))}px`;

        const texto=new XMLSerializer().serializeToString(clone);
        const svgBlob=new Blob([texto],{type:'image/svg+xml;charset=utf-8'});
        const url=URL.createObjectURL(svgBlob);
        try{
            const img=await new Promise((resolve,reject)=>{
                const im=new Image();
                im.onload=()=>resolve(im);
                im.onerror=()=>reject(new Error('No se pudo rasterizar una fórmula.'));
                im.src=url;
            });
            const canvas=document.createElement('canvas');
            canvas.width=Math.max(1,Math.ceil(w*renderScale));
            canvas.height=Math.max(1,Math.ceil(h*renderScale));
            const ctx=canvas.getContext('2d',{alpha:true});
            ctx.clearRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(img,0,0,canvas.width,canvas.height);
            const png=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('No se pudo crear la imagen matemática.')),'image/png',1));
            return {bytes:new Uint8Array(await png.arrayBuffer()),width:w,height:h,ext:'png',mime:'image/png'};
        }finally{ URL.revokeObjectURL(url); }
    }

    async function elixWordFormulaPng(tex,display=false){
        const {win}=await elixWordMathFrame();
        const container=await win.MathJax.tex2svgPromise(String(tex||''),{display:!!display});
        const svg=container?.querySelector?.('svg');
        if(!svg) throw new Error('No se pudo representar la fórmula.');
        return await elixWordSvgAPng(svg,display);
    }

    function elixWordRelacion(state,type,target,targetMode=''){
        const id=`rId${state.nextRel++}`;
        state.rels.push(`<Relationship Id="${id}" Type="${elixWordAttr(type)}" Target="${elixWordAttr(target)}"${targetMode?` TargetMode="${elixWordAttr(targetMode)}"`:''}/>`);
        return id;
    }

    function elixWordAgregarImagen(state,imagen,nombre='Imagen'){
        const idx=state.media.length+1;
        const ext=(imagen.ext||'png').replace(/^\./,'').toLowerCase();
        const path=`media/elix-${idx}.${ext}`;
        state.media.push({path,bytes:imagen.bytes,ext});
        const rid=elixWordRelacion(state,'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',path);
        const maxW=625;
        let w=Math.max(6,Number(imagen.width)||100), h=Math.max(6,Number(imagen.height)||40);
        if(w>maxW){ h*=maxW/w; w=maxW; }
        const cx=Math.round(w*9525), cy=Math.round(h*9525);
        const docId=state.nextDocPr++;
        return `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docId}" name="${elixWordAttr(nombre)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${elixWordAttr(nombre)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    }

    async function elixWordImagenDesdeSrc(src){
        const s=String(src||'');
        const m=s.match(/^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/i);
        if(m){
            const bin=atob(m[2]);
            const bytes=new Uint8Array(bin.length);
            for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
            const ext=m[1].toLowerCase()==='jpg'?'jpeg':m[1].toLowerCase();
            return {bytes,width:420,height:260,ext,mime:`image/${ext}`};
        }
        if(/^blob:|^https?:/i.test(s)){
            try{
                const r=await fetch(s);
                if(!r.ok) return null;
                const blob=await r.blob();
                if(!/^image\/(png|jpeg|jpg|gif)/i.test(blob.type)) return null;
                const ext=/jpeg|jpg/i.test(blob.type)?'jpeg':(/gif/i.test(blob.type)?'gif':'png');
                const bytes=new Uint8Array(await blob.arrayBuffer());
                const dims=await new Promise(resolve=>{
                    const u=URL.createObjectURL(blob); const im=new Image();
                    im.onload=()=>{const d={width:im.naturalWidth||420,height:im.naturalHeight||260};URL.revokeObjectURL(u);resolve(d);};
                    im.onerror=()=>{URL.revokeObjectURL(u);resolve({width:420,height:260});}; im.src=u;
                });
                return {bytes,...dims,ext,mime:blob.type};
            }catch(_){ return null; }
        }
        return null;
    }

    async function elixWordInlineDesdeNodo(node,state,fmt={}){
        if(!node) return '';
        if(node.nodeType===3) return elixWordRunTexto(node.nodeValue||'',fmt);
        if(node.nodeType!==1) return '';
        const tag=node.tagName.toUpperCase();
        if(tag==='BR') return '<w:r><w:br/></w:r>';
        if(tag==='SCRIPT'||tag==='STYLE') return '';

        if(node.classList?.contains('elix-word-math')){
            const tex=decodeURIComponent(node.getAttribute('data-tex')||'');
            const display=node.getAttribute('data-display')==='1';
            try{
                const png=await elixWordFormulaPng(tex,display);
                return elixWordAgregarImagen(state,png,display?'Ecuación':'Fórmula');
            }catch(error){
                console.warn('Elix AI · fórmula Word:',error);
                return elixWordRunTexto(tex,{...fmt,italic:true});
            }
        }

        if(tag==='IMG'){
            const img=await elixWordImagenDesdeSrc(node.getAttribute('src')||'');
            if(img) return elixWordAgregarImagen(state,img,node.getAttribute('alt')||'Imagen');
            return elixWordRunTexto(node.getAttribute('alt')||'[Imagen]',fmt);
        }

        if(tag==='A'){
            const href=String(node.getAttribute('href')||'').trim();
            const inner=await elixWordInlineDesdeNodos(Array.from(node.childNodes),state,{...fmt,underline:true,color:'1D4ED8'});
            if(!href) return inner;

            // Solo generamos relaciones externas con URI válida.
            // Anclas internas, javascript: o data: quedan como texto para no corromper .rels.
            let target='';
            try{
                const u=new URL(href,location.href);
                if(['http:','https:','mailto:'].includes(u.protocol)) target=u.href;
            }catch(_){}
            if(!target) return inner;

            const rid=elixWordRelacion(state,'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',target,'External');
            return `<w:hyperlink r:id="${rid}" w:history="1">${inner}</w:hyperlink>`;
        }

        const nuevo={...fmt};
        if(tag==='STRONG'||tag==='B') nuevo.bold=true;
        if(tag==='EM'||tag==='I') nuevo.italic=true;
        if(tag==='CODE') nuevo.code=true;
        if(tag==='SUP') nuevo.sup=true;
        if(tag==='SUB') nuevo.sub=true;
        return await elixWordInlineDesdeNodos(Array.from(node.childNodes),state,nuevo);
    }

    async function elixWordInlineDesdeNodos(nodes,state,fmt={}){
        let out='';
        for(const n of nodes) out+=await elixWordInlineDesdeNodo(n,state,fmt);
        return out;
    }

    async function elixWordParrafoNodo(node,state,style='Normal',extraPr=''){
        const hijos=Array.from(node?.childNodes||[]);
        const visibles=hijos.filter(n=>!(n.nodeType===3 && !String(n.nodeValue||'').trim()));
        const soloMath=visibles.length===1 && visibles[0].nodeType===1 && visibles[0].classList?.contains('elix-word-math') && visibles[0].getAttribute('data-display')==='1';
        let runs='';
        if(soloMath){
            runs=await elixWordInlineDesdeNodo(visibles[0],state,{});
            extraPr+= '<w:spacing w:before="120" w:after="160"/><w:jc w:val="center"/>';
        }else{
            runs=await elixWordInlineDesdeNodos(hijos,state,{});
        }
        if(!runs) runs=elixWordRunTexto('');
        return `<w:p><w:pPr><w:pStyle w:val="${elixWordAttr(style)}"/>${extraPr}</w:pPr>${runs}</w:p>`;
    }

    async function elixWordLista(node,state,ordered=false,level=0){
        let out='',index=1;
        for(const li of Array.from(node.children).filter(x=>x.tagName?.toUpperCase()==='LI')){
            const inlineNodes=Array.from(li.childNodes).filter(n=>!(n.nodeType===1 && ['UL','OL'].includes(n.tagName.toUpperCase())));
            const prefix=ordered?`${index}. `:'• ';
            const runs=elixWordRunTexto(prefix,{bold:false}) + await elixWordInlineDesdeNodos(inlineNodes,state,{});
            const left=360+(level*280);
            out+=`<w:p><w:pPr><w:pStyle w:val="Normal"/><w:spacing w:after="50"/><w:ind w:left="${left}" w:hanging="180"/></w:pPr>${runs}</w:p>`;
            for(const nested of Array.from(li.children).filter(x=>['UL','OL'].includes(x.tagName.toUpperCase()))){
                out+=await elixWordLista(nested,state,nested.tagName.toUpperCase()==='OL',level+1);
            }
            index++;
        }
        return out;
    }

    async function elixWordTabla(node,state){
        const rows=Array.from(node.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
        const reales=rows.length?rows:Array.from(node.querySelectorAll('tr'));
        if(!reales.length) return '';

        const maxCols=Math.max(1,...reales.map(row=>Array.from(row.children).filter(c=>['TD','TH'].includes(c.tagName.toUpperCase())).length));
        const tableWidth=9000;
        const colWidth=Math.max(600,Math.floor(tableWidth/maxCols));
        const grid=`<w:tblGrid>${Array.from({length:maxCols},()=>`<w:gridCol w:w="${colWidth}"/>`).join('')}</w:tblGrid>`;

        let trs='';
        for(let ri=0;ri<reales.length;ri++){
            const row=reales[ri];
            const cells=Array.from(row.children).filter(c=>['TD','TH'].includes(c.tagName.toUpperCase()));
            let tcs='';
            for(const cell of cells){
                const isHead=cell.tagName.toUpperCase()==='TH' || (ri===0 && !!reales[0].querySelector('th'));
                let contenido='';
                const blockKids=Array.from(cell.children).filter(c=>['P','DIV','UL','OL','PRE','BLOCKQUOTE'].includes(c.tagName.toUpperCase()));
                if(blockKids.length) contenido=await elixWordBloquesDesdeContainer(cell,state,true);
                else contenido=await elixWordParrafoNodo(cell,state,'Normal','<w:spacing w:after="0"/>');

                // w:tcW debe preceder a w:shd dentro de w:tcPr.
                tcs+=`<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/>${isHead?'<w:shd w:val="clear" w:fill="EDEFF2"/>':''}</w:tcPr>${contenido || '<w:p/>'}</w:tc>`;
            }
            trs+=`<w:tr><w:trPr><w:cantSplit/></w:trPr>${tcs}</w:tr>`;
        }

        // tblGrid es parte estructural del esquema de tablas WordprocessingML.
        return `<w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="6" w:color="888888"/><w:left w:val="single" w:sz="6" w:color="888888"/><w:bottom w:val="single" w:sz="6" w:color="888888"/><w:right w:val="single" w:sz="6" w:color="888888"/><w:insideH w:val="single" w:sz="4" w:color="B0B0B0"/><w:insideV w:val="single" w:sz="4" w:color="B0B0B0"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr>${grid}${trs}</w:tbl>`;
    }

    async function elixWordBloque(node,state){
        if(!node) return '';
        if(node.nodeType===3){
            if(!String(node.nodeValue||'').trim()) return '';
            return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${elixWordRunTexto(node.nodeValue||'')}</w:p>`;
        }
        if(node.nodeType!==1) return '';
        const tag=node.tagName.toUpperCase();
        if(tag==='SCRIPT'||tag==='STYLE') return '';
        if(tag==='H1') return await elixWordParrafoNodo(node,state,'Heading1');
        if(tag==='H2') return await elixWordParrafoNodo(node,state,'Heading2');
        if(tag==='H3') return await elixWordParrafoNodo(node,state,'Heading3');
        if(tag==='H4'||tag==='H5'||tag==='H6') return await elixWordParrafoNodo(node,state,'Heading4');
        if(tag==='P') return await elixWordParrafoNodo(node,state,'Normal');
        if(tag==='UL') return await elixWordLista(node,state,false,0);
        if(tag==='OL') return await elixWordLista(node,state,true,0);
        if(tag==='TABLE') return await elixWordTabla(node,state);
        if(tag==='PRE'){
            const runs=elixWordRunTexto(node.textContent||'',{code:true});
            return `<w:p><w:pPr><w:pStyle w:val="ElixCode"/></w:pPr>${runs}</w:p>`;
        }
        if(tag==='BLOCKQUOTE'){
            let out='';
            const ps=Array.from(node.children).filter(x=>x.tagName?.toUpperCase()==='P');
            if(ps.length){ for(const p of ps) out+=await elixWordParrafoNodo(p,state,'ElixQuote'); }
            else out+=await elixWordParrafoNodo(node,state,'ElixQuote');
            return out;
        }
        if(tag==='HR') return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="B8B8B8"/></w:pBdr><w:spacing w:before="120" w:after="120"/></w:pPr></w:p>';
        if(tag==='FIGURE'){
            let out='';
            const img=node.querySelector(':scope > img');
            if(img){
                const imagen=await elixWordImagenDesdeSrc(img.getAttribute('src')||'');
                if(imagen) out+=`<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${elixWordAgregarImagen(state,imagen,img.getAttribute('alt')||'Figura')}</w:p>`;
            }
            const cap=node.querySelector(':scope > figcaption');
            if(cap) out+=`<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${elixWordRunTexto(cap.textContent||'',{italic:true,color:'666666'})}</w:p>`;
            return out;
        }
        if(tag==='IMG'){
            const imagen=await elixWordImagenDesdeSrc(node.getAttribute('src')||'');
            if(imagen) return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${elixWordAgregarImagen(state,imagen,node.getAttribute('alt')||'Imagen')}</w:p>`;
            return '';
        }
        return await elixWordBloquesDesdeContainer(node,state,false);
    }

    async function elixWordBloquesDesdeContainer(container,state,cell=false){
        let out='';
        const nodes=Array.from(container.childNodes||[]);
        for(const node of nodes) out+=await elixWordBloque(node,state);
        if(cell && !out) out='<w:p/>';
        return out;
    }

    function elixWordStylesXml(){
        // Orden estricto de propiedades OOXML: rFonts -> b/i -> color -> size.
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-EC"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>

  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:after="140" w:line="300" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:color w:val="111111"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="300" w:after="140"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="111111"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="260" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="1F2937"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="374151"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="180" w:after="90"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="374151"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="ElixQuote">
    <w:name w:val="Elix Quote"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:shd w:val="clear" w:fill="F5F5F5"/><w:spacing w:before="80" w:after="140"/><w:ind w:left="360"/></w:pPr>
    <w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="ElixCode">
    <w:name w:val="Elix Code"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:shd w:val="clear" w:fill="F3F4F6"/><w:spacing w:before="100" w:after="160"/><w:ind w:left="180" w:right="180"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr>
  </w:style>
</w:styles>`;
    }

    function elixWordValidarXml(nombre,xml){
        const doc=new DOMParser().parseFromString(String(xml||''),'application/xml');
        if(doc.querySelector('parsererror')){
            throw new Error(`Elix AI detectó XML inválido en ${nombre} antes de crear el Word.`);
        }
    }

    async function elixExportarWord(scope='chat',chatId=null,mensajesOverride=null,tituloOverride=null,opciones={}){
        if(typeof JSZip==='undefined'){
            alert('Elix AI no pudo cargar el generador de Word. Actualiza la página e inténtalo otra vez.');
            return;
        }
        const mensajes=Array.isArray(mensajesOverride) ? mensajesOverride.filter(Boolean) : elixMensajesExportables('chat',chatId);
        if(!mensajes.length){ alert('No hay contenido de Elix AI para convertir a Word.'); return; }

        const chat=elixObtenerChatExportable(chatId);
        const titulo=String(tituloOverride || chat?.title || 'Conversación Elix AI').replace(/\.\.\.$/,'').trim() || 'Elix AI';
        const presentation=String(opciones?.presentation||'chat');

        try{
            setCargando(true,'📝 Elix AI construyendo Word compatible...');
            const state={rels:[],media:[],nextRel:2,nextDocPr:1};
            let body='';

            body+=`<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:after="180"/></w:pPr>${elixWordRunTexto(titulo,{bold:true})}</w:p>`;

            for(const m of mensajes){
                if(presentation!=='answer'){
                    const role=m.role==='user'?'Tú':'Elix AI';
                    body+=`<w:p><w:pPr><w:pStyle w:val="Heading3"/><w:spacing w:before="180" w:after="70"/></w:pPr>${elixWordRunTexto(role,{bold:true,color:m.role==='user'?'4B5563':'1D4ED8'})}</w:p>`;
                }
                const root=document.createElement('div');
                root.innerHTML=elixWordMarcadoresMatematicos(elixContenidoVisibleMensaje(m));
                body+=await elixWordBloquesDesdeContainer(root,state,false);
            }

            // Crédito visible pero discreto; evita usar propiedades Core no válidas.
            body+=`<w:p><w:pPr><w:spacing w:before="220" w:after="0"/><w:jc w:val="center"/></w:pPr>${elixWordRunTexto('© InOutBio.Os',{color:'8A8A8A'})}</w:p>`;
            body+=`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1020" w:right="1020" w:bottom="1134" w:left="1020" w:header="500" w:footer="500" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>`;

            const documentXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="w14 wp14"><w:body>${body}</w:body></w:document>`;

            const relStyles='<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
            const docRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relStyles}${state.rels.join('')}</Relationships>`;
            const contentTypes=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
            const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
            const stylesXml=elixWordStylesXml();

            // Validación previa: XML bien formado y relaciones internas coherentes.
            elixWordValidarXml('word/document.xml',documentXml);
            elixWordValidarXml('word/styles.xml',stylesXml);
            elixWordValidarXml('word/_rels/document.xml.rels',docRels);
            elixWordValidarXml('[Content_Types].xml',contentTypes);
            elixWordValidarXml('_rels/.rels',rootRels);

            const zip=new JSZip();
            zip.file('[Content_Types].xml',contentTypes);
            zip.folder('_rels').file('.rels',rootRels);
            const word=zip.folder('word');
            word.file('document.xml',documentXml);
            word.file('styles.xml',stylesXml);
            word.folder('_rels').file('document.xml.rels',docRels);
            for(const media of state.media) word.file(media.path,media.bytes,{binary:true});

            const blob=await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',compression:'DEFLATE',compressionOptions:{level:6}});
            const a=document.createElement('a');
            const url=URL.createObjectURL(blob);
            a.href=url; a.download=`${elixNombreSeguro(titulo)}-Elix.docx`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(()=>URL.revokeObjectURL(url),20000);
        }catch(error){
            console.error('Elix AI · Word nativo:',error);
            alert(`No se pudo crear el Word.\n\n${error?.message || error}`);
        }finally{
            setCargando(false);
        }
    }

    // PDF conserva el flujo que ya tenía Elix AI; solo se invoca por texto.
    async function elixExportarPDF(scope='chat',chatId=null,mensajesOverride=null,tituloOverride=null,opciones={}){
        const mensajes=Array.isArray(mensajesOverride) ? mensajesOverride.filter(Boolean) : elixMensajesExportables('chat',chatId);
        if(!mensajes.length) return alert('No hay contenido para exportar.');
        const chat=elixObtenerChatExportable(chatId);
        const titulo=String(tituloOverride || chat?.title || 'Conversación Elix AI');
        const fecha=new Intl.DateTimeFormat('es-EC',{dateStyle:'long',timeStyle:'short'}).format(new Date());
        document.getElementById('elix-print-root')?.remove();
        const root=document.createElement('div');
        root.id='elix-print-root';
        const answerOnly=String(opciones?.presentation||'chat')==='answer';
        root.innerHTML=`<header class="elix-print-header"><div class="elix-print-brand">Elix AI · © InOutBio.Os</div><h1>${escapeHTML(titulo)}</h1><div class="elix-print-meta">${escapeHTML(fecha)}</div></header><div class="elix-print-copyright">© InOutBio.Os</div>` + mensajes.map(m=>{
            const role=m.role==='user' ? 'Tú' : 'Elix AI';
            const roleHtml=answerOnly ? '' : `<div class="elix-pdf-role">${role}</div>`;
            return `<section class="elix-pdf-message ${m.role==='user'?'is-user':'is-ai'}">${roleHtml}<div class="elix-pdf-body">${formatTextoMarkdown(elixContenidoVisibleMensaje(m))}</div></section>`;
        }).join('');
        document.body.appendChild(root);
        try{
            if(window.MathJax?.typesetPromise) await window.MathJax.typesetPromise([root]);
            if(document.fonts?.ready) await document.fonts.ready;
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            const cleanup=()=>{root.remove();window.removeEventListener('afterprint',cleanup);};
            window.addEventListener('afterprint',cleanup);
            window.print();
            setTimeout(()=>{if(document.body.contains(root))root.remove();},30000);
        }catch(error){
            root.remove();
            console.error(error);
            alert('Elix AI no pudo preparar el PDF.');
        }
    }

    // No hay botones: esta función solo la llama la orden escrita en el chat.
    window.elixExportarDocumento=async function(scope='chat',format='docx',chatId=null,mensajesOverride=null,tituloOverride=null,opciones={}){
        if(format==='docx') return await elixExportarWord('chat',chatId,mensajesOverride,tituloOverride,opciones);
        if(format==='pdf') return await elixExportarPDF('chat',chatId,mensajesOverride,tituloOverride,opciones);
    };

    // Compatibilidad interna; no se muestra ningún botón de exportación.
    window.exportarPDFSoloRespuestas=()=>window.elixExportarDocumento('chat','pdf',currentChatId);


    /* =========================================================
       D) SIDEBAR PC + AVISO + LEGAL
       ========================================================= */
    function mostrarLegal() {
        document.querySelector('.elix-legal-overlay')?.remove();
        const o=document.createElement('div');
        o.className='elix-legal-overlay';
        o.innerHTML=`<div class="elix-legal-box">
            <button class="elix-legal-close" type="button">Cerrar</button>
            <h2>Acuerdo de uso, licencia y condiciones — Elix AI</h2>
            <p><strong>Versión 2.0 · © InOutBio.Os.</strong> Este acuerdo regula el acceso y uso de Elix AI. Al iniciar sesión o continuar utilizando la aplicación declaras haber leído y aceptado estas condiciones.</p>
            <h3>1. Naturaleza del servicio</h3><p>Elix AI es una herramienta de apoyo basada en inteligencia artificial que puede integrar modelos y servicios de terceros para procesar instrucciones, archivos, imágenes, búsquedas y documentos. Las respuestas pueden contener errores, omisiones o información desactualizada y deben verificarse cuando la exactitud sea importante.</p>
            <h3>2. Licencia de uso</h3><p>InOutBio.Os concede al usuario una licencia limitada, personal, no exclusiva, revocable y no transferible para utilizar Elix AI conforme a estas condiciones y a la legislación aplicable. La autorización de uso no implica cesión de propiedad sobre la aplicación, su interfaz, código, diseño, marca o componentes propios.</p>
            <h3>3. Uso aceptable</h3><p>No se permite utilizar Elix AI para vulnerar sistemas, eludir controles de seguridad, distribuir malware, infringir derechos de terceros, suplantar identidades, realizar actividades ilícitas o procesar contenidos que el usuario no tenga derecho a utilizar. El usuario es responsable de sus instrucciones y del uso que haga de los resultados.</p>
            <h3>4. Contenido, archivos y datos</h3><p>Los archivos, imágenes y textos que el usuario envíe pueden ser procesados por servicios técnicos y proveedores de inteligencia artificial necesarios para ejecutar la solicitud. No deben cargarse datos confidenciales, personales o de terceros cuando no se cuente con autorización suficiente. El usuario conserva la responsabilidad sobre el contenido que aporta.</p>
            <h3>5. Servicios de terceros</h3><p>Algunas funciones dependen de servicios externos de autenticación, inteligencia artificial, búsqueda, alojamiento o almacenamiento temporal. Dichos servicios pueden aplicar límites, políticas y condiciones propias, y pueden cambiar, interrumpirse o dejar de estar disponibles sin control directo de InOutBio.Os.</p>
            <h3>6. Resultados generados por IA</h3><p>Elix AI no sustituye asesoría profesional ni una fuente oficial. En asuntos académicos, científicos, médicos, legales, financieros, de seguridad o de alto impacto, el usuario debe contrastar los resultados con fuentes fiables y, cuando corresponda, con un profesional competente.</p>
            <h3>7. Propiedad intelectual</h3><p>Elix AI, su presentación, identidad visual, componentes propios y documentación están protegidos por los derechos aplicables. © InOutBio.Os. Los derechos sobre materiales aportados por terceros pertenecen a sus respectivos titulares. La salida generada puede estar sujeta a derechos, reglas académicas o condiciones de los proveedores y debe utilizarse responsablemente.</p>
            <h3>8. Cuenta y seguridad</h3><p>El usuario debe proteger sus credenciales y cerrar sesión en dispositivos compartidos. Elix AI puede mantener la sesión iniciada en el dispositivo para facilitar el acceso hasta que el usuario cierre sesión, se invalide la autenticación o cambien las condiciones de acceso. La contraseña no se guarda manualmente por Elix AI en el navegador.</p>
            <h3>9. Disponibilidad y cambios</h3><p>El servicio se ofrece sujeto a disponibilidad técnica. Pueden realizarse cambios de interfaz, modelos, funciones, límites o condiciones para mejorar seguridad, estabilidad o funcionamiento. No se garantiza disponibilidad ininterrumpida ni ausencia absoluta de errores.</p>
            <h3>10. Limitación de responsabilidad</h3><p>En la medida permitida por la legislación aplicable, Elix AI se proporciona como herramienta de apoyo y no se garantiza que todos los resultados sean completos, exactos o adecuados para un propósito específico. El usuario debe revisar la información antes de tomar decisiones o publicarla.</p>
            <h3>11. Aceptación y actualización</h3><p>La aceptación queda asociada a la versión vigente de estas condiciones. Si se publica una versión nueva, Elix AI puede solicitar una nueva aceptación. Si el usuario no acepta las condiciones vigentes, debe dejar de utilizar la aplicación.</p>
            <div class="elix-legal-brand">© InOutBio.Os · Todos los derechos reservados.<br><span>Desarrollador: Sebastián Neto Ibarra</span></div>
        </div>`;
        document.body.appendChild(o);
        o.querySelector('.elix-legal-close').onclick=()=>o.remove();
        o.addEventListener('click',e=>{if(e.target===o)o.remove();});
    }
    window.mostrarLegalElix=mostrarLegal;

    function mostrarManualUsuario(){
        document.querySelector('.elix-legal-overlay')?.remove();
        const o=document.createElement('div');
        o.className='elix-legal-overlay';
        o.innerHTML=`<div class="elix-legal-box elix-manual-box" role="dialog" aria-modal="true" aria-labelledby="elix-manual-title">
            <button class="elix-legal-close" type="button">Cerrar</button>
            <h2 id="elix-manual-title">Manual de usuario — Elix AI</h2>
            <div class="elix-manual-intro"><strong>Elix AI</strong> reúne conversación, análisis académico, lectura de archivos e imágenes, búsqueda cuando es necesaria y exportación profesional. Puedes usar lenguaje natural: no necesitas aprender comandos rígidos.</div>

            <div class="elix-manual-grid">
                <section class="elix-manual-card"><h3>1. Chats y análisis</h3><p>Usa <strong>+ Nuevo Análisis</strong> para iniciar un tema independiente. Los chats aparecen en la barra lateral; puedes abrirlos, renombrarlos o eliminarlos. Conviene usar un chat por tema para mantener el contexto ordenado.</p></section>
                <section class="elix-manual-card"><h3>2. Modos de análisis</h3><p><strong>Rápido</strong> prioriza respuestas directas. <strong>Estándar</strong> equilibra claridad y profundidad. <strong>Riguroso</strong> exige mayor formalidad técnica. <strong>Profundo</strong> aplica el máximo nivel de rigor disponible para tareas complejas.</p></section>
                <section class="elix-manual-card"><h3>3. Modo académico</h3><p>APA 7, Vancouver e IEEE activan una respuesta orientada a citas y referencias. Si el modo académico está desactivado, Elix AI decide automáticamente si una consulta necesita búsqueda externa. Puedes indicar expresamente “no busques en internet” cuando quieras trabajar solo con el material aportado.</p></section>
                <section class="elix-manual-card"><h3>4. Cómo escribir un buen prompt</h3><p>Indica la tarea, el nivel de detalle, el formato esperado y cualquier restricción. Para mejores resultados, formula una instrucción completa.</p><span class="elix-manual-example">Analiza el archivo adjunto, explica los resultados paso a paso y destaca las conclusiones principales.</span></section>
            </div>

            <h3>5. Archivos e imágenes</h3>
            <p>Puedes adjuntar imágenes, PDF, Word, PowerPoint, Excel, TXT, CSV, Markdown y JSON. Elix AI prepara el contenido antes de responder para conservar texto, tablas, fórmulas, gráficos, imágenes y datos relevantes cuando el formato lo permite.</p>
            <ul><li><strong>Imágenes:</strong> se normalizan automáticamente para mejorar compatibilidad y lectura.</li><li><strong>PDF:</strong> los documentos grandes pueden procesarse página por página.</li><li><strong>Word/PowerPoint:</strong> se analiza el texto y también los elementos visuales extraíbles.</li><li><strong>Excel:</strong> se leen hojas, datos y fórmulas; los elementos visuales compatibles también pueden analizarse.</li></ul>
            <div class="elix-manual-note">Si una parte de una imagen o documento no es legible, formula la pregunta indicando exactamente qué zona, tabla, ecuación o página quieres revisar.</div>
            <div class="elix-manual-note">También puedes pedir generación de imágenes dentro del chat, por ejemplo: <strong>"Hazme una infografía científica sobre la célula animal"</strong>, <strong>"Crea una imagen realista de eso"</strong> o <strong>"Genera un diagrama del proceso basado en el chat"</strong>. Elix AI usará tu instrucción y, cuando haga falta, el contexto reciente del chat o los archivos adjuntos.</div>

            <h3>6. Exportar a Word o PDF mediante el chat</h3>
            <p>La exportación se solicita escribiendo una orden. Elix AI distingue entre exportar contenido existente y generar contenido nuevo antes de crear el archivo.</p>
            <span class="elix-manual-example">Convierte todo este chat en Word.</span>
            <span class="elix-manual-example">Pásame tu última respuesta a Word.</span>
            <span class="elix-manual-example">Exporta solo la parte donde hablamos de números irracionales a Word.</span>
            <span class="elix-manual-example">Exporta el chat de Química orgánica a Word.</span>
            <span class="elix-manual-example">Investiga la Segunda Guerra Mundial y al final hazme un Word de la respuesta.</span>
            <p>Si pides contenido nuevo y un archivo, Elix AI primero realiza la tarea y después exporta <strong>solo el contenido recién generado</strong>, salvo que indiques expresamente “todo el chat”. También se toleran errores comunes al escribir Word/DOCX.</p>

            <h3>7. Exportar una parte específica</h3>
            <p>Puedes pedir un tema, fragmento o respuesta concreta del chat. Sé descriptivo cuando existan varias partes parecidas.</p>
            <span class="elix-manual-example">Solo la explicación de la ley de Ohm, sin el resto del chat, en Word.</span>
            <span class="elix-manual-example">Desde la pregunta sobre mitosis hasta la tabla comparativa, pásalo a Word.</span>

            <h3>8. Ecuaciones, tablas e imágenes en Word</h3>
            <p>Las ecuaciones se preparan con tamaño proporcional para evitar fórmulas gigantes. Los títulos, listas, tablas, enlaces e imágenes compatibles se convierten a una estructura de documento. Las ecuaciones en bloque se centran automáticamente y las ecuaciones en línea permanecen integradas en el párrafo.</p>

            <h3>9. Detener y editar</h3>
            <p>Si una solicitud tarda demasiado o necesitas cambiarla, utiliza el control de detener cuando esté disponible. Puedes editar o volver a enviar una instrucción para corregir el enfoque sin crear otro chat.</p>

            <h3>10. Recomendaciones</h3>
            <ul><li>Usa un chat separado para trabajos extensos diferentes.</li><li>Indica páginas o secciones cuando un documento sea muy largo.</li><li>Revisa datos importantes antes de utilizarlos en trabajos académicos o decisiones relevantes.</li><li>Para una exportación limpia, especifica “última respuesta”, “parte sobre…” o “todo el chat”.</li></ul>

            <h3>11. Privacidad, sesión y seguridad</h3>
            <p>La sesión puede mantenerse iniciada en el dispositivo hasta que cierres sesión o el acceso deje de ser válido. No compartas tus credenciales y evita cargar información de terceros si no tienes autorización para procesarla.</p>

            <h3>12. Si algo no funciona</h3>
            <ul><li>Actualiza la página y vuelve a intentar la operación.</li><li>Comprueba que el archivo no esté dañado y que use un formato admitido.</li><li>Si una selección para exportar es ambigua, describe el tema con más precisión.</li><li>Si una respuesta importante parece incompleta, solicita una verificación o vuelve a formular la instrucción.</li></ul>

            <div class="elix-legal-brand">© InOutBio.Os · Manual de usuario de Elix AI<br><span>Desarrollador: Sebastián Neto Ibarra</span></div>
        </div>`;
        document.body.appendChild(o);
        o.querySelector('.elix-legal-close').onclick=()=>o.remove();
        o.addEventListener('click',e=>{if(e.target===o)o.remove();});
    }
    window.mostrarManualElix=mostrarManualUsuario;

    // Toggle de sidebar en PC.
    const top=document.querySelector('.top-bar');
    const title=document.querySelector('.app-title');
    if(top && title && !document.querySelector('.btn-sidebar-toggle')) {
        const b=document.createElement('button');
        b.className='btn-sidebar-toggle';
        b.type='button';
        b.title='Contraer o mostrar barra lateral';
        b.innerHTML='☰';
        top.insertBefore(b,title);
        const sidebar=document.querySelector('.sidebar');
        const apply=collapsed=>{
            sidebar?.classList.toggle('desktop-collapsed',collapsed);
            b.setAttribute('aria-expanded',String(!collapsed));
        };
        apply(localStorage.getItem('elixSidebarCollapsed')==='1');
        b.onclick=()=>{
            const collapsed=!sidebar.classList.contains('desktop-collapsed');
            apply(collapsed);
            localStorage.setItem('elixSidebarCollapsed',collapsed?'1':'0');
        };
    }

    // Aviso bajo el compositor.
    const wrapper=document.querySelector('.input-wrapper');
    if(wrapper && !wrapper.querySelector('.elix-ai-disclaimer')) {
        const d=document.createElement('div');
        d.className='elix-ai-disclaimer';
        d.innerHTML='© InOutBio.Os · La IA puede cometer errores. Verifica la información importante. · <button type="button">Acuerdo de uso y licencia</button>';
        d.querySelector('button').onclick=mostrarLegal;
        wrapper.appendChild(d);
    }

    // Panel de cuenta al pie del sidebar.
    const sidebar=document.querySelector('.sidebar');
    if(sidebar && !sidebar.querySelector('.elix-account-panel')) {
        const p=document.createElement('div');
        p.className='elix-account-panel';
        p.innerHTML=`<div id="elix-account-name" class="elix-account-name">Cuenta: comprobando acceso...</div><div class="elix-account-actions"><button type="button" id="elix-manual-btn">Manual de usuario</button><button type="button" id="elix-logout-btn" style="display:none">Cerrar sesión</button></div><div class="elix-account-copyright">© InOutBio.Os</div>`;
        sidebar.appendChild(p);
        p.querySelector('#elix-manual-btn').onclick=mostrarManualUsuario;
    }

    /* =========================================================
       E) FIREBASE AUTH — USUARIO + CONTRASEÑA
       =========================================================
       IMPORTANTE: Firebase Auth nativamente autentica email+password.
       Para ofrecer UX de "usuario + contraseña" sin Google, Elix transforma
       internamente el username en username@elix.local. No se expone al usuario.
       ========================================================= */
    const ELIX_FIREBASE_CONFIG = {
        apiKey: "AIzaSyC9C8xG_2j8m9ud4N_dZTlW_IpNGSObMag",
        authDomain: "simulador-sql-1.firebaseapp.com",
        projectId: "simulador-sql-1",
        storageBucket: "simulador-sql-1.firebasestorage.app",
        messagingSenderId: "716599040841",
        appId: "1:716599040841:web:1909dbb878589483b75898"
    };
    const ELIX_AUTH_REQUIRED = true;
    const ELIX_LICENSE_VERSION = '2.0';
    const ELIX_LICENSE_PENDING_KEY = 'elixLicenseAcceptancePending';
    const ELIX_LAST_USER_KEY = 'elixLastUser';

    function elixLicenseKey(uid){ return `elixLicense:${String(uid||'anon')}:${ELIX_LICENSE_VERSION}`; }
    function elixLicenciaAceptada(uid){ return localStorage.getItem(elixLicenseKey(uid))==='1'; }
    function elixGuardarLicencia(uid){ if(uid) localStorage.setItem(elixLicenseKey(uid),'1'); }

    function firebaseConfigLista(){
        return Object.values(ELIX_FIREBASE_CONFIG).every(v=>String(v||'').trim().length>0);
    }
    function normalizarCredencial(valor){
        return String(valor||'').trim().toLowerCase();
    }
    function esEmailValido(valor){
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizarCredencial(valor));
    }
    function validarCredencial(valor){
        const v=normalizarCredencial(valor);
        return esEmailValido(v) || /^[a-z0-9._-]{3,32}$/.test(v);
    }
    function credencialAEmail(valor){
        const v=normalizarCredencial(valor);
        return esEmailValido(v) ? v : `${v}@elix.local`;
    }
    function nombreUsuarioFirebase(currentUser){
        if(currentUser?.displayName) return currentUser.displayName;
        const email=String(currentUser?.email||'');
        return email.endsWith('@elix.local') ? email.slice(0,-'@elix.local'.length) : email;
    }

    function crearAuthOverlay(){
        const existente=document.getElementById('elix-auth-overlay');
        if(existente) return existente;

        const o=document.createElement('div');
        // Se abre desde el primer instante: la app permanece bloqueada hasta validar Firebase.
        o.className='elix-auth-overlay open';
        o.id='elix-auth-overlay';
        o.innerHTML=`<div class="elix-auth-card" role="dialog" aria-modal="true" aria-labelledby="elix-auth-title">
            <div class="elix-auth-logo" id="elix-auth-title">🧬 Elix AI</div>
            <div class="elix-auth-sub" id="elix-auth-sub">Acceso seguro a Elix AI · © InOutBio.Os</div>
            <form id="elix-auth-form" novalidate>
                <label for="elix-auth-user">Usuario</label>
                <input id="elix-auth-user" type="text" autocomplete="username" maxlength="254" placeholder="Tu usuario o correo" required>
                <label for="elix-auth-pass">Contraseña</label>
                <input id="elix-auth-pass" type="password" autocomplete="current-password" minlength="6" placeholder="Tu contraseña" required>
                <label class="elix-auth-accept"><input id="elix-auth-terms" type="checkbox" required><span>He leído y acepto el <button type="button" id="elix-auth-legal">Acuerdo de uso, licencia y condiciones</button>.</span></label>
                <div class="elix-auth-remember">La sesión se mantendrá en este dispositivo hasta que cierres sesión o el acceso deje de ser válido.</div>
                <button id="elix-auth-submit" class="elix-auth-primary" type="submit" disabled>Iniciar sesión</button>
                <div id="elix-auth-error" class="elix-auth-error" role="alert" aria-live="polite"></div>
                <div class="elix-auth-copyright">© InOutBio.Os</div>
            </form>
        </div>`;
        document.body.appendChild(o);
        o.querySelector('#elix-auth-legal').onclick=mostrarLegal;
        return o;
    }

    async function iniciarFirebaseAuth(){
        const accountName=document.getElementById('elix-account-name');
        const logoutBtn=document.getElementById('elix-logout-btn');
        const overlay=crearAuthOverlay();
        const form=overlay.querySelector('#elix-auth-form');
        const user=overlay.querySelector('#elix-auth-user');
        const pass=overlay.querySelector('#elix-auth-pass');
        const terms=overlay.querySelector('#elix-auth-terms');
        const submit=overlay.querySelector('#elix-auth-submit');
        const sub=overlay.querySelector('#elix-auth-sub');
        const errorBox=overlay.querySelector('#elix-auth-error');

        // El botón solo se habilita después de marcar expresamente el acuerdo.
        const actualizarBoton=()=>{
            submit.disabled=!terms.checked;
        };
        terms.addEventListener('change', actualizarBoton);
        actualizarBoton();

        const bloquearPorConfiguracion=(mensaje)=>{
            overlay.classList.add('open');
            user.disabled=true;
            pass.disabled=true;
            terms.disabled=true;
            submit.disabled=true;
            sub.textContent='El acceso a Elix AI requiere autenticación.';
            errorBox.textContent=mensaje;
        };

        // A diferencia de la versión anterior, si Firebase no está configurado NO se deja pasar a la app.
        if(!firebaseConfigLista()) {
            if(accountName) accountName.textContent='Cuenta: acceso no disponible';
            bloquearPorConfiguracion('El servicio de acceso de Elix AI no está disponible en este momento.');
            console.info('Elix AI bloqueado: falta completar ELIX_FIREBASE_CONFIG.');
            return;
        }
        if(typeof firebase==='undefined') {
            if(accountName) accountName.textContent='Cuenta: acceso no disponible';
            bloquearPorConfiguracion('El servicio de acceso de Elix AI no pudo cargarse. Revisa tu conexión.');
            console.error('No se cargó Firebase desde el CDN.');
            return;
        }

        try {
            if(!firebase.apps.length) firebase.initializeApp(ELIX_FIREBASE_CONFIG);
            const auth=firebase.auth();

            // Persistencia local de Firebase: la sesión continúa en este dispositivo hasta cerrar sesión
            // o hasta que el proveedor invalide la autenticación. Elix AI no almacena la contraseña.
            await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

            const usuarioRecordado=localStorage.getItem(ELIX_LAST_USER_KEY);
            if(usuarioRecordado && !user.value) user.value=usuarioRecordado;

            form.onsubmit=async(e)=>{
                e.preventDefault();
                errorBox.textContent='';

                const credencial=normalizarCredencial(user.value);
                const password=pass.value;

                if(!validarCredencial(credencial)) {
                    errorBox.textContent='Escribe un usuario válido o el correo registrado.';
                    return;
                }
                if(password.length<6) {
                    errorBox.textContent='La contraseña debe tener al menos 6 caracteres.';
                    return;
                }
                if(!terms.checked) {
                    errorBox.textContent='Debes marcar la casilla y aceptar el acuerdo de uso y licencia antes de iniciar sesión.';
                    actualizarBoton();
                    return;
                }

                submit.disabled=true;
                submit.textContent='Validando...';
                localStorage.removeItem(ELIX_LICENSE_PENDING_KEY);

                try {
                    // Marcador temporal para que onAuthStateChanged pueda asociar la aceptación al UID
                    // incluso si el evento de autenticación llega antes de resolverse la promesa.
                    localStorage.setItem(ELIX_LICENSE_PENDING_KEY, ELIX_LICENSE_VERSION);
                    localStorage.setItem(ELIX_LAST_USER_KEY, credencial);
                    const authResult=await auth.signInWithEmailAndPassword(credencialAEmail(credencial), password);
                    if(authResult?.user?.uid) elixGuardarLicencia(authResult.user.uid);
                    localStorage.removeItem(ELIX_LICENSE_PENDING_KEY);
                } catch(err) {
                    localStorage.removeItem(ELIX_LICENSE_PENDING_KEY);
                    const code=String(err?.code||'');
                    const friendly = code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('user-not-found') || code.includes('invalid-login-credentials')
                        ? 'Usuario o contraseña incorrectos.'
                        : code.includes('user-disabled')
                            ? 'Esta cuenta está deshabilitada.'
                            : code.includes('too-many-requests')
                                ? 'Demasiados intentos. Intenta nuevamente más tarde.'
                                : code.includes('network-request-failed')
                                    ? 'No se pudo conectar con el servicio de acceso. Revisa tu conexión.'
                                    : (err?.message || 'No se pudo iniciar sesión.');
                    errorBox.textContent=friendly;
                } finally {
                    submit.textContent='Iniciar sesión';
                    actualizarBoton();
                }
            };

            auth.onAuthStateChanged(async currentUser=>{
                if(currentUser) {
                    // La aceptación se guarda por usuario y por versión del acuerdo.
                    // Si el usuario acaba de autenticarse con la casilla marcada, se vincula ahora a su UID.
                    const pendiente=localStorage.getItem(ELIX_LICENSE_PENDING_KEY)===ELIX_LICENSE_VERSION;
                    if(pendiente){
                        elixGuardarLicencia(currentUser.uid);
                        localStorage.removeItem(ELIX_LICENSE_PENDING_KEY);
                    }
                    const licenciaAceptada=elixLicenciaAceptada(currentUser.uid);
                    if(!licenciaAceptada) {
                        overlay.classList.add('open');
                        terms.checked=false;
                        actualizarBoton();
                        if(accountName) accountName.textContent='Sesión pendiente de aceptación';
                        if(logoutBtn) logoutBtn.style.display='none';
                        try { await auth.signOut(); } catch(_) {}
                        return;
                    }

                    overlay.classList.remove('open');
                    errorBox.textContent='';
                    if(accountName) accountName.textContent=`Usuario: ${nombreUsuarioFirebase(currentUser) || 'autenticado'}`;
                    if(logoutBtn) logoutBtn.style.display='block';
                } else {
                    overlay.classList.add('open');
                    if(accountName) accountName.textContent='Sesión no iniciada';
                    if(logoutBtn) logoutBtn.style.display='none';
                }
            });

            if(logoutBtn) logoutBtn.onclick=async()=>{
                localStorage.removeItem(ELIX_LICENSE_PENDING_KEY);
                terms.checked=false;
                pass.value='';
                actualizarBoton();
                await auth.signOut();
            };
        } catch(e) {
            console.error('Firebase Auth no pudo inicializarse:',e);
            if(accountName) accountName.textContent='Cuenta: acceso no disponible';
            bloquearPorConfiguracion('No se pudo inicializar el servicio de acceso de Elix AI.');
        }
    }

    iniciarFirebaseAuth();
})();
