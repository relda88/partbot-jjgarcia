const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ===== CONFIGURACIÓN =====
const PORT = process.env.PORT || 10161;
const TIENDA_ID = parseInt(process.env.TIENDA_ID) || 161;
const DB_HOST = process.env.DB_HOST || 'one4cars.com';
const DB_USER = process.env.DB_USER || 'juant200_one4car';
const DB_PASS = process.env.DB_PASS || 'Notieneclave1*';
const DB_NAME = process.env.DB_NAME || 'juant200_bot_clientes';

process.on('unhandledRejection', (err) => {
    console.log("[PARTBOT] Error no capturado:", err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.log("[PARTBOT] Error crítico:", err?.message || err);
});

const pool = mysql.createPool({
    host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME,
    waitForConnections: true, connectionLimit: 5, queueLimit: 0
});

// ===== MAPAS DE SESIÓN =====
const carritoCompras = new Map();
const pendientesConfirmacion = new Map();
const esperandoDelivery = new Map();
const multiItemOrders = new Map();
const pendingProductSelection = new Map();
const clientNames = new Map();

let qrCodeData = "Iniciando...";
let socketBot = null;
let tiendaInfo = null;

function normalizar(texto) {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?!]/g, "").toLowerCase().trim();
}

function formatWhatsApp(jid) {
    if (!jid) return null;
    if (jid.toString().includes('@')) return jid;
    let clean = jid.toString().replace(/\D/g, '');
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (!clean.startsWith('58')) clean = '58' + clean;
    return `${clean}@s.whatsapp.net`;
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function safeSendMessage(jid, content) {
    try {
        if (!socketBot) return;
        await socketBot.sendMessage(jid, content);
        if (content.text) {
            const nombres = clientNames.get(jid) || null;
            await guardarHistorial(jid.split('@')[0], 'model', content.text, nombres);
        }
    } catch (e) { console.log("[PARTBOT] Error enviando mensaje:", e.message); }
}

function isBotReady() {
    return socketBot && socketBot.user && socketBot.user.id;
}

const MENU_TEXT = `🎯 *REPUESTOS JJ GARCIA, C.A* 🚗

1️⃣ *Buscar productos*
2️⃣ *Ver carrito*
3️⃣ *Finalizar pedido*
4️⃣ *Delivery disponible*
5️⃣ *Hablar con asesor*

_Escriba el número de la opción o directamente el producto que necesita._`;

function obtenerSaludo(nombre) {
    const saludos = [
        `Saludos, se ha comunicado con *REPUESTOS JJ GARCIA, C.A*. ¡Dios le bendiga, *${nombre}*! 🙏 ¿Qué se le ofrece el día de hoy?`,
        `¡Hola, *${nombre}*! Qué gusto saludarle. 😊 Es un placer atenderle desde *REPUESTOS JJ GARCIA, C.A*. ¿En qué podemos servirle?`,
        `¡Buenos días / tardes, *${nombre}*! Bienvenido a *REPUESTOS JJ GARCIA, C.A*. A la orden para lo que necesite. 🚗`,
        `¡Hola, *${nombre}*! Reciba un cordial saludo de parte de *REPUESTOS JJ GARCIA, C.A*. ¿Cómo podemos ayudarle hoy? 🙌`
    ];
    return saludos[Math.floor(Math.random() * saludos.length)];
}

const DESPEDIDAS = [
    `¡Ha sido un placer atenderle desde *REPUESTOS JJ GARCIA, C.A*! Que Dios le bendiga y quede muy pendiente cualquier cosita. 🙏`,
    `Un honor poder ayudarle. *REPUESTOS JJ GARCIA, C.A* es su casa. ¡Aquí siempre será bienvenido! 🏠`,
    `Con mucho gusto, para eso estamos. *REPUESTOS JJ GARCIA, C.A* le agradece su preferencia. Que tenga un excelente día. 😊`,
    `¡De nada! Recuerde que *REPUESTOS JJ GARCIA, C.A* está a la orden para lo que necesite. 🚗`
];

async function cargarTienda() {
    try {
        const [rows] = await pool.execute("SELECT * FROM partbot_tiendas WHERE tienda_id = ? AND activo = 'SI' LIMIT 1", [TIENDA_ID]);
        if (rows.length > 0) {
            tiendaInfo = rows[0];
            console.log(`[PARTBOT] Tienda: ${tiendaInfo.nombre}`);
        } else {
            console.log("[PARTBOT] ERROR: Tienda no encontrada o inactiva");
        }
    } catch (e) { console.log("[PARTBOT] Error cargando tienda:", e.message); }
}

async function obtenerTasa(tiendaId) {
    try {
        const [rows] = await pool.execute("SELECT porcentaje FROM partbot_tasa_cambio WHERE tienda_id = ? ORDER BY id_tasa DESC LIMIT 1", [tiendaId]);
        if (rows.length > 0) return parseFloat(rows[0].porcentaje) || 1;
    } catch (e) {}
    return 1;
}

async function buscarProductoPorCodigo(codigo, tiendaId) {
    try {
        const sql = `SELECT id_producto, producto, descripcion, tipo, precio_minimo, (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0)) as stock_total, cantidad_fabricando FROM partbot_productos WHERE tienda_id = ? AND producto = ? AND activo = 'SI' LIMIT 1`;
        const [rows] = await pool.execute(sql, [tiendaId, codigo.trim()]);
        if (rows.length > 0) return rows;
    } catch (e) { console.log("[PARTBOT] Error buscando código:", e.message); }
    return null;
}

async function buscarProductoPorTexto(texto, tiendaId) {
    const stopWords = ['tienes', 'la', 'del', 'quiere', 'saber', 'cuanto', 'mide', 'venden', 'donde',
        'precio', 'tienen', 'el', 'una', 'un', 'hay', 'si', 'es', 'de', 'con', 'para',
        'busco', 'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'como', 'estas',
        'esta', 'queria', 'preguntarte', 'gracias', 'por', 'favor', 'ayuda', 'puedes',
        'quisiera', 'necesito', 'saludos', 'muchas', 'todo', 'dia', 'tarde', 'noche',
        'se', 'me', 'le', 'te', 'lo', 'los', 'las', 'les', 'su', 'sus', 'mi', 'mis',
        'tu', 'tus', 'que', 'cual', 'cuando', 'porque', 'pues', 'pero', 'mas', 'muy',
        'puede', 'puedo', 'pueden', 'hacer', 'hace', 'hacen', 'tener', 'tiene',
        'quiero', 'quiere', 'quieren', 'necesita', 'necesitan', 'unid', 'unidad', 'unidades',
        'vale', 'va', 'vamos', 'ok', 'okey', 'pana', 'brother', 'bro', 'amigo',
        'estoy', 'estas', 'esta', 'vengo', 'vienes', 'viene', 'voy', 'vas',
        'repuesto', 'repuestos', 'catalogo', 'existencia', 'disponibilidad'];
    const txtNormal = normalizar(texto);
    const palabrasBase = txtNormal.split(' ').filter(p => p.length > 2 && !stopWords.includes(p));
    if (palabrasBase.length === 0) return null;

    const expandirFormas = (pal) => {
        const f = [pal];
        if (pal.endsWith('es') && pal.length > 4) f.push(pal.slice(0, -2));
        if (pal.endsWith('s') && pal.length > 3 && !pal.endsWith('es')) f.push(pal.slice(0, -1));
        if (!pal.endsWith('s')) { f.push(pal + 's'); if (pal.endsWith('z')) f.push(pal.slice(0, -1) + 'ces'); }
        return [...new Set(f)];
    };

    let whereClause = "", queryParams = [];
    palabrasBase.forEach((pal, index) => {
        const formas = expandirFormas(pal);
        const conditions = formas.map(() => "descripcion LIKE ?");
        whereClause += `(${conditions.join(" OR ")})`;
        if (index < palabrasBase.length - 1) whereClause += " AND ";
        formas.forEach(f => queryParams.push(`%${f}%`));
    });

    try {
        const sql = `SELECT id_producto, producto, descripcion, tipo, precio_minimo, (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0)) as stock_total, cantidad_fabricando FROM partbot_productos WHERE tienda_id = ? AND activo = 'SI' AND (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0) > 0 OR COALESCE(cantidad_fabricando,0) > 0) AND (${whereClause}) LIMIT 8`;
        const [rows] = await pool.execute(sql, [tiendaId, ...queryParams]);
        if (rows.length > 0) return rows;
    } catch (e) { console.log("[PARTBOT] Error búsqueda 1:", e.message); }

    const expandedTerms = [...new Set(palabrasBase.flatMap(expandirFormas))];
    const orConditions = expandedTerms.map(() => "descripcion LIKE ?");
    const orParams = expandedTerms.map(p => `%${p}%`);

    const relevanceParts = palabrasBase.map(p => {
        const formas = expandirFormas(p);
        const cases = formas.map(f => `descripcion LIKE '%${f.replace(/[^a-z]/g, '')}%'`);
        return `(CASE WHEN ${cases.join(' OR ')} THEN 1 ELSE 0 END)`;
    });
    const relevanceSQL = relevanceParts.join(' + ');
    let minRelevance = palabrasBase.length >= 2 ? Math.max(1, palabrasBase.length - 1) : palabrasBase.length;

    try {
        const sql = `SELECT id_producto, producto, descripcion, tipo, precio_minimo, (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0)) as stock_total, cantidad_fabricando FROM partbot_productos WHERE tienda_id = ? AND activo = 'SI' AND (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0) > 0 OR COALESCE(cantidad_fabricando,0) > 0) AND (${orConditions.join(" OR ")}) HAVING (${relevanceSQL}) >= ? ORDER BY ${relevanceSQL} DESC LIMIT 8`;
        const [rows] = await pool.execute(sql, [tiendaId, ...orParams, minRelevance]);
        if (rows.length > 0) return rows;
    } catch (e) { console.log("[PARTBOT] Error búsqueda 2:", e.message); }

    if (minRelevance > 1 && palabrasBase.length > 1) {
        try {
            const sql = `SELECT id_producto, producto, descripcion, tipo, precio_minimo, (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0)) as stock_total, cantidad_fabricando FROM partbot_productos WHERE tienda_id = ? AND activo = 'SI' AND (COALESCE(cantidad_existencia,0) + COALESCE(cantidad_existencia_almacen,0) > 0 OR COALESCE(cantidad_fabricando,0) > 0) AND (${orConditions.join(" OR ")}) HAVING (${relevanceSQL}) >= 1 ORDER BY ${relevanceSQL} DESC LIMIT 8`;
            const [rows] = await pool.execute(sql, [tiendaId, ...orParams]);
            if (rows.length > 0) return rows;
        } catch (e) { console.log("[PARTBOT] Error búsqueda 3:", e.message); }
    }

    return null;
}

async function obtenerZonas(tiendaId) {
    try {
        const [rows] = await pool.execute("SELECT id_zona, zona, costo_envio, tiempo_estimado FROM partbot_zonas_envio WHERE tienda_id = ? AND activo = 'SI' ORDER BY zona", [tiendaId]);
        return rows;
    } catch (e) { return []; }
}

async function guardarHistorial(telefono, rol, contenido, nombres) {
    try {
        await pool.execute("INSERT INTO partbot_historial_chat (tienda_id, telefono, nombres, rol, contenido) VALUES (?, ?, ?, ?, ?)", [TIENDA_ID, telefono, nombres || null, rol, contenido]);
    } catch (e) {}
}

async function setModo(tel, modo) {
    try {
        await pool.execute("INSERT INTO partbot_control_chat (tienda_id, telefono, modo) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE modo = VALUES(modo)", [TIENDA_ID, tel, modo]);
    } catch (e) {}
}

async function guardarSesion(tel, datos) {
    try {
        await pool.execute("UPDATE partbot_control_chat SET datos = ? WHERE tienda_id = ? AND telefono = ?", [JSON.stringify(datos), TIENDA_ID, tel]);
    } catch (e) {}
}

const AUTH_DIR = path.join(__dirname, `auth_info_partbot_${TIENDA_ID}`);

async function backupAuthToMySQL() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return;
        const files = fs.readdirSync(AUTH_DIR).filter(f => f.endsWith('.json'));
        const authData = {};
        for (const f of files) {
            try { authData[f] = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, f), 'utf-8')); } catch (e) {}
        }
        if (Object.keys(authData).length === 0) return;
        await pool.execute(
            "INSERT INTO partbot_auth_store (tienda_id, auth_data) VALUES (?, ?) ON DUPLICATE KEY UPDATE auth_data = VALUES(auth_data)",
            [TIENDA_ID, JSON.stringify(authData)]
        );
    } catch (e) { console.log("[PARTBOT] Error backup auth:", e.message); }
}

