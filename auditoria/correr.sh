#!/usr/bin/env bash
# Corre la auditoría reproducible del entregable y deja el resultado en auditoria/corridas/<fecha>-<commit>/.
# Uso: auditoria/correr.sh [aceleracion]   (por defecto x30: cada partido de práctica dura ~3,5 min)
# Corre tres partidos de práctica en paralelo contra el simulador oficial:
#   oficial      el circuito tal cual se va a correr en la final (es el que define el veredicto del núcleo)
#   cambio_turno la jueza saliente no atiende sus pendientes: los tiene que firmar el juez entrante
#   reclamo      se fuerza un bloqueo por IP compartida para que el simulador emita un reclamo (extra E1)
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ACEL="${1:-30}"
BASE_PUERTO="${BASE_PUERTO:-8181}"
COMMIT="$(git -C "$RAIZ" rev-parse --short HEAD)"
SUCIO="$(git -C "$RAIZ" status --porcelain --untracked-files=no | { grep -v '^.. auditoria/' || true; } | wc -l | tr -d ' ')"
SAL="$RAIZ/auditoria/corridas/$(date -u +%Y%m%dT%H%M%SZ)-$COMMIT"
mkdir -p "$SAL"
D="$RAIZ/desafio-simulador"
R="$SAL/resumen.txt"
HOST_RECLAMO="${HOST_RECLAMO:-live.golazo-libre.test}"

paso() { printf '\n== %s\n' "$1" | tee -a "$R"; }
falla() { echo "FALLA: $1" | tee -a "$R"; }
{
  echo "commit: $(git -C "$RAIZ" rev-parse HEAD)"
  echo "archivos modificados sin commit (fuera de auditoria/): $SUCIO"
  echo "fecha UTC: $(date -u +%FT%TZ)"
  echo "aceleracion: x$ACEL"
} > "$R"

# partido <nombre> <puerto_sim> <puerto_plat> <args extra plataforma> <args extra juez>
partido() {
  local N="$1" SP="$2" PP="$3" XPLAT="$4" XJUEZ="$5" S="$SAL/$1" pids=()
  mkdir -p "$S"
  cd "$D"
  python3 simulador/servidor.py --acelerar "$ACEL" --puerto "$SP" --log "$S/registro_simulador.jsonl" > "$S/simulador.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 30); do curl -sf "http://localhost:$SP/estado" >/dev/null 2>&1 && break; sleep 1; done
  # shellcheck disable=SC2086
  python3 plataforma/servidor.py --simulador "http://localhost:$SP" --puerto "$PP" --salida "$S/entrega" $XPLAT > "$S/plataforma.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 30); do curl -s "http://localhost:$PP/" >/dev/null 2>&1 && break; sleep 1; done
  # shellcheck disable=SC2086
  python3 pruebas/juez_automatico.py --plataforma "http://localhost:$PP" --demora 0.2 $XJUEZ > "$S/juez_automatico.log" 2>&1 &
  pids+=($!)
  # El juez automático no termina solo: se espera el fin del partido y unos segundos para el control de vencimiento.
  until curl -sf "http://localhost:$SP/estado" | grep -q '"finalizado": true'; do sleep 5; done
  sleep 20
  kill "${pids[@]}" 2>/dev/null || true
  sleep 1
  python3 evaluacion/verificar.py --log "$S/registro_simulador.jsonl" > "$S/evaluacion.txt" 2>&1 || true
  python3 evaluacion/verificar.py --log "$S/registro_simulador.jsonl" --json > "$S/evaluacion.json" 2>/dev/null || true
  python3 plataforma/servidor.py --verificar-auditoria "$S/entrega/auditoria.jsonl" > "$S/verificar_auditoria.txt" 2>&1 || true
  python3 plataforma/expedientes.py --verificar "$S/entrega/expedientes.json" > "$S/verificar_expedientes.txt" 2>&1 || true
  python3 plataforma/servidor.py --verificar-sellos "$S/entrega/sellos" > "$S/verificar_sellos.txt" 2>&1 || true
  python3 plataforma/servidor.py --verificar-firmas "$S/entrega/plataforma.json" > "$S/verificar_firmas.txt" 2>&1 || true
  if [ -f "$S/entrega/evidencia/SHA256SUMS" ]; then
    (cd "$S/entrega/evidencia" && sha256sum -c --quiet SHA256SUMS > /dev/null 2>&1 && echo "OK: $(wc -l < SHA256SUMS) capturas" || echo "FALLA") > "$S/sha256sum.txt"
  else
    echo "FALTA SHA256SUMS" > "$S/sha256sum.txt"
  fi
  python3 "$RAIZ/auditoria/datos_ficticios.py" "$S/entrega" > "$S/datos_ficticios.txt" 2>&1 || true
}

