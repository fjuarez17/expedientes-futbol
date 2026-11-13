# Revisión de "peces dorados"

Un pez dorado es un revisor que **no vio la conversación** en la que se diseñó el sistema. Solo lee lo que está en el repo.
Si algo no se entiende o no se puede comprobar sin el contexto del chat, eso es un hallazgo.

## Protocolo

1. Cada revisor arranca de cero y recibe solo:
   - la consigna: `desafio-simulador/README.md`;
   - esta carpeta: `auditoria/README.md` y `auditoria/PRIORIDADES.md`;
   - el código.
2. Cada uno revisa con un enfoque distinto (personas del modelo Elephant-Goldfish):

   | Persona | Pregunta que contesta |
   |---|---|
   | Visión general (*zoom out*) | ¿El sistema resuelve el problema de la consigna o algo parecido? |
   | Comprensión | ¿Un juez o un jurado entiende el expediente y la decisión sin explicación oral? |
   | Crítica de diseño | ¿Qué falla primero en el partido final? ¿Qué caso borde no está cubierto? |
   | Correspondencia con el código | ¿Cada fila de la matriz dice la verdad? Revisa archivo y función. |
   | Lista para implementar | ¿Cada punto de `PRIORIDADES.md` se puede hacer con lo que está escrito? |

3. Cada hallazgo se registra abajo con el commit revisado, la gravedad (alta, media o baja), el archivo y la decisión del equipo: se corrige, se acepta como limitación o se descarta con el motivo.
4. Si un hallazgo contradice la matriz, **se corrige la matriz primero**.

## Registro de hallazgos

| Fecha | Commit | Persona | Gravedad | Hallazgo | Archivo | Decisión |
|---|---|---|---|---|---|---|
| | | | | | | |