async function restoreAuthFromMySQL() {
    try {
        if (fs.existsSync(AUTH_DIR)) return;
        const [rows] = await pool.execute("SELECT auth_data FROM partbot_auth_store WHERE tienda_id = ?", [TIENDA_ID]);
        if (rows.length === 0) return;
        const authData = JSON.parse(rows[0].auth_data);
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const [filename, content] of Object.entries(authData)) {
            try { fs.writeFileSync(path.join(AUTH_DIR, filename), JSON.stringify(content)); } catch (e) {}
        }
        console.log(`[PARTBOT] Auth restaurada desde MySQL (${Object.keys(authData).length} archivos)`);
    } catch (e) { console.log("[PARTBOT] Error restore auth:", e.message); }
}

setInterval(backupAuthToMySQL, 5 * 60 * 1000);

function parseMultiItemMessage(rawText) {
    if (!rawText || rawText.length < 10 || rawText.length > 1000) return null;
    let text = rawText.replace(/\s+y\s+/gi, ',').trim();
    const items = [];
    const parts = text.split(/(?=\b\d{1,4}\s+[a-zA-ZáéíóúñüÁÉÍÓÚÑÜ])/);
    for (const part of parts) {
        const m = part.match(/^\s*(\d{1,4})\s+(.+)/);
        if (m) {
            let desc = m[2].trim().replace(/[,\s]+$/g, '').replace(/\s+y\s*$/i, '').trim();
            if (desc.length > 2) items.push({ cantidad: parseInt(m[1]), descripcion: desc });
        }
    }
    const kw = ['filtro', 'aceite', 'bujia', 'freno', 'pastilla', 'disco', 'correa', 'rodamiento',
        'amortiguador', 'reten', 'empaque', 'caucho', 'bateria', 'radiador', 'alternador',
        'sensor', 'manguera', 'bomba', 'inyector', 'tripoide', 'rolinera', 'cable', 'llanta',
        'embrague', 'luz', 'farol', 'espejo', 'parabrisas', 'silenciador'];
    const txtN = normalizar(rawText);
    const tieneKW = kw.some(k => txtN.includes(k));
    return items.length >= 2 && tieneKW ? items : null;
}