# metrica <nombre> <clave del resumen de verificar.py>
metrica() { grep -m1 "  $2:" "$SAL/$1/evaluacion.txt" | awk -F': ' '{print $2}'; }
# eventos <nombre> <evento> [actor]: cuántas entradas de ese evento hay en la auditoría de la plataforma
eventos() {
  python3 - "$SAL/$1/entrega/auditoria.jsonl" "$2" "${3:-}" <<'PY'
import json, sys
f, ev, actor = sys.argv[1], sys.argv[2], sys.argv[3]
n = 0
for l in open(f, encoding="utf-8"):
    e = json.loads(l)
    n += e["evento"] == ev and (not actor or e["actor"] == actor)
print(n)
PY
}
integridad() {  # integridad <nombre>: auditoría encadenada, expedientes, capturas y datos ficticios
  local S="$SAL/$1"
  tail -n 1 "$S/verificar_auditoria.txt" | tee -a "$R"
  tail -n 1 "$S/verificar_expedientes.txt" | tee -a "$R"
  tail -n 1 "$S/verificar_sellos.txt" | tee -a "$R"
  tail -n 1 "$S/verificar_firmas.txt" | tee -a "$R"
  tee -a "$R" < "$S/sha256sum.txt"
  tail -n 2 "$S/datos_ficticios.txt" | tee -a "$R"
  grep -q '^OK' "$S/verificar_auditoria.txt" || falla "$1: auditoría encadenada"
  grep -q '^OK' "$S/verificar_expedientes.txt" || falla "$1: expedientes"
  grep -q '^OK' "$S/verificar_sellos.txt" || falla "$1: sellos de tiempo RFC 3161"
  grep -q '^OK' "$S/verificar_firmas.txt" || falla "$1: firmas de los jueces desde su dispositivo"
  grep -q '"motivo": "ancla_auditoria"' "$S/entrega/sellos/indice.jsonl" || echo "AVISO $1: sin ancla externa de la auditoría (¿sin internet?)" | tee -a "$R"
  grep -q '^OK' "$S/sha256sum.txt" || falla "$1: hashes de capturas"
  grep -q 'fuera de RFC 5737: 0' "$S/datos_ficticios.txt" || falla "$1: IPs no ficticias"
  grep -q 'fuera de .test/.example: 0' "$S/datos_ficticios.txt" || falla "$1: dominios no ficticios"
}

paso "1. Pruebas unitarias de la app web (node --test)"
if command -v node >/dev/null; then
  (cd "$RAIZ" && node --test tests/ > "$SAL/node-test.txt" 2>&1) && echo "OK: $(grep -m1 '^# pass' "$SAL/node-test.txt")" | tee -a "$R" \
    || falla "node --test (ver node-test.txt)"
else
  echo "OMITIDO: falta node" | tee -a "$R"
fi

paso "2. Tres partidos de práctica en paralelo contra el simulador oficial"
P=$BASE_PUERTO
partido oficial      $P       $((P+10)) ""                                   "" &
A=$!
partido cambio_turno $((P+1)) $((P+11)) ""                                   "--ausente laura" &
B=$!
partido reclamo      $((P+2)) $((P+12)) "--forzar-bloqueo-ip $HOST_RECLAMO"   "" &
C=$!
trap 'kill $A $B $C 2>/dev/null || true; pkill -P $$ 2>/dev/null || true' EXIT
wait $A $B $C
for n in oficial cambio_turno reclamo; do
  echo "$n: $(wc -l < "$SAL/$n/registro_simulador.jsonl") eventos del simulador" | tee -a "$R"
done

