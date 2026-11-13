#!/usr/bin/env bash
# Corre la auditoría reproducible del entregable y deja el resultado en auditoria/corridas/<fecha>-<commit>/.
# Uso: auditoria/correr.sh [aceleracion]   (por defecto x30: el partido de práctica dura ~3,5 min)
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ACEL="${1:-30}"
SIM_PUERTO="${SIM_PUERTO:-8181}"
PLAT_PUERTO="${PLAT_PUERTO:-8191}"
COMMIT="$(git -C "$RAIZ" rev-parse --short HEAD)"
SUCIO="$(git -C "$RAIZ" status --porcelain --untracked-files=no | { grep -v '^.. auditoria/' || true; } | wc -l | tr -d ' ')"
SAL="$RAIZ/auditoria/corridas/$(date -u +%Y%m%dT%H%M%SZ)-$COMMIT"
mkdir -p "$SAL"
D="$RAIZ/desafio-simulador"
PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT

paso() { printf '\n== %s\n' "$1" | tee -a "$SAL/resumen.txt"; }
{
  echo "commit: $(git -C "$RAIZ" rev-parse HEAD)"
  echo "archivos modificados sin commit (fuera de auditoria/): $SUCIO"
  echo "fecha UTC: $(date -u +%FT%TZ)"
  echo "aceleracion: x$ACEL"
} > "$SAL/resumen.txt"

paso "1. Pruebas unitarias de la app web (node --test)"
if command -v node >/dev/null; then
  (cd "$RAIZ" && node --test tests/ > "$SAL/node-test.txt" 2>&1) && echo "OK" | tee -a "$SAL/resumen.txt" \
    || { echo "FALLA (ver node-test.txt)" | tee -a "$SAL/resumen.txt"; }
else
  echo "OMITIDO: falta node" | tee -a "$SAL/resumen.txt"
fi

paso "2. Partido de práctica completo contra el simulador oficial"
cd "$D"
python3 simulador/servidor.py --acelerar "$ACEL" --puerto "$SIM_PUERTO" --log "$SAL/registro_simulador.jsonl" > "$SAL/simulador.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 30); do curl -sf "http://localhost:$SIM_PUERTO/estado" >/dev/null 2>&1 && break; sleep 1; done
python3 plataforma/servidor.py --simulador "http://localhost:$SIM_PUERTO" --puerto "$PLAT_PUERTO" --salida "$SAL/entrega" > "$SAL/plataforma.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 30); do curl -s "http://localhost:$PLAT_PUERTO/" >/dev/null 2>&1 && break; sleep 1; done
python3 pruebas/juez_automatico.py --plataforma "http://localhost:$PLAT_PUERTO" --demora 0.2 > "$SAL/juez_automatico.log" 2>&1 &
PIDS+=($!)
# El juez automático no termina solo: se espera el fin del partido y unos segundos para el control de vencimiento.
until curl -sf "http://localhost:$SIM_PUERTO/estado" | grep -q '"finalizado": true'; do sleep 5; done
sleep 10
kill "${PIDS[@]}" 2>/dev/null || true
sleep 1
echo "registro del simulador: $(wc -l < "$SAL/registro_simulador.jsonl") eventos" | tee -a "$SAL/resumen.txt"

paso "3. Evaluación oficial (evaluacion/verificar.py)"
python3 evaluacion/verificar.py --log "$SAL/registro_simulador.jsonl" > "$SAL/evaluacion.txt" 2>&1 || true
python3 evaluacion/verificar.py --log "$SAL/registro_simulador.jsonl" --json > "$SAL/evaluacion.json" 2>/dev/null || true
sed -n '/^Resumen/,/^$/p' "$SAL/evaluacion.txt" | tee -a "$SAL/resumen.txt"

paso "4. Integridad de la auditoría encadenada"
python3 plataforma/servidor.py --verificar-auditoria "$SAL/entrega/auditoria.jsonl" 2>&1 | tail -n 3 | tee -a "$SAL/resumen.txt" || true

paso "5. Integridad de los expedientes"
python3 plataforma/expedientes.py --verificar "$SAL/entrega/expedientes.json" 2>&1 | tail -n 3 | tee -a "$SAL/resumen.txt" || true

paso "6. Hashes de las capturas (sha256sum -c)"
if [ -f "$SAL/entrega/evidencia/SHA256SUMS" ]; then
  (cd "$SAL/entrega/evidencia" && sha256sum -c --quiet SHA256SUMS > /dev/null 2>&1 && echo "OK: $(wc -l < SHA256SUMS) capturas" || echo "FALLA") | tee -a "$SAL/resumen.txt"
else
  echo "FALTA SHA256SUMS" | tee -a "$SAL/resumen.txt"
fi

paso "7. Datos ficticios (dominios .test/.example, IPs RFC 5737)"
python3 "$RAIZ/auditoria/datos_ficticios.py" "$SAL/entrega" | tee -a "$SAL/resumen.txt" || true

paso "8. Huella de la corrida"
(cd "$SAL" && find . -type f ! -name MANIFIESTO.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFIESTO.sha256)
echo "sha256 del manifiesto: $(sha256sum "$SAL/MANIFIESTO.sha256" | cut -d' ' -f1)" | tee -a "$SAL/resumen.txt"
paso "9. Veredicto del núcleo"
FALLAS=0
for k in "bloqueos con dano colateral" "dominios legitimos afectados" "bloqueos falsos positivos" \
         "bloqueos ip activos post partido" "ordenes firmadas fuera de turno" "ordenes rechazadas"; do
  v="$(grep -m1 "  $k:" "$SAL/evaluacion.txt" | awk -F': ' '{print $2}')"
  if [ "$v" != "0" ]; then echo "FALLA: $k = ${v:-sin dato}" | tee -a "$SAL/resumen.txt"; FALLAS=$((FALLAS+1)); fi
done
F="$(grep -m1 'fases piratas bloqueadas:' "$SAL/evaluacion.txt" | awk -F': ' '{print $2}')"
if [ -z "$F" ] || [ "$(echo "$F" | awk '{print $1}')" != "$(echo "$F" | awk '{print $3}')" ]; then
  echo "FALLA: fases piratas bloqueadas = ${F:-sin dato}" | tee -a "$SAL/resumen.txt"; FALLAS=$((FALLAS+1))
fi
grep -q "FALLA" "$SAL/resumen.txt" && FALLAS=$((FALLAS+1))
[ "$FALLAS" = 0 ] && echo "NÚCLEO OK" | tee -a "$SAL/resumen.txt" || echo "NÚCLEO CON FALLAS ($FALLAS)" | tee -a "$SAL/resumen.txt"

echo
echo "Resultado en: $SAL"
[ "$FALLAS" = 0 ]
