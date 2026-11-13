# Auditoría del entregable: Desafío Fútbol (Hackathon Argentina Space 2026)

Esta carpeta sirve para comprobar, con evidencia reproducible, qué parte de la consigna del desafío cumple el repositorio y qué parte falta.
Se basa en el método *Elephant-Goldfish*: el equipo (el "elefante") escribe con todo el contexto, y después lo revisan lectores que no participaron de la conversación (los "peces dorados").
Por eso cada afirmación de esta carpeta apunta a un archivo, a una función o a una corrida guardada. Ninguna depende de lo que se haya dicho en el chat.

| Archivo | Qué es |
|---|---|
| `README.md` | Esta matriz: requisito → dónde está → cómo se comprueba → estado. |
| `correr.sh` | Corre tres partidos de práctica en paralelo contra el simulador oficial (circuito normal, cambio de turno con jueza ausente y reclamo) y guarda la evidencia en `corridas/<fecha>-<commit>/`. |
| `GUION_DEMO.md` | Camino único para la demo, guion del video de 3 minutos y pasos del partido final. |
| `datos_ficticios.py` | Comprueba que las salidas solo tengan dominios `.test`/`.example` e IPs RFC 5737. |
| `PRIORIDADES.md` | Lo que falta o es débil, ordenado por impacto en la evaluación. |
| `REVISION.md` | Protocolo para la revisión de "peces dorados" (lectores sin contexto) y registro de sus hallazgos. |
| `ci/auditoria.yml` | Workflow de GitHub Actions que corre `correr.sh` en cada push (copiar a `.github/workflows/`). |
| `corridas/` | Resultados guardados. Cada corrida tiene el commit, la evaluación oficial y un `MANIFIESTO.sha256`. |

## Cómo auditar un cambio

```bash
auditoria/correr.sh          # ~4 min con aceleración x30
cat auditoria/corridas/*/resumen.txt | tail -n 40
```

Regla del equipo: **un cambio que toca el núcleo entra solo con una corrida nueva en `corridas/`** que no empeore el resumen de `verificar.py`.
GitHub Actions puede correr lo mismo en cada push y PR: `ci/auditoria.yml` está listo, pero hay que copiarlo a `.github/workflows/` desde la web de GitHub (el token con el que se subió esta rama no tiene permiso para crear workflows).

## Alcance: hay dos plataformas en el repo

1. **App web** (`index.html`, `app.js`, `oraculo.js`, `supa.js`, `api/`, `supabase/schema.sql`): expedientes sobre streams reales, oráculo de consenso, juez con Supabase Auth y RLS, registro público. Publicada en https://expedientes-futbol.vercel.app.
2. **Motor del desafío** (`desafio-simulador/plataforma/`): corre contra el simulador oficial (`desafio-simulador/simulador/`). Es lo que mide `evaluacion/verificar.py` en el partido final. Puede publicar en el mismo Supabase (`supabase/motor.sql`, `plataforma/supabase_puente.py`), y entonces el juez firma desde la app web.

**Para la evaluación del desafío cuenta el motor**: es el único que habla con los proveedores simulados. La app web es la interfaz del juez y el registro público. La matriz indica cuál de los dos cubre cada punto.

## Matriz del núcleo obligatorio

Estados: **cumple** (hay código y una comprobación automática que lo confirma) · **parcial** (hay código, pero la comprobación es manual o deja casos afuera) · **falta**.

