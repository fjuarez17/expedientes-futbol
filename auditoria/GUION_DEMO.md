# Guion: video de demo y partido final

## Camino único para la demo

**El juez firma en la interfaz del motor** (`desafio-simulador/plataforma/web/`, puerto 8090). Es el camino que mide
`verificar.py`, no depende de internet ni de Supabase y es el que prueba `auditoria/correr.sh` en cada corrida.
La app web (https://expedientes-futbol.vercel.app) se muestra solo como complemento: registro público, verificación
de evidencia y oráculo sobre streams reales. El puente a Supabase (`--supabase-url`) queda como plan B y no se usa en vivo.

## Video (máximo 3 minutos)

Grabar sobre un partido de práctica con `--acelerar 6` (17,5 min reales) y recortar. Dos terminales y un navegador.

| Tiempo | Qué se ve | Qué se dice |
|---|---|---|
| 0:00–0:15 | Terminales con simulador y motor arrancando | “El motor lee las detecciones del simulador oficial y arma un expediente por servidor pirata.” |
| 0:15–0:45 | Expediente abierto: marca de agua, host/IP/ASN, riesgo colateral, hashes | “La marca coincide con el partido y no es de un licenciatario en su dominio. Esta IP la comparten sitios legítimos: se pide bloqueo por dominio.” |
| 0:45–1:15 | Login de `laura`, cola del juez, **Aprobar** | “La jueza de turno entra con su usuario, ve solo lo suyo y firma sobre el hash del expediente.” |
| 1:15–1:45 | Estado por proveedor: recibida → aplicada; una fallida con reintento | “Cada proveedor recibe la orden en el tipo que acepta. FibraValle solo dominio. Si falla, se reenvía con otra orden.” |
| 1:45–2:05 | Minuto 50: entra `martin`, aparecen los pendientes; `laura` recibe 403 | “Cambio de turno: lo pendiente pasa al entrante y la saliente ya no puede firmar.” |
| 2:05–2:25 | Reclamo de un sitio legítimo → **Aceptar y levantar** | “El reclamo se verifica con DNS pasivo, se levanta con firma y se reemplaza por un bloqueo por dominio.” (usar la corrida con `--forzar-bloqueo-ip`) |
| 2:25–2:40 | `/publico` | “Registro público: qué se bloqueó, por orden de quién y hasta cuándo, sin evidencia ni datos del reportante.” |
| 2:40–3:00 | Salida de `verificar.py` y `--verificar-auditoria` | “7 de 7 fases bloqueadas, cero daño colateral, cero bloqueos por IP después del partido, auditoría íntegra.” |

## Partido final (día 3)

1. **Antes**: `auditoria/correr.sh 30` en el commit que se va a usar. Tiene que dar “NÚCLEO OK · CAMBIO DE TURNO OK · RECLAMO OK”.
2. Apenas la organización publique la IP asignada, probar conectividad: `curl http://<ip>:8080/estado`.
3. Arrancar el motor con una salida limpia (no pisar la de práctica):
   ```bash
   cd desafio-simulador
   python3 plataforma/servidor.py --simulador http://<ip>:8080 --salida entrega/final --https
   ```
4. Jueces en celulares: `https://<ip-de-la-compu>:8090/` (aceptar el certificado autofirmado; ensayarlo antes) con `laura` y `martin`
   (`plataforma/README.md`). Cada celular firma con su propia clave: verificar que diga «Firma desde este dispositivo: … huella». Una persona
   por juez, sonido activado. **No usar `juez_automatico.py` en la final**: firma sin intervención humana y la consigna
   pide que nadie firme en nombre del juez. Cada minuto sin firmar cuesta Velocidad (ver nota en `auditoria/README.md`).
5. Al terminar (después de los 5 minutos de gracia):
   ```bash
   python3 plataforma/servidor.py --verificar-auditoria entrega/final/auditoria.jsonl
   python3 plataforma/servidor.py --verificar-firmas entrega/final/plataforma.json
   python3 plataforma/servidor.py --verificar-sellos entrega/final/sellos
   python3 plataforma/expedientes.py --verificar entrega/final/expedientes.json
   python3 plataforma/informe_pdf.py --entrada entrega/final/expedientes.json --salida entrega/final/informe_expedientes.pdf
   ```
6. `git add desafio-simulador/entrega/final && git commit && git push` **antes de la hora de cierre**: la organización
   clona el repo y anota el commit; lo que se suba después no cuenta.
7. Actualizar `entrega/README.md` para que apunte a `entrega/final/` además de la práctica.
