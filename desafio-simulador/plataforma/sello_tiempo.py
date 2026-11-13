"""Sellos de tiempo RFC 3161 de terceros (FreeTSA y Sectigo de respaldo), solo biblioteca estándar.

Solo TSAs por HTTPS: aquí no se verifica la firma CMS del token (eso lo hace openssl al auditar), así que por
HTTP plano alguien en el camino podría inyectar un sello falso.

Se sella el hash, nunca el contenido. El sellado corre en un hilo aparte: si no hay internet (o la TSA no
responde) el circuito sigue igual y el intento fallido queda registrado. Verificación independiente:
    openssl ts -verify -digest <sha256> -in <archivo.tsr> -CAfile cacert.pem -untrusted tsa.crt   (FreeTSA)
"""
import json
import os
import queue
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable, Optional

TSAS = [
    {"id": "freetsa", "nombre": "FreeTSA (freetsa.org)", "url": "https://freetsa.org/tsr"},
    {"id": "sectigo", "nombre": "Sectigo", "url": "https://timestamp.sectigo.com"},
]


def _largo(n: int) -> bytes:
    if n < 128:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def _tlv(tag: int, contenido: bytes) -> bytes:
    return bytes([tag]) + _largo(len(contenido)) + contenido


def pedido_tsq(sha256_hex: str) -> bytes:
    """TimeStampReq DER: versión 1, messageImprint SHA-256, nonce y certReq = true."""
    algo = _tlv(0x30, bytes.fromhex("0609608648016503040201") + b"\x05\x00")
    imprint = _tlv(0x30, algo + _tlv(0x04, bytes.fromhex(sha256_hex)))
    nonce = bytearray(os.urandom(8))
    nonce[0] &= 0x7F
    return _tlv(0x30, _tlv(0x02, b"\x01") + imprint + _tlv(0x02, bytes(nonce)) + b"\x01\x01\xff")


def estado_pki(tsr: bytes) -> Optional[int]:
    """PKIStatus de un TimeStampResp (0 = granted, 1 = grantedWithMods)."""
    def at(i):
        n, off = tsr[i + 1], i + 2
        if n & 0x80:
            k = n & 0x7F
            n, off = int.from_bytes(tsr[off:off + k], "big"), off + k
        return tsr[i], off
    try:
        t, i = at(0)
        t2, j = at(i)
        t3, k = at(j)
        return tsr[k + tsr[j + 1] - 1] if (t, t2, t3) == (0x30, 0x30, 0x02) else None
    except IndexError:
        return None


def hora_sello(tsr: bytes) -> Optional[str]:
    """genTime (GeneralizedTime) del TSTInfo, en ISO 8601."""
    for m in re.finditer(rb"\x18[\x0f-\x17](\d{14}(?:\.\d+)?Z)", tsr):
        s = m.group(1).decode()
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}T{s[8:10]}:{s[10:12]}:{s[12:]}"
    return None


def sellar_hash(sha256_hex: str, timeout: float = 10.0) -> dict:
    """Pide un sello a cada TSA en orden hasta que una lo otorgue. Devuelve el .tsr y los intentos fallidos."""
    intentos = []
    for tsa in TSAS:
        try:
            req = urllib.request.Request(tsa["url"], data=pedido_tsq(sha256_hex), method="POST",
                                         headers={"Content-Type": "application/timestamp-query",
                                                  "User-Agent": "expedientes-futbol/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                tsr = r.read()
            if estado_pki(tsr) not in (0, 1):
                raise ValueError(f"PKIStatus {estado_pki(tsr)}")
            if bytes.fromhex(sha256_hex) not in tsr:
                raise ValueError("el sello no contiene el hash pedido")
            return {"ok": True, "tsa": tsa["id"], "tsa_nombre": tsa["nombre"], "tsa_url": tsa["url"],
                    "hora_sello": hora_sello(tsr), "tsr": tsr, "fallidos": intentos}
        except Exception as e:  # noqa: BLE001 — cualquier falla de red o de formato pasa a la TSA siguiente
            intentos.append(f"{tsa['id']}: {str(e)[:80]}")
    return {"ok": False, "fallidos": intentos}


class Sellador:
    """Cola de sellado en segundo plano. Cada sello queda en <dir>/<nombre>.tsr y en <dir>/indice.jsonl."""

    def __init__(self, directorio: Path, al_sellar: Optional[Callable[[dict], None]] = None,
                 activo: bool = True, reintentos: int = 3):
        self.dir = directorio
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "indice.jsonl").write_text("", encoding="utf-8")
        self.al_sellar, self.activo, self.reintentos = al_sellar, activo, reintentos
        self.cola: "queue.Queue[dict]" = queue.Queue()
        self.lock = threading.Lock()
        self.otorgados = self.fallidos = 0
        if activo:
            threading.Thread(target=self._trabajar, daemon=True).start()

    def pedir(self, sha256_hex: str, nombre: str, motivo: str, **ref) -> None:
        if self.activo:
            self.cola.put({"sha256": sha256_hex, "nombre": nombre, "motivo": motivo, "ref": ref, "intento": 1})

    def pendientes(self) -> int:
        return self.cola.unfinished_tasks

    def esperar(self, segundos: float) -> None:
        fin = time.time() + segundos
        while self.cola.unfinished_tasks and time.time() < fin:
            time.sleep(0.2)

    def _trabajar(self) -> None:
        while True:
            item = self.cola.get()
            try:
                r = sellar_hash(item["sha256"])
                if not r["ok"] and item["intento"] < self.reintentos:
                    time.sleep(2 * item["intento"])
                    self.cola.put(dict(item, intento=item["intento"] + 1))
                    continue
                fila = {"nombre": item["nombre"], "motivo": item["motivo"], "sha256": item["sha256"], **item["ref"],
                        "ok": r["ok"], "intentos": item["intento"], "fallidos": r["fallidos"]}
                if r["ok"]:
                    (self.dir / f"{item['nombre']}.tsr").write_bytes(r["tsr"])
                    fila.update(tsa=r["tsa"], tsa_url=r["tsa_url"], hora_sello=r["hora_sello"],
                                archivo=f"{item['nombre']}.tsr")
                with self.lock:
                    self.otorgados += r["ok"]
                    self.fallidos += not r["ok"]
                    with (self.dir / "indice.jsonl").open("a", encoding="utf-8") as f:
                        f.write(json.dumps(fila, ensure_ascii=False) + "\n")
                if self.al_sellar:
                    self.al_sellar(fila)
            finally:
                self.cola.task_done()


def verificar_sellos(directorio: Path, auditoria: Optional[Path] = None) -> int:
    """Comprueba cada sello del índice: el .tsr existe, está otorgado y contiene el hash. Si se pasa la auditoría,
    comprueba además que cada ancla coincida con el hash de esa entrada."""
    hashes = {}
    if auditoria and auditoria.exists():
        for linea in auditoria.read_text(encoding="utf-8").splitlines():
            e = json.loads(linea)
            hashes[e["n"]] = e["hash"]
    errores, ok, sin_sello = [], 0, 0
    for linea in (directorio / "indice.jsonl").read_text(encoding="utf-8").splitlines():
        s = json.loads(linea)
        if not s["ok"]:
            sin_sello += 1
            continue
        tsr = (directorio / s["archivo"]).read_bytes()
        if estado_pki(tsr) not in (0, 1) or bytes.fromhex(s["sha256"]) not in tsr:
            errores.append(f"{s['nombre']}: el sello no corresponde al hash")
        elif s["motivo"] == "ancla_auditoria" and hashes and hashes.get(s.get("entrada")) != s["sha256"]:
            errores.append(f"{s['nombre']}: el ancla no coincide con la entrada {s.get('entrada')} de la auditoría")
        else:
            ok += 1
    print("\n".join(errores) if errores else
          f"OK: {ok} sellos RFC 3161 corresponden a sus hashes" + (f" ({sin_sello} sin sello: TSA no disponible)" if sin_sello else ""))
    return 1 if errores else 0
