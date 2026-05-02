/**
 * Cliente de Supabase para la aplicación de Gestión Financiera
 * Proporciona funciones para interactuar con la base de datos y el almacenamiento
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, FACTURAS_BUCKET } from './supabase-config.js';

// Inicializar cliente de Supabase
// Nota: Necesitas incluir la librería de Supabase en el HTML
let supabase;

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
    let query = supabase
        .from('movimientos')
        .select('*')
        .order('fecha', { ascending: false });

    // Aplicar filtros
    if (filters.month) {
        const [year, month] = filters.month.split('-');
        const startDate = `${year}-${month}-01`;
        const endDate = new Date(year, month, 0).toISOString().split('T')[0];
        query = query.gte('fecha', startDate).lte('fecha', endDate);
    }

    if (filters.categoria) {
        query = query.eq('categoria', filters.categoria);
    }

    if (filters.concepto) {
        query = query.ilike('concepto', `%${filters.concepto}%`);
    }

    const { data, error } = await query;

    if (error) {
        console.error('Error al obtener movimientos:', error);
        throw error;
    }

    return data;
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
    const payload = {
        tipo: movimiento.tipo,
        fecha: movimiento.fecha,
        concepto: movimiento.concepto,
        categoria: movimiento.categoria,
        importe: parseFloat(movimiento.importe),
        observaciones: movimiento.observaciones || null,
        tipo_documento: movimiento.tipo_documento || 'Factura',
        ocr_detectado: movimiento.ocr_detectado || null,
        url_pdf: movimiento.url_pdf || null
    };

    const { data, error } = await supabase
        .from('movimientos')
        .insert([payload])
        .select()
        .single();

    if (error) {
        console.error('Error al crear movimiento:', error);
        throw error;
    }

    return data;
}

/**
 * Eliminar un movimiento por ID
 * @param {number} id - ID del movimiento
 * @returns {Promise<boolean>} True si se eliminó correctamente
 */
export async function deleteMovimiento(id) {
    const { error } = await supabase
        .from('movimientos')
        .delete()
        .eq('id', id);

    if (error) {
        console.error('Error al eliminar movimiento:', error);
        throw error;
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
        console.error('Error al crear documento pendiente:', error);
        throw error;
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
        console.error('Error al obtener documentos pendientes:', error);
        throw error;
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
        console.error('Error al actualizar documento pendiente:', error);
        throw error;
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
        console.error('Error al subir factura:', error);
        throw error;
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
        console.error('Error al subir factura:', error);
        throw error;
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
        console.error('Error al eliminar factura:', error);
        throw error;
    }

    return true;
}

/**
 * Obtener estadísticas de movimientos
 * @returns {Promise<Object>} Estadísticas (total ingresos, gastos, balance)
 */
export async function getEstadisticas() {
    const { data, error } = await supabase
        .from('movimientos')
        .select('tipo, importe');

    if (error) {
        console.error('Error al obtener estadísticas:', error);
        throw error;
    }

    const stats = data.reduce((acc, mov) => {
        if (mov.tipo === 'Ingreso') {
            acc.totalIngresos += mov.importe;
        } else {
            acc.totalGastos += mov.importe;
        }
        return acc;
    }, { totalIngresos: 0, totalGastos: 0 });

    stats.balance = stats.totalIngresos - stats.totalGastos;

    return stats;
}

export { supabase };
