# Entrega · Desafío Fútbol (Hackathon Argentina Space 2026)

Índice de lo que pide la consigna (“Entregables del día 3”). Los archivos los genera el motor del desafío en
`desafio-simulador/entrega/`; esta carpeta solo los ordena para el jurado.

| Entregable | Dónde está |
|---|---|
| Ejemplo exportado de un expediente | [`../desafio-simulador/entrega/expedientes/`](../desafio-simulador/entrega/expedientes/) (un JSON por expediente) e [`informe_expedientes.pdf`](../desafio-simulador/entrega/informe_expedientes.pdf) |
| Registro de auditoría | [`../desafio-simulador/entrega/auditoria.jsonl`](../desafio-simulador/entrega/auditoria.jsonl), encadenado con SHA-256 |
| Capturas con hash | [`../desafio-simulador/entrega/evidencia/`](../desafio-simulador/entrega/evidencia/) + `SHA256SUMS` |
| Sellos de tiempo RFC 3161 (evidencias, decisiones y anclas de la auditoría) | [`../auditoria/corridas/20261113T031423Z-401466a/oficial/entrega/sellos/`](../auditoria/corridas/20261113T031423Z-401466a/oficial/entrega/sellos/) — `python3 plataforma/servidor.py --verificar-sellos <dir>` |
| Propuesta normativa (1 página) | [`../desafio-simulador/entrega/propuesta_normativa.md`](../desafio-simulador/entrega/propuesta_normativa.md) |
| Evaluación con `verificar.py` | [`../desafio-simulador/entrega/evaluacion.txt`](../desafio-simulador/entrega/evaluacion.txt) |
| Pruebas de cambio de turno y de reclamo | [`../desafio-simulador/entrega/pruebas/`](../desafio-simulador/entrega/pruebas/) |
| Auditoría reproducible (requisito → código → prueba) | [`../auditoria/`](../auditoria/) |
| Guion del video y del partido final | [`../auditoria/GUION_DEMO.md`](../auditoria/GUION_DEMO.md) |

Para verificar todo sin confiar en nosotros:

```bash
cd desafio-simulador
python3 plataforma/servidor.py --verificar-auditoria entrega/auditoria.jsonl
python3 plataforma/expedientes.py --verificar entrega/expedientes.json
(cd entrega/evidencia && sha256sum -c SHA256SUMS)
python3 evaluacion/verificar.py --log entrega/registro_simulador_practica.jsonl
```

> Todos los datos son ficticios (dominios `.test`/`.example`, IPs RFC 5737, ASN privados). No se bloqueó nada real.
