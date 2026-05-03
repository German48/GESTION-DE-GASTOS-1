/**
 * Cliente de Supabase para la aplicación de Gestión Financiera
 * Proporciona funciones para interactuar con la base de datos y el almacenamiento
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, FACTURAS_BUCKET } from './supabase-config.js';

// Inicializar cliente de Supabase
// Nota: Necesitas incluir la librería de Supabase en el HTML
let supabase;
const MOVIMIENTOS_TABLE = 'camisetas_movimientos';
const MOVIMIENTOS_SELECT = '*';

const pickPresentEntries = (entries) => Object.fromEntries(
    entries.filter(([, value]) => value !== undefined && value !== null && value !== '')
);

const isSchemaMismatchError = (error) => {
    const message = [error?.message, error?.details, error?.hint]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return message.includes('column')
        || message.includes('schema cache')
        || message.includes('could not find')
        || message.includes('does not exist');
};

const buildMovimientoPayloadVariants = (movimiento) => {
    const base = [
        ['tipo', movimiento.tipo],
        ['fecha', movimiento.fecha],
        ['concepto', movimiento.concepto],
        ['importe', Number.parseFloat(movimiento.importe)],
        ['tipo_documento', movimiento.tipo_documento],
        ['ocr_detectado', movimiento.ocr_detectado]
    ];

    return [
        pickPresentEntries([
            ...base,
            ['categoria', movimiento.categoria],
            ['descripcion', movimiento.observaciones],
            ['url_documento', movimiento.url_pdf]
        ]),
        pickPresentEntries([
            ...base,
            ['categoría', movimiento.categoria],
            ['descripcion', movimiento.observaciones],
            ['url_documento', movimiento.url_pdf]
        ]),
        pickPresentEntries([
            ...base,
            ['categoria', movimiento.categoria],
            ['observaciones', movimiento.observaciones],
            ['url_pdf', movimiento.url_pdf]
        ]),
        pickPresentEntries([
            ...base,
            ['categoría', movimiento.categoria],
            ['observaciones', movimiento.observaciones],
            ['url_pdf', movimiento.url_pdf]
        ])
    ];
};

const isLikelyNetworkError = (error) => {
    const rawMessage = [error?.message, error?.details, error?.hint]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return !navigator.onLine
        || error instanceof TypeError
        || rawMessage.includes('failed to fetch')
        || rawMessage.includes('networkerror')
        || rawMessage.includes('fetch');
};

const buildSupabaseError = (error, operation) => {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const appError = new Error(error?.message || `No se pudo ${operation} en Supabase.`);

    appError.cause = error;
    appError.operation = operation;
    appError.code = isLikelyNetworkError(error) ? 'OFFLINE_OR_NETWORK' : 'SUPABASE_ERROR';
    appError.userMessage = appError.code === 'OFFLINE_OR_NETWORK'
        ? `Sin conexión con Supabase. No se pudo ${operation}.`
        : `Supabase devolvió un error al ${operation}.`;
    appError.isOffline = offline;

    return appError;
};

const buildRestUrl = (table, query = {}) => {
    const url = new URL(`/rest/v1/${table}`, SUPABASE_URL);

    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, value);
        }
    });

    return url.toString();
};

const restRequest = async (table, {
    method = 'GET',
    query = {},
    body,
    prefer,
    headers = {}
} = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
        const response = await fetch(buildRestUrl(table, query), {
            method,
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                ...headers,
                ...(prefer ? { Prefer: prefer } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
            throw payload || { message: text || `HTTP ${response.status}`, status: response.status };
        }

        return payload;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw buildSupabaseError({ message: 'Tiempo de espera agotado (timeout)' }, `consultar ${table}`);
        }
        throw buildSupabaseError(error, `consultar ${table}`);
    }
};

/**
 * Inicializar el cliente de Supabase.
 * Requiere que la librería de Supabase esté presente en el ámbito global (window.supabase).
 * 
 * @returns {Object|null} El cliente de Supabase inicializado o null si falla.
 */