paso "3. Partido oficial: evaluación oficial (evaluacion/verificar.py)"
sed -n '/^Resumen/,/^$/p' "$SAL/oficial/evaluacion.txt" | tee -a "$R"
for k in "bloqueos con dano colateral" "dominios legitimos afectados" "bloqueos falsos positivos" \
         "bloqueos ip activos post partido" "ordenes firmadas fuera de turno" "ordenes rechazadas"; do
  v="$(metrica oficial "$k")"
  [ "$v" = "0" ] || falla "oficial: $k = ${v:-sin dato}"
done
F="$(metrica oficial 'fases piratas bloqueadas')"
if [ -z "$F" ] || [ "$(echo "$F" | awk '{print $1}')" != "$(echo "$F" | awk '{print $3}')" ]; then
  falla "oficial: fases piratas bloqueadas = ${F:-sin dato}"
fi
integridad oficial

paso "4. Cambio de turno con la jueza saliente ausente"
REAS="$(eventos cambio_turno pendiente_reasignado)"
FIRMA_ENTRANTE="$(eventos cambio_turno decision_firmada juez-martin-ejemplo)"
FIRMA_SALIENTE="$(eventos cambio_turno decision_firmada jueza-laura-ficticia)"
RECHAZO="$(eventos cambio_turno firma_rechazada)"
echo "pendientes reasignados al juez entrante: $REAS" | tee -a "$R"
echo "decisiones firmadas por el juez entrante: $FIRMA_ENTRANTE · por la jueza saliente: $FIRMA_SALIENTE" | tee -a "$R"
echo "firmas rechazadas a la jueza fuera de turno: $RECHAZO" | tee -a "$R"
echo "fases piratas bloqueadas: $(metrica cambio_turno 'fases piratas bloqueadas')" | tee -a "$R"
echo "ordenes firmadas fuera de turno: $(metrica cambio_turno 'ordenes firmadas fuera de turno')" | tee -a "$R"
[ "$REAS" -ge 1 ] || falla "cambio_turno: no se reasignó ningún pendiente"
[ "$FIRMA_ENTRANTE" -ge 1 ] || falla "cambio_turno: el juez entrante no firmó"
[ "$FIRMA_SALIENTE" = 0 ] || falla "cambio_turno: firmó la jueza ausente"
[ "$RECHAZO" -ge 1 ] || falla "cambio_turno: no se probó la firma fuera de turno"
[ "$(metrica cambio_turno 'ordenes firmadas fuera de turno')" = "0" ] || falla "cambio_turno: órdenes fuera de turno"
integridad cambio_turno

paso "5. Reclamo de un sitio legítimo (bloqueo IP forzado sobre $HOST_RECLAMO)"
sed -n '/^5. Reclamos/,/^$/p' "$SAL/reclamo/evaluacion.txt" | tee -a "$R"
for ev in reclamo_recibido reclamo_verificado reclamo_decidido orden_levantada; do
  echo "$ev: $(eventos reclamo "$ev")" | tee -a "$R"
  [ "$(eventos reclamo "$ev")" -ge 1 ] || falla "reclamo: falta el evento $ev"
done
RES="$(metrica reclamo 'reclamos resueltos por levantamiento')"
echo "reclamos resueltos por levantamiento: $RES de $(metrica reclamo 'reclamos')" | tee -a "$R"
[ "${RES:-0}" -ge 1 ] || falla "reclamo: ningún reclamo resuelto por levantamiento"
echo "(el daño colateral de este partido es esperado: el bloqueo por IP compartida se fuerza a propósito)" | tee -a "$R"
integridad reclamo

paso "6. Huella de la corrida"
(cd "$SAL" && find . -type f ! -name MANIFIESTO.sha256 ! -name resumen.txt -print0 | sort -z | xargs -0 sha256sum > MANIFIESTO.sha256)
echo "sha256 del manifiesto: $(sha256sum "$SAL/MANIFIESTO.sha256" | cut -d' ' -f1)" | tee -a "$R"

paso "7. Veredicto"
FALLAS="$(grep -c '^FALLA' "$R" || true)"
[ "$FALLAS" = 0 ] && echo "NÚCLEO OK · CAMBIO DE TURNO OK · RECLAMO OK" | tee -a "$R" || echo "CON FALLAS ($FALLAS)" | tee -a "$R"
echo
echo "Resultado en: $SAL"
[ "$FALLAS" = 0 ]
