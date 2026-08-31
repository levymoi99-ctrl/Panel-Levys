"""
Tests de la logica de reconexion del navegador en ml_bot_competencia.py.

No dependen de una tienda real de Mercado Libre: usan objetos falsos
(fakes) que imitan lo minimo de la API de Playwright que el bot usa
(page.is_closed(), context.close()), y un stub de p.chromium.launch_persistent_context
para simular exitos/fallos al reabrir el navegador.

Correr con: python3 -m pytest test_reconexion.py -v
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

# Variables minimas para que el modulo importe sin RuntimeError de validar_config
os.environ.setdefault("TELEGRAM_TOKEN", "test-token")
os.environ.setdefault("TELEGRAM_CHAT_ID", "test-chat")
os.environ.setdefault("COMP_TIENDA_URL", "https://listado.mercadolibre.com.ar/tienda/levys-bazar/")
os.environ.setdefault("COMP_LOG_CONSOLE", "false")

import ml_bot_competencia as bot


# --- Fakes ---------------------------------------------------------------

class FakePage:
    def __init__(self, closed=False):
        self._closed = closed

    def is_closed(self):
        return self._closed


class FakeContext:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class FakeChromiumSiempreFalla:
    def __init__(self):
        self.intentos = 0

    async def launch_persistent_context(self, **kwargs):
        self.intentos += 1
        raise RuntimeError("Target page, context or browser has been closed")


class FakeChromiumFallaNVecesLuegoOk:
    def __init__(self, n_fallos):
        self.n_fallos = n_fallos
        self.intentos = 0

    async def launch_persistent_context(self, **kwargs):
        self.intentos += 1
        if self.intentos <= self.n_fallos:
            raise RuntimeError("Target page, context or browser has been closed")
        context = FakeContext()
        return context

    # abrir_navegador espera context.pages y context.new_page()
    # asi que devolvemos un context "enriquecido"


class FakeP:
    def __init__(self, chromium):
        self.chromium = chromium


# --- Tests de deteccion de error -----------------------------------------

def test_detecta_frases_de_navegador_cerrado():
    casos_positivos = [
        "Target page, context or browser has been closed",
        "Error: Target closed",
        "browser has been closed",
        "Connection closed",
    ]
    for texto in casos_positivos:
        assert bot.es_error_de_navegador_cerrado(RuntimeError(texto)), texto


def test_no_detecta_errores_no_relacionados():
    casos_negativos = [
        "Timeout 60000ms exceeded",
        "net::ERR_NAME_NOT_RESOLVED",
        "list index out of range",
    ]
    for texto in casos_negativos:
        assert not bot.es_error_de_navegador_cerrado(RuntimeError(texto)), texto


# --- Tests de navegador_sigue_vivo ----------------------------------------

def test_navegador_sigue_vivo_true_si_pagina_abierta():
    assert bot.navegador_sigue_vivo(FakeContext(), FakePage(closed=False)) is True


def test_navegador_sigue_vivo_false_si_pagina_cerrada():
    assert bot.navegador_sigue_vivo(FakeContext(), FakePage(closed=True)) is False


def test_navegador_sigue_vivo_false_si_no_hay_contexto():
    assert bot.navegador_sigue_vivo(None, None) is False


# --- Tests de asegurar_navegador (async) ----------------------------------

async def _run_asegurar_navegador_reintentos_ok():
    """Si falla 2 veces y a la 3ra abre bien (dentro del limite de 3
    intentos), asegurar_navegador debe devolver un context/page validos."""
    chromium = FakeChromiumFallaNVecesLuegoOk(n_fallos=2)
    p = FakeP(chromium)

    # abrir_navegador real llama a p.chromium.launch_persistent_context(...)
    # y despues lee context.pages / context.new_page(). Parcheamos
    # abrir_navegador para no depender de esos detalles de Playwright real.
    async def abrir_navegador_fake(p_):
        context = await p_.chromium.launch_persistent_context()
        return context, FakePage(closed=False)

    original = bot.abrir_navegador
    bot.abrir_navegador = abrir_navegador_fake
    try:
        context, page, se_relanzo = await bot.asegurar_navegador(p, None, None)
    finally:
        bot.abrir_navegador = original

    assert context is not None
    assert page is not None
    assert se_relanzo is True
    assert chromium.intentos == 3


async def _run_asegurar_navegador_agota_intentos():
    """Si siempre falla, despues de MAX_INTENTOS_RELANZAR_NAVEGADOR intentos
    debe devolver (None, None, True) en vez de colgarse para siempre."""
    chromium = FakeChromiumSiempreFalla()
    p = FakeP(chromium)

    # abrir_navegador solo debe propagar la excepcion del stub.
    async def abrir_navegador_fake(p_):
        await p_.chromium.launch_persistent_context()

    original = bot.abrir_navegador
    original_sleep = asyncio.sleep
    bot.abrir_navegador = abrir_navegador_fake
    asyncio.sleep = lambda *_a, **_k: original_sleep(0)  # no perder tiempo real en el test
    try:
        context, page, se_relanzo = await bot.asegurar_navegador(p, None, None)
    finally:
        bot.abrir_navegador = original
        asyncio.sleep = original_sleep

    assert context is None
    assert page is None
    assert se_relanzo is True
    assert chromium.intentos == bot.MAX_INTENTOS_RELANZAR_NAVEGADOR


async def _run_asegurar_navegador_reusa_si_vivo():
    """Si el navegador ya esta vivo, no debe intentar relanzarlo."""
    chromium = FakeChromiumSiempreFalla()
    p = FakeP(chromium)
    context_actual = FakeContext()
    page_actual = FakePage(closed=False)

    context, page, se_relanzo = await bot.asegurar_navegador(p, context_actual, page_actual)

    assert context is context_actual
    assert page is page_actual
    assert se_relanzo is False
    assert chromium.intentos == 0  # no se toco el navegador para nada


def test_asegurar_navegador_reintentos_ok():
    asyncio.run(_run_asegurar_navegador_reintentos_ok())


def test_asegurar_navegador_agota_intentos():
    asyncio.run(_run_asegurar_navegador_agota_intentos())


def test_asegurar_navegador_reusa_si_vivo():
    asyncio.run(_run_asegurar_navegador_reusa_si_vivo())


if __name__ == "__main__":
    tests = [
        test_detecta_frases_de_navegador_cerrado,
        test_no_detecta_errores_no_relacionados,
        test_navegador_sigue_vivo_true_si_pagina_abierta,
        test_navegador_sigue_vivo_false_si_pagina_cerrada,
        test_navegador_sigue_vivo_false_si_no_hay_contexto,
        test_asegurar_navegador_reintentos_ok,
        test_asegurar_navegador_agota_intentos,
        test_asegurar_navegador_reusa_si_vivo,
    ]
    fallos = 0
    for t in tests:
        try:
            t()
            print(f"OK   {t.__name__}")
        except AssertionError as e:
            fallos += 1
            print(f"FAIL {t.__name__}: {e}")
        except Exception as e:
            fallos += 1
            print(f"ERROR {t.__name__}: {type(e).__name__}: {e}")
    print()
    if fallos:
        print(f"{fallos} test(s) fallaron")
        sys.exit(1)
    else:
        print(f"Los {len(tests)} tests pasaron")
