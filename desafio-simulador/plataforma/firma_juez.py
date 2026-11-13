"""Firma del juez hecha en su propio dispositivo, verificada en el servidor. Solo biblioteca estándar.

El navegador del juez genera el par de claves con WebCrypto (Ed25519; ECDSA P-256 si el navegador no tiene
Ed25519) y la clave privada nunca sale del dispositivo: el servidor solo recibe la clave pública y verifica.
Ed25519 sigue RFC 8032 §5.1 / §6 (implementación de referencia). ECDSA P-256 sigue FIPS 186-4 con SHA-256 y
la firma en formato crudo r‖s de WebCrypto. Firmar en Python (Ed25519) solo se usa en las pruebas.
"""
import base64
import hashlib
from typing import Optional

# --- Ed25519 (RFC 8032) -----------------------------------------------------------------
_p = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _p - 2, _p) % _p
_SQRT_M1 = pow(2, (_p - 1) // 4, _p)


def _sha512(b: bytes) -> bytes:
    return hashlib.sha512(b).digest()


def _sumar(P, Q):
    A, B = (P[1] - P[0]) * (Q[1] - Q[0]) % _p, (P[1] + P[0]) * (Q[1] + Q[0]) % _p
    C, D = 2 * P[3] * Q[3] * _d % _p, 2 * P[2] * Q[2] % _p
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _p, G * H % _p, F * G % _p, E * H % _p)


def _mult(s: int, P):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            Q = _sumar(Q, P)
        P = _sumar(P, P)
        s >>= 1
    return Q


def _iguales(P, Q) -> bool:
    return (P[0] * Q[2] - Q[0] * P[2]) % _p == 0 and (P[1] * Q[2] - Q[1] * P[2]) % _p == 0


def _x_desde_y(y: int, signo: int) -> Optional[int]:
    if y >= _p:
        return None
    x2 = (y * y - 1) * pow(_d * y * y + 1, _p - 2, _p)
    if x2 == 0:
        return None if signo else 0
    x = pow(x2, (_p + 3) // 8, _p)
    if (x * x - x2) % _p != 0:
        x = x * _SQRT_M1 % _p
    if (x * x - x2) % _p != 0:
        return None
    return _p - x if (x & 1) != signo else x


_gy = 4 * pow(5, _p - 2, _p) % _p
_gx = _x_desde_y(_gy, 0)
_G = (_gx, _gy, 1, _gx * _gy % _p)


def _comprimir(P) -> bytes:
    zinv = pow(P[2], _p - 2, _p)
    x, y = P[0] * zinv % _p, P[1] * zinv % _p
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _descomprimir(b: bytes):
    if len(b) != 32:
        return None
    y = int.from_bytes(b, "little")
    signo, y = y >> 255, y & ((1 << 255) - 1)
    x = _x_desde_y(y, signo)
    return None if x is None else (x, y, 1, x * y % _p)


def _expandir(semilla: bytes):
    h = _sha512(semilla)
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def ed25519_publica(semilla: bytes) -> bytes:
    return _comprimir(_mult(_expandir(semilla)[0], _G))


def ed25519_firmar(semilla: bytes, msj: bytes) -> bytes:
    a, prefijo = _expandir(semilla)
    A = _comprimir(_mult(a, _G))
    r = int.from_bytes(_sha512(prefijo + msj), "little") % _L
    R = _comprimir(_mult(r, _G))
    h = int.from_bytes(_sha512(R + A + msj), "little") % _L
    return R + int.to_bytes((r + h * a) % _L, 32, "little")


def ed25519_verificar(publica: bytes, msj: bytes, firma: bytes) -> bool:
    if len(publica) != 32 or len(firma) != 64:
        return False
    A, R = _descomprimir(publica), _descomprimir(firma[:32])
    s = int.from_bytes(firma[32:], "little")
    if not A or not R or s >= _L:
        return False
    h = int.from_bytes(_sha512(firma[:32] + publica + msj), "little") % _L
    return _iguales(_mult(s, _G), _sumar(R, _mult(h, A)))


# --- ECDSA P-256 / SHA-256 (solo verificación) -----------------------------------------
_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_A = _P - 3
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_GP = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
       0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)


def _p256_sumar(P, Q):
    if P is None:
        return Q
    if Q is None:
        return P
    if P[0] == Q[0] and (P[1] + Q[1]) % _P == 0:
        return None
    if P == Q:
        m = (3 * P[0] * P[0] + _A) * pow(2 * P[1], _P - 2, _P) % _P
    else:
        m = (Q[1] - P[1]) * pow(Q[0] - P[0], _P - 2, _P) % _P
    x = (m * m - P[0] - Q[0]) % _P
    return (x, (m * (P[0] - x) - P[1]) % _P)


def _p256_mult(k: int, P):
    R = None
    while k:
        if k & 1:
            R = _p256_sumar(R, P)
        P = _p256_sumar(P, P)
        k >>= 1
    return R


def p256_verificar(publica: bytes, msj: bytes, firma: bytes) -> bool:
    """`publica` en formato crudo sin comprimir (0x04‖x‖y, 65 bytes), `firma` cruda r‖s (64 bytes)."""
    if len(publica) != 65 or publica[0] != 4 or len(firma) != 64:
        return False
    Q = (int.from_bytes(publica[1:33], "big"), int.from_bytes(publica[33:], "big"))
    if (Q[1] ** 2 - Q[0] ** 3 - _A * Q[0] - _B) % _P:
        return False
    r, s = int.from_bytes(firma[:32], "big"), int.from_bytes(firma[32:], "big")
    if not (0 < r < _N and 0 < s < _N):
        return False
    e = int.from_bytes(hashlib.sha256(msj).digest(), "big")
    w = pow(s, _N - 2, _N)
    X = _p256_sumar(_p256_mult(e * w % _N, _GP), _p256_mult(r * w % _N, Q))
    return X is not None and X[0] % _N == r


# --- interfaz ---------------------------------------------------------------------------
ALGORITMOS = {"Ed25519": ed25519_verificar, "ECDSA-P256": p256_verificar}


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def huella(alg: str, publica_b64: str) -> str:
    return hashlib.sha256(f"{alg}:{publica_b64}".encode()).hexdigest()[:16]


def verificar(alg: str, publica_b64: str, texto: str, firma_b64: str) -> bool:
    try:
        f = ALGORITMOS.get(alg)
        return bool(f) and f(base64.b64decode(publica_b64), texto.encode(), base64.b64decode(firma_b64))
    except (ValueError, TypeError):
        return False
