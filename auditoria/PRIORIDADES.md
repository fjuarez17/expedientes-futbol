# Prioridades para pulir el entregable

Orden: primero lo que puede hacer perder puntos del núcleo en el partido final y después los extras.
Cada punto dice cómo se va a comprobar que quedó resuelto. Se cierra cuando hay una corrida en `corridas/` que lo demuestre.

## P0 · Núcleo: riesgo de perder puntos en la final

1. **Incorporar o rechazar el PR #1 de forma explícita.** El motor del desafío solo existe en ese PR. Si no entra a `main`, la rama principal no tiene envío a proveedores, reintentos, confirmación ni vencimiento: los ítems N11 a N14 quedan en **falta**.
   *Comprobación:* `auditoria/correr.sh` en `main` da «NÚCLEO OK».
2. **Cambio de turno con juez ausente, automatizado.** Hoy se prueba a mano con `juez_automatico.py --ausente laura`. Hay que sumarlo a `correr.sh` como segunda corrida y exigir que lo pendiente lo firme el juez entrante.
   *Comprobación:* eventos `pendiente_reasignado` y `reenvio_firmado` del juez entrante en `auditoria.jsonl`, y «órdenes firmadas fuera de turno: 0».
3. **Ensayo contra la IP asignada del partido final.** Correr `correr.sh` apuntando al simulador de la organización (`--simulador http://<ip>:8080`) apenas la publiquen, con la aceleración real (x1).
4. **Un solo camino para la demo.** Elegir si el juez firma en la interfaz del motor (`:8090`) o en la app web vía Supabase, y escribir el guion paso a paso. Con dos caminos a medio probar en vivo, el riesgo es alto.

## P1 · Solidez de la evidencia (lo que va a preguntar un jurado o un juez)

5. **Anclar la cabecera de la auditoría afuera del servidor.** Sellar con RFC 3161 el último hash cada N eventos y al final del partido, y mostrarlo en el registro público. Sin esto, alguien con acceso al disco puede reescribir el archivo entero.
6. **Sello de tiempo de terceros en el motor.** Las capturas del motor se encadenan con la hora del propio servidor. Reutilizar el sellado RFC 3161 de la app web (`api/timestamp.js`, FreeTSA con Sectigo de respaldo) sobre el hash de cada expediente.
7. **Firma del juez.** El motor firma con HMAC y la clave queda en el servidor, así que no prueba que firmó el juez. Pasar a Ed25519 con la clave del lado del juez, como en la app web, o declararlo como limitación del MVP en la demo.
8. **Consenso del lado del servidor en la app web.** Hoy el oráculo corre en el navegador del reportante. Moverlo a una función (`api/`) o a una política de Supabase.

## P2 · Extras

9. **Escenario con reclamo.** El escenario de práctica no trae reclamos, así que E1 no se ejerce. Armar un escenario derivado en `desafio-simulador/datos/` (ficticio, `.test`) con una IP compartida reclamada y verificar levantamiento firmado y reemplazo por dominio.
10. **Aviso al juez por WhatsApp o mail** (webhook n8n en `api/notify.js`): falta la URL del webhook.
11. **Prueba automática del registro público:** que la respuesta de `/publico` y de la vista `registro_publico` no contenga capturas, HAR ni datos de quien reportó.

## Higiene

12. Regenerar la `SUPABASE_SECRET_KEY` (quedó en un chat).
13. El PR #1 sube a `desafio-simulador/entrega/` salidas generadas. Conviene dejar solo la corrida de referencia y regenerar el resto con `correr.sh`, para que el diff sea revisable.