| # | Requisito (texto de la consigna) | Dónde está | Cómo se comprueba | Estado |
|---|---|---|---|---|
| N1 | Marca de agua verificada: coincide con el partido | `plataforma/expedientes.py` → `verificar_marca()` | `expedientes.py --verificar`; cero falsos positivos en `verificar.py` | cumple |
| N2 | …y no es un licenciatario en su propio dominio | `verificar_marca()` (`host_en` contra `dominios` del licenciatario) | `verificar.py`: «bloqueos falsos positivos: 0» | cumple |
| N3 | Servidor que entrega el video: host, IP y ASN | `Armador` en `expedientes.py` (datos de la detección del simulador) | cada `entrega/expedientes/EXP-*.json` | cumple |
| N4 | Riesgo colateral: IP compartida → bloqueo por dominio | `evaluar_colateral()` (DNS pasivo del simulador) | `verificar.py`: «bloqueos con daño colateral: 0», «dominios legítimos afectados: 0» | cumple |
| N5 | Hashes de la captura y sellos de tiempo | `sellar()`, `exportar_capturas()` → `evidencia/SHA256SUMS` | `sha256sum -c SHA256SUMS`; `servidor.py --verificar-sellos <salida>/sellos` (cada `hash_encadenado` y cada decisión tienen un `.tsr` de FreeTSA/Sectigo, `sello_tiempo.py`) | cumple (sin internet, el sello queda `sello_fallido` en la auditoría y el circuito sigue) |
| N6 | Notificación al juez de turno | `Plataforma.abrir_tramite()` → evento `juez_notificado` | `auditoria.jsonl` | cumple |
| N7 | Decisión firmada | `web/juez.html` firma con WebCrypto (Ed25519 / ECDSA P-256, clave no exportable en IndexedDB) el texto `DECISION\|exp\|hash_expediente\|decisión\|juez`; `comprobar_firma()` la verifica con `firma_juez.py` (stdlib, contrastado con `cryptography` y el vector 1 de RFC 8032). El HMAC queda solo como firma de transporte que exige el simulador | `servidor.py --verificar-firmas <salida>/plataforma.json` (paso de `correr.sh`) | cumple (MVP: el alta de la clave es al primer login con contraseña y queda en la auditoría como `clave_registrada`; en producción, firma digital con certificado) |
| N8 | Juez entra con usuario y contraseña | `Plataforma.login()` (PBKDF2), `usuarios_demo.json`; en la app web, Supabase Auth | `juez_automatico.py` hace login | cumple |
| N9 | Cada juez ve y firma solo lo suyo mientras está de turno | `puede_firmar()`, `vista_juez()`; en Supabase, RLS `juez_de_turno_*` | `verificar.py`: «órdenes firmadas fuera de turno: 0»; `juez_automatico.py` intenta firmar fuera de turno | cumple |
| N10 | Al cambio de turno lo pendiente pasa al entrante y el saliente ya no firma | `reasignar()` → `pendiente_reasignado`; reenvíos `RE-*` | partido `cambio_turno` de `correr.sh` (`juez_automatico.py --ausente laura`): exige `pendiente_reasignado` ≥ 1, firmas del entrante ≥ 1, cero firmas de la saliente y un 403 fuera de turno | cumple |
| N11 | Orden a cada proveedor en el tipo que acepta | `objetivos_para()`, `preparar_envios()` (FibraValle solo dominio) | `verificar.py`: «órdenes rechazadas: 0» | cumple |
| N12 | Reintento si falla | `enviar()` → `reintentar()` con `orden_id` nuevo y firmas de reserva | `verificar.py`: órdenes fallidas > 0 y fases bloqueadas 7/7 | cumple |
| N13 | Seguimiento de la confirmación | `seguir_ordenes()` → `confirmacion_aplicada` | `auditoria.jsonl` | cumple |
| N14 | Vencimiento automático de bloqueos por IP al terminar | `vence_min` en la orden; `controlar_vencimiento()` | `verificar.py`: «bloqueos ip activos post partido: 0» | cumple |
| N15 | Registro de auditoría de cada paso | clase `Auditoria` (JSONL encadenado SHA-256) | `--verificar-auditoria`; `--verificar-sellos` comprueba que cada ancla RFC 3161 coincide con la entrada `n` | cumple: la cabecera se sella con RFC 3161 cada 25 entradas y al final del partido, y se muestra en `/publico`. Reescribir el archivo deja de coincidir con las anclas selladas por un tercero |

## Matriz de extras