async function processMultiItemProduct(from, item, multiOrder) {
    const pct = await obtenerTasa(TIENDA_ID);
    multiOrder.pct = pct;
    const prods = await buscarProductoPorTexto(item.descripcion, TIENDA_ID);
    if (!prods || prods.length === 0) {
        multiOrder.resolvedItems.push({ descripcion: item.descripcion, cantidad: item.cantidad, error: true });
        multiOrder.currentIndex++;
        await processNextMultiItem(from, multiOrder);
        return;
    }
    if (prods.length === 1) {
        const p = prods[0];
        const precio = parseFloat(p.precio_minimo || 0) / pct;
        multiOrder.resolvedItems.push({ descripcion: item.descripcion, cantidad: item.cantidad, codigo: p.producto, tipo: p.tipo, precio, error: false });
        multiOrder.currentIndex++;
        await processNextMultiItem(from, multiOrder);
        return;
    }
    let msg = `🔍 *Producto ${multiOrder.currentIndex + 1} de ${multiOrder.items.length}:* "${item.descripcion}"\n(Cantidad: ${item.cantidad})\n\n`;
    prods.slice(0, 8).forEach((p, i) => {
        const precio = parseFloat(p.precio_minimo || 0) / pct;
        const stock = parseFloat(p.stock_total || 0);
        const estado = stock > 0 ? "✅" : (parseFloat(p.cantidad_fabricando || 0) > 0 ? "🚚" : "❌");
        msg += `*${i+1}.* ${p.producto} — *$${precio.toFixed(2)}* ${estado}\n   ${p.descripcion.substring(0, 55)}${p.descripcion.length > 55 ? '...' : ''}\n`;
    });
    msg += `\n📌 Responde el *número* del producto para este ítem.\n_O responde 0 para omitir_`;
    pendingProductSelection.set(from, { productos: prods.slice(0, 8), pct, multiItem: true });
    await safeSendMessage(from, { text: msg });
}

async function processNextMultiItem(from, multiOrder) {
    if (multiOrder.currentIndex >= multiOrder.items.length) {
        await showMultiItemCotizacion(from, multiOrder);
        return;
    }
    await processMultiItemProduct(from, multiOrder.items[multiOrder.currentIndex], multiOrder);
}

async function showMultiItemCotizacion(from, multiOrder) {
    const okItems = multiOrder.resolvedItems.filter(it => !it.error);
    const errorItems = multiOrder.resolvedItems.filter(it => it.error);
    if (okItems.length === 0) {
        await safeSendMessage(from, { text: "❌ No se pudo identificar ningún producto. Intenta con descripciones más detalladas." });
        multiItemOrders.delete(from);
        return;
    }
    let gt = 0, msg = `📋 *COTIZACIÓN*\n💰 *Precios en USD*\n\n`;
    okItems.forEach(it => {
        const t = it.precio * it.cantidad; gt += t;
        msg += `*${it.codigo}* ${it.tipo || ''}\n   ${it.cantidad} und x $${it.precio.toFixed(2)} = *$${t.toFixed(2)}*\n\n`;
    });
    msg += `\n*TOTAL: $${gt.toFixed(2)}*`;
    if (errorItems.length > 0) msg += `\n\n⚠️ No encontrados:\n${errorItems.map(e => `❌ "${e.descripcion}"`).join('\n')}`;
    await safeSendMessage(from, { text: msg });
    const dataConfirm = { items: okItems, vendedor: null, pushName: multiOrder.pushName };
    pendientesConfirmacion.set(from, dataConfirm);
    await setModo(from.split('@')[0], 'confirmando');
    await guardarSesion(from.split('@')[0], { tipo: 'confirmando', items: dataConfirm.items, pushName: multiOrder.pushName });
    await sleep(500);
    await safeSendMessage(from, { text: `✅ *¿Desea confirmar este pedido?*\n\nResponda *SI* para continuar o *NO* para cancelar.` });
    multiItemOrders.delete(from);
}

async function iniciarFlujoDelivery(from, pushName) {
    const msg = `🚚 *¿Cómo desea recibir su pedido?*

1️⃣ *Retiro en tienda* — Pasas a buscar
2️⃣ *Delivery* — Te lo llevamos`;
    esperandoDelivery.set(from, { paso: 'tipo_entrega', data: {} });
    await setModo(from.split('@')[0], 'delivery');
    await safeSendMessage(from, { text: msg });
}

async function procesarDelivery(from, text, rawText) {
    const estado = esperandoDelivery.get(from);
    if (!estado) return false;
    if (estado.paso === 'tipo_entrega') {
        if (text === '1' || rawText.toLowerCase().includes('tienda') || rawText.toLowerCase().includes('retiro')) {
            estado.data.tipo_entrega = 'tienda';
            estado.paso = 'confirmar';
            await safeSendMessage(from, { text: `✅ *Retiro en tienda* seleccionado.\n\n¿Confirmas tu pedido? Responde *SI* para confirmar o *NO* para cancelar.` });
            return true;
        }
        if (text === '2' || rawText.toLowerCase().includes('delivery') || rawText.toLowerCase().includes('envio') || rawText.toLowerCase().includes('envío')) {
            estado.data.tipo_entrega = 'delivery';
            estado.paso = 'zona';
            const zonas = await obtenerZonas(TIENDA_ID);
            if (zonas.length === 0) {
                await safeSendMessage(from, { text: "📝 Por favor, indícanos tu *dirección* y *zona* para coordinar el delivery:" });
                estado.paso = 'direccion';
            } else {
                let msg = `📍 *Zonas de delivery disponibles:*\n\n`;
                zonas.forEach((z, i) => { msg += `${i+1}. ${z.zona} — *$${parseFloat(z.costo_envio).toFixed(2)}* (${z.tiempo_estimado || 'Consultar'})\n`; });
                msg += `\n📌 Responde el *número* de tu zona.`;
                estado.zonas = zonas;
                await safeSendMessage(from, { text: msg });
            }
            return true;
        }
        await safeSendMessage(from, { text: "Por favor responde *1* para retiro en tienda o *2* para delivery." });
        return true;
    }
    if (estado.paso === 'zona') {
        const idx = parseInt(text) - 1;
        if (idx >= 0 && idx < estado.zonas.length) {
            const z = estado.zonas[idx];
            estado.data.zona = z.zona;
            estado.data.costo_envio = parseFloat(z.costo_envio);
            estado.paso = 'direccion';
            await safeSendMessage(from, { text: `✅ Zona seleccionada: *${z.zona}* ($${parseFloat(z.costo_envio).toFixed(2)})\n\n📝 Ahora indícanos tu *dirección exacta* para la entrega:` });
        } else {
            await safeSendMessage(from, { text: "Por favor responde un *número* de zona válido." });
        }
        return true;
    }
    if (estado.paso === 'direccion') {
        estado.data.direccion = rawText.trim();
        estado.paso = 'confirmar';
        const costo = estado.data.costo_envio || 0;
        let msg = `📋 *Resumen del pedido*\n\n📍 Dirección: ${estado.data.direccion}\n`;
        if (estado.data.zona) msg += `📍 Zona: ${estado.data.zona}\n`;
        msg += `🚚 Costo envío: $${costo.toFixed(2)}\n\n¿Confirmas? Responde *SI* para confirmar o *NO* para cancelar.`;
        await safeSendMessage(from, { text: msg });
        return true;
    }
    if (estado.paso === 'confirmar') {
        const conf = ['si', 'sí', 'confirmo', 'dale', 'ok', 'claro'];
        const canc = ['no', 'nop', 'cancelar', 'nunca'];
        if (conf.includes(text)) { await finalizarPedido(from, estado.data); return true; }
        if (canc.includes(text)) {
            esperandoDelivery.delete(from);
            await setModo(from.split('@')[0], 'bot');
            await safeSendMessage(from, { text: "❌ Pedido cancelado. Si necesitas algo más, aquí estamos." });
            return true;
        }
        await safeSendMessage(from, { text: "Responde *SI* para confirmar o *NO* para cancelar." });
        return true;
    }
    return false;
}

