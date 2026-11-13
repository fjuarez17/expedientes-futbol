# Expedientes · Piratería de fútbol argentino

Plataforma web para **armar expedientes verificables de streams piratas** de partidos del fútbol argentino (Liga Profesional), pensada para usarse desde el celular.

**App en vivo:** https://expedientes-futbol.vercel.app

> Para ver un caso completo sin cargar nada: en el **Panel** tocá **“Cargar expediente de demostración”** (es un caso ficticio con dominios `.example` e IPs de documentación RFC 5737).

---

## Índice

1. [Qué problema resuelve](#qué-problema-resuelve)
2. [Qué se hizo](#qué-se-hizo)
   - [El expediente, punto por punto](#el-expediente-punto-por-punto)
   - [Búsqueda, auditoría y verificación](#búsqueda-auditoría-y-verificación)
3. [Cómo funciona por dentro](#cómo-funciona-por-dentro)
4. [Fuentes de datos](#fuentes-de-datos)
5. [Cómo verificar la evidencia por fuera de la plataforma](#cómo-verificar-la-evidencia-por-fuera-de-la-plataforma)
6. [Qué falta](#qué-falta)
7. [Qué se puede mejorar](#qué-se-puede-mejorar)
8. [Estructura del repositorio](#estructura-del-repositorio)
9. [Correrlo y publicarlo](#correrlo-y-publicarlo)
10. [Aviso legal y de uso](#aviso-legal-y-de-uso)

---

## Qué problema resuelve

Cuando un partido se retransmite sin autorización, pedir un bloqueo requiere evidencia sólida y difícil de discutir:

- que **es la señal oficial** (y no cualquier video),
- **qué servidor entrega realmente el video** (bloquear la página que muestra el reproductor no corta el video: el reproductor suele estar embebido desde otro dominio y los segmentos vienen de un tercero),
- **qué daño colateral** causaría bloquear ese servidor (si es una CDN o un hosting compartido, bloquear la IP tira abajo sitios legítimos),
- que la evidencia **no fue alterada** después de capturada,
- dónde se **promocionó** el enlace,
- y **por cuánto tiempo** pedir la medida.

La plataforma junta todo eso en un expediente por stream, atado a un partido concreto, sellado con hash y hora oficial, y con un registro de auditoría encadenado.

---

## Qué se hizo

### El expediente, punto por punto

Cada expediente se crea desde **Partidos → “+ Expediente”** pegando la URL de la página pirata (y, opcionalmente, la URL del `.m3u8` si se la tiene). Tiene un **puntaje de solidez** (0–100 %) que muestra qué evidencia falta.

#### 1. Prueba de señal oficial (marca de agua)

- Se pega el **payload** que devuelve el detector de marca de agua forense al analizar la captura del stream.
- Formato definido para la plataforma: `AR-<PARTIDO>-<LIC>-<SESION>-<CTRL>`
  - `PARTIDO`: 6 hex derivados del ID del partido (SHA-256).
  - `LIC`: código de 3 letras del licenciatario (ESP, TNT, DTV, FLW, TLC, MOV…).
  - `SESION`: 8 hex que identifican la sesión/decodificador al que se emitió la señal.
  - `CTRL`: 4 hex de control (SHA-256 del resto) para detectar lecturas erróneas o adulteraciones.
- La plataforma verifica:
  1. ✅ dígito de control válido,
  2. ✅ que la marca **corresponde a ese partido** (si es de otro, dice de cuál),
  3. ✅ a **qué licenciatario** se emitió,
  4. ✅ que el sitio donde se ve **no es un dominio propio de ningún licenciatario autorizado** (si lo es, avisa que es distribución autorizada y no corresponde expediente),
  5. ⚠️ si el payload figura en el **registro de emisión** importado, identifica la **sesión de origen de la fuga**.
- Veredicto: *“Señal oficial redistribuida sin autorización”* o no.

#### 2. Servidor que entrega el video (host, IP, ASN)

Función serverless `api/analyze` que:

- Descarga la página pirata con user-agent de Android y **sigue la cadena de carga**: página → iframes/embeds (hasta 2 niveles, enviando el `Referer` correcto) → manifiestos `.m3u8` / `.mpd` → **segmentos** de video.
- Detecta URLs de video en `<iframe>`, `<video>`, `<source>`, variables JS (`file:`, `source:`, `hls:`…) y strings en `atob("…")`.
- Abre el manifiesto, baja a la variante y toma los primeros segmentos: **el host de los segmentos es el que entrega el video**.
- Para cada host: DNS (A, AAAA, CNAME), **ASN y titular**, prefijo, país, y tipo de infraestructura (CDN / nube pública / hosting-VPS).
- Guarda el **SHA-256 del HTML** de cada página descargada, códigos HTTP, cabeceras relevantes y horarios.
- Consulta **RDAP** del dominio: registrador, mail de abuso, fecha de alta y de vencimiento.
- El informe completo se hashea y se **sella con RFC 3161**.

#### 3. Riesgo colateral

- **Reverse IP**: cuántos otros dominios comparten esa IP (con muestra).
- Detección de CDN por **ASN** (Cloudflare, Akamai, Fastly, CloudFront, BunnyCDN, G-Core, CDN77…), por **CNAME** (`*.cloudfront.net`, `*.akamaiedge.net`…) y por **cabeceras** (`cf-ray`, `x-amz-cf-id`, `x-served-by`…).
- Nivel de riesgo: **alto / medio / bajo / sin datos**, con explicación.
- **Recomendación**:
  - CDN, nube pública o IP compartida (> 5 dominios) → **bloquear por dominio (DNS + SNI), no por IP**.
  - IP dedicada (pocos dominios) → **bloquear IP + dominio**.
  - Sin datos → por prudencia, **bloquear por dominio**.

#### 4. Hashes de la captura y sellos de tiempo

- Las capturas (foto o video) se procesan **en el teléfono**: el SHA-256 se calcula localmente y **el archivo no se sube a ningún lado**; solo el hash viaja a la autoridad de sellado.
- Cada hash se sella con **FreeTSA (RFC 3161)**; si no responde, se pide a **Sectigo**. Solo se usan TSAs por HTTPS: la función no verifica la firma CMS del token, así que una TSA por HTTP plano permitiría que alguien en el camino inyecte un sello falso. El expediente guarda qué TSA selló (`tsa.tsaId`). Si ninguna responde, el sello queda pendiente con un botón **Reintentar sello** (también para el sello del expediente, que solo suma a la solidez cuando tiene hora oficial).
- Los videos de más de 64 MB se hashean **por partes** (SHA-256 incremental, bloques de 4 MB) para no cargar el archivo entero en la memoria del celular.
- La **demo** trae una captura de ejemplo generada en el momento, con hash y sello reales: arranca en 95 % y llega al 100 % con **Sellar expediente** o **Correr el oráculo**. Si ninguna TSA responde, la demo usa sellos **simulados** con etiqueta DEMO: no tienen `.tsr`, no suman solidez, no se pueden publicar y muestran **Reintentar sello**.
- Se guarda el token `.tsr` (descargable), la hora oficial (`genTime`) y se comprueba que el hash quedó incluido en el sello.
- Se guarda una miniatura chica de las fotos para el PDF.
- Se probó la verificación externa con `openssl ts -verify` → `Verification: OK`.

#### 4 bis. Verificación del stream de fútbol (PASO 0.0, automática)

“Crear y verificar” en **Nuevo expediente**:

- `api/analyze` además arma un **perfil de la página** (`api/_futbol.js`): reproductor (Clappr, JW Player, hls.js, Video.js, P2P…), palabras de fútbol, canal anunciado (ESPN, TNT Sports, DSports, TyC…) con su licenciatario. En el navegador se buscan los equipos en el fixture: avisa si la página nombra otro partido y deja cambiarlo.
- `api/stream-capture` baja el `.m3u8` (la variante más liviana con video), lo vuelve a pedir una duración de segmento después para comprobar que **la secuencia avanza (en vivo)**, y baja los últimos 2 segmentos con su SHA-256, status, servidor y `PROGRAM-DATE-TIME`. Cada salto se valida contra IPs privadas.
- El navegador recalcula el hash del segmento, saca un **fotograma real** (mux.js → MP4 → canvas → PNG) para el detector de marca de agua, y sella con RFC 3161 cada segmento, el fotograma y el HTML de la página (`api/capture`).
- Veredicto: reproductor + contenido de fútbol + stream en vivo, y que ni la página ni los embebidos sean dominios de un licenciatario. También marca si se capturó durante el partido.
- Página de prueba: `/prueba/en-vivo.html` imita un sitio de fútbol libre con un reproductor embebido y la señal pública de test de Unified Streaming (no es un partido).
- Límites: segmentos cifrados (AES-128) o fMP4 se hashean pero no dan fotograma; si el `.m3u8` se arma por JS ofuscado o detrás de un challenge anti-bot, hay que pegarlo a mano.

#### 5. Dónde se promocionó el enlace (extra)

- Se carga la URL del posteo/mensaje; la red se detecta sola: **X, Discord, Telegram**, Facebook, Instagram, TikTok, WhatsApp, Reddit, YouTube u Otro.
- Cuenta/canal, alcance y captura opcional del posteo (hasheada y sellada).

#### 6. Medida y vencimiento propuesto

Reglas, editables a mano:

| Situación | Vencimiento del bloqueo de dominio |
|---|---|
| Primera detección | 30 días desde el partido (renovable) |
| Reincidente (dominio/IP ya vistos en 1–2 expedientes) | 90 días |
| Reincidente en 3 o más expedientes | Hasta fin de temporada (31/12) |

- Si el servidor de video tiene IP dedicada: se suma un **bloqueo dinámico de IP** durante la ventana del partido (+1 h), renovable fecha a fecha.
- Si la IP es de CDN/compartida: se indica explícitamente **“NO bloquear por IP”** con el motivo.

#### 7. Sellado del expediente

- Calcula el SHA-256 del expediente completo (JSON canónico con claves ordenadas) y lo sella con RFC 3161.
- El expediente queda en solo lectura. “Nueva versión” lo reabre y deja el sello anterior en el historial.
- Exportable a **PDF** (imprimir desde el navegador) y a **JSON** (incluye los tokens `.tsr` y los eventos de auditoría del caso).

### Búsqueda, auditoría y verificación

- **Partidos**: fixture de la Liga Profesional bajado automáticamente (TheSportsDB) + carga manual con los 30 equipos de 2026. Cada partido muestra cuántos expedientes tiene.
- **Expedientes**: buscador por dominio, IP, ASN, titular del ASN, payload de marca, cuenta de promoción; filtros por estado (borrador/sellado) y por partido. Exportar/importar toda la base.
- **Base de conocimiento**: agrega lo relevado en todos los expedientes (ASN, dominios, IPs) con cantidad de expedientes, partidos y última vez visto. Se usa para detectar **reincidencia** y endurecer el vencimiento propuesto. Es lo que hace que la plataforma “aprenda” con cada caso (reglas + datos acumulados, no un modelo de IA).
- **Licenciatarios y marcas**: dominios autorizados por licenciatario (editables) y **registro de emisión de marcas** (importar el export del sistema de marcado, o generar marcas de prueba).
- **Verificar**:
  - subir un archivo → calcula su hash y dice si coincide con alguna captura registrada;
  - subir un expediente JSON → recalcula el hash y dice si fue alterado respecto del sellado;
  - verificar todos los expedientes del dispositivo.
- **Banco de pruebas** (`#/pruebas`): servidor de pruebas de marcas de agua con una base ficticia, sin tocar señales reales. `GET /api/mock-payloads` emite payloads simulados con la estructura del detector forense (válidos, adulterados, no emitidos, licenciatario desconocido, otro partido, malformados) y `POST /api/verify-mark` (`{"payload": "...", "matchId": "..."}`) responde **200** si es válido y figura como emitido, **403** si la señal no está autorizada, **422** si el dígito de control no coincide y **400** si el formato es inválido. La pantalla permite verificar un payload a mano o correr el lote completo y comparar el código obtenido con el esperado. `node api/_wm.js 20` imprime payloads simulados por consola.
- **Auditoría**: cada acción (crear, analizar, verificar marca, agregar captura, sellar, editar vencimiento, borrar…) queda en un **registro encadenado por hash** (cada evento incluye el hash del anterior). Si alguien modifica o borra un evento, la cadena se rompe y se ve en qué evento.

---

## Oráculo, juez de turno y registro público (v3)

Archivo `oraculo.js` (modo local) + `supabase/schema.sql` (modo multiusuario).

- **Filtro de consenso** (paso 9): pasan a la cola del juez solo los expedientes que cumplen las cuatro señales: 1) la marca de agua coincide con un partido **en curso**; 2) ningún dominio del caso está en la lista de licenciatarios; 3) el video se reproduce desde **dos o más puntos independientes** (`api/probe` → nodos de check-host.net en distintos países/ASN); 4) el riesgo colateral está calculado y hay un tipo de bloqueo recomendado. Si falla una, va a **revisión humana**. Si pasa, el expediente se congela (SHA-256 + sello RFC 3161).
- **Juez de turno** (`#/juez`): tabla de turnos (`juez_id`, `jurisdiccion`, `desde`, `hasta`). El juez competente se calcula por consulta; la cola se ordena por minutos restantes del partido; el traspaso de turno queda en la auditoría. La firma es **Ed25519** (WebCrypto; ECDSA P-256 si el navegador no soporta Ed25519) sobre `{sha256, juez_id, ts}`: si el expediente cambia, la firma deja de verificar. Al firmar se generan las órdenes.
- **Aviso**: si se configura un webhook de n8n, `api/notify` le manda número, juez, contacto y link directo a la tarjeta.
- **Grafo de origen** (paso 8 y `#/origenes`): página → reproductor → host de video → IP → ASN, más `api/trace`: RDAP (registrador, fecha de alta, dominios nuevos ≤ 30 días), nameservers y dominios hermanos por Certificate Transparency (certspotter). Agrupa por host de video, sesión de marca de agua, nameservers y ASN.
- **Anexo dinámico**: un dominio nuevo con el mismo host de video o la misma sesión de marca de agua que un expediente ya firmado se anexa a ese expediente y suma una orden, en vez de abrir uno nuevo.
- **Registro público** (`#/transparencia`): qué se bloqueó, tipo, juzgado, desde/hasta, estado (vigente / vencida / levantada por reclamo) y el hash de cabecera de la auditoría. Sin evidencia ni identidad de quien reportó. Botón “Mi sitio fue bloqueado por error” → reclamo que resuelve el juez de turno.

**Modo compartido (Supabase, `supa.js`)** — ya conectado al proyecto. Con sesión iniciada (`#/acceso`): el reportante que corre el oráculo publica el expediente congelado en `expedientes` (estado `en_cola_juez`); el juez ve la cola en vivo (Realtime) solo si la RLS lo permite (turno activo + jurisdicción), firma (`firmas`) y se generan las `ordenes`; el registro público lee la vista `registro_publico` y `cabecera_auditoria` sin login; los reclamos van a `reclamos`. La auditoría remota se encadena con un trigger SHA-256. Las cuentas de jueces se crean desde el panel de Supabase (Auth + fila en `jueces` + `turnos`).

**Falta para producción:** ejecutar `supabase/schema.sql`, login de jueces con Supabase Auth, mover los datos de `localStorage` a las tablas, Realtime para la cola y firma digital con certificado en lugar de la clave Ed25519 del MVP. En modo local el selector "Actuás como" reemplaza al login y los jueces y turnos cargados son de ejemplo.

---

## Cómo funciona por dentro

```
Celular (navegador)                         Vercel (funciones serverless)
┌─────────────────────────────┐            ┌──────────────────────────────────────┐
│ index.html + app.js         │  GET       │ api/fixtures   → TheSportsDB         │
│ - SPA con rutas #/...       │ ─────────► │ api/analyze    → página, iframes,    │
│ - SHA-256 local (WebCrypto) │            │                  m3u8, segmentos,    │
│ - localStorage (base)       │  POST hash │                  dns.google, RIPEstat│
│ - auditoría encadenada      │ ─────────► │                  hackertarget, RDAP  │
│ - export JSON / PDF         │            │ api/timestamp  → TSAs RFC 3161      │
└─────────────────────────────┘            └──────────────────────────────────────┘
```

- **Frontend**: HTML + JS + CSS sin frameworks ni build. Todo en `app.js`.
- **Backend**: 3 funciones Node 20 sin dependencias (`fetch` nativo). `api/_lib.js` tiene utilidades compartidas.
- **Sellado RFC 3161**: `api/timestamp.js` arma el `TimeStampReq` en DER a mano (SHA-256, nonce aleatorio, `certReq=true`), lo manda a FreeTSA (con Sectigo de respaldo, ambas por HTTPS), valida el `PKIStatus`, la hora y que el hash esté en el token, y devuelve el `.tsr` en base64, la hora (`genTime`) y si el hash aparece en el token.
- **Diseño**: estética editorial inspirada en [Object — Football As Football](https://object.design/work/football-as-football/): fondo verde césped, tipografía grotesca grande (Plus Jakarta Sans), titulares blanco/negro, paneles negros tipo "figura" (`PASO 1.0`, `FIG 1.0`), menú a pantalla completa con ítems numerados y grilla de partidos con escudos en los colores de cada club (si la fuente no trae escudo, se dibuja uno con las iniciales).
- **Protección SSRF**: antes de descargar cualquier URL se resuelve el DNS y se rechazan IPs privadas/loopback/link-local.
- **Seguridad del contenido**: todo lo que viene de sitios piratas (títulos, URLs, dominios) se escapa antes de mostrarse.

---

## Fuentes de datos

| Dato | Fuente | Notas |
|---|---|---|
| Fixture Liga Profesional | [TheSportsDB](https://www.thesportsdb.com) (clave de prueba `123`, liga 4406) | La clave gratuita trae pocos partidos |
| DNS | [dns.google](https://dns.google) (DNS-over-HTTPS) | |
| ASN, titular, prefijo, país | [RIPEstat](https://stat.ripe.net) | Gratis, sin clave |
| Sitios en la misma IP | [HackerTarget reverse IP](https://hackertarget.com/reverse-ip-lookup/) | Límite diario de consultas |
| Registro de dominio | [rdap.org](https://rdap.org) | |
| Sello de tiempo | [FreeTSA](https://freetsa.org) (RFC 3161); respaldo [Sectigo](https://timestamp.sectigo.com) | |

---

## Cómo verificar la evidencia por fuera de la plataforma

Cualquier tercero (un juzgado, un perito, el ISP) puede comprobar la evidencia sin confiar en la plataforma:

```bash
# 1) Hash del archivo original de la captura
sha256sum captura.jpg

# 2) Certificados de FreeTSA
curl -O https://freetsa.org/files/cacert.pem
curl -O https://freetsa.org/files/tsa.crt

# 3) Verificar el sello (.tsr descargado desde el expediente)
openssl ts -verify -digest <SHA256_DE_LA_CAPTURA> -in sello.tsr -CAfile cacert.pem -untrusted tsa.crt
# → Verification: OK
# Si lo selló la TSA de respaldo (Sectigo), el certificado viene en el .tsr:
# openssl ts -verify -digest <SHA256> -in sello.tsr -CAfile /etc/ssl/certs/ca-certificates.crt

# 4) Ver la hora oficial del sello
openssl ts -reply -in sello.tsr -text
```

Para el expediente completo: el hash sellado está en el JSON exportado (`case.seal.sha256`) y se recalcula como SHA-256 del JSON canónico (claves ordenadas, sin `seal` y sin miniaturas). La pantalla **Verificar** hace ese cálculo.

---

## Qué falta

Cosas necesarias para usarla en producción y que **no están hechas**:

1. **Extracción real de la marca de agua.** La plataforma **valida** el payload, pero no lo extrae del video: eso lo hace el detector del proveedor de marcado forense (NAGRA NexGuard, Irdeto, Friend MTS, Verimatrix, etc.) que use cada licenciatario. Falta:
   - integrarse con la API/export de ese detector,
   - alinear el formato del payload (el `AR-…` es una propuesta propia),
   - cargar el registro real de emisión de marcas por partido.
2. **Base de datos compartida y usuarios.** Hoy todo vive en el `localStorage` del dispositivo (se puede exportar/importar JSON). Para un equipo hace falta una base central (por ejemplo Postgres/Supabase), **login con roles** (analista, supervisor, legal) y que la cadena de auditoría viva en el servidor.
3. **Datos reales de licenciatarios.** Los dominios autorizados cargados son **de ejemplo**: hay que reemplazarlos por los de los contratos vigentes (incluyendo CDNs y dominios técnicos de cada OTT).
4. **Fixture completo.** La clave gratuita de TheSportsDB trae pocos partidos; los faltantes se cargan a mano. Falta una fuente oficial o paga (API-Football, la propia LPF/AFA).
5. **Captura automática del stream.** Hoy las capturas se suben a mano. Falta un capturador (navegador headless) que grabe unos segundos del stream, saque fotogramas para el detector de marcas y lo hashee/selle solo.
6. **Streams con JavaScript ofuscado o protegidos.** Si el `.m3u8` se arma por JS dinámico, tokens o anti-bots (Cloudflare challenge), el análisis estático no lo encuentra; hay un campo para pegarlo a mano. Falta un análisis con navegador real que intercepte el tráfico de red.
7. **Reverse IP sin límites.** HackerTarget gratis tiene cupo diario; para volumen hace falta un proveedor pago (SecurityTrails, DomainTools, WhoisXML) o datos pasivos de DNS.
8. **Envío de la orden/notificación.** No genera ni manda todavía las notificaciones a ISPs, CDNs (abuse de Cloudflare, etc.), registradores ni plataformas (X, Telegram, Discord).
9. **Tests automáticos** y CI.

---

## Qué se puede mejorar

- **Monitoreo en vivo durante el partido**: escaneo programado de sitios conocidos y de canales de Telegram/Discord/X para detectar nuevos enlaces y abrir expedientes en borrador solos.
- **Clasificador entrenado** (ahora son reglas): con los expedientes cerrados como dataset, entrenar un modelo que puntúe si una página es pirata, agrupe sitios de una misma red (mismo player, mismo ASN, mismos patrones de URL) y priorice qué bloquear primero.
- **Agrupamiento de redes piratas**: grafo dominio ↔ IP ↔ ASN ↔ player embebido ↔ cuentas que promocionan, para atacar la infraestructura común en vez de sitio por sitio.
- **Re-verificación periódica**: volver a analizar los expedientes activos para ver si el sitio cambió de IP/CDN (evasión) o si el bloqueo está funcionando, y renovar vencimientos con evidencia nueva.
- **Doble sello / anclaje público**: sumar una segunda TSA (o una TSA calificada para valor legal reforzado) y opcionalmente anclar los hashes en una cadena pública (OpenTimestamps).
- **Firma digital** del expediente por el analista (certificado del firmante) además del sello de tiempo.
- **Plantillas legales**: PDF con formato de presentación judicial / carta a ISP generada desde el expediente.
- **Panel por partido y por fecha**: cantidad de streams, tiempo hasta la detección, tiempo hasta el bloqueo, efectividad por ISP.
- **PWA instalable y modo offline** (service worker) para trabajar en la cancha o con mala señal.
- **Internacionalización** y soporte para otras competencias (Copa de la Liga, Copa Argentina, Primera Nacional, Libertadores).
- **Rendimiento**: mover el hashing de videos grandes a un Web Worker para que la interfaz no se trabe mientras calcula.

---

## Estructura del repositorio

```
.
├── index.html          # Shell de la app (navegación)
├── styles.css          # Estilos (mobile-first, modo impresión para PDF)
├── app.js              # Toda la lógica del frontend (SPA)
├── api/
│   ├── _lib.js         # Utilidades: fetch con timeout, DNS, RIPEstat, reverse IP, RDAP, clasificación de ASN/CDN
│   ├── analyze.js      # Análisis técnico: cadena de carga, servidor de video, riesgo colateral
│   ├── timestamp.js    # Sellado RFC 3161 (FreeTSA + respaldos)
│   ├── _wm.js          # Marca de agua: regex, dígito de control, base de prueba y emisor mock
│   ├── verify-mark.js  # Servidor de pruebas de marcas (200 / 403 / 422 / 400)
│   ├── mock-payloads.js # Payloads simulados del detector forense
│   └── fixtures.js     # Fixture de la Liga Profesional (TheSportsDB)
├── tests/wm.test.js    # Pruebas unitarias y de API (node --test tests/)
└── vercel.json         # Config de Vercel (timeout de funciones y cabeceras)
```

---

## Correrlo y publicarlo

No tiene dependencias ni paso de build.

```bash
# Local (requiere Node 20 y Vercel CLI)
npm i -g vercel
vercel dev            # http://localhost:3000

# Pruebas (Node 20, sin dependencias)
node --test tests/

# Publicar
vercel deploy --prod
```

---

## Aviso legal y de uso

Herramienta de apoyo para titulares de derechos y sus representantes en la **documentación** de retransmisiones no autorizadas. Las recomendaciones de bloqueo y los vencimientos son **propuestas** que debe revisar un profesional y, cuando corresponda, ordenar una autoridad competente. El análisis solo descarga contenido público (páginas y manifiestos) para identificar infraestructura; no evade protecciones ni accede a sistemas de terceros.

Los dominios de licenciatarios, los ejemplos de demostración y el formato de payload de marca de agua son **ilustrativos**.