| # | Extra | Dónde está | Cómo se comprueba | Estado |
|---|---|---|---|---|
| E1 | Reclamos: verificación, levantamiento firmado, reemplazo más preciso | `verificar_reclamo()`, `decidir_reclamo()` | partido `reclamo` de `correr.sh` (`--forzar-bloqueo-ip live.golazo-libre.test`): exige `reclamo_recibido`, `reclamo_verificado`, `reclamo_decidido`, `orden_levantada` y «reclamos resueltos por levantamiento» ≥ 1 en `verificar.py` | cumple |
| E2 | Registro público de transparencia | motor `/publico`; app web `#/transparencia` (vista `registro_publico`) | revisión manual: no expone capturas, HAR ni reportante | cumple (manual) |
| E3 | Dónde se promocionó el enlace | expediente (`promocion`), avisos `EXP-*-RED*.txt` | `entrega/avisos/` | cumple |
| E4 | Interfaz del juez cuidada, celular, notificaciones | `plataforma/web/` (sonido y vibración); app web `#/juez` con Realtime | manual en celular | parcial: sin prueba automática; el aviso por WhatsApp o mail (n8n) no está configurado |

## Fuera de la consigna, pero ya existe en la app web

Oráculo de consenso de 4 señales, grafo página → reproductor → host → IP → ASN con RDAP, Certificate Transparency y nameservers, prueba desde varios puntos (check-host) y anexado dinámico.
Suma como diferencial, pero **no reemplaza al núcleo**: la consigna dice que los extras no compensan un núcleo que no corre.

## Última corrida

`corridas/20261113T032715Z-58682f4/` (commit `58682f4`: el juez firma en su dispositivo con Ed25519 y el servidor verifica con la clave pública; sin cambios sin commitear, aceleración x30). Las corridas anteriores (`20261113T023339Z-05d3e17`, solo el partido normal; `20261113T025420Z-784fa30`, tres partidos sin sellos externos; `20261113T031423Z-401466a`, con sellos pero firma HMAC en el servidor) quedan como histórico.

| Control | oficial | cambio_turno | reclamo |
|---|---|---|---|
| Pruebas de la app web (`node --test`) | OK (15 de 15) | | |
| Fases piratas bloqueadas | **7 de 7** | 6 de 7 (ver nota) | — |
| Órdenes recibidas / aplicadas / fallidas y reintentadas / rechazadas | 33 / 30 / 3 / 0 | | |
| Daño colateral · dominios legítimos afectados · falsos positivos | 0 · 0 · 0 | | esperado (bloqueo IP forzado) |
| Bloqueos por IP activos después del partido | 0 | | |
| Órdenes firmadas fuera de turno | 0 | 0 (1 intento rechazado con 403) | |
| Pendientes reasignados al entrante / firmados por el entrante / por la saliente | | 4 / 7 / 0 | |
| Reclamo | | | R-001 `noticias-del-valle.test` levantado en 0,2 min |
| Auditoría encadenada | 245 íntegras | 254 íntegras | 255 íntegras |
| Firmas del juez desde su dispositivo (`--verificar-firmas`) | 7 OK | 7 OK | 9 OK |
| Sellos RFC 3161 (`--verificar-sellos`) · anclas de la auditoría | 55 OK · 10 | 56 OK · 11 | 56 OK · 11 |
| Expedientes y capturas | 7 y 38 OK | 7 y 38 OK | 7 y 38 OK |
| Datos ficticios | 0 IPs / 0 dominios fuera de rango | ídem | ídem |
| Veredicto | **NÚCLEO OK · CAMBIO DE TURNO OK · RECLAMO OK** | | |

En la corrida `401466a`, la última ancla del partido oficial se verificó además con la cadena de certificados de FreeTSA (`openssl ts -verify … -CAfile cacert.pem -untrusted tsa.crt` → `Verification: OK`), y su hash coincide con la entrada 241 de `auditoria.jsonl`.

**Nota sobre el cambio de turno.** Con la jueza saliente ausente, `pelotaya` fase 1 (min 2–36) no se bloquea nunca y los streams que arrancan antes del minuto 50 recién se bloquean al entrar el juez (42 a 45 min tarde). La plataforma hace lo correcto (nadie firma por la jueza), pero en la final **cada minuto sin un juez atento cuesta puntos de Velocidad**. Ver `PRIORIDADES.md`.