async function finalizarPedido(from, deliveryData) {
    try {
        const dataConfirm = pendientesConfirmacion.get(from);
        if (!dataConfirm) { await safeSendMessage(from, { text: "❌ No hay un pedido pendiente para confirmar." }); return; }
        const tel = from.split('@')[0];
        const [maxNro] = await pool.execute("SELECT COALESCE(MAX(nro_pedido), 0) + 1 as next FROM partbot_pedidos WHERE tienda_id = ?", [TIENDA_ID]);
        const nro = maxNro[0].next;
        const tot = dataConfirm.items.reduce((s, it) => s + it.precio * it.cantidad, 0);
        const costoEnvio = deliveryData.costo_envio || 0;
        const totalGeneral = tot + costoEnvio;
        await pool.execute(
            `INSERT INTO partbot_pedidos (tienda_id, nro_pedido, id_cliente, nombres, celular, direccion_delivery, zona_delivery, costo_envio, total_productos, total_general, tipo_entrega, estado) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmado')`,
            [TIENDA_ID, nro, dataConfirm.pushName || 'Cliente', tel, deliveryData.direccion || '', deliveryData.zona || '', costoEnvio, tot, totalGeneral, deliveryData.tipo_entrega || 'delivery']
        );
        const [pedido] = await pool.execute("SELECT MAX(id_pedido) as id FROM partbot_pedidos WHERE tienda_id = ?", [TIENDA_ID]);
        const idPed = pedido[0].id;
        for (let i = 0; i < dataConfirm.items.length; i++) {
            const it = dataConfirm.items[i];
            await pool.execute("INSERT INTO partbot_pedidos_reng (id_pedido, nro_reglon, producto, descripcion, cantidad, precio_unitario, precio_total, tipo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [idPed, i + 1, it.codigo, it.descripcion || '', it.cantidad, it.precio, it.precio * it.cantidad, it.tipo || '']);
        }
        let resumen = `✅ *PEDIDO CONFIRMADO #${nro}*\n\n`;
        dataConfirm.items.forEach(it => { resumen += `📦 ${it.codigo} x${it.cantidad} — $${(it.precio * it.cantidad).toFixed(2)}\n`; });
        resumen += `\n💰 Total productos: $${tot.toFixed(2)}`;
        if (costoEnvio > 0) resumen += `\n🚚 Envío: $${costoEnvio.toFixed(2)}`;
        resumen += `\n*💵 Total general: $${totalGeneral.toFixed(2)}*`;
        if (deliveryData.tipo_entrega === 'delivery') { resumen += `\n📍 Dirección: ${deliveryData.direccion || 'Pendiente'}`; if (deliveryData.zona) resumen += `\n📍 Zona: ${deliveryData.zona}`; }
        else { resumen += `\n🏪 Retiro en tienda`; }
        resumen += `\n\n¡Gracias por tu compra! 🙏`;
        await safeSendMessage(from, { text: resumen });
        if (tiendaInfo && tiendaInfo.telefono_dueno) {
            const jidDueno = formatWhatsApp(tiendaInfo.telefono_dueno);
            if (jidDueno) {
                let notif = `📢 *NUEVO PEDIDO #${nro}*\n\nCliente: ${dataConfirm.pushName || tel}\nTel: ${tel}\n`;
                dataConfirm.items.forEach(it => { notif += `📦 ${it.codigo} x${it.cantidad} — $${(it.precio * it.cantidad).toFixed(2)}\n`; });
                notif += `\n💰 Total: $${totalGeneral.toFixed(2)}`;
                if (deliveryData.tipo_entrega === 'delivery') { notif += `\n🚚 Delivery: ${deliveryData.zona || ''} - ${deliveryData.direccion || ''}`; }
                else { notif += `\n🏪 Retiro en tienda`; }
                await safeSendMessage(jidDueno, { text: notif });
            }
        }
        pendientesConfirmacion.delete(from);
        esperandoDelivery.delete(from);
        await setModo(tel, 'bot');
    } catch (e) { console.log("[PARTBOT] Error finalizando pedido:", e.message); await safeSendMessage(from, { text: "❌ Ocurrió un error al confirmar el pedido. Intenta de nuevo." }); }
}

async function startBot() {
    if (socketBot) { try { socketBot.removeAllListeners(); socketBot.end(undefined); } catch (e) {} socketBot = null; }
    await restoreAuthFromMySQL();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: [`PartBot-${TIENDA_ID}`, "Chrome", "1.0.0"] });
    socketBot = sock;
    sock.ev.on('creds.update', async () => { saveCreds(); await backupAuthToMySQL(); });
    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrcode.toDataURL(qr, { scale: 10 }, (_, url) => qrCodeData = url);
        if (connection === 'open') { qrCodeData = "ONLINE ✅"; console.log(`[PARTBOT-${TIENDA_ID}] 🚀 Online`); }
        if (connection === 'close') {
            const isLogout = (lastDisconnect?.error instanceof Boom)?.output?.statusCode === DisconnectReason.loggedOut;
            if (!isLogout) setTimeout(() => startBot(), 5000);
        }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message) return;
            const from = msg.key.remoteJid;
            if (from === 'status@broadcast' || from.includes('@g.us')) return;
            if (msg.key.fromMe) return;
            const pushName = msg.pushName || "Cliente";
            clientNames.set(from, pushName);
            const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!rawText) return;
            const text = normalizar(rawText);
            await guardarHistorial(from.split('@')[0], 'user', rawText, pushName);
            const pendingSel = pendingProductSelection.get(from);
            if (pendingSel && /^\d{1,2}$/.test(text)) {
                const idx = parseInt(text) - 1;
                if (pendingSel.multiItem) {
                    const multiOrder = multiItemOrders.get(from);
                    if (multiOrder) {
                        if (idx >= 0 && idx < pendingSel.productos.length) {
                            const p = pendingSel.productos[idx];
                            const pct = pendingSel.pct;
                            pendingProductSelection.delete(from);
                            const precio = parseFloat(p.precio_minimo || 0) / pct;
                            multiOrder.resolvedItems.push({ descripcion: multiOrder.items[multiOrder.currentIndex].descripcion, cantidad: multiOrder.items[multiOrder.currentIndex].cantidad, codigo: p.producto, tipo: p.tipo, precio, error: false });
                            multiOrder.currentIndex++;
                            await processNextMultiItem(from, multiOrder);
                        } else {
                            pendingProductSelection.delete(from);
                            multiOrder.resolvedItems.push({ descripcion: multiOrder.items[multiOrder.currentIndex].descripcion, cantidad: multiOrder.items[multiOrder.currentIndex].cantidad, error: true });
                            multiOrder.currentIndex++;
                            await processNextMultiItem(from, multiOrder);
                        }
                        return;
                    }
                }
                if (idx >= 0 && idx < pendingSel.productos.length) {
                    const p = pendingSel.productos[idx];
                    const pct = pendingSel.pct;
                    pendingProductSelection.delete(from);
                    const precio = parseFloat(p.precio_minimo || 0) / pct;
                    let infoStock = "";
                    if (parseFloat(p.stock_total || 0) <= 0) { infoStock = parseFloat(p.cantidad_fabricando || 0) > 0 ? "\n🚚 *Sin existencia, en tránsito desde fábrica*" : ""; }
                    else { infoStock = "\n✅ *Disponible*"; }
                    const caption = `📦 *${p.producto}*\n💰 *Precio: $${precio.toFixed(2)}*${infoStock}\n📝 ${p.descripcion}`;
                    await safeSendMessage(from, { text: caption });
                    const telefono = from.split('@')[0];
                    let carrito = carritoCompras.get(telefono) || [];
                    carrito.push({ codigo: p.producto, descripcion: p.descripcion, tipo: p.tipo, cantidad: 1, precio });
                    carritoCompras.set(telefono, carrito);
                    await safeSendMessage(from, { text: `✅ *${p.producto}* agregado al carrito.\n\n¿Deseas seguir agregando productos o *finalizar* el pedido?\nResponde *3* para finalizar o *1* para buscar más productos.` });
                    return;
                }
            }
            if (multiItemOrders.has(from)) {
                if (text === 'cancelar') { multiItemOrders.delete(from); const psel = pendingProductSelection.get(from); if (psel && psel.multiItem) pendingProductSelection.delete(from); await safeSendMessage(from, { text: "❌ Pedido cancelado." }); return; }
                if (!/^\d{1,2}$/.test(text)) { await safeSendMessage(from, { text: "⚠️ Tienes un pedido pendiente. Responde el *número* del producto, o escribe *cancelar*." }); return; }
            }
            if (esperandoDelivery.has(from)) { const handled = await procesarDelivery(from, text, rawText); if (handled) return; }
            const tel = from.split('@')[0];
            if (pendientesConfirmacion.has(from)) {
                const conf = ['si', 'sí', 'confirmo', 'dale', 'ok', 'claro']; const canc = ['no', 'nop', 'cancelar', 'nunca'];
                if (conf.includes(text)) { await iniciarFlujoDelivery(from, pushName); return; }
                if (canc.includes(text)) { pendientesConfirmacion.delete(from); carritoCompras.delete(tel); await setModo(tel, 'bot'); const despedida = DESPEDIDAS[Math.floor(Math.random() * DESPEDIDAS.length)]; await safeSendMessage(from, { text: `❌ Pedido cancelado.\n\n${despedida}` }); return; }
            }
            if (text.startsWith('menu') || text === 'hola' || text.startsWith('buen') || text.startsWith('buenas') || text.includes('saludo') || text.includes('salud')) { await safeSendMessage(from, { text: `${obtenerSaludo(pushName)}\n\n${MENU_TEXT}` }); return; }
            if (text === '1' || text === '1️⃣' || text.includes('buscar')) { await safeSendMessage(from, { text: `🔍 *Buscar productos*\n\nEscribe el nombre, código o descripción del repuesto que necesitas. Ej: *filtro de aceite corolla* o *B11001*` }); return; }
            if (text === '2' || text === '2️⃣' || text.includes('carrito')) {
                const carrito = carritoCompras.get(tel) || [];
                if (carrito.length === 0) { await safeSendMessage(from, { text: "🛒 Tu carrito está vacío. Busca productos con la opción *1️⃣*" }); }
                else { let msg = `🛒 *TU CARRITO*\n\n`; let total = 0; carrito.forEach((it, i) => { const st = it.precio * it.cantidad; total += st; msg += `${i+1}. ${it.codigo} x${it.cantidad} — $${st.toFixed(2)}\n   ${it.descripcion.substring(0, 50)}...\n`; }); msg += `\n*💰 Total: $${total.toFixed(2)}*\n\nEscribe *3* para finalizar el pedido.`; await safeSendMessage(from, { text: msg }); }
                return;
            }
            if (text === '3' || text === '3️⃣' || text.includes('finalizar') || text.includes('pedido')) {
                const carrito = carritoCompras.get(tel) || [];
                if (carrito.length === 0) { await safeSendMessage(from, { text: "🛒 Tu carrito está vacío. Agrega productos primero con la opción *1️⃣*" }); return; }
                let msg = `📋 *COTIZACIÓN*\n💰 *Precios en USD*\n\n`; let total = 0;
                carrito.forEach(it => { const st = it.precio * it.cantidad; total += st; msg += `*${it.codigo}* ${it.tipo || ''}\n   ${it.cantidad} und x $${it.precio.toFixed(2)} = *$${st.toFixed(2)}*\n\n`; });
                msg += `\n*TOTAL: $${total.toFixed(2)}*`;
                await safeSendMessage(from, { text: msg });
                const dataConfirm = { items: carrito, vendedor: null, pushName };
                pendientesConfirmacion.set(from, dataConfirm);
                await setModo(tel, 'confirmando');
                await guardarSesion(tel, { tipo: 'confirmando', items: dataConfirm.items, pushName });
                await sleep(500);
                await safeSendMessage(from, { text: `✅ *¿Desea confirmar este pedido?*\n\nResponda *SI* para continuar o *NO* para cancelar.` });
                return;
            }
            if (text === '4' || text === '4️⃣' || text.includes('delivery') || text.includes('envio') || text.includes('envío')) {
                const zonas = await obtenerZonas(TIENDA_ID);
                if (zonas.length === 0) { await safeSendMessage(from, { text: "🚚 Consulta las zonas de delivery disponibles directamente con nuestro asesor." }); }
                else { let msg = `📍 *Zonas de delivery:*\n\n`; zonas.forEach(z => { msg += `• ${z.zona} — *$${parseFloat(z.costo_envio).toFixed(2)}* (${z.tiempo_estimado || 'Consultar'})\n`; }); await safeSendMessage(from, { text: msg }); }
                return;
            }
            if (text === '5' || text === '5️⃣' || text.includes('asesor') || text.includes('hablar') || text.includes('ayuda')) {
                await safeSendMessage(from, { text: `👩‍💼 *Hablar con un asesor*\n\nUn operador revisará tu caso y te contactará pronto. Mientras tanto, puedes seguir explorando nuestro catálogo.\n\n${MENU_TEXT}` });
                if (tiendaInfo && tiendaInfo.telefono_dueno) { const jidD = formatWhatsApp(tiendaInfo.telefono_dueno); if (jidD) await safeSendMessage(jidD, { text: `👤 *Cliente solicita asesor:* ${pushName} (${tel})` }); }
                return;
            }
            const grat = ['gracias', 'agradecid', 'agardecid'];
            if (grat.some(w => text.includes(w))) { const d = DESPEDIDAS[Math.floor(Math.random() * DESPEDIDAS.length)]; await safeSendMessage(from, { text: d }); return; }
            const tieneCodigo = rawText.split(/\s+/).some(p => { const c = p.replace(/[^a-zA-Z0-9]/g, ''); return c.length >= 4 && /[A-Za-z]/.test(c) && /[0-9]/.test(c); });
            if (!multiItemOrders.has(from)) {
                const multiItems = parseMultiItemMessage(rawText);
                if (multiItems) {
                    const multiOrder = { items: multiItems, currentIndex: 0, resolvedItems: [], pct: null, pushName };
                    multiItemOrders.set(from, multiOrder);
                    await processNextMultiItem(from, multiOrder);
                    return;
                }
            }
            let prods = null;
            if (tieneCodigo) { for (const p of rawText.split(/\s+/)) { const c = p.replace(/[^a-zA-Z0-9]/g, ''); if (c.length >= 4 && /[A-Za-z]/.test(c) && /[0-9]/.test(c)) { prods = await buscarProductoPorCodigo(c, TIENDA_ID); if (prods) break; } } }
            if (!prods) prods = await buscarProductoPorTexto(rawText, TIENDA_ID);
            if (prods) {
                if (prods.length > 1) {
                    const pct = await obtenerTasa(TIENDA_ID);
                    let msg = `🔍 *${prods.length} productos encontrados*\n\n`;
                    prods.slice(0, 8).forEach((p, i) => {
                        const precio = parseFloat(p.precio_minimo || 0) / pct;
                        const stock = parseFloat(p.stock_total || 0);
                        const estado = stock > 0 ? "✅" : (parseFloat(p.cantidad_fabricando || 0) > 0 ? "🚚" : "❌");
                        msg += `*${i+1}.* ${p.producto} — *$${precio.toFixed(2)}* ${estado}\n   ${p.descripcion.substring(0, 60)}${p.descripcion.length > 60 ? '...' : ''}\n`;
                    });
                    msg += `\n📌 Responde el *número* del producto que necesitas.`;
                    pendingProductSelection.set(from, { productos: prods.slice(0, 8), pct, multiItem: false });
                    await safeSendMessage(from, { text: msg });
                } else {
                    const p = prods[0];
                    const pct = await obtenerTasa(TIENDA_ID);
                    const precio = parseFloat(p.precio_minimo || 0) / pct;
                    let infoStock = "";
                    if (parseFloat(p.stock_total || 0) <= 0) { infoStock = parseFloat(p.cantidad_fabricando || 0) > 0 ? "\n🚚 *Sin existencia, en tránsito desde fábrica*" : ""; }
                    else { infoStock = "\n✅ *Disponible*"; }
                    const caption = `📦 *${p.producto}*\n💰 *Precio: $${precio.toFixed(2)}*${infoStock}\n📝 ${p.descripcion}`;
                    await safeSendMessage(from, { text: caption });
                    let carrito = carritoCompras.get(tel) || [];
                    carrito.push({ codigo: p.producto, descripcion: p.descripcion, tipo: p.tipo, cantidad: 1, precio });
                    carritoCompras.set(tel, carrito);
                    await safeSendMessage(from, { text: `✅ *${p.producto}* agregado al carrito.\n\n¿Deseas seguir agregando productos o *finalizar* el pedido?\nResponde *3* para finalizar o escribe *menu* para volver al inicio.` });
                }
                return;
            }
            if (rawText.length < 500 && !['si', 'no', 'ok', 'vale', 'ya'].includes(text)) {
                await safeSendMessage(from, { text: `😅 Disculpa, no logré entender bien tu mensaje. ¿Podrías indicarme qué producto necesitas?\n\nEj: *filtro de aceite* o *B11001*\n\nO escribe *menu* para ver las opciones. 🙏` });
            }
        } catch (e) { console.log("[PARTBOT] Error handler:", e.message); }
    });
}

