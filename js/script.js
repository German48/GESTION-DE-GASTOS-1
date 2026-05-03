/**
 * GESTIÓN FINANCIERA - DEPARTAMENTO DE MADERA
 * Script principal con integración de Supabase
 */

import { initSupabase, getMovimientos, createMovimiento, deleteMovimiento, uploadFacturaBase64, createDocumentoPendiente, getDocumentosPendientes, updateDocumentoPendiente } from './supabase-client.js';
import { EXTERNAL_OCR_URL, EXTERNAL_OCR_API_KEY, EXTERNAL_OCR_TIMEOUT_MS } from './ocr-external-config.js';
import { MOVEMENTS_SEED } from './movimientos-seed.js';

document.addEventListener('DOMContentLoaded', () => {
    // --- INICIALIZAR SUPABASE ---
    const supabase = initSupabase();
    if (!supabase) {
        alert('Error: No se pudo inicializar Supabase. Verifica que la librería esté cargada.');
        return;
    }

    // --- ELEMENTOS DEL DOM ---
    const themeToggle = document.getElementById('theme-toggle');
    const form = document.getElementById('expense-form');
    const saveButton = document.getElementById('save-button');
    const savePendingButton = document.getElementById('save-pending-button');
    const fileInput = document.getElementById('factura-file');
    const cameraInput = document.getElementById('factura-camera');
    const docTypeSelect = document.getElementById('doc-type');
    const ocrModeSelect = document.getElementById('ocr-mode');
    const previewContainer = document.getElementById('preview-container');
    const thumbnail = document.getElementById('thumbnail');
    const ocrStatus = document.getElementById('ocr-status');
    const reviewPanel = document.getElementById('review-panel');
    const reviewConfidence = document.getElementById('ocr-confidence');
    const reviewProvider = document.getElementById('review-provider');
    const reviewDocType = document.getElementById('review-doc-type');
    const reviewInvoiceNumber = document.getElementById('review-invoice-number');
    const reviewDuplicate = document.getElementById('review-duplicate');
    const reviewWarnings = document.getElementById('review-warnings');
    const providerSuggestion = document.getElementById('review-provider');
    const tableBody = document.getElementById('expenses-table-body');
    const pendingList = document.getElementById('pending-list');
    const pendingEmpty = document.getElementById('pending-empty');
    const totalIngresosEl = document.getElementById('total-ingresos');
    const totalGastosEl = document.getElementById('total-gastos');
    const balanceEl = document.getElementById('balance');
    const filterMonth = document.getElementById('filter-month');
    const filterCategory = document.getElementById('filter-category');
    const filterProvider = document.getElementById('filter-provider');
    const radioTipo = document.querySelectorAll('input[name="tipo"]');
    const prevPageBtn = document.getElementById('prev-page');
    const nextPageBtn = document.getElementById('next-page');
    const pageInfo = document.getElementById('page-info');
    const exportCsvBtn = document.getElementById('export-csv');
    const exportPdfBtn = document.getElementById('export-pdf');
    const importCsvTrigger = document.getElementById('import-csv-trigger');
    const importCsvFile = document.getElementById('import-csv-file');
    const dashBalance = document.getElementById('dash-balance');
    const dashIngresos = document.getElementById('dash-ingresos');
    const dashGastos = document.getElementById('dash-gastos');

    // --- VARIABLES DE ESTADO ---
    let allMovements = [];
    let pendingItems = [];
    let attachedFile = { base64: null, name: null, type: null, thumbnail: null };
    let activePendingId = null;
    let currentPage = 1;
    let currentOcrAnalysis = null;
    let remotePendingAvailable = false;
    const rowsPerPage = 10;
    const PENDING_STORAGE_KEY = 'gestion_pendientes_revision';
    const MOVEMENTS_STORAGE_KEY = 'gestion_movimientos_cache';
    const OFFLINE_QUEUE_STORAGE_KEY = 'gestion_sync_queue_v1';
    const offlineStatusBanner = document.getElementById('offline-status');
    let syncInProgress = false;

    // --- INICIALIZACIÓN ---
    const init = async () => {
        setupTheme();
        setupEventListeners();
        setDefaultDate();
        await applyPrefillFromUrl();
        toggleCategoryFields();
        await hydrateMovementCacheFromSeed();
        await Promise.allSettled([loadPendingItems(), loadMovements()]);
        if (navigator.onLine) {
            const syncSummary = await processSyncQueue({ silent: true });
            if (syncSummary.processed > 0) {
                await Promise.allSettled([loadPendingItems(), loadMovements()]);
            }
        }
    };

    // --- MANEJO DEL TEMA ---
    const setupTheme = () => {
        const isDarkMode = localStorage.getItem('modoOscuro') === 'true';
        document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
        themeToggle.addEventListener('click', () => {
            const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('modoOscuro', newTheme === 'dark');
        });
    };

    // --- EVENT LISTENERS ---
    const setupEventListeners = () => {
        form.addEventListener('submit', handleFormSubmit);
        fileInput.addEventListener('change', handleFileChange);
        cameraInput.addEventListener('change', handleFileChange);
        [filterMonth, filterCategory, filterProvider].forEach(el => el.addEventListener('input', () => {
            currentPage = 1;
            renderTable();
        }));
        tableBody.addEventListener('click', handleDeleteClick);
        radioTipo.forEach(radio => radio.addEventListener('change', toggleCategoryFields));
        if (providerSuggestion) providerSuggestion.addEventListener('click', applySuggestedProvider);
        savePendingButton.addEventListener('click', handleSavePending);
        pendingList.addEventListener('click', handlePendingActions);
        exportPdfBtn.addEventListener('click', handleExportPDF);
        prevPageBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderTable();
            }
        });
        nextPageBtn.addEventListener('click', () => {
            currentPage++;
            renderTable();
        });
        exportCsvBtn?.addEventListener('click', exportMovementsToCsv);
        importCsvTrigger?.addEventListener('click', () => importCsvFile.click());
        importCsvFile?.addEventListener('change', handleImportCSV);
        window.addEventListener('online', handleConnectionBackOnline);
        window.addEventListener('offline', handleConnectionLost);
    };

    const isOfflineLikeError = (error) => error?.code === 'OFFLINE_OR_NETWORK' || !navigator.onLine;

    const readStoredArray = (key) => {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : [];
        } catch (error) {
            console.warn(`No se pudo leer ${key} de localStorage.`, error);
            return [];
        }
    };

    const writeStoredArray = (key, value) => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(`No se pudo guardar ${key} en localStorage.`, error);
        }
    };

    const getOfflineQueue = () => readStoredArray(OFFLINE_QUEUE_STORAGE_KEY);
    const saveOfflineQueue = (queue) => writeStoredArray(OFFLINE_QUEUE_STORAGE_KEY, queue);
    const getOfflineQueueCount = () => getOfflineQueue().length;
    const nextQueueId = () => `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const enqueueSyncOperation = (type, payload) => {
        const queue = getOfflineQueue();
        const entry = {
            id: nextQueueId(),
            type,
            payload,
            createdAt: new Date().toISOString()
        };
        queue.push(entry);
        saveOfflineQueue(queue);
        return entry;
    };

    const removeQueuedOperations = (predicate) => {
        const queue = getOfflineQueue();
        const nextQueue = queue.filter(item => !predicate(item));
        if (nextQueue.length !== queue.length) {
            saveOfflineQueue(nextQueue);
        }
    };

    const upsertQueuedMovement = (entry, movimientoData) => {
        const queuedMovement = {
            id: `queued-${entry.id}`,
            Timestamp: new Date().toISOString(),
            Tipo: movimientoData.tipo,
            Fecha: movimientoData.fecha ? new Date(movimientoData.fecha).toLocaleDateString('es-ES') : 'Sin fecha',
            Concepto: movimientoData.concepto || 'Sin concepto',
            Categoría: movimientoData.categoria || '',
            Importe: Number(movimientoData.importe || 0),
            Observaciones: [movimientoData.observaciones, 'Pendiente de sincronizar'].filter(Boolean).join(' · '),
            'Tipo Documento': movimientoData.tipo_documento,
            'URL PDF': null,
            'OCR Detectado': movimientoData.ocr_detectado || 'Pendiente de sincronizar',
            _queued: true,
            _queueId: entry.id
        };

        allMovements = [queuedMovement, ...allMovements.filter(mov => mov._queueId !== entry.id)];
        saveMovementCache(allMovements);
        renderTable();
    };

    const removeQueuedMovement = (queueId) => {
        if (!queueId) return;
        const before = allMovements.length;
        allMovements = allMovements.filter(mov => mov._queueId !== queueId);
        if (allMovements.length !== before) {
            saveMovementCache(allMovements);
            renderTable();
        }
    };

    const removeLocalPendingItemById = (pendingId) => {
        if (!pendingId) return;
        pendingItems = pendingItems.filter(item => Number(item.id) !== Number(pendingId));
        savePendingItems();
    };

    const buildPendingRemotePayload = (snapshot) => ({
        origen: 'web-manual',
        estado: 'pendiente',
        tipo: snapshot.tipo,
        fecha_detectada: snapshot.fecha || null,
        importe_detectado: snapshot.importe ? parseFloat(snapshot.importe) : null,
        proveedor_detectado: snapshot.analysis?.provider || null,
        numero_factura: snapshot.analysis?.invoiceNumber || null,
        tipo_documento: snapshot.tipo_documento || null,
        concepto_sugerido: snapshot.concepto || null,
        confianza_ocr: snapshot.analysis?.confidenceScore || null,
        ocr_resumen: snapshot.ocrStatus || null,
        documento_url: null,
        metadata_json: {
            analysis: snapshot.analysis || null,
            observaciones: snapshot.observaciones || null,
            categoria: snapshot.categoria || null,
            local_pending_id: snapshot.id
        }
    });

    const syncQueuedEntry = async (entry) => {
        switch (entry.type) {
            case 'create-movement': {
                const { movimientoData, attachedFileData, pendingToRemoveId, remotePendingId } = entry.payload;
                let urlPdf = movimientoData.url_pdf || null;
                if (!urlPdf && attachedFileData?.base64) {
                    urlPdf = await uploadFacturaBase64(attachedFileData.base64, attachedFileData.name, attachedFileData.type);
                }
                await createMovimiento({ ...movimientoData, url_pdf: urlPdf });
                if (remotePendingId) {
                    await updateDocumentoPendiente(remotePendingId, { estado: 'validado' });
                }
                if (pendingToRemoveId) {
                    removeLocalPendingItemById(pendingToRemoveId);
                }
                removeQueuedMovement(entry.id);
                return 'Movimiento sincronizado';
            }
            case 'delete-movement':
                await deleteMovimiento(entry.payload.remoteId);
                return 'Eliminación sincronizada';
            case 'create-pending':
                await createDocumentoPendiente(entry.payload.data);
                return 'Pendiente sincronizado';
            case 'update-pending':
                await updateDocumentoPendiente(entry.payload.remoteId, entry.payload.changes);
                return 'Pendiente actualizado';
            default:
                throw new Error(`Tipo de sincronización desconocido: ${entry.type}`);
        }
    };

    const processSyncQueue = async ({ silent = false, syncHandler = syncQueuedEntry, forceOnline = false } = {}) => {
        if (syncInProgress || (!forceOnline && !navigator.onLine)) {
            return { processed: 0, failed: 0, remaining: getOfflineQueueCount() };
        }

        const queue = getOfflineQueue();
        if (!queue.length) {
            return { processed: 0, failed: 0, remaining: 0 };
        }

        syncInProgress = true;
        let processed = 0;
        let failed = 0;
        let remaining = [];

        try {
            for (let index = 0; index < queue.length; index += 1) {
                const entry = queue[index];
                try {
                    await syncHandler(entry);
                    processed += 1;
                } catch (error) {
                    failed += 1;
                    remaining.push(entry);
                    if (!isOfflineLikeError(error)) {
                        console.error('Error al sincronizar la cola offline:', entry, error);
                    }
                    if (isOfflineLikeError(error)) {
                        remaining = [...remaining, ...queue.slice(index + 1)];
                        break;
                    }
                }
            }

            saveOfflineQueue(remaining);
        } finally {
            syncInProgress = false;
        }

        if (!silent) {
            if (processed > 0) {
                showToast(`Sincronización completada: ${processed} cambio(s) enviado(s) a Supabase.`, 'success');
            }
            if (failed > 0 && remaining.length > 0) {
                setOfflineBannerMessage(`Quedan ${remaining.length} cambio(s) pendientes de sincronizar con Supabase.`);
                showToast(`Quedan ${remaining.length} cambio(s) en cola para el próximo intento.`, 'info');
            }
        }

        return { processed, failed, remaining: remaining.length };
    };

    const runOfflineQueueSelfTest = async () => {
        const originalQueue = getOfflineQueue();
        const testEntries = [
            { id: 'test-ok-1', type: '__test__', payload: { step: 'ok-1' }, createdAt: new Date().toISOString() },
            { id: 'test-offline', type: '__test__', payload: { step: 'offline' }, createdAt: new Date().toISOString() },
            { id: 'test-ok-2', type: '__test__', payload: { step: 'ok-2' }, createdAt: new Date().toISOString() }
        ];
        const seen = [];

        try {
            saveOfflineQueue(testEntries);
            const summary = await processSyncQueue({
                silent: true,
                forceOnline: true,
                syncHandler: async (entry) => {
                    seen.push(entry.id);
                    if (entry.payload.step === 'offline') {
                        const error = new Error('offline-test');
                        error.code = 'OFFLINE_OR_NETWORK';
                        throw error;
                    }
                    return entry.id;
                }
            });

            const remainingQueue = getOfflineQueue();
            const passed = summary.processed === 1
                && summary.failed === 1
                && summary.remaining === 2
                && seen.join(',') === 'test-ok-1,test-offline'
                && remainingQueue.map(entry => entry.id).join(',') === 'test-offline,test-ok-2';

            return {
                passed,
                summary,
                seen,
                remainingIds: remainingQueue.map(entry => entry.id)
            };
        } finally {
            saveOfflineQueue(originalQueue);
        }
    };


    const setOfflineBannerMessage = (message, visible = true) => {
        if (!offlineStatusBanner) return;
        const textSpan = offlineStatusBanner.querySelector('span') || offlineStatusBanner;
        textSpan.textContent = message;
        offlineStatusBanner.classList.toggle('hidden', !visible);
    };

    const saveMovementCache = (movements) => {
        try {
            localStorage.setItem(MOVEMENTS_STORAGE_KEY, JSON.stringify(movements));
        } catch (error) {
            console.warn('No se pudo guardar la caché local de movimientos.', error);
        }
    };

    const loadMovementCache = () => {
        try {
            return JSON.parse(localStorage.getItem(MOVEMENTS_STORAGE_KEY) || '[]');
        } catch (error) {
            console.warn('La caché local de movimientos está dañada; se ignorará.', error);
            return [];
        }
    };

    const hydrateMovementCacheFromSeed = async () => {
        const cachedMovements = loadMovementCache();
        if (cachedMovements.length) return cachedMovements;
        
        console.log('Caché vacía. Hidratando desde MOVEMENTS_SEED...');
        return MOVEMENTS_SEED || [];
    };

    const CSV_METADATA_URL = './gestion-movimientos-2026-03-24.csv';
    let movementMetadataIndexPromise = null;

    const firstDefinedValue = (...values) => values.find(value => value !== undefined && value !== null && value !== '');

    const normalizeMovementText = (value) => String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[–—]/g, '-')
        .replace(/\s+/g, ' ');

    const normalizeMovementAmount = (value) => Number.parseFloat(value || 0).toFixed(2);

    const normalizeMovementDate = (value) => {
        if (!value) return '';
        const text = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
        const [day, month, year] = text.split('/');
        if (day && month && year) {
            return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
        const parsed = new Date(text);
        if (Number.isNaN(parsed.getTime())) return '';
        return parsed.toISOString().slice(0, 10);
    };

    const buildMovementCompositeKey = ({ fecha, concepto, importe }) => [
        normalizeMovementDate(fecha),
        normalizeMovementText(concepto),
        normalizeMovementAmount(importe)
    ].join('|');

    const parseCsvLine = (line) => {
        const values = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i += 1) {
            const char = line[i];
            const nextChar = line[i + 1];

            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    current += '"';
                    i += 1;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                values.push(current);
                current = '';
            } else {
                current += char;
            }
        }

        values.push(current);
        return values;
    };

    const loadMovementMetadataIndex = async () => {
        if (!movementMetadataIndexPromise) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

            movementMetadataIndexPromise = fetch(CSV_METADATA_URL, { 
                cache: 'no-store',
                signal: controller.signal
            })
                .then((response) => {
                    clearTimeout(timeoutId);
                    if (!response.ok) throw new Error(`No se pudo leer ${CSV_METADATA_URL} (HTTP ${response.status})`);
                    return response.text();
                })
                .then((csvText) => {
                    const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
                    if (lines.length < 2) return new Map();

                    const headers = parseCsvLine(lines[0]);
                    const index = new Map();

                    lines.slice(1).forEach((line) => {
                        const cols = parseCsvLine(line);
                        const row = Object.fromEntries(headers.map((header, idx) => [header, cols[idx] ?? '']));
                        const key = buildMovementCompositeKey({
                            fecha: row.Fecha,
                            concepto: row.Concepto,
                            importe: row.Importe
                        });

                        index.set(key, {
                            Tipo: row.Tipo || '',
                            Categoría: row.Categoría || '',
                            Observaciones: row.Observaciones || '',
                            'Tipo Documento': row.Documento || '',
                            'URL PDF': row.URL_Documento || ''
                        });
                    });

                    return index;
                })
                .catch((error) => {
                    clearTimeout(timeoutId);
                    console.warn('No se pudo cargar el índice de metadatos del CSV.', error);
                    return new Map();
                });
        }

        return movementMetadataIndexPromise;
    };

    const enrichMovementWithMetadata = (movement, metadataIndex) => {
        const metadata = metadataIndex.get(buildMovementCompositeKey({
            fecha: movement.Fecha,
            concepto: movement.Concepto,
            importe: movement.Importe
        }));

        if (!metadata) return movement;

        return {
            ...movement,
            Tipo: firstDefinedValue(movement.Tipo, metadata.Tipo, 'Gasto'),
            Categoría: firstDefinedValue(movement.Categoría, metadata.Categoría, ''),
            Observaciones: firstDefinedValue(movement.Observaciones, metadata.Observaciones, ''),
            'Tipo Documento': firstDefinedValue(movement['Tipo Documento'], metadata['Tipo Documento'], ''),
            'URL PDF': firstDefinedValue(movement['URL PDF'], metadata['URL PDF'], '')
        };
    };

    const enrichMovementsWithMetadata = async (movements) => {
        const metadataIndex = await loadMovementMetadataIndex();
        if (!metadataIndex.size) return movements;
        return movements.map((movement) => enrichMovementWithMetadata(movement, metadataIndex));
    };

    const mapSupabaseMovement = (mov) => ({
        id: mov.id,
        Timestamp: firstDefinedValue(mov.created_at, mov.updated_at, mov.fecha),
        Tipo: firstDefinedValue(mov.tipo, 'Gasto'),
        Fecha: mov.fecha ? new Date(mov.fecha).toLocaleDateString('es-ES') : 'Sin fecha',
        Concepto: firstDefinedValue(mov.concepto, ''),
        Categoría: firstDefinedValue(mov.categoria, mov['categoría'], ''),
        Importe: Number(firstDefinedValue(mov.importe, 0) || 0),
        Observaciones: firstDefinedValue(mov.descripcion, mov.observaciones, ''),
        'Tipo Documento': firstDefinedValue(mov.tipo_documento, mov.tipoDocumento, ''),
        'URL PDF': firstDefinedValue(mov.url_documento, mov.url_pdf, mov.documento_url, ''),
        'OCR Detectado': firstDefinedValue(mov.ocr_detectado, mov.ocr_resumen, '')
    });

    const renderTableMessage = (message) => {
        tableBody.innerHTML = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.textContent = message;
        tr.appendChild(td);
        tableBody.appendChild(tr);
    };

    const handleConnectionLost = () => {
        const queueCount = getOfflineQueueCount();
        const suffix = queueCount > 0 ? ` Ya hay ${queueCount} cambio(s) esperando sincronización.` : '';
        setOfflineBannerMessage(`Sin conexión: puedes seguir usando la app y los cambios nuevos se guardarán en cola hasta volver a tener Internet.${suffix}`);
        showToast('Modo sin conexión activado. Los cambios nuevos se guardarán en cola local.', 'info');
    };

    const handleConnectionBackOnline = async () => {
        if (offlineStatusBanner) {
            setOfflineBannerMessage('Conexión recuperada. Sincronizando cambios pendientes con Supabase...', true);
        }

        const syncSummary = await processSyncQueue();
        showToast('Conexión recuperada. Recargando datos de Supabase...', 'success');
        await Promise.allSettled([loadPendingItems(), loadMovements()]);

        if (navigator.onLine && offlineStatusBanner && syncSummary.remaining === 0) {
            offlineStatusBanner.classList.add('hidden');
        }
    };

    const toggleCategoryFields = () => {
        const tipoSeleccionado = document.querySelector('input[name="tipo"]:checked').value;
        document.getElementById('categoria-gasto-group').classList.toggle('hidden', tipoSeleccionado !== 'Gasto');
        document.getElementById('categoria-ingreso-group').classList.toggle('hidden', tipoSeleccionado !== 'Ingreso');
    };

    const setDefaultDate = () => {
        document.getElementById('fecha').valueAsDate = new Date();
    };

    const setRadioValue = (name, value) => {
        if (!value) return false;
        const normalizedValue = String(value).trim().toLowerCase();
        const radio = Array.from(document.querySelectorAll(`input[name="${name}"]`))
            .find(input => input.value.trim().toLowerCase() === normalizedValue);
        if (!radio) return false;
        radio.checked = true;
        return true;
    };

    const setSelectValue = (elementId, value) => {
        if (!value) return false;
        const select = document.getElementById(elementId);
        if (!select) return false;
        const normalizedValue = String(value).trim().toLowerCase();
        const option = Array.from(select.options)
            .find(opt => String(opt.value).trim().toLowerCase() === normalizedValue);
        if (!option) return false;
        select.value = option.value;
        return true;
    };

    const setInputValue = (elementId, value) => {
        if (value === null || value === undefined || value === '') return false;
        const input = document.getElementById(elementId);
        if (!input) return false;
        input.value = String(value).trim();
        return true;
    };

    const loadAttachedFileFromUrl = async (imageUrl) => {
        if (!imageUrl) return false;
        try {
            const response = await fetch(imageUrl);
            if (!response.ok) throw new Error(`No se pudo descargar la imagen: ${response.status}`);
            const blob = await response.blob();
            const reader = new FileReader();
            const base64Data = await new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            const extension = (blob.type && blob.type.split('/')[1]) || 'jpg';
            attachedFile.base64 = base64Data;
            attachedFile.name = `telegram_${Date.now()}.${extension}`;
            attachedFile.type = blob.type || 'image/jpeg';
            attachedFile.thumbnail = base64Data;
            thumbnail.src = base64Data;
            previewContainer.classList.remove('hidden');
            return true;
        } catch (error) {
            console.error('Error cargando imagen precargada:', error);
            return false;
        }
    };

    const applyPrefillFromUrl = async () => {
        const params = new URLSearchParams(window.location.search);
        if (![...params.keys()].length) return;

        const tipo = params.get('tipo');
        const doc = params.get('doc') || params.get('documento');
        const fecha = params.get('fecha');
        const importe = params.get('importe');
        const concepto = params.get('concepto') || params.get('proveedor') || params.get('cliente');
        const categoria = params.get('categoria');
        const observaciones = params.get('observaciones') || params.get('obs');
        const ocr = params.get('ocr');
        const ocrMode = params.get('ocrMode');
        const imageUrl = params.get('imageUrl') || params.get('imagen') || params.get('mediaUrl');

        let changed = false;
        changed = setRadioValue('tipo', tipo) || changed;
        toggleCategoryFields();
        changed = setSelectValue('doc-type', doc) || changed;
        changed = setInputValue('fecha', fecha) || changed;
        changed = setInputValue('importe', importe) || changed;
        changed = setInputValue('concepto', concepto) || changed;
        changed = setInputValue('observaciones', observaciones) || changed;
        changed = setSelectValue('ocr-mode', ocrMode) || changed;

        const tipoSeleccionado = document.querySelector('input[name="tipo"]:checked')?.value;
        if (tipoSeleccionado === 'Ingreso') {
            changed = setSelectValue('categoria-ingreso', categoria) || changed;
        } else {
            changed = setSelectValue('categoria-gasto', categoria) || changed;
        }

        const imageLoaded = await loadAttachedFileFromUrl(imageUrl);

        if (ocr) {
            ocrStatus.textContent = `Precargado desde Telegram/OCR: ${ocr}`;
            changed = true;
        } else if (changed || imageLoaded) {
            ocrStatus.textContent = 'Formulario precargado desde enlace.';
        }

        if (changed || imageLoaded) {
            previewContainer.classList.remove('hidden');
            if ((!thumbnail.src || thumbnail.src.endsWith('#')) && !imageLoaded) {
                thumbnail.src = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" rx="16" fill="#e9ecef"/><text x="120" y="72" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" fill="#6c757d">Precarga</text><text x="120" y="102" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#6c757d">desde Telegram</text></svg>');
            }
            showToast(imageLoaded ? 'Formulario e imagen precargados desde la URL' : 'Formulario precargado desde la URL', 'success');
        }
    };

    /**
     * Sanitiza una cadena de texto para evitar inyecciones HTML.
     */
    const escapeHTML = (str) => {
        if (!str) return "";
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    };

    // --- NOTIFICACIONES TOAST ---
    const showToast = (message, type = 'info') => {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const span = document.createElement('span');
        span.textContent = message;
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.textContent = '×';
        closeBtn.onclick = () => toast.remove();
        
        toast.appendChild(span);
        toast.appendChild(closeBtn);
        
        document.getElementById('toast-container').appendChild(toast);
        toast.offsetHeight;
        toast.classList.add('show');
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.remove('show');
                toast.addEventListener('transitionend', () => toast.remove());
            }
        }, 3000);
    };

    const setReviewBadge = (label, level = 'neutral') => {
        reviewConfidence.textContent = label;
        reviewConfidence.className = `review-badge review-badge-${level}`;
    };

    const updateReviewPanel = (analysis) => {
        currentOcrAnalysis = analysis;
        if (!analysis) {
            reviewPanel.classList.add('hidden');
            providerSuggestion.classList.add('hidden');
            setReviewBadge('Sin analizar', 'neutral');
            return;
        }

        reviewPanel.classList.remove('hidden');
        reviewProvider.textContent = analysis.provider || 'No detectado';
        reviewDocType.textContent = analysis.detectedDocType || 'No claro';
        reviewInvoiceNumber.textContent = analysis.invoiceNumber || 'No detectado';
        reviewDuplicate.textContent = analysis.duplicateRisk?.label || 'Sin comprobar';

        reviewWarnings.textContent = '';
        const warnings = analysis.warnings?.length ? analysis.warnings : ['Sin avisos relevantes.'];
        const listFragment = document.createDocumentFragment();
        warnings.forEach(msg => {
            const li = document.createElement('li');
            li.textContent = msg;
            listFragment.appendChild(li);
        });
        reviewWarnings.appendChild(listFragment);

        if (analysis.provider) {
            providerSuggestion.textContent = `Usar proveedor sugerido: ${analysis.provider}`;
            providerSuggestion.classList.remove('hidden');
        } else {
            providerSuggestion.classList.add('hidden');
        }

        const score = analysis.confidenceScore || 0;
        if (score >= 75) setReviewBadge(`Confianza OCR alta (${score}/100)`, 'good');
        else if (score >= 45) setReviewBadge(`Confianza OCR media (${score}/100)`, 'warn');
        else setReviewBadge(`Confianza OCR baja (${score}/100)`, 'bad');
    };

    const applySuggestedProvider = () => {
        if (!currentOcrAnalysis?.provider) return;
        const conceptInput = document.getElementById('concepto');
        if (!conceptInput.value.trim()) {
            conceptInput.value = currentOcrAnalysis.provider;
        } else if (!conceptInput.value.toLowerCase().includes(currentOcrAnalysis.provider.toLowerCase())) {
            conceptInput.value = `${currentOcrAnalysis.provider} - ${conceptInput.value}`;
        }
        showToast('Proveedor sugerido aplicado al concepto', 'success');
    };

    const loadPendingItems = async () => {
        const localItems = readStoredArray(PENDING_STORAGE_KEY).map(item => ({ ...item, source: item.source || 'local' }));

        try {
            const remoteItems = await getDocumentosPendientes();
            remotePendingAvailable = true;
            const syncedLocalIds = new Set(
                remoteItems
                    .map(item => item.metadata_json?.local_pending_id)
                    .filter(Boolean)
                    .map(value => Number(value))
            );

            pendingItems = remoteItems.map(item => ({
                id: item.id,
                remoteId: item.id,
                createdAt: item.created_at,
                tipo: item.tipo || 'Gasto',
                fecha: item.fecha_detectada || '',
                concepto: item.concepto_sugerido || '',
                categoria: item.metadata_json?.categoria || '',
                importe: item.importe_detectado ?? '',
                observaciones: item.metadata_json?.observaciones || '',
                tipo_documento: item.tipo_documento || 'Factura',
                ocrStatus: item.ocr_resumen || '',
                analysis: item.metadata_json?.analysis || {
                    provider: item.proveedor_detectado || null,
                    invoiceNumber: item.numero_factura || null,
                    detectedDocType: item.tipo_documento || null,
                    confidenceScore: item.confianza_ocr || 0
                },
                documento_url: item.documento_url || null,
                source: 'remote',
                status: item.estado || 'pendiente'
            }));

            const remainingLocalItems = localItems.filter(item => !syncedLocalIds.has(Number(item.id)));
            if (remainingLocalItems.length !== localItems.length) {
                writeStoredArray(PENDING_STORAGE_KEY, remainingLocalItems);
            }

            if (remainingLocalItems.length) {
                pendingItems = [...pendingItems, ...remainingLocalItems];
            }
        } catch (error) {
            remotePendingAvailable = false;
            pendingItems = localItems;
            if (isOfflineLikeError(error)) {
                setOfflineBannerMessage('Sin conexión con Supabase: se muestran solo los pendientes guardados en este dispositivo.');
                if (localItems.length) {
                    showToast('Supabase no está disponible. Mostrando pendientes guardados en este dispositivo.', 'info');
                }
            } else {
                console.error('Error inesperado al cargar los pendientes:', error);
                showToast('No se pudieron cargar los pendientes remotos.', 'error');
            }
        }

        renderPendingItems();
    };

    const savePendingItems = () => {
        const localPendingItems = pendingItems.filter(item => item.source !== 'remote');
        writeStoredArray(PENDING_STORAGE_KEY, localPendingItems);
        renderPendingItems();
    };

    const buildFormSnapshot = () => {
        const tipo = document.querySelector('input[name="tipo"]:checked').value;
        const categoria = tipo === 'Ingreso'
            ? document.getElementById('categoria-ingreso').value
            : document.getElementById('categoria-gasto').value;

        return {
            id: Date.now(),
            createdAt: new Date().toISOString(),
            source: 'local',
            tipo,
            fecha: document.getElementById('fecha').value,
            concepto: document.getElementById('concepto').value,
            categoria,
            importe: document.getElementById('importe').value,
            observaciones: document.getElementById('observaciones').value,
            tipo_documento: docTypeSelect.value,
            ocrStatus: ocrStatus.textContent,
            analysis: currentOcrAnalysis,
            attachedFile
        };
    };

    const handleSavePending = async () => {
        const snapshot = buildFormSnapshot();
        if (!snapshot.concepto && !snapshot.importe && !snapshot.attachedFile?.base64) {
            showToast('No hay suficiente información para guardar un pendiente.', 'error');
            return;
        }

        pendingItems.unshift(snapshot);
        savePendingItems();
        const remotePayload = buildPendingRemotePayload(snapshot);

        try {
            await createDocumentoPendiente(remotePayload);
            showToast('Documento guardado en pendientes y enviado a Supabase', 'success');
        } catch (error) {
            if (isOfflineLikeError(error)) {
                enqueueSyncOperation('create-pending', { localPendingId: snapshot.id, data: remotePayload });
                setOfflineBannerMessage('Sin conexión con Supabase: los pendientes nuevos se guardan en este dispositivo y se enviarán automáticamente al reconectar.');
                showToast('Pendiente guardado localmente y añadido a la cola de sincronización.', 'info');
            } else {
                console.warn('Pendiente guardado solo en localStorage; falta tabla documentos_pendientes o configuración equivalente.', error);
                showToast('Pendiente guardado localmente. Supabase aún no tiene la tabla de pendientes.', 'info');
            }
        }

        form.reset();
        resetFileInput();
        setDefaultDate();
        toggleCategoryFields();
        await loadPendingItems();
    };

    const renderPendingItems = () => {
        pendingList.innerHTML = '';
        pendingEmpty.classList.toggle('hidden', pendingItems.length > 0);
        if (!pendingItems.length) return;

        const fragment = document.createDocumentFragment();

        pendingItems.forEach(item => {
            const article = document.createElement('article');
            article.className = 'pending-item';
            
            const badgeClass = item.analysis?.confidenceScore >= 75 ? 'review-badge-good' : 
                             item.analysis?.confidenceScore >= 45 ? 'review-badge-warn' : 
                             'review-badge-bad';
            
            const sourceLabel = item.source === 'remote' ? 'Supabase' : 'Local';
            const hasDocument = item.documento_url || (item.attachedFile && item.attachedFile.thumbnail);
            
            const wrapper = document.createElement('div');
            wrapper.className = 'pending-content-wrapper';

            if (hasDocument) {
                const thumbContainer = document.createElement('div');
                thumbContainer.className = 'pending-thumbnail-container';
                const img = document.createElement('img');
                img.src = item.documento_url || item.attachedFile.thumbnail;
                img.className = 'pending-thumbnail';
                img.alt = 'Miniatura';
                thumbContainer.appendChild(img);
                wrapper.appendChild(thumbContainer);
            }

            const info = document.createElement('div');
            info.className = 'pending-info';

            const top = document.createElement('div');
            top.className = 'pending-top';

            const textData = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'pending-title';
            title.textContent = item.concepto || item.analysis?.provider || 'Sin concepto';
            
            const meta = document.createElement('div');
            meta.className = 'pending-meta';
            
            const createMetaTag = (text) => {
                const span = document.createElement('span');
                span.className = 'meta-tag';
                span.textContent = text;
                return span;
            };

            meta.appendChild(createMetaTag(item.fecha || 'Sin fecha'));
            meta.appendChild(createMetaTag(`${item.importe || '0.00'} €`));
            meta.appendChild(createMetaTag(item.tipo_documento || 'Doc'));
            
            const sourceSpan = document.createElement('span');
            sourceSpan.className = 'meta-source';
            sourceSpan.textContent = sourceLabel;
            meta.appendChild(sourceSpan);

            textData.appendChild(title);
            textData.appendChild(meta);

            const badge = document.createElement('span');
            badge.className = `review-badge ${badgeClass}`;
            badge.textContent = item.analysis?.confidenceScore ? `OCR ${item.analysis.confidenceScore}%` : 'Pendiente';

            top.appendChild(textData);
            top.appendChild(badge);

            const actions = document.createElement('div');
            actions.className = 'pending-actions';

            const applyBtn = document.createElement('button');
            applyBtn.type = 'button';
            applyBtn.className = 'pending-apply';
            applyBtn.dataset.action = 'apply';
            applyBtn.dataset.id = item.id;
            applyBtn.textContent = 'Cargar';

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'pending-delete';
            deleteBtn.dataset.action = 'delete';
            deleteBtn.dataset.id = item.id;
            deleteBtn.title = 'Descartar documento';
            deleteBtn.textContent = 'Descartar';

            actions.appendChild(applyBtn);
            actions.appendChild(deleteBtn);

            info.appendChild(top);
            info.appendChild(actions);

            wrapper.appendChild(info);
            article.appendChild(wrapper);
            fragment.appendChild(article);
        });

        pendingList.appendChild(fragment);
    };

    const fillFormFromPending = (item) => {
        if (!item) return;
        activePendingId = item.id;
        document.querySelector(`input[name="tipo"][value="${item.tipo || 'Gasto'}"]`).checked = true;
        toggleCategoryFields();
        docTypeSelect.value = item.tipo_documento || 'Factura';
        document.getElementById('fecha').value = item.fecha || '';
        document.getElementById('concepto').value = item.concepto || '';
        document.getElementById('importe').value = item.importe || '';
        document.getElementById('observaciones').value = item.observaciones || '';
        
        if (item.tipo === 'Ingreso') document.getElementById('categoria-ingreso').value = item.categoria || 'Otros Ingresos';
        else document.getElementById('categoria-gasto').value = item.categoria || 'Otros Gastos';
        
        if (item.documento_url) {
            previewContainer.classList.remove('hidden');
            thumbnail.src = item.documento_url;
            // No reseteamos attachedFile.base64 si ya existe, pero priorizamos la URL remota para el guardado si no se cambia
            attachedFile.remoteUrl = item.documento_url;
            ocrStatus.textContent = item.analysis?.confidenceScore ? `OCR Localizado (${item.analysis.confidenceScore}%)` : 'Documento remoto cargado';
        } else {
            attachedFile = item.attachedFile || { base64: null, name: null, type: null, thumbnail: null };
            if (attachedFile?.thumbnail) {
                previewContainer.classList.remove('hidden');
                thumbnail.src = attachedFile.thumbnail;
                ocrStatus.textContent = item.ocrStatus || '';
            }
        }
        
        updateReviewPanel(item.analysis || null);
    };

    const handlePendingActions = async (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        const item = pendingItems.find(p => Number(p.id) === id);
        if (!item) return;

        if (action === 'apply') {
            fillFormFromPending(item);
            window.scrollTo({ top: 0, behavior: 'smooth' });
            showToast('Pendiente cargado en el formulario', 'success');
        }

        if (action === 'delete') {
            if (item.source === 'remote' && item.remoteId) {
                try {
                    await updateDocumentoPendiente(item.remoteId, { estado: 'descartado' });
                } catch (error) {
                    if (isOfflineLikeError(error)) {
                        enqueueSyncOperation('update-pending', { remoteId: item.remoteId, changes: { estado: 'descartado' } });
                        setOfflineBannerMessage('Sin conexión: el descarte del pendiente se ha guardado en cola y se aplicará al reconectar.');
                        showToast('Pendiente marcado para descarte en cuanto vuelva la conexión.', 'info');
                    } else {
                        console.warn('No se pudo marcar como descartado en Supabase', error);
                    }
                }
            } else {
                removeQueuedOperations(queueItem => queueItem.payload?.localPendingId === id || queueItem.payload?.pendingToRemoveId === id);
            }
            pendingItems = pendingItems.filter(p => Number(p.id) !== id);
            savePendingItems();
            showToast('Pendiente eliminado', 'success');
        }
    };

    const loadMovements = async () => {
        toggleLoading(true, 'Cargando movimientos desde Supabase...');
        try {
            const data = await getMovimientos();
            allMovements = await enrichMovementsWithMetadata(data.map(mapSupabaseMovement));
            saveMovementCache(allMovements);
            renderTable();
            if (navigator.onLine && offlineStatusBanner) {
                offlineStatusBanner.classList.add('hidden');
            }
        } catch (error) {
            console.error('Error al cargar movimientos:', error);
            
            const cachedMovements = loadMovementCache();
            if (cachedMovements.length) {
                allMovements = cachedMovements;
                renderTable();
                
                const userMsg = isOfflineLikeError(error) 
                    ? 'Sin conexión: mostrando copia local de movimientos.'
                    : 'Supabase no responde: mostrando copia local.';
                setOfflineBannerMessage(userMsg);
                showToast(userMsg, 'info');
            } else {
                // Si no hay cache, intentar hidratar desde el seed
                console.log('Sin cache. Intentando hidratar desde MOVEMENTS_SEED...');
                const seedMovements = await hydrateMovementCacheFromSeed();
                if (seedMovements.length) {
                    allMovements = seedMovements;
                    renderTable();
                    showToast('Sin conexión. Usando datos históricos de respaldo.', 'info');
                } else {
                    allMovements = [];
                    renderTableMessage('No se pudieron cargar los movimientos ni hay copia local disponible.');
                    showToast('Error crítico: no se pudo cargar ningún dato.', 'error');
                }
            }
        }
    };

    // --- RENDERIZADO DE TABLA ---
    const getFilteredMovements = () => {
        const filters = {
            month: filterMonth.value,
            category: filterCategory.value,
            provider: filterProvider.value.toLowerCase()
        };

        return allMovements.filter(mov => {
            if (!mov || !mov.Fecha) return false;
            const movDate = new Date(mov.Fecha.split('/').reverse().join('-'));
            const movMonth = movDate.toISOString().slice(0, 7);
            const monthMatch = !filters.month || movMonth === filters.month;
            const categoryMatch = !filters.category || mov.Categoría === filters.category;
            const providerMatch = !filters.provider || (mov.Concepto && mov.Concepto.toLowerCase().includes(filters.provider));
            return monthMatch && categoryMatch && providerMatch;
        });
    };

    const exportMovementsToCsv = () => {
        const rows = getFilteredMovements();
        if (!rows.length) {
            showToast('No hay movimientos para exportar con los filtros actuales', 'error');
            return;
        }

        const headers = ['Fecha', 'Tipo', 'Documento', 'Concepto', 'Categoría', 'Importe', 'Observaciones', 'OCR Detectado', 'URL Documento'];
        const escapeCsv = (value) => {
            const text = String(value ?? '').replace(/"/g, '""');
            return `"${text}"`;
        };

        const csvRows = [headers.join(';')];
        rows.forEach((mov) => {
            csvRows.push([
                mov.Fecha || '',
                mov.Tipo || '',
                mov['Tipo Documento'] || '',
                mov.Concepto || '',
                mov.Categoría || '',
                mov.Importe ?? '',
                mov.Observaciones || '',
                mov['OCR Detectado'] || '',
                mov['URL PDF'] || ''
            ].map(escapeCsv).join(';'));
        });

        const blob = new Blob(["\ufeff" + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `gestion-movimientos-${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('CSV exportado correctamente', 'success');
    };

    const handleImportCSV = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                let text = event.target.result;
                // Eliminar BOM de UTF-8 si está presente
                if (text.startsWith('\uFEFF')) {
                    text = text.substring(1);
                }

                const lines = text.split(/\r?\n/).filter(line => line.trim());
                if (lines.length < 2) {
                    showToast('El archivo CSV está vacío o no es válido.', 'error');
                    return;
                }

                // Detectar separador (punto y coma o coma)
                const firstLine = lines[0];
                const separator = firstLine.includes(';') ? ';' : ',';
                
                // Normalizar cabeceras: quitar espacios, comillas y limpiar nombres
                const headers = firstLine.split(separator).map(h => h.replace(/^"|"$/g, '').trim());
                const rows = lines.slice(1);

                const newMovements = [];

                rows.forEach(line => {
                    const values = [];
                    let current = '';
                    let inQuotes = false;
                    
                    // Parser básico para CSV con soporte de comillas
                    for (let i = 0; i < line.length; i++) {
                        const char = line[i];
                        if (char === '"') {
                            if (inQuotes && line[i+1] === '"') {
                                current += '"';
                                i++;
                            } else {
                                inQuotes = !inQuotes;
                            }
                        } else if (char === separator && !inQuotes) {
                            values.push(current.trim());
                            current = '';
                        } else {
                            current += char;
                        }
                    }
                    values.push(current.trim());

                    const rowData = {};
                    headers.forEach((header, index) => {
                        const val = values[index];
                        rowData[header] = (val !== undefined) ? val.replace(/^"|"$/g, '').trim() : '';
                    });

                    // Helper para obtener valor de cabeceras parecidas (tolerancia a mayúsculas/minúsculas)
                    const getVal = (possibleKeys) => {
                        const keys = Object.keys(rowData);
                        const match = keys.find(k => possibleKeys.some(p => k.toLowerCase() === p.toLowerCase()));
                        return match ? rowData[match] : '';
                    };

                    const fecha = getVal(['Fecha', 'Date']);
                    const importeRaw = getVal(['Importe', 'Amount', 'Monto']);

                    if (fecha && importeRaw) {
                        // Limpiar importe: quitar símbolos de moneda y manejar decimales europeos/americanos
                        const cleanImporte = importeRaw.replace(/[€$£\s]/g, '').replace(',', '.');
                        const importeNum = parseFloat(cleanImporte);

                        if (!isNaN(importeNum)) {
                            newMovements.push({
                                id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                                Timestamp: new Date().toISOString(),
                                Tipo: getVal(['Tipo', 'Type']) || (importeNum < 0 ? 'Gasto' : 'Ingreso'),
                                Fecha: fecha,
                                Concepto: getVal(['Concepto', 'Concept', 'Description', 'Proveedor']),
                                Categoría: getVal(['Categoría', 'Categoria', 'Category', 'Clase']),
                                Importe: Math.abs(importeNum),
                                Observaciones: getVal(['Observaciones', 'Notes', 'Comentarios']),
                                'Tipo Documento': getVal(['Tipo Documento', 'Documento', 'DocType']) || 'Factura',
                                'URL PDF': getVal(['URL Documento', 'URL_Documento', 'URL PDF', 'Link', 'URL_PDF']),
                                'OCR Detectado': 'Importado via CSV'
                            });
                        }
                    }
                });

                if (newMovements.length > 0) {
                    // Filtrar duplicados: comparamos con el estado actual usando un set de llaves únicas
                    const existingKeys = new Set(
                        (allMovements || [])
                            .filter(m => m && m.Fecha)
                            .map(m => `${m.Fecha}|${(m.Concepto || '').trim()}|${(Number(m.Importe) || 0).toFixed(2)}`)
                    );

                    const uniqueNewMovements = newMovements.filter(m => {
                        const key = `${m.Fecha}|${(m.Concepto || '').trim()}|${(Number(m.Importe) || 0).toFixed(2)}`;
                        return !existingKeys.has(key);
                    });

                    if (uniqueNewMovements.length > 0) {
                        allMovements = [...uniqueNewMovements, ...allMovements];
                        saveMovementCache(allMovements);
                        renderTable();
                        showToast(`Se importaron ${uniqueNewMovements.length} movimientos nuevos con éxito.`, 'success');
                    } else {
                        showToast('Todos los movimientos del archivo ya estaban registrados.', 'info');
                    }
                } else {
                    showToast('No se detectaron movimientos válidos. Verifica las columnas "Fecha" e "Importe".', 'warning');
                }
            } catch (err) {
                console.error('Error detallado en importación:', err);
                showToast('Error crítico al procesar el CSV. Revisa el formato del archivo.', 'error');
            }
            e.target.value = '';
        };
        reader.readAsText(file);
    };

    const handleExportPDF = () => {
        try {
            // Verificar disponibilidad de jsPDF (soporta varias formas de carga del CDN)
            const jsPDFClass = window.jspdf ? window.jspdf.jsPDF : (window.jsPDF || null);
            
            if (!jsPDFClass) {
                showToast('Error: Librería PDF no cargada. Intenta recargar la página.', 'error');
                return;
            }

            const doc = new jsPDFClass();
        
        const filteredMovements = getFilteredMovements();
        const stamp = new Date().toLocaleDateString('es-ES');
        
        // Título y Cabecera
        doc.setFontSize(18);
        doc.setTextColor(58, 124, 165); 
        doc.text('Reporte de Gestión Financiera - Dpto. Madera', 14, 20);
        
        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text(`Fecha del reporte: ${stamp}`, 14, 30);
        
        // Resumen
        const tIngresos = totalIngresosEl.textContent;
        const tGastos = totalGastosEl.textContent;
        const bal = balanceEl.textContent;
        
        doc.setDrawColor(224);
        doc.line(14, 35, 196, 35);
        
        doc.setFontSize(12);
        doc.setTextColor(0);
        doc.text(`Resumen:  Ingresos: ${tIngresos} €  |  Gastos: ${tGastos} €  |  Balance: ${bal} €`, 14, 45);
        
        // Tabla de movimientos
        const tableData = filteredMovements.map(mov => [
            mov.Fecha,
            mov.Concepto,
            mov.Tipo,
            mov.Categoria,
            mov.Importe.toFixed(2) + ' €'
        ]);
        
        doc.autoTable({
            startY: 55,
            head: [['Fecha', 'Concepto', 'Tipo', 'Categoría', 'Importe']],
            body: tableData,
            headStyles: { fillColor: [198, 166, 100] }, 
            alternateRowStyles: { fillColor: [245, 245, 245] },
            margin: { top: 55 },
        });
        
        const totalPages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= totalPages; i++) {
            doc.setPage(i);
            doc.setFontSize(10);
            doc.setTextColor(150);
            doc.text(`Página ${i} de ${totalPages}`, 180, 285);
        }

        doc.save(`reporte-madera-${new Date().toISOString().slice(0,10)}.pdf`);
        showToast('PDF exportado correctamente', 'success');
    } catch (error) {
        console.error('Error al generar PDF:', error);
        showToast('Error al generar el PDF', 'error');
    }
};

    const renderTable = () => {
        const filteredMovements = getFilteredMovements();

        // Calcular totales
        let totalIngresos = 0;
        let totalGastos = 0;
        filteredMovements.forEach(mov => {
            if (mov.Tipo === 'Ingreso') totalIngresos += mov.Importe || 0;
            else totalGastos += mov.Importe || 0;
        });
        totalIngresosEl.textContent = totalIngresos.toFixed(2);
        totalGastosEl.textContent = totalGastos.toFixed(2);
        balanceEl.textContent = (totalIngresos - totalGastos).toFixed(2);

        // Actualizar Dashboard
        if (dashBalance) dashBalance.textContent = balanceEl.textContent + ' €';
        if (dashIngresos) dashIngresos.textContent = totalIngresosEl.textContent + ' €';
        if (dashGastos) dashGastos.textContent = totalGastosEl.textContent + ' €';

        // Paginación
        const totalPages = Math.ceil(filteredMovements.length / rowsPerPage) || 1;
        if (currentPage > totalPages) currentPage = totalPages;
        const start = (currentPage - 1) * rowsPerPage;
        const end = start + rowsPerPage;
        const paginatedMovements = filteredMovements.slice(start, end);

        tableBody.innerHTML = '';
        if (filteredMovements.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 7;
            td.textContent = 'No hay movimientos que coincidan con los filtros.';
            tr.appendChild(td);
            tableBody.appendChild(tr);
            pageInfo.textContent = 'Página 0 de 0';
            prevPageBtn.disabled = true;
            nextPageBtn.disabled = true;
            return;
        }

        const fragment = document.createDocumentFragment();

        paginatedMovements.forEach(mov => {
            const row = document.createElement('tr');
            const isIngreso = mov.Tipo === 'Ingreso';
            const importeClass = isIngreso ? 'monto-ingreso' : 'monto-gasto';
            const isQueuedMovement = Boolean(mov._queued);

            const createCell = (text, className) => {
                const td = document.createElement('td');
                td.textContent = text;
                if (className) td.className = className;
                return td;
            };

            row.appendChild(createCell(mov.Fecha || "N/A"));
            row.appendChild(createCell(mov.Concepto || ""));
            row.appendChild(createCell(mov.Tipo || "-"));
            row.appendChild(createCell(mov.Categoría || "-"));

            const linkTd = document.createElement('td');
            if (mov["URL PDF"]) {
                const a = document.createElement('a');
                a.href = mov["URL PDF"];
                a.target = "_blank";
                a.title = "Ver documento";
                // Usamos innerHTML solo para el icono SVG estático, lo cual es seguro
                a.innerHTML = '<svg class="link-icon"><use href="#link"></use></svg>';
                linkTd.appendChild(a);
            } else {
                linkTd.textContent = "-";
            }
            row.appendChild(linkTd);

            row.appendChild(createCell((mov.Importe || 0).toFixed(2), importeClass));

            const actionTd = document.createElement('td');
            actionTd.className = "actions-col";
            if (isQueuedMovement) {
                const pendingBadge = document.createElement('span');
                pendingBadge.textContent = 'En cola';
                pendingBadge.title = 'Este movimiento se enviará a Supabase cuando vuelva la conexión';
                actionTd.appendChild(pendingBadge);
            } else {
                const btn = document.createElement('button');
                btn.className = "delete-btn";
                btn.dataset.id = mov.id || "";
                btn.title = "Eliminar movimiento";
                btn.innerHTML = '<svg><use href="#trash"></use></svg>';
                actionTd.appendChild(btn);
            }
            row.appendChild(actionTd);

            fragment.appendChild(row);
        });

        tableBody.appendChild(fragment);

        pageInfo.textContent = `Página ${currentPage} de ${totalPages}`;
        prevPageBtn.disabled = currentPage === 1;
        nextPageBtn.disabled = currentPage === totalPages;
    };

    // --- MANEJO DEL FORMULARIO CON SUPABASE ---
    const handleFormSubmit = async (e) => {
        e.preventDefault();
        toggleButtonLoading(true);

        const tipo = document.querySelector('input[name="tipo"]:checked').value;
        const categoria = tipo === 'Ingreso'
            ? document.getElementById('categoria-ingreso').value
            : document.getElementById('categoria-gasto').value;

        if (currentOcrAnalysis?.confidenceScore < 45 && attachedFile.base64) {
            const proceed = confirm('La confianza del OCR es baja (' + currentOcrAnalysis.confidenceScore + '%). ¿Estás seguro de que los datos son correctos y quieres guardar?');
            if (!proceed) {
                toggleButtonLoading(false);
                return;
            }
        }

        let urlPdf = null;
        const pendingItem = activePendingId ? pendingItems.find(p => p.id === activePendingId) : null;

        const movimientoData = {
            tipo: tipo,
            fecha: document.getElementById('fecha').value,
            concepto: document.getElementById('concepto').value,
            categoria: categoria,
            importe: document.getElementById('importe').value,
            observaciones: document.getElementById('observaciones').value,
            tipo_documento: docTypeSelect.value,
            ocr_detectado: ocrStatus.textContent,
            url_pdf: null
        };

        const finishLocalSubmit = async (successMessage) => {
            if (activePendingId) {
                pendingItems = pendingItems.filter(p => p.id !== activePendingId);
                activePendingId = null;
                savePendingItems();
            }
            showToast(successMessage, 'success');
            form.reset();
            resetFileInput();
            setDefaultDate();
            toggleCategoryFields();
            await loadPendingItems();
        };

        const queueMovementForSync = async () => {
            const entry = enqueueSyncOperation('create-movement', {
                movimientoData,
                attachedFileData: attachedFile.base64 ? { ...attachedFile } : null,
                pendingToRemoveId: activePendingId || null,
                remotePendingId: pendingItem?.source === 'remote' ? pendingItem.remoteId : null
            });
            upsertQueuedMovement(entry, movimientoData);
            await finishLocalSubmit('Movimiento guardado en cola. Se enviará a Supabase al reconectar.');
            setOfflineBannerMessage(`Sin conexión: hay ${getOfflineQueueCount()} cambio(s) pendientes de sincronizar con Supabase.`);
        };

        try {
            if (!navigator.onLine) {
                await queueMovementForSync();
                return;
            }

            if (attachedFile.base64) {
                showToast('Subiendo factura a Supabase...', 'info');
                urlPdf = await uploadFacturaBase64(
                    attachedFile.base64,
                    attachedFile.name,
                    attachedFile.type
                );
            }

            movimientoData.url_pdf = urlPdf;
            await createMovimiento(movimientoData);

            if (activePendingId) {
                if (pendingItem?.source === 'remote' && pendingItem.remoteId) {
                    try {
                        await updateDocumentoPendiente(pendingItem.remoteId, { estado: 'validado' });
                    } catch (error) {
                        if (isOfflineLikeError(error)) {
                            enqueueSyncOperation('update-pending', { remoteId: pendingItem.remoteId, changes: { estado: 'validado' } });
                        } else {
                            console.warn('Error al validar pendiente remoto:', error);
                        }
                    }
                }
            }

            await finishLocalSubmit('Movimiento guardado en Supabase');
            await loadMovements();
        } catch (error) {
            if (isOfflineLikeError(error)) {
                movimientoData.url_pdf = urlPdf;
                await queueMovementForSync();
            } else {
                console.error('Error al guardar el movimiento en Supabase:', error);
                showToast('Error al guardar el movimiento', 'error');
            }
        } finally {
            toggleButtonLoading(false);
        }
    };

    // --- ELIMINAR MOVIMIENTO CON SUPABASE ---
    const handleDeleteClick = async (e) => {
        const deleteButton = e.target.closest('.delete-btn');
        if (!deleteButton) return;
        const id = deleteButton.dataset.id;
        if (!id) {
            showToast('Error: Movimiento sin ID.', 'error');
            return;
        }
        if (!confirm('¿Estás seguro de que quieres eliminar este movimiento? Esta acción no se puede deshacer.')) return;
        deleteButton.disabled = true;

        const remoteId = String(id);
        const queueDeleteAndRemoveLocally = () => {
            enqueueSyncOperation('delete-movement', { remoteId });
            allMovements = allMovements.filter(mov => String(mov.id) !== remoteId);
            saveMovementCache(allMovements);
            renderTable();
            setOfflineBannerMessage(`Sin conexión: hay ${getOfflineQueueCount()} cambio(s) pendientes de sincronizar con Supabase.`);
            showToast('Movimiento eliminado en local y añadido a la cola de sincronización.', 'info');
        };

        try {
            if (!navigator.onLine) {
                queueDeleteAndRemoveLocally();
                return;
            }

            await deleteMovimiento(remoteId);
            allMovements = allMovements.filter(mov => String(mov.id) !== remoteId);
            saveMovementCache(allMovements);
            renderTable();
            showToast('Movimiento eliminado correctamente', 'success');
        } catch (error) {
            if (isOfflineLikeError(error)) {
                queueDeleteAndRemoveLocally();
            } else {
                console.error('Error al eliminar el movimiento de Supabase:', error);
                showToast('No se pudo eliminar el movimiento.', 'error');
                deleteButton.disabled = false;
            }
        }
    };

    // --- OCR Y PROCESAMIENTO DE IMÁGENES ---
    const getSelectedDocType = () => docTypeSelect ? docTypeSelect.value : 'Factura';
    const getSelectedOcrMode = () => ocrModeSelect ? ocrModeSelect.value : 'local';

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    const computeOtsuThreshold = (hist, total) => {
        let sum = 0;
        for (let i = 0; i < 256; i++) sum += i * hist[i];
        let sumB = 0;
        let wB = 0;
        let wF = 0;
        let maxVariance = 0;
        let threshold = 128;
        for (let i = 0; i < 256; i++) {
            wB += hist[i];
            if (wB === 0) continue;
            wF = total - wB;
            if (wF === 0) break;
            sumB += i * hist[i];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const variance = wB * wF * (mB - mF) * (mB - mF);
            if (variance > maxVariance) {
                maxVariance = variance;
                threshold = i;
            }
        }
        return threshold;
    };

    const preprocessImage = (dataUrl, docType, mode = 'binary') => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const baseScale = docType === 'Ticket' ? 2.5 : 2;
            let targetWidth = Math.round(img.width * baseScale);
            let targetHeight = Math.round(img.height * baseScale);
            const maxDim = docType === 'Ticket' ? 2600 : 3000;
            const maxSide = Math.max(targetWidth, targetHeight);
            if (maxSide > maxDim) {
                const downScale = maxDim / maxSide;
                targetWidth = Math.round(targetWidth * downScale);
                targetHeight = Math.round(targetHeight * downScale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const contrast = docType === 'Ticket' ? 55 : 35;
            const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

            const hist = new Array(256).fill(0);
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                hist[gray] += 1;
            }

            const totalPixels = data.length / 4;
            const otsu = computeOtsuThreshold(hist, totalPixels);
            const threshold = docType === 'Ticket' ? otsu - 10 : otsu;

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                let v = factor * (gray - 128) + 128;
                if (mode === 'binary') {
                    v = v >= threshold ? 255 : 0;
                } else {
                    v = clamp(v, 0, 255);
                }
                data[i] = v;
                data[i + 1] = v;
                data[i + 2] = v;
            }

            ctx.putImageData(imageData, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('Error al cargar imagen'));
        img.src = dataUrl;
    });

    const cropImage = (dataUrl, cropRatio) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const cropHeight = Math.round(img.height * cropRatio);
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = cropHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, img.width, cropHeight, 0, 0, img.width, cropHeight);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('Error al cargar imagen'));
        img.src = dataUrl;
    });

    const cropImageRange = (dataUrl, startRatio, endRatio) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const start = clamp(startRatio, 0, 1);
            const end = clamp(endRatio, 0, 1);
            if (end <= start) {
                reject(new Error('Rango de recorte inválido'));
                return;
            }
            const cropY = Math.round(img.height * start);
            const cropHeight = Math.round(img.height * (end - start));
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = cropHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, cropY, img.width, cropHeight, 0, 0, img.width, cropHeight);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('Error al cargar imagen'));
        img.src = dataUrl;
    });

    const getOcrOptions = (docType, mode = 'primary', useWhitelist = true) => {
        const options = {
            tessedit_pageseg_mode: docType === 'Ticket'
                ? (mode === 'primary' ? 6 : mode === 'secondary' ? 11 : 6)
                : (mode === 'primary' ? 4 : 6),
            preserve_interword_spaces: '1',
            user_defined_dpi: '300'
        };
        if (useWhitelist) {
            options.tessedit_char_whitelist = '0123456789€.,-/: ';
        }
        return options;
    };

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        previewContainer.classList.remove('hidden');
        const docType = getSelectedDocType();
        ocrStatus.textContent = `Procesando imagen (${docType})...`;
        const reader = new FileReader();
        reader.onload = async (event) => {
            const originalDataUrl = event.target.result;
            attachedFile.base64 = originalDataUrl;
            attachedFile.name = `factura_${Date.now()}.${file.name.split('.').pop()}`;
            attachedFile.type = file.type;
            generateThumbnail(originalDataUrl, (thumbDataUrl) => {
                thumbnail.src = thumbDataUrl;
                attachedFile.thumbnail = thumbDataUrl;
            });

            try {
                const processedDataUrl = await preprocessImage(originalDataUrl, docType);
                runOCR(processedDataUrl, originalDataUrl, docType);
            } catch (error) {
                console.error('Error en preprocesado:', error);
                runOCR(originalDataUrl, originalDataUrl, docType);
            }
        };
        reader.readAsDataURL(file);
    };

    const runLocalOCR = async (processedDataUrl, originalDataUrl, docType) => {
        const primary = await Tesseract.recognize(processedDataUrl, 'spa+eng', getOcrOptions(docType, 'primary', true));
        const primaryData = extractOCRData(primary.data.text, docType);

        let secondaryData = null;
        if (!primaryData.amount || primaryData.amountScore < 3 || !primaryData.date) {
            const secondary = await Tesseract.recognize(originalDataUrl, 'spa+eng', getOcrOptions(docType, 'secondary', false));
            secondaryData = extractOCRData(secondary.data.text, docType);
        }

        let tertiaryData = null;
        let dateFocusData = null;
        let amountFocusData = null;
        if (docType === 'Ticket' && (!primaryData.date && (!secondaryData || !secondaryData.date))) {
            const softProcessed = await preprocessImage(originalDataUrl, docType, 'soft');
            const tertiary = await Tesseract.recognize(softProcessed, 'spa+eng', getOcrOptions(docType, 'tertiary', false));
            tertiaryData = extractOCRData(tertiary.data.text, docType);

            if (!tertiaryData.date) {
                const croppedTop = await cropImageRange(originalDataUrl, 0, 0.45);
                const processedCrop = await preprocessImage(croppedTop, docType, 'soft');
                const dateFocus = await Tesseract.recognize(processedCrop, 'spa+eng', getOcrOptions(docType, 'tertiary', false));
                dateFocusData = extractOCRData(dateFocus.data.text, docType);
            }
        }

        const needsAmountFocus = (!primaryData.amount || primaryData.amountScore < 3)
            && (!secondaryData || !secondaryData.amount || secondaryData.amountScore < 3)
            && (!tertiaryData || !tertiaryData.amount || tertiaryData.amountScore < 3);

        if (needsAmountFocus) {
            const croppedBottom = await cropImageRange(originalDataUrl, 0.55, 1);
            const processedBottom = await preprocessImage(croppedBottom, docType, 'soft');
            const amountFocus = await Tesseract.recognize(processedBottom, 'spa+eng', getOcrOptions(docType, 'tertiary', false));
            amountFocusData = extractOCRData(amountFocus.data.text, docType);
        }

        applyOCRResults(primaryData, secondaryData, tertiaryData, dateFocusData, amountFocusData);
    };

    const runExternalOCR = async (processedDataUrl, docType) => {
        if (!EXTERNAL_OCR_URL) {
            throw new Error('URL de OCR externo no configurada');
        }

        const payload = {
            imageBase64: processedDataUrl,
            docType: docType,
            language: 'spa'
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), EXTERNAL_OCR_TIMEOUT_MS || 45000);
        let response;
        try {
            response = await fetch(EXTERNAL_OCR_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(EXTERNAL_OCR_API_KEY ? { 'Authorization': `Bearer ${EXTERNAL_OCR_API_KEY}` } : {})
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            throw new Error(`OCR externo fallo: ${response.status}`);
        }

        const result = await response.json();
        if (!result || !result.text) {
            throw new Error('OCR externo no devolvio texto');
        }

        const externalData = extractOCRData(result.text, docType);
        applyOCRResults(externalData, null, null, null, null);
    };

    const runOCR = async (processedDataUrl, originalDataUrl, docType) => {
        ocrStatus.textContent = 'Reconociendo texto...';
        try {
            const mode = getSelectedOcrMode();
            if (mode === 'external') {
                await runExternalOCR(processedDataUrl, docType);
            } else {
                await runLocalOCR(processedDataUrl, originalDataUrl, docType);
            }
        } catch (error) {
            ocrStatus.textContent = 'Error en OCR.';
            console.error('Error en OCR:', error);
        }
    };

    const applyOCRResults = (primaryData, secondaryData, tertiaryData, dateFocusData, amountFocusData) => {
        const results = [primaryData, secondaryData, tertiaryData, dateFocusData, amountFocusData].filter(Boolean);
        let bestDate = null;
        let bestAmount = null;
        let enrichedResult = results.find(r => r.provider || r.invoiceNumber || r.detectedDocType) || primaryData || null;

        results.forEach(result => {
            if (result.date && (!bestDate || result.dateScore > bestDate.dateScore)) {
                bestDate = result;
            }
            if (result.amount) {
                if (!bestAmount || result.amountScore > bestAmount.amountScore || (result.amountScore === bestAmount.amountScore && result.amount > bestAmount.amount)) {
                    bestAmount = result;
                }
            }
            if (!enrichedResult && (result.provider || result.invoiceNumber || result.detectedDocType)) {
                enrichedResult = result;
            }
        });

        let detectedData = '';
        const dateInput = document.getElementById('fecha');
        if (bestDate) {
            dateInput.value = bestDate.date;
            detectedData += `Fecha: ${bestDate.dateRaw} | `;
        } else if (dateInput) {
            dateInput.value = '';
            detectedData += 'Fecha no detectada | ';
        }
        if (bestAmount) {
            document.getElementById('importe').value = bestAmount.amount.toFixed(2);
            detectedData += `Importe: ${bestAmount.amountRaw}`;
        }

        if (enrichedResult?.provider && !document.getElementById('concepto').value.trim()) {
            document.getElementById('concepto').value = enrichedResult.provider;
        }

        const analysis = buildReviewAnalysis(bestDate, bestAmount, enrichedResult);
        updateReviewPanel(analysis);
        ocrStatus.textContent = detectedData ? `Datos detectados: ${detectedData}` : 'No se detectaron datos claros.';
    };

    const extractOCRData = (text, docType) => {
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const normalized = text.replace(/\s+/g, ' ').trim();

        const parseDateToken = (token) => {
            const normalizedToken = token
                .replace(/[Oo]/g, '0')
                .replace(/[Il|!]/g, '1')
                .replace(/[Ss]/g, '5')
                .replace(/[Zz]/g, '2')
                .replace(/[Bb]/g, '8');
            const rawDigits = normalizedToken.replace(/\D/g, '');
            let year, month, day;

            if (rawDigits.length === 8) {
                const first4 = parseInt(rawDigits.slice(0, 4), 10);
                if (first4 >= 2000 && first4 <= 2035) {
                    year = first4;
                    month = parseInt(rawDigits.slice(4, 6), 10);
                    day = parseInt(rawDigits.slice(6, 8), 10);
                } else {
                    day = parseInt(rawDigits.slice(0, 2), 10);
                    month = parseInt(rawDigits.slice(2, 4), 10);
                    year = parseInt(rawDigits.slice(4, 8), 10);
                }
            } else if (rawDigits.length === 6) {
                day = parseInt(rawDigits.slice(0, 2), 10);
                month = parseInt(rawDigits.slice(2, 4), 10);
                year = parseInt(rawDigits.slice(4, 6), 10);
                year += year < 70 ? 2000 : 1900;
            } else {
                const parts = token.replace(/[^0-9]/g, '-').split('-').filter(Boolean);
                if (parts.length < 3) return null;
                if (parts[0].length === 4) {
                    year = parseInt(parts[0], 10);
                    month = parseInt(parts[1], 10);
                    day = parseInt(parts[2], 10);
                } else {
                    day = parseInt(parts[0], 10);
                    month = parseInt(parts[1], 10);
                    year = parseInt(parts[2], 10);
                    if (year < 100) year += year < 70 ? 2000 : 1900;
                }
            }

            if (!year || !month || !day) return null;
            if (year < 2000 || year > 2035) return null;
            const dt = new Date(year, month - 1, day);
            if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
            return dt.toISOString().split('T')[0];
        };

        const findBestDate = () => {
            const dateRegex = /(\d{1,2}\s*[\/\.-]\s*\d{1,2}\s*[\/\.-]\s*\d{2,4})|(\d{4}\s*[\/\.-]\s*\d{1,2}\s*[\/\.-]\s*\d{1,2})|(\d{1,2}\s+\d{1,2}\s+\d{2,4})/g;
            const keywordRegex = /(fecha|emision|expedicion|factura)/i;
            const strongKeywordRegex = /(factura|fecha)/i;
            const ticketStrongRegex = /(factura\s*[:#]?\s*\d+)/i;
            const candidates = [];

            const collectDateTokens = (source) => {
                const cleaned = source
                    .replace(/[Oo]/g, '0')
                    .replace(/[Il|!]/g, '1')
                    .replace(/[Ss]/g, '5')
                    .replace(/[Zz]/g, '2')
                    .replace(/[Bb]/g, '8');
                const tokens = [];
                const matches = cleaned.match(dateRegex) || [];
                matches.forEach(match => tokens.push(match));

                const normalizedSep = cleaned.replace(/[^0-9]/g, '/');
                const sepMatches = normalizedSep.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})|(\d{4}\/\d{1,2}\/\d{1,2})/g) || [];
                sepMatches.forEach(match => tokens.push(match));

                const digitMatches = cleaned.match(/\d{8}|\d{6}/g) || [];
                digitMatches.forEach(match => tokens.push(match));
                return tokens;
            };

            const scanText = (source, weight, requireKeyword) => {
                if (requireKeyword && !keywordRegex.test(source)) return;
                const matches = collectDateTokens(source);
                matches.forEach(match => candidates.push({ match, weight }));
            };

            lines.forEach(line => {
                let weight = keywordRegex.test(line) ? 2 : 1;
                if (strongKeywordRegex.test(line)) weight += 1;
                if (docType === 'Ticket' && ticketStrongRegex.test(line)) weight += 2;
                scanText(line, weight, false);
                if (docType === 'Ticket') scanText(line, weight + 1, true);
            });
            scanText(normalized, 0.5, false);

            const parsedCandidates = [];
            candidates.forEach(candidate => {
                const parsed = parseDateToken(candidate.match);
                if (parsed) parsedCandidates.push({ parsed, raw: candidate.match, score: candidate.weight });
            });
            if (!parsedCandidates.length) return null;
            parsedCandidates.sort((a, b) => b.score - a.score || b.parsed.localeCompare(a.parsed));
            return parsedCandidates[0];
        };

        const parseAmountToken = (token) => {
            const cleaned = token.replace(/\s/g, '');
            let normalizedNumber = cleaned;
            if (cleaned.includes(',') && cleaned.includes('.')) {
                normalizedNumber = cleaned.replace(/\./g, '').replace(',', '.');
            } else if (cleaned.includes(',')) {
                normalizedNumber = cleaned.replace(',', '.');
            }
            const value = parseFloat(normalizedNumber);
            return Number.isFinite(value) && value > 0 ? value : null;
        };

        const findBestAmount = () => {
            const amountRegex = /(\d{1,3}(?:[\.\s]\d{3})*(?:[\.,]\d{2})|\d+(?:[\.,]\d{2}))/g;
            const strongKeywordRegex = /(total(\s*a\s*pagar)?|importe\s*total|total\s*factura|total\s*general)/i;
            const softKeywordRegex = /(total|importe|€)/i;
            const penalizeKeywordRegex = /(subtotal|igic|iva|base)/i;
            const totalEurosRegex = /(total\s+euros|total\s+€|total\s*eur|total\s*euros)/i;
            const candidates = [];

            const scanLine = (source, baseWeight) => {
                const matches = source.match(amountRegex) || [];
                matches.forEach(match => candidates.push({ match, weight: baseWeight, line: source }));
            };

            lines.forEach(line => {
                let weight = strongKeywordRegex.test(line) ? 3 : softKeywordRegex.test(line) ? 2 : 1;
                if (totalEurosRegex.test(line)) weight += 2;
                if (penalizeKeywordRegex.test(line)) weight -= 1;
                scanLine(line, weight);
            });
            scanLine(normalized, 0.5);

            const weighted = [];
            candidates.forEach(candidate => {
                const value = parseAmountToken(candidate.match);
                if (!value) return;
                let bonus = 0;
                if (value >= 500) bonus += 2;
                else if (value >= 100) bonus += 1;
                let weight = candidate.weight + bonus;
                if (docType === 'Ticket' && value < 5) weight -= 1;
                weighted.push({ value, raw: candidate.match, weight, line: candidate.line });
            });

            if (!weighted.length) return null;

            const maxValue = Math.max(...weighted.map(item => item.value));
            const filteredByValue = maxValue >= 100
                ? weighted.filter(item => item.value >= 10)
                : weighted;

            const strongCandidates = filteredByValue.filter(item => item.weight >= 3);
            const softCandidates = filteredByValue.filter(item => item.weight >= 2);
            const pool = strongCandidates.length ? strongCandidates : softCandidates.length ? softCandidates : filteredByValue;

            pool.sort((a, b) => b.weight - a.weight || b.value - a.value);
            return { value: pool[0].value, raw: pool[0].raw, score: pool[0].weight };
        };

        const dateResult = findBestDate();
        const amountResult = findBestAmount();

        const provider = detectProvider(lines);
        const invoiceNumber = detectInvoiceNumber(lines, normalized);
        const detectedDocType = inferDocumentType(normalized, docType);

        return {
            date: dateResult ? dateResult.parsed : null,
            dateRaw: dateResult ? dateResult.raw : null,
            dateScore: dateResult ? dateResult.score : 0,
            amount: amountResult ? amountResult.value : null,
            amountRaw: amountResult ? amountResult.raw : null,
            amountScore: amountResult ? amountResult.score : 0,
            provider,
            invoiceNumber,
            detectedDocType,
            rawText: normalized
        };
    };

    const detectProvider = (lines) => {
        const blocked = /fecha|factura|ticket|total|importe|igic|iva|base|cliente|cif|nif|pagina|albaran/i;
        const candidate = lines
            .map(line => line.replace(/\s+/g, ' ').trim())
            .find(line => line.length >= 4 && line.length <= 45 && /[A-Za-zÁÉÍÓÚÑ]/.test(line) && !blocked.test(line) && !/^\d/.test(line));
        return candidate || null;
    };

    const detectInvoiceNumber = (lines, normalized) => {
        const fromText = normalized.match(/(?:factura|fra|ticket|doc)\s*(?:n[oº°.]?|num(?:ero)?)?\s*[:#-]?\s*([A-Z0-9\-\/]{4,})/i);
        if (fromText) return fromText[1];
        const lineCandidate = lines.find(line => /[A-Z]{1,4}\-?\d{3,}/i.test(line));
        const match = lineCandidate?.match(/([A-Z]{1,4}\-?\d{3,})/i);
        return match ? match[1] : null;
    };

    const inferDocumentType = (normalized, fallback) => {
        if (/ticket/i.test(normalized)) return 'Ticket';
        if (/factura|fra\.?/i.test(normalized)) return 'Factura';
        return fallback || 'No claro';
    };

    const detectDuplicateRisk = (date, amount, provider) => {
        if (!date || !amount) return { label: 'No evaluable', level: 'neutral' };
        const matches = allMovements.filter(mov => {
            const sameDate = mov.Fecha === new Date(date).toLocaleDateString('es-ES');
            const sameAmount = Math.abs((mov.Importe || 0) - amount) < 0.01;
            const sameProvider = provider && mov.Concepto && mov.Concepto.toLowerCase().includes(provider.toLowerCase());
            return sameDate && sameAmount && (sameProvider || !provider);
        });
        if (matches.length >= 1) return { label: `Posible duplicado (${matches.length})`, level: 'bad' };
        return { label: 'Sin indicios', level: 'good' };
    };

    const buildReviewAnalysis = (bestDate, bestAmount, enrichedResult) => {
        const warnings = [];
        const provider = enrichedResult?.provider || null;
        const invoiceNumber = enrichedResult?.invoiceNumber || null;
        const detectedDocType = enrichedResult?.detectedDocType || null;
        const duplicateRisk = detectDuplicateRisk(bestDate?.date, bestAmount?.amount, provider);

        let score = 0;
        if (bestDate?.date) score += Math.min(25, 10 + (bestDate.dateScore || 0) * 5);
        else warnings.push('No se detectó fecha con suficiente claridad.');

        if (bestAmount?.amount) score += Math.min(30, 10 + (bestAmount.amountScore || 0) * 5);
        else warnings.push('No se detectó importe fiable.');

        if (provider) score += 20;
        else warnings.push('No se detectó proveedor; conviene rellenarlo a mano.');

        if (invoiceNumber) score += 10;
        else warnings.push('No se encontró número de factura/ticket.');

        if (duplicateRisk.level === 'bad') {
            warnings.push('Puede ser un documento ya registrado: revisa fecha, importe y proveedor.');
            score -= 20;
        }

        if (detectedDocType && docTypeSelect.value !== detectedDocType && detectedDocType !== 'No claro') {
            warnings.push(`El OCR sugiere ${detectedDocType}, pero el formulario está en ${docTypeSelect.value}.`);
        }

        score = Math.max(0, Math.min(100, Math.round(score)));

        return {
            provider,
            invoiceNumber,
            detectedDocType,
            duplicateRisk,
            confidenceScore: score,
            warnings
        };
    };

    const generateThumbnail = (dataUrl, callback) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX_SIZE = 150;
            let { width, height } = img;
            if (width > height) {
                if (width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                }
            } else {
                if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
            }
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            callback(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.src = dataUrl;
    };

    const resetFileInput = () => {
        fileInput.value = '';
        cameraInput.value = '';
        previewContainer.classList.add('hidden');
        thumbnail.src = '#';
        ocrStatus.textContent = '';
        attachedFile = { base64: null, name: null, type: null, thumbnail: null };
        updateReviewPanel(null);
    };

    const toggleButtonLoading = (isLoading) => {
        saveButton.disabled = isLoading;
        saveButton.querySelector('.btn-text').classList.toggle('hidden', isLoading);
        saveButton.querySelector('.loader').classList.toggle('hidden', !isLoading);
    };

    const toggleLoading = (isLoading, message) => {
        if (isLoading) {
            tableBody.innerHTML = '';
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 7;
            td.style.textAlign = 'center';
            td.textContent = message;
            tr.appendChild(td);
            tableBody.appendChild(tr);
        }
    };

    window.__gestionDebug = {
        getOfflineQueue,
        getOfflineQueueCount,
        processSyncQueue,
        runOfflineQueueSelfTest,
        loadPendingItems,
        loadMovements,
        readPendingStorage: () => readStoredArray(PENDING_STORAGE_KEY),
        readMovementCache: () => loadMovementCache(),
        clearOfflineQueue: () => saveOfflineQueue([]),
        clearPendingStorage: () => writeStoredArray(PENDING_STORAGE_KEY, []),
        clearMovementCache: () => saveMovementCache([]),
        enqueueSyncOperation
    };

    // --- INICIAR LA APP ---
    init();
});