export function initSupabase() {
    if (typeof window.supabase === 'undefined') {
        console.error('La librería de Supabase no está cargada. Asegúrate de incluir el script en el HTML.');
        return null;
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabase;
}

/**
 * Obtener todos los movimientos con filtros opcionales
 * @param {Object} filters - Filtros opcionales (mes, categoria, concepto)
 * @returns {Promise<Array>} Lista de movimientos
 */
export async function getMovimientos(filters = {}) {
    const query = {
        select: MOVIMIENTOS_SELECT,
        order: 'fecha.desc'
    };

    if (filters.month) {
        const [year, month] = filters.month.split('-');
        const startDate = `${year}-${month}-01`;
        const endDate = new Date(year, month, 0).toISOString().split('T')[0];
        query.and = `(fecha.gte.${startDate},fecha.lte.${endDate})`;
    }

    if (filters.concepto) {
        query.concepto = `ilike.*${String(filters.concepto).replace(/\*/g, '')}*`;
    }

    try {
        return await restRequest(MOVIMIENTOS_TABLE, { query });
    } catch (error) {
        throw buildSupabaseError(error?.cause || error, 'obtener los movimientos');
    }
}

/**
 * Crear un nuevo registro de movimiento financiero.
 * 
 * @param {Object} movimiento - Objeto con los datos del movimiento.
 * @param {string} movimiento.tipo - 'Ingreso' o 'Gasto'.
 * @param {string} movimiento.fecha - Fecha en formato YYYY-MM-DD.
 * @param {string} movimiento.concepto - Descripción del movimiento.
 * @param {string} movimiento.categoria - Categoría del movimiento.
 * @param {number|string} movimiento.importe - Monto decimal.
 * @param {string} [movimiento.observaciones] - Notas adicionales.
 * @param {string} [movimiento.tipo_documento] - 'Factura', 'Ticket', etc.
 * @param {string} [movimiento.url_pdf] - Enlace al documento adjunto.
 * @returns {Promise<Object>} El registro creado.
 */
export async function createMovimiento(movimiento) {
    const payloadVariants = buildMovimientoPayloadVariants(movimiento);
    let lastError = null;

    for (const payload of payloadVariants) {
        try {
            const data = await restRequest(MOVIMIENTOS_TABLE, {
                method: 'POST',
                body: payload,
                prefer: 'return=representation'
            });
            return Array.isArray(data) ? data[0] : data;
        } catch (error) {
            lastError = error?.cause || error;
            if (!isSchemaMismatchError(lastError)) {
                break;
            }
        }
    }

    throw buildSupabaseError(lastError, 'guardar el movimiento');
}

/**
 * Eliminar un movimiento por ID
 * @param {number} id - ID del movimiento
 * @returns {Promise<boolean>} True si se eliminó correctamente
 */
export async function deleteMovimiento(id) {
    try {
        await restRequest(MOVIMIENTOS_TABLE, {
            method: 'DELETE',
            query: { id: `eq.${id}` }
        });
    } catch (error) {
        throw buildSupabaseError(error?.cause || error, 'eliminar el movimiento');
    }

    return true;
}

/**
 * Crear un documento pendiente de revisión.
 * Nota: requiere tabla `documentos_pendientes` en Supabase.
 */
export async function createDocumentoPendiente(documento) {
    const { data, error } = await supabase
        .from('documentos_pendientes')
        .insert([documento])
        .select()
        .single();

    if (error) {
        throw buildSupabaseError(error, 'guardar el pendiente');
    }

    return data;
}

/**
 * Recuperar la lista de documentos que están pendientes de revisión por el usuario.
 * 
 * @returns {Promise<Array>} Lista de registros pendientes.
 */
export async function getDocumentosPendientes() {
    const { data, error } = await supabase
        .from('documentos_pendientes')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        throw buildSupabaseError(error, 'obtener los pendientes');
    }

    return data;
}

/**
 * Marcar documento pendiente como validado o cambiar su estado.
 */
export async function updateDocumentoPendiente(id, patch) {
    const { data, error } = await supabase
        .from('documentos_pendientes')
        .update(patch)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw buildSupabaseError(error, 'actualizar el pendiente');
    }

    return data;
}

/**
 * Subir una factura al almacenamiento de Supabase
 * @param {File} file - Archivo a subir
 * @param {string} fileName - Nombre del archivo
 * @returns {Promise<string>} URL pública del archivo
 */
export async function uploadFactura(file, fileName) {
    const { data, error } = await supabase.storage
        .from(FACTURAS_BUCKET)
        .upload(fileName, file, {
            cacheControl: '3600',
            upsert: false
        });

    if (error) {
        throw buildSupabaseError(error, 'subir la factura');
    }

    // Obtener URL pública
    const { data: { publicUrl } } = supabase.storage
        .from(FACTURAS_BUCKET)
        .getPublicUrl(fileName);

    return publicUrl;
}

/**
 * Subir factura desde base64
 * @param {string} base64Data - Datos en base64
 * @param {string} fileName - Nombre del archivo
 * @param {string} contentType - Tipo de contenido (ej: 'image/jpeg')
 * @returns {Promise<string>} URL pública del archivo
 */
export async function uploadFacturaBase64(base64Data, fileName, contentType) {
    // Convertir base64 a blob
    const base64Response = await fetch(base64Data);
    const blob = await base64Response.blob();

    const { data, error } = await supabase.storage
        .from(FACTURAS_BUCKET)
        .upload(fileName, blob, {
            contentType: contentType,
            cacheControl: '3600',
            upsert: false
        });

    if (error) {
        throw buildSupabaseError(error, 'subir la factura');
    }

    // Obtener URL pública
    const { data: { publicUrl } } = supabase.storage
        .from(FACTURAS_BUCKET)
        .getPublicUrl(fileName);

    return publicUrl;
}

/**
 * Eliminar una factura del almacenamiento
 * @param {string} fileName - Nombre del archivo
 * @returns {Promise<boolean>} True si se eliminó correctamente
 */
export async function deleteFactura(fileName) {
    const { error } = await supabase.storage
        .from(FACTURAS_BUCKET)
        .remove([fileName]);

    if (error) {
        throw buildSupabaseError(error, 'eliminar la factura');
    }

    return true;
}

/**
 * Obtener estadísticas de movimientos
 * @returns {Promise<Object>} Estadísticas (total ingresos, gastos, balance)
 */
export async function getEstadisticas() {
    let data;
    try {
        data = await restRequest(MOVIMIENTOS_TABLE, {
            query: { select: 'importe,tipo' }
        });
    } catch (error) {
        throw buildSupabaseError(error?.cause || error, 'obtener las estadísticas');
    }

    const stats = data.reduce((acc, mov) => {
        const importe = Number(mov.importe || 0);
        const tipo = String(mov.tipo || '').toLowerCase();

        if (tipo === 'ingreso') {
            acc.totalIngresos += importe;
        } else {
            acc.totalGastos += importe;
        }
        return acc;
    }, { totalIngresos: 0, totalGastos: 0 });

    stats.balance = stats.totalIngresos - stats.totalGastos;

    return stats;
}

export { supabase };