// ===== HELPERS PARA PÁGINAS =====
const CSS = `body{background:#f4f7f6;font-family:'Segoe UI',sans-serif;font-size:14px}.card{border-radius:12px;border:none;box-shadow:0 2px 8px rgba(0,0,0,0.06)}.card h5{font-size:1rem;font-weight:700}.total-row{background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:10px 14px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:1rem;margin-top:10px}.prod-card{background:#fcfcfc;border-radius:10px;padding:10px;border:1px solid #eee;height:100%}.prod-card .code{font-weight:700;font-size:.9rem;color:#e94560;margin-bottom:2px}.prod-card .desc{font-size:.75rem;color:#666;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:4px}.prod-card .meta{display:flex;justify-content:space-between;align-items:center;font-size:.8rem;border-top:1px solid #eee;padding-top:4px;margin-top:4px}.badge{font-weight:500;font-size:.7rem}.navbar-brand{font-weight:700}`;
function pageWrap(title, body) { return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><title>${title}</title><style>${CSS}</style></head><body><nav class="navbar navbar-dark mb-3" style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:8px 0"><div class="container"><a href="/" class="navbar-brand py-0" style="font-size:1rem">🚗 PartBot</a></div></nav><div class="container px-3">${body}</div></body></html>`; }
function prodCard(codigo, desc, tipo, cant, precio, subtotal) { return `<div class="col-12 col-sm-6 col-lg-4"><div class="prod-card"><div class="code">${codigo}</div><div class="desc">${desc || 'Sin descripción'}${tipo ? ' ('+tipo+')' : ''}</div><div class="meta"><span>${cant} x <strong>$${precio.toFixed(2)}</strong></span><strong>= $${subtotal.toFixed(2)}</strong></div></div></div>`; }
function emptyBox(msg) { return `<div class="card p-3 mb-3 text-center text-muted py-4">${msg}</div>`; }
function backBtn() { return `<a href="/" class="btn btn-primary w-100 mt-2" style="border-radius:50px;padding:10px">← Volver al panel</a>`; }
function notFoundHtml(msg) { return pageWrap('No encontrado', `<div class="alert alert-warning mt-3">${msg}</div>${backBtn()}`); }

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const pathname = parsedUrl.pathname;
    if (pathname === '/') {
        try {
            const [stats] = await pool.execute("SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN estado='pendiente' OR estado='confirmado' THEN 1 ELSE 0 END),0) as pendientes FROM partbot_pedidos WHERE tienda_id = ?", [TIENDA_ID]);
            const [abandonados] = await pool.execute("SELECT COUNT(*) as total FROM partbot_control_chat WHERE tienda_id = ? AND modo = 'confirmando'", [TIENDA_ID]);
            const [pendientes] = await pool.execute("SELECT p.*,(SELECT COUNT(*) FROM partbot_pedidos_reng WHERE id_pedido = p.id_pedido) as items,(SELECT GROUP_CONCAT(CONCAT(producto,' x',cantidad) SEPARATOR ', ') FROM partbot_pedidos_reng WHERE id_pedido = p.id_pedido) as resumen FROM partbot_pedidos p WHERE p.tienda_id = ? AND p.estado IN ('pendiente','confirmado') ORDER BY p.id_pedido DESC", [TIENDA_ID]);
            const [abandonadosDet] = await pool.execute("SELECT cc.*, cc.datos as datos_raw FROM partbot_control_chat cc WHERE cc.tienda_id = ? AND cc.modo = 'confirmando' ORDER BY cc.ultima_interaccion DESC", [TIENDA_ID]);
            const filasPend = pendientes.map(p => {
                const entrega = p.tipo_entrega === 'delivery' ? '🚚 Delivery' : '🏪 Retiro tienda';
                const direccion = p.tipo_entrega === 'delivery' ? (p.direccion_delivery || '-') : '🏪 En tienda';
                return `<tr><td>#${p.nro_pedido}</td><td>${p.nombres || p.celular}<br><small class="text-muted">${p.celular}</small></td><td><small>${direccion}${p.zona_delivery ? '<br>📍 '+p.zona_delivery : ''}</small></td><td>${entrega}</td><td><small>${p.resumen || '-'}</small></td><td><span class="badge ${p.estado === 'confirmado' ? 'bg-success' : 'bg-warning'}">${p.estado}</span></td><td>$${parseFloat(p.total_general).toFixed(2)}</td><td><small>${new Date(p.fecha_reg).toLocaleString()}</small></td><td><a href="/detalle-pedido?id=${p.id_pedido}" class="btn btn-sm btn-outline-primary">Ver detalle</a></td></tr>`;
            }).join('');
            const filasAban = abandonadosDet.map(a => {
                let itemsHtml = '', itemsCount = 0, pushName = '';
                try { const datos = JSON.parse(a.datos_raw); if (datos && datos.items) { itemsHtml = datos.items.map(i => (i.codigo || i.producto) + ' x' + i.cantidad).join(', '); itemsCount = datos.items.length; pushName = datos.pushName || ''; } } catch(e) {}
                const nombre = pushName || a.telefono;
                return `<tr><td>${nombre}<br><small class="text-muted">${a.telefono}</small></td><td><small>${itemsHtml || 'Visitó el bot'}</small></td><td><span class="badge bg-secondary">Sin confirmar</span></td><td><small>${new Date(a.ultima_interaccion).toLocaleString()}</small></td><td><a href="/detalle-carrito?tel=${encodeURIComponent(a.telefono)}" class="btn btn-sm btn-outline-primary">Ver detalle</a></td></tr>`;
            }).join('');
            res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><title>PartBot - ${tiendaInfo?.nombre || 'Tienda'}</title><style>body{background:#f4f7f6;font-family:'Segoe UI',sans-serif}.card{border-radius:12px;border:none;box-shadow:0 2px 8px rgba(0,0,0,0.06)}.table th{font-size:.75rem;text-transform:uppercase;letter-spacing:.3px;color:#888;font-weight:600}.table td{vertical-align:middle}.badge{font-weight:500}.section-title{font-size:.85rem;text-transform:uppercase;letter-spacing:.5px;color:#999;font-weight:600;margin-bottom:12px}.order-item{border-left:3px solid #e94560;padding:8px 12px;margin-bottom:6px;background:#fcfcfc;border-radius:0 8px 8px 0}</style><meta http-equiv="refresh" content="30"></head><body><nav class="navbar navbar-dark mb-3" style="background:linear-gradient(135deg,#1a1a2e,#16213e)"><div class="container"><span class="navbar-brand fw-bold">🚗 PartBot — ${tiendaInfo?.nombre || 'Tienda'}</span><span class="badge ${isBotReady() ? 'bg-success' : 'bg-danger'}">${isBotReady() ? '🟢 Online' : '🔴 Offline'}</span></div></nav><div class="container"><div class="row mb-3 g-2"><div class="col-md-4"><div class="card p-3 text-center"><h3 class="mb-0">📦 ${stats[0].total}</h3><small class="text-muted">Total Pedidos</small></div></div><div class="col-md-4"><div class="card p-3 text-center"><h3 class="mb-0">⏳ ${stats[0].pendientes}</h3><small class="text-muted">Pendientes</small></div></div><div class="col-md-4"><div class="card p-3 text-center"><h3 class="mb-0">🛒 ${abandonados[0].total}</h3><small class="text-muted">Carritos abandonados</small></div></div></div>` +
            (pendientes.length ? `<div class="card p-3 mb-3"><div class="section-title">📋 Pedidos Pendientes</div><div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>#</th><th>Cliente</th><th>Dirección</th><th>Tipo</th><th>Productos</th><th>Estado</th><th>Total</th><th>Fecha</th><th></th></tr></thead><tbody>${filasPend}</tbody></table></div></div>` : `<div class="card p-3 mb-3 text-center text-muted py-4">✅ No hay pedidos pendientes</div>`) +
            (abandonados[0].total > 0 ? `<div class="card p-3 mb-3"><div class="section-title">🛒 Carritos Abandonados (sin confirmar)</div><div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>Cliente</th><th>Productos</th><th>Estado</th><th>Última interacción</th><th></th></tr></thead><tbody>${filasAban}</tbody></table></div></div>` : '') +
            `<div class="card p-3"><div class="d-flex gap-2">${qrCodeData.startsWith('data') ? `<div><img src="${qrCodeData}" style="max-width:130px"><br><small class="text-muted">Escanee el QR</small></div>` : ''}<div><a href="/pedidos" class="btn btn-primary btn-sm">📋 Ver todos los pedidos</a><br class="mb-1"><a href="${isBotReady() ? '/reset-sesion' : '#'}" class="btn btn-outline-danger btn-sm mt-1">${isBotReady() ? '🔄 Nuevo QR' : '🔄 Reconectar'}</a></div></div></div></div></body></html>`);
        } catch (e) { res.end("Error: " + e.message); }
    } else if (pathname === '/detalle-carrito') {
        try {
            const tel = query.tel || '';
            if (!tel) { res.writeHead(302, { Location: '/' }); res.end(); return; }
            const [rows] = await pool.execute("SELECT * FROM partbot_control_chat WHERE tienda_id = ? AND telefono = ? AND modo = 'confirmando' LIMIT 1", [TIENDA_ID, tel]);
            if (rows.length === 0) { res.end(notFoundHtml("Carrito no encontrado para " + tel)); return; }
            const a = rows[0];
            let datos = null, items = [], pushName = '';
            try { datos = JSON.parse(a.datos); if (datos && datos.items) { items = datos.items; pushName = datos.pushName || ''; } } catch(e) {}
            let total = 0;
            const itemsHtml = items.map((i, idx) => {
                const subtotal = (i.precio || 0) * (i.cantidad || 0);
                total += subtotal;
                return prodCard(i.codigo || i.producto || '?', i.descripcion || '', i.tipo || '', i.cantidad || 0, i.precio || 0, subtotal);
            }).join('');
            const nombre = pushName || tel;
            res.end(pageWrap(`Detalle carrito - ${nombre}`,`<div class="card p-3 mb-3"><h5 class="mb-3">👤 Datos del cliente</h5><div class="row g-2"><div class="col-6 col-sm-4"><small class="text-muted d-block">Nombre</small><strong>${nombre}</strong></div><div class="col-6 col-sm-4"><small class="text-muted d-block">Teléfono</small><strong>${tel}</strong></div><div class="col-6 col-sm-4"><small class="text-muted d-block">Estado</small><span class="badge bg-warning">Sin confirmar</span></div><div class="col-6 col-sm-4"><small class="text-muted d-block">Última interacción</small><strong><small>${new Date(a.ultima_interaccion).toLocaleString()}</small></strong></div></div></div>` +
            (items.length ? `<div class="card p-3 mb-3"><h5 class="mb-3">📦 Productos en carrito (${items.length})</h5><div class="row g-2">${itemsHtml}</div><div class="total-row">TOTAL  <strong>$${total.toFixed(2)}</strong></div></div>` : emptyBox('🛒 Sin productos en el carrito')) +
            backBtn()) });
        } catch (e) { res.end("Error: " + e.message); }
    } else if (pathname === '/detalle-pedido') {
        try {
            const idPed = parseInt(query.id) || 0;
            if (!idPed) { res.writeHead(302, { Location: '/' }); res.end(); return; }
            const [rows] = await pool.execute("SELECT * FROM partbot_pedidos WHERE id_pedido = ? AND tienda_id = ? LIMIT 1", [idPed, TIENDA_ID]);
            if (rows.length === 0) { res.end(notFoundHtml("Pedido no encontrado")); return; }
            const p = rows[0];
            const [reng] = await pool.execute("SELECT * FROM partbot_pedidos_reng WHERE id_pedido = ? ORDER BY nro_reglon", [idPed]);
            const entrega = p.tipo_entrega === 'delivery' ? '🚚 Delivery' : '🏪 Retiro en tienda';
            const itemsHtml = reng.map(r => {
                const st = parseFloat(r.precio_total || 0);
                return prodCard(r.producto || '?', r.descripcion || '', r.tipo || '', r.cantidad || 0, parseFloat(r.precio_unitario || 0), st);
            }).join('');
            const total = reng.reduce((s, r) => s + parseFloat(r.precio_total || 0), 0);
            const badgeClass = p.estado === 'confirmado' ? 'bg-success' : p.estado === 'entregado' ? 'bg-info' : p.estado === 'cancelado' ? 'bg-danger' : 'bg-warning';
            res.end(pageWrap(`Pedido #${p.nro_pedido}`,
                `<div class="card p-3 mb-3"><h5 class="mb-3">🧾 Pedido #${p.nro_pedido}</h5><div class="row g-2"><div class="col-6 col-sm-4"><small class="text-muted d-block">Cliente</small><strong>${p.nombres || '-'}</strong></div><div class="col-6 col-sm-4"><small class="text-muted d-block">Teléfono</small><strong>${p.celular || '-'}</strong></div><div class="col-6 col-sm-4"><small class="text-muted d-block">Tipo entrega</small><strong>${entrega}</strong></div>` +
                (p.tipo_entrega === 'delivery' ? `<div class="col-12"><small class="text-muted d-block">Dirección</small><strong>${p.direccion_delivery || '-'}</strong>${p.zona_delivery ? '<br><small>📍 '+p.zona_delivery+'</small>' : ''}</div><div class="col-6 col-sm-4"><small class="text-muted d-block">Costo envío</small><strong>$${parseFloat(p.costo_envio || 0).toFixed(2)}</strong></div>` : '') +
                `<div class="col-6 col-sm-4"><small class="text-muted d-block">Estado</small><span class="badge ${badgeClass}">${p.estado}</span></div><div class="col-6 col-sm-4"><small class="text-muted d-block">Fecha</small><strong><small>${new Date(p.fecha_reg).toLocaleString()}</small></strong></div></div></div>` +
                (reng.length ? `<div class="card p-3 mb-3"><h5 class="mb-3">📦 Productos (${reng.length})</h5><div class="row g-2">${itemsHtml}</div><div class="total-row">TOTAL  <strong>$${total.toFixed(2)}</strong></div>` +
                (p.costo_envio > 0 ? `<div class="d-flex justify-content-between mt-2 px-2"><span>Costo envío</span><strong>+$${parseFloat(p.costo_envio).toFixed(2)}</strong></div><div class="d-flex justify-content-between px-2" style="border-top:1px solid #ddd;padding-top:6px;margin-top:4px"><span><strong>TOTAL GENERAL</strong></span><strong>$${parseFloat(p.total_general).toFixed(2)}</strong></div>` : '') +
                `</div>` : emptyBox('Sin productos')) + backBtn()) });
        } catch (e) { res.end("Error: " + e.message); }
    } else if (pathname === '/pedidos') {
        try {
            const [rows] = await pool.execute("SELECT p.*,(SELECT COUNT(*) FROM partbot_pedidos_reng WHERE id_pedido = p.id_pedido) as items FROM partbot_pedidos p WHERE p.tienda_id = ? ORDER BY p.id_pedido DESC LIMIT 50", [TIENDA_ID]);
            const filas = rows.map(p => `<tr><td>#${p.nro_pedido}</td><td>${p.nombres || p.celular}</td><td>$${parseFloat(p.total_general).toFixed(2)}</td><td>${p.tipo_entrega === 'delivery' ? '🚚' : '🏪'}</td><td>${p.zona_delivery || '-'}</td><td>${p.items}</td><td><span class="badge ${p.estado === 'confirmado' ? 'bg-success' : p.estado === 'entregado' ? 'bg-info' : p.estado === 'cancelado' ? 'bg-danger' : 'bg-warning'}">${p.estado}</span></td><td><small>${new Date(p.fecha_reg).toLocaleString()}</small></td><td><a href="/detalle-pedido?id=${p.id_pedido}" class="btn btn-sm btn-outline-primary">Ver</a></td></tr>`).join('');
            res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><title>Pedidos - PartBot</title><style>body{background:#f4f7f6;font-family:'Segoe UI',sans-serif;font-size:14px}.card{border-radius:12px;border:none;box-shadow:0 2px 8px rgba(0,0,0,0.06)}.table th{font-size:.7rem;text-transform:uppercase;letter-spacing:.3px;color:#888;font-weight:600;white-space:nowrap}.table td{vertical-align:middle;white-space:nowrap}</style></head><body><nav class="navbar navbar-dark mb-3" style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:8px 0"><div class="container"><a href="/" class="navbar-brand py-0" style="font-size:1rem">🚗 PartBot</a><span class="text-white" style="font-size:.85rem">📋 Pedidos</span></div></nav><div class="container px-3"><div class="card p-2 p-sm-3"><div class="table-responsive"><table class="table table-sm table-hover mb-0"><thead><tr><th>#</th><th>Cliente</th><th>Total</th><th>Tipo</th><th>Zona</th><th>Items</th><th>Estado</th><th>Fecha</th><th></th></tr></thead><tbody>${filas || '<tr><td colspan="9" class="text-center text-muted py-3">Sin pedidos</td></tr>'}</tbody></table></div></div><a href="/" class="btn btn-outline-secondary btn-sm mt-2">← Volver</a></div></body></html>`);
        } catch (e) { res.end("Error: " + e.message); }
    } else if (pathname === '/reset-sesion') {
        try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); await pool.execute("DELETE FROM partbot_auth_store WHERE tienda_id = ?", [TIENDA_ID]); res.writeHead(302, { Location: '/' }); res.end(); setTimeout(() => startBot(), 2000); } catch (e) { res.end("Error: " + e.message); }
    } else { res.writeHead(302, { Location: '/' }); res.end(); }
});

server.listen(PORT, '0.0.0.0', async () => {
    await cargarTienda();
    console.log(`[PARTBOT-${TIENDA_ID}] 🌐 Servidor en puerto ${PORT}`);
    startBot();
});