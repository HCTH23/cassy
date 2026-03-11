const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

// nodemailer es opcional
let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch (e) {
  nodemailer = null;
}

const app = express();
const PORT = Number(process.env.PORT || 3001);

// =============================
// Rutas de proyecto
// =============================
const PUBLIC_DIR = path.join(__dirname, "public");
const PAGOS_FILE = path.join(__dirname, "pagos.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOAD_DIR });

// =============================
// Configuración
// =============================

// 0,5% diario
const TASA_DIARIA = Number(process.env.TASA_DIARIA || 0.005);

// Del 1 al 10 sin interés
const DIA_LIMITE_SIN_INTERES = Number(process.env.DIA_LIMITE_SIN_INTERES || 10);

// El interés se cuenta desde el día 1
const DIA_INICIO_INTERES = Number(process.env.DIA_INICIO_INTERES || 1);

// Contraseña admin
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// Mail vendedor opcional
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";

// Mercado Pago
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "APP_USR-5980326739207721-031017-36c6c06f7e593adf7e43fc659da2004a-3078861398";
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:3001";

const mpClient = MP_ACCESS_TOKEN
  ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN })
  : null;

// =============================
// Middlewares
// =============================
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// =============================
// Lock de escritura
// =============================
let writeQueue = Promise.resolve();

function withWriteLock(fn) {
  writeQueue = writeQueue.then(fn, fn);
  return writeQueue;
}

// =============================
// Utils archivo JSON
// =============================
function ensurePagosFile() {
  if (!fs.existsSync(PAGOS_FILE)) {
    fs.writeFileSync(PAGOS_FILE, "[]", "utf-8");
  }
}

function leerPagos() {
  ensurePagosFile();
  try {
    const raw = fs.readFileSync(PAGOS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Error leyendo pagos.json:", err);
    return [];
  }
}

function guardarPagos(data) {
  const tmp = `${PAGOS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, PAGOS_FILE);
}

function generarId() {
  return `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function normalizeStr(v) {
  return String(v ?? "").trim();
}

function normalizeLower(v) {
  return normalizeStr(v).toLowerCase();
}

function isValidMoney(n) {
  return Number.isFinite(n) && n >= 0 && n <= 1e12;
}

// =============================
// Parseo de mes
// Acepta: "enero 2026" o "2026-01"
// =============================
function parseMes(mesStr) {
  if (!mesStr || typeof mesStr !== "string") return null;
  const s = mesStr.trim().toLowerCase().replace(/\s+/g, " ");

  const iso = s.match(/^(\d{4})-(\d{1,2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, 1);

  const meses = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    setiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11,
  };

  const parts = s.replace("-", " ").split(" ");
  if (parts.length >= 2) {
    const mesName = parts[0];
    const year = Number(parts[1]);
    if (mesName in meses && Number.isFinite(year)) {
      return new Date(year, meses[mesName], 1);
    }
  }

  return null;
}

function monthKey(d) {
  return d.getFullYear() * 12 + d.getMonth();
}

function isConsecutiveMonths(datesSortedAsc) {
  for (let i = 1; i < datesSortedAsc.length; i++) {
    if (monthKey(datesSortedAsc[i]) !== monthKey(datesSortedAsc[i - 1]) + 1) {
      return false;
    }
  }
  return true;
}

// =============================
// Fechas / días
// =============================
function startOfDayLocal(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function diffDaysLocal(fromDate, toDate) {
  const a = startOfDayLocal(fromDate).getTime();
  const b = startOfDayLocal(toDate).getTime();
  return Math.floor((b - a) / 86400000);
}

// =============================
// Interés diario
// =============================
function calcularInteres(montoBase, dias) {
  const base = Number(montoBase) || 0;
  const dd = Number(dias) || 0;
  const interes = Math.round(base * TASA_DIARIA * dd);

  return {
    base: Math.round(base),
    diasInteres: dd,
    interes,
    total: Math.round(base + interes),
  };
}

function diasInteresParaCuota(cuotaMesStr, now = new Date()) {
  const mesDate = parseMes(cuotaMesStr);
  if (!mesDate) return 0;

  const cuotaKey = monthKey(mesDate);
  const nowKey = monthKey(now);

  // cuota futura
  if (cuotaKey > nowKey) return 0;

  // cuota del mes actual
  if (cuotaKey === nowKey) {
    if (now.getDate() <= DIA_LIMITE_SIN_INTERES) return 0;
    return now.getDate(); // día 11 => 11 días, día 15 => 15 días
  }

  // cuota de mes anterior: cuenta desde el día 1 de ese mes
  const inicioInteres = new Date(
    mesDate.getFullYear(),
    mesDate.getMonth(),
    DIA_INICIO_INTERES
  );

  if (startOfDayLocal(now) < startOfDayLocal(inicioInteres)) return 0;

  const dias = diffDaysLocal(inicioInteres, now) + 1;
  return Math.max(0, dias);
}

function calcularInteresPorCuota(montoBase, cuotaMesStr, now = new Date()) {
  const dias = diasInteresParaCuota(cuotaMesStr, now);
  return calcularInteres(montoBase, dias);
}

// =============================
// Admin auth por token
// =============================
const adminTokens = new Map();
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

function cleanupTokens() {
  const now = Date.now();
  for (const [token, exp] of adminTokens.entries()) {
    if (exp <= now) {
      adminTokens.delete(token);
    }
  }
}

function requireAdmin(req, res, next) {
  cleanupTokens();
  const token = req.header("X-Admin-Token") || "";
  const exp = adminTokens.get(token);

  if (!exp) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// =============================
// Email opcional
// =============================
function getTransporter() {
  if (!nodemailer) return null;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 0);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) return null;

  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" ||
    port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

async function enviarMailPago({ to, subject, text }) {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, reason: "smtp_not_configured" };

  const from = process.env.FROM_EMAIL || process.env.SMTP_USER;
  await transporter.sendMail({ from, to, subject, text });

  return { ok: true };
}

// =============================
// Mercado Pago helpers
// =============================
function buildExternalReference(userId, meses) {
  return JSON.stringify({
    userId,
    meses,
    ts: Date.now(),
  });
}

function parseExternalReference(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getSelectedCuotasConInteres(user, meses, now = new Date()) {
  const cuotas = Array.isArray(user.cuotas) ? user.cuotas : [];

  const seleccionadas = cuotas.filter(
    (c) =>
      meses.includes(normalizeStr(c.mes)) &&
      (c.estado || "pendiente") !== "pagado"
  );

  const detalle = seleccionadas.map((c) => {
    const calc = calcularInteresPorCuota(c.monto, c.mes, now);
    return {
      mes: c.mes,
      montoBase: calc.base,
      diasInteres: calc.diasInteres,
      interes: calc.interes,
      total: calc.total,
    };
  });

  return detalle;
}

function totalFromDetalle(detalle) {
  return detalle.reduce((acc, x) => acc + Number(x.total || 0), 0);
}

function isWebhookSignatureValid(req) {
  if (!MP_WEBHOOK_SECRET) return true;

  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  const dataId =
    req.query["data.id"] ||
    req.body?.data?.id ||
    req.query.id;

  if (!signature || !requestId || !dataId) return false;

  const parts = Object.fromEntries(
    String(signature)
      .split(",")
      .map((p) => p.split("=").map((s) => s.trim()))
      .filter((x) => x.length === 2)
  );

  const ts = parts.ts;
  const v1 = parts.v1;

  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;

  const hmac = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  return hmac === v1;
}

// =============================
// Rutas HTML
// =============================
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

// =============================
// API Admin login
// =============================
app.post("/api/admin/login", (req, res) => {
  const pass = normalizeStr(req.body?.password);

  if (!pass || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  const token = crypto.randomBytes(24).toString("hex");
  adminTokens.set(token, Date.now() + TOKEN_TTL_MS);

  return res.json({ ok: true, token });
});

// =============================
// API Admin CRUD
// =============================
app.get("/api/pagos", requireAdmin, (req, res) => {
  res.json(leerPagos());
});

app.get("/api/pago/:id", requireAdmin, (req, res) => {
  const data = leerPagos();
  const user = data.find((p) => p.id === req.params.id);

  if (!user) {
    return res.status(404).json({ error: "No encontrado" });
  }

  return res.json(user);
});

app.post("/api/pagos", requireAdmin, (req, res) => {
  const nombre = normalizeStr(req.body?.nombre);
  const mail = normalizeStr(req.body?.mail);
  const telefono = normalizeStr(req.body?.telefono);

  if (!nombre) {
    return res.status(400).json({ error: "Falta nombre" });
  }

  const nuevo = {
    id: generarId(),
    nombre,
    mail,
    telefono,
    cuotas: [],
  };

  return withWriteLock(async () => {
    const data = leerPagos();
    data.push(nuevo);
    guardarPagos(data);
    return res.json(nuevo);
  });
});

app.put("/api/pago/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  const body = req.body;

  const nombre = normalizeStr(body?.nombre);
  if (!nombre) {
    return res.status(400).json({ error: "Falta nombre" });
  }

  const cuotas = Array.isArray(body?.cuotas) ? body.cuotas : [];

  const updated = {
    id,
    nombre,
    mail: normalizeStr(body.mail),
    telefono: normalizeStr(body.telefono),
    cuotas: cuotas.map((c) => ({
      mes: normalizeStr(c.mes),
      monto: Number(c.monto) || 0,
      estado: normalizeStr(c.estado || "pendiente") || "pendiente",
      fechaPago: c.fechaPago ? normalizeStr(c.fechaPago) : undefined,
      interesAplicado:
        c.interesAplicado != null ? Number(c.interesAplicado) : undefined,
      diasInteres: c.diasInteres != null ? Number(c.diasInteres) : undefined,
      totalPagado: c.totalPagado != null ? Number(c.totalPagado) : undefined,
      mpPaymentId: c.mpPaymentId ? normalizeStr(c.mpPaymentId) : undefined,
      mpStatus: c.mpStatus ? normalizeStr(c.mpStatus) : undefined,
    })),
  };

  for (const c of updated.cuotas) {
    if (!c.mes) {
      return res.status(400).json({ error: "Cada cuota debe tener mes" });
    }

    if (!isValidMoney(Number(c.monto))) {
      return res
        .status(400)
        .json({ error: `Monto inválido en ${c.mes}` });
    }

    if (c.estado !== "pendiente" && c.estado !== "pagado") {
      c.estado = "pendiente";
    }
  }

  return withWriteLock(async () => {
    const data = leerPagos();
    const idx = data.findIndex((p) => p.id === id);

    if (idx === -1) {
      return res.status(404).json({ error: "No encontrado" });
    }

    data[idx] = updated;
    guardarPagos(data);
    return res.json({ ok: true });
  });
});

app.delete("/api/pago/:id", requireAdmin, (req, res) => {
  const id = req.params.id;

  return withWriteLock(async () => {
    const data = leerPagos();
    const nuevo = data.filter((p) => p.id !== id);

    if (nuevo.length === data.length) {
      return res.status(404).json({ error: "No encontrado" });
    }

    guardarPagos(nuevo);
    return res.json({ ok: true });
  });
});

// =============================
// API importar excel
// =============================
app.post(
  "/api/importar-excel",
  requireAdmin,
  upload.single("excel"),
  (req, res) => {
    try {
      if (!req.file?.path) {
        return res.status(400).json({ error: "Falta archivo" });
      }

      const workbook = XLSX.readFile(req.file.path);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);

      return withWriteLock(async () => {
        const data = leerPagos();

        rows.forEach((r) => {
          const nombre = normalizeStr(r.nombre || r.Nombre);
          if (!nombre) return;

          data.push({
            id: generarId(),
            nombre,
            mail: normalizeStr(r.mail || r.Mail || r.email || r.Email),
            telefono: normalizeStr(
              r.telefono || r.Telefono || r.tel || r.Tel
            ),
            cuotas: [],
          });
        });

        guardarPagos(data);

        try {
          fs.unlinkSync(req.file.path);
        } catch (_) {}

        return res.json({ ok: true, cantidad: rows.length });
      });
    } catch (err) {
      console.error("Error importando Excel:", err);
      try {
        if (req.file?.path) fs.unlinkSync(req.file.path);
      } catch (_) {}
      return res.status(500).json({ error: "Error importando Excel" });
    }
  }
);

// =============================
// API Público resumen
// =============================
app.get("/api/resumen", (req, res) => {
  const nombre = normalizeLower(req.query.nombre);
  const contacto = normalizeLower(req.query.contacto);

  if (!nombre || !contacto) {
    return res.status(400).json({ error: "Faltan nombre/contacto" });
  }

  const data = leerPagos();
  const user = data.find(
    (p) =>
      normalizeLower(p.nombre) === nombre &&
      (normalizeLower(p.mail) === contacto ||
        normalizeLower(p.telefono) === contacto)
  );

  if (!user) {
    return res.status(404).json({ error: "No encontrado" });
  }

  const cuotas = Array.isArray(user.cuotas) ? user.cuotas : [];
  const pagadas = cuotas.filter((c) => (c.estado || "pendiente") === "pagado");

  const pendientes = cuotas
    .map((c) => ({ ...c, _fecha: parseMes(c.mes) }))
    .filter((c) => (c.estado || "pendiente") !== "pagado" && c._fecha);

  pendientes.sort((a, b) => a._fecha - b._fecha);

  const fechas = pendientes.map((x) => x._fecha);
  const consecutivas = fechas.length ? isConsecutiveMonths(fechas) : true;

  const now = new Date();

  const pendientesCalc = pendientes.map((c) => {
    const calc = calcularInteresPorCuota(c.monto, c.mes, now);
    return {
      mes: c.mes,
      montoBase: calc.base,
      diasInteres: calc.diasInteres,
      interes: calc.interes,
      total: calc.total,
      estado: c.estado || "pendiente",
    };
  });

  const totalBase = pendientesCalc.reduce((a, x) => a + x.montoBase, 0);
  const totalInteres = pendientesCalc.reduce((a, x) => a + x.interes, 0);
  const totalPagar = pendientesCalc.reduce((a, x) => a + x.total, 0);

  return res.json({
    nombre: user.nombre,
    mail: user.mail || "",
    telefono: user.telefono || "",
    consecutivas,
    pagadas,
    pendientes: pendientesCalc,
    totalBase,
    totalInteres,
    totalPagar,
  });
});

// =============================
// API Público: crear preferencia MP
// =============================
app.post("/api/mp/create-preference", async (req, res) => {
  try {
    if (!mpClient) {
      return res.status(500).json({ error: "Mercado Pago no configurado" });
    }

    const nombre = normalizeLower(req.body?.nombre);
    const contacto = normalizeLower(req.body?.contacto);
    const meses = Array.isArray(req.body?.meses)
      ? req.body.meses.map(normalizeStr).filter(Boolean)
      : [];

    if (!nombre || !contacto || meses.length === 0) {
      return res.status(400).json({ error: "Faltan nombre/contacto/meses" });
    }

    const data = leerPagos();
    const idx = data.findIndex(
      (p) =>
        normalizeLower(p.nombre) === nombre &&
        (normalizeLower(p.mail) === contacto ||
          normalizeLower(p.telefono) === contacto)
    );

    if (idx === -1) {
      return res.status(404).json({ error: "No encontrado" });
    }

    const user = data[idx];
    const detalle = getSelectedCuotasConInteres(user, meses, new Date());

    if (detalle.length === 0) {
      return res.status(400).json({ error: "No hay cuotas válidas para pagar" });
    }

    const total = totalFromDetalle(detalle);
    const externalReference = buildExternalReference(user.id, meses);

    const preferenceApi = new Preference(mpClient);

    const result = await preferenceApi.create({
      body: {
        items: [
          {
            title: `Pago de cuotas - ${user.nombre}`,
            quantity: 1,
            unit_price: Number(total),
            currency_id: "ARS",
          },
        ],
        payer: {
          name: user.nombre,
          email: user.mail || undefined,
        },
        external_reference: externalReference,
        back_urls: {
          success: `${BASE_URL}/?mp=success`,
          pending: `${BASE_URL}/?mp=pending`,
          failure: `${BASE_URL}/?mp=failure`,
        },
        auto_return: "approved",
        notification_url: `${BASE_URL}/api/mp/webhook`,
      },
    });

    return res.json({
      ok: true,
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
    });
  } catch (err) {
    console.error("Error creando preferencia MP:", err);
    return res.status(500).json({ error: "No se pudo crear la preferencia" });
  }
});

// =============================
// API Público: webhook MP
// =============================
app.post("/api/mp/webhook", async (req, res) => {
  try {
    if (!isWebhookSignatureValid(req)) {
      return res.status(401).send("invalid signature");
    }

    const topic = req.query.type || req.query.topic;
    const dataId =
      req.query["data.id"] ||
      req.body?.data?.id ||
      req.query.id;

    if (topic !== "payment" || !dataId) {
      return res.status(200).send("ignored");
    }

    if (!mpClient) {
      return res.status(500).send("mp not configured");
    }

    const paymentApi = new Payment(mpClient);
    const payment = await paymentApi.get({ id: dataId });

    if (!payment) {
      return res.status(404).send("payment not found");
    }

    if (payment.status !== "approved") {
      return res.status(200).send("payment not approved");
    }

    const ref = parseExternalReference(payment.external_reference);

    if (!ref?.userId || !Array.isArray(ref.meses)) {
      return res.status(400).send("invalid external_reference");
    }

    let userForMail = null;
    let detallesPagados = [];
    let totalBase = 0;
    let totalInteres = 0;
    let total = 0;

    await withWriteLock(async () => {
      const data = leerPagos();
      const idx = data.findIndex((u) => u.id === ref.userId);

      if (idx === -1) return;

      const user = data[idx];
      userForMail = user;

      if (!Array.isArray(user.cuotas)) {
        user.cuotas = [];
      }

      user.cuotas = user.cuotas.map((c) => {
        if (!ref.meses.includes(normalizeStr(c.mes))) return c;
        if ((c.estado || "pendiente") === "pagado") return c;

        const calc = calcularInteresPorCuota(c.monto, c.mes, new Date());

        detallesPagados.push({
          mes: c.mes,
          montoBase: calc.base,
          diasInteres: calc.diasInteres,
          interes: calc.interes,
          total: calc.total,
        });

        return {
          ...c,
          estado: "pagado",
          fechaPago: new Date().toISOString(),
          interesAplicado: calc.interes,
          diasInteres: calc.diasInteres,
          totalPagado: calc.total,
          mpPaymentId: String(payment.id),
          mpStatus: String(payment.status),
        };
      });

      guardarPagos(data);
    });

    totalBase = detallesPagados.reduce((a, x) => a + x.montoBase, 0);
    totalInteres = detallesPagados.reduce((a, x) => a + x.interes, 0);
    total = detallesPagados.reduce((a, x) => a + x.total, 0);

    if (NOTIFY_EMAIL && userForMail && detallesPagados.length > 0) {
      const subject = `Pago recibido por Mercado Pago: ${userForMail.nombre}`;
      const text =
        `Se registró un pago por Mercado Pago.\n\n` +
        `Cliente: ${userForMail.nombre}\n` +
        `Mail: ${userForMail.mail || "-"}\n` +
        `Teléfono: ${userForMail.telefono || "-"}\n` +
        `Fecha: ${new Date().toLocaleString("es-AR")}\n\n` +
        `Cuotas pagadas:\n` +
        detallesPagados
          .map(
            (d) =>
              `- ${d.mes}: Base $${d.montoBase} + Interés (${d.diasInteres} días) $${d.interes} = Total $${d.total}`
          )
          .join("\n") +
        `\n\nTotales:\nBase: $${totalBase}\nInterés: $${totalInteres}\nTOTAL: $${total}\n`;

      try {
        await enviarMailPago({
          to: NOTIFY_EMAIL,
          subject,
          text,
        });
      } catch (e) {
        console.error("Error enviando mail webhook:", e);
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Error webhook MP:", err);
    return res.status(500).send("error");
  }
});

// =============================
// API Público pagar manual
// (lo dejo por si querés seguir usándolo)
// =============================
app.post("/api/pagar", async (req, res) => {
  const nombre = normalizeLower(req.body?.nombre);
  const contacto = normalizeLower(req.body?.contacto);
  const meses = Array.isArray(req.body?.meses)
    ? req.body.meses.map(normalizeStr).filter(Boolean)
    : [];

  if (!nombre || !contacto || meses.length === 0) {
    return res.status(400).json({ error: "Faltan nombre/contacto/meses" });
  }

  const hoy = new Date();

  return withWriteLock(async () => {
    const data = leerPagos();
    const idx = data.findIndex(
      (p) =>
        normalizeLower(p.nombre) === nombre &&
        (normalizeLower(p.mail) === contacto ||
          normalizeLower(p.telefono) === contacto)
    );

    if (idx === -1) {
      return res.status(404).json({ error: "No encontrado" });
    }

    const user = data[idx];
    if (!Array.isArray(user.cuotas)) user.cuotas = [];

    const detallesPagados = [];

    user.cuotas = user.cuotas.map((c) => {
      const esSeleccionada = meses.includes(normalizeStr(c.mes));
      const yaPagada = (c.estado || "pendiente") === "pagado";

      if (!esSeleccionada || yaPagada) return c;

      const calc = calcularInteresPorCuota(c.monto, c.mes, hoy);

      detallesPagados.push({
        mes: c.mes,
        montoBase: calc.base,
        diasInteres: calc.diasInteres,
        interes: calc.interes,
        total: calc.total,
      });

      return {
        ...c,
        estado: "pagado",
        fechaPago: hoy.toISOString(),
        interesAplicado: calc.interes,
        diasInteres: calc.diasInteres,
        totalPagado: calc.total,
      };
    });

    if (detallesPagados.length === 0) {
      return res
        .status(400)
        .json({ error: "No se marcó ninguna cuota (¿ya estaban pagadas?)" });
    }

    guardarPagos(data);

    const totalBase = detallesPagados.reduce((a, x) => a + x.montoBase, 0);
    const totalInteres = detallesPagados.reduce((a, x) => a + x.interes, 0);
    const total = detallesPagados.reduce((a, x) => a + x.total, 0);

    let emailResult = { ok: false, reason: "smtp_not_configured" };

    if (NOTIFY_EMAIL) {
      const subject = `Pago recibido: ${user.nombre}`;
      const text =
        `Se registró un pago.\n\n` +
        `Cliente: ${user.nombre}\n` +
        `Mail: ${user.mail || "-"}\n` +
        `Teléfono: ${user.telefono || "-"}\n` +
        `Fecha: ${hoy.toLocaleString("es-AR")}\n\n` +
        `Cuotas pagadas:\n` +
        detallesPagados
          .map(
            (d) =>
              `- ${d.mes}: Base $${d.montoBase} + Interés (${d.diasInteres} días) $${d.interes} = Total $${d.total}`
          )
          .join("\n") +
        `\n\nTotales:\nBase: $${totalBase}\nInterés: $${totalInteres}\nTOTAL: $${total}\n`;

      try {
        emailResult = await enviarMailPago({
          to: NOTIFY_EMAIL,
          subject,
          text,
        });
      } catch (e) {
        console.error("Error enviando mail:", e);
        emailResult = { ok: false, reason: "send_failed" };
      }
    }

    return res.json({
      ok: true,
      cuotasPagadas: detallesPagados,
      totalBase,
      totalInteres,
      total,
      email: emailResult,
    });
  });
});

// =============================
// Start
// =============================
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(
    `Interés: ${(TASA_DIARIA * 100).toFixed(3)}% diario | sin interés hasta día ${DIA_LIMITE_SIN_INTERES} | cuenta desde día ${DIA_INICIO_INTERES}`
  );
  console.log(
    MP_ACCESS_TOKEN
      ? "Mercado Pago configurado"
      : "Mercado Pago NO configurado"
  );
});