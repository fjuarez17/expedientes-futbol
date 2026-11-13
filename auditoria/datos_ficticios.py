#!/usr/bin/env python3
"""Comprueba que las salidas solo mencionen datos ficticios: dominios .test/.example e IPs RFC 5737."""
import ipaddress
import re
import sys
from pathlib import Path

DOC = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]
LOCAL = [ipaddress.ip_network(n) for n in ("127.0.0.0/8", "0.0.0.0/32")]
IP = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")
# Servicios de sello de tiempo RFC 3161 a los que la plataforma le pide sellos: no son objetivos ni datos del caso.
SERVICIOS = {"freetsa.org", "timestamp.sectigo.com"}
HOST = re.compile(r"\b((?:[a-z0-9-]+\.)+(test|example|com|net|org|ar|io|tv|live|xyz|me|cc|to|online|site))\b", re.I)


def revisar(raiz: Path) -> int:
    malas_ip, malos_host, archivos = {}, {}, 0
    for f in raiz.rglob("*"):
        if not f.is_file() or f.suffix not in {".json", ".jsonl", ".txt", ".md", ".html"}:
            continue
        archivos += 1
        texto = f.read_text(errors="ignore")
        for m in IP.findall(texto):
            try:
                ip = ipaddress.ip_address(m)
            except ValueError:
                continue
            if not any(ip in n for n in DOC + LOCAL):
                malas_ip.setdefault(m, set()).add(str(f.relative_to(raiz)))
        for h, tld in HOST.findall(texto):
            if tld.lower() not in ("test", "example") and h.lower() not in SERVICIOS:
                malos_host.setdefault(h.lower(), set()).add(str(f.relative_to(raiz)))
    print(f"archivos revisados: {archivos}  (se ignoran los servicios de sello: {', '.join(sorted(SERVICIOS))})")
    print(f"IPs fuera de RFC 5737: {len(malas_ip)}")
    for ip, fs in sorted(malas_ip.items())[:20]:
        print(f"  {ip}  en {', '.join(sorted(fs)[:3])}")
    print(f"dominios fuera de .test/.example: {len(malos_host)}")
    for h, fs in sorted(malos_host.items())[:20]:
        print(f"  {h}  en {', '.join(sorted(fs)[:3])}")
    return 1 if malas_ip else 0


if __name__ == "__main__":
    sys.exit(revisar(Path(sys.argv[1] if len(sys.argv) > 1 else "desafio-simulador/entrega")))
