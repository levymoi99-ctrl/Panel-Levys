import asyncio
import html
import json
import logging
import os
import random
import re
import time
from pathlib import Path

import requests
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

import firebase_sync
import novedades_competencia


BASE_DIR = Path(__file__).resolve().parent

handlers = [logging.FileHandler(BASE_DIR / "bot.log", encoding="utf-8")]
if os.getenv("COMP_LOG_CONSOLE", "true").strip().lower() == "true":
    handlers.append(logging.StreamHandler())

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=handlers,
)
log = logging.getLogger("ml_bot_competencia")


def cargar_env_desde_archivo(ruta: Path) -> None:
    if not ruta.exists():
        return

    for linea in ruta.read_text(encoding="utf-8").splitlines():
        contenido = linea.strip()
        if not contenido or contenido.startswith("#") or "=" not in contenido:
            continue

        clave, valor = contenido.split("=", 1)
        clave = clave.strip()
        valor = valor.strip().strip('"').strip("'")
        if clave and clave not in os.environ:
            os.environ[clave] = valor


cargar_env_desde_archivo(BASE_DIR / ".env.competencia")
cargar_env_desde_archivo(BASE_DIR / ".env")

SELLER_ID = os.getenv("COMP_SELLER_ID", "107584006").strip()
TIENDA_URL = os.getenv(
    "COMP_TIENDA_URL", "https://listado.mercadolibre.com.ar/tienda/levys-bazar/"
).strip()
NOMBRES_PROPIOS = {
    nombre.strip().lower()
    for nombre in os.getenv("COMP_NOMBRE_VENDEDOR", "Levys Bazar,Tushka").split(",")
    if nombre.strip()
}
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
INTERVALO_SEGUNDOS = int(os.getenv("COMP_INTERVALO_SEGUNDOS", "3600"))
ARCHIVO_ESTADO = Path(
    os.getenv("COMP_ARCHIVO_ESTADO", str(BASE_DIR / "competencia_conocida.json"))
)
CHROME_PATH = os.getenv(
    "CHROME_PATH",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
).strip()
CHROME_PROFILE = os.getenv(
    "COMP_CHROME_PROFILE",
    str(BASE_DIR / "chrome_profile_competencia"),
).strip()
HEADLESS = os.getenv("HEADLESS", "false").strip().lower() == "true"
OCULTAR_VENTANA = os.getenv("COMP_OCULTAR_VENTANA", "false").strip().lower() == "true"
MAX_PAGINAS = int(os.getenv("MAX_PAGINAS", "80"))
POR_PAGINA = int(os.getenv("POR_PAGINA", "48"))
ITEMS_POR_CICLO = int(os.getenv("COMP_ITEMS_POR_CICLO", "150"))
RELISTAR_CADA_HORAS = float(os.getenv("COMP_RELISTAR_CADA_HORAS", "24"))
ARCHIVO_ROTACION = Path(
    os.getenv("COMP_ARCHIVO_ROTACION", str(BASE_DIR / "rotacion_competencia.json"))
)
ARCHIVO_EXCLUIDOS = Path(
    os.getenv("COMP_ARCHIVO_EXCLUIDOS", str(BASE_DIR / "excluidos.txt"))
)

# Sincronización con el panel de Tampermonkey (levys-copilot.user.js), vía
# el mismo proyecto de Firebase que ya usa ese script (shops/levysbazar).
# Ninguno de los dos valores es secreto por sí solo (ver LEEME.md del
# panel) -- lo que protege los datos son las reglas de Firestore. Si
# quedan vacíos, la sincronización queda inerte: el bot sigue funcionando
# 100% igual que antes, solo que el panel no ve sus avisos.
FIREBASE_API_KEY = os.getenv("FIREBASE_API_KEY", "").strip()
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "").strip()
ARCHIVO_NOVEDADES = Path(
    os.getenv("COMP_ARCHIVO_NOVEDADES", str(BASE_DIR / "novedades_competencia.json"))
)

# Cuantos intentos de relanzar el navegador se hacen seguidos, dentro del
# mismo ciclo, antes de resignarse y esperar al proximo INTERVALO_SEGUNDOS.
MAX_INTENTOS_RELANZAR_NAVEGADOR = int(os.getenv("COMP_MAX_INTENTOS_RELANZAR", "3"))
# Cuantos ciclos seguidos tienen que fallar en relanzar el navegador antes de
# mandar un aviso por Telegram (para no spamear un aviso por cada intento).
CICLOS_FALLIDOS_PARA_AVISAR = int(os.getenv("COMP_CICLOS_FALLIDOS_PARA_AVISAR", "2"))

TELEGRAM_URL = "https://api.telegram.org/bot{token}/sendMessage"


def validar_config() -> None:
    faltantes = []
    if not TELEGRAM_TOKEN:
        faltantes.append("TELEGRAM_TOKEN")
    if not TELEGRAM_CHAT_ID:
        faltantes.append("TELEGRAM_CHAT_ID")
    if not TIENDA_URL:
        faltantes.append("COMP_TIENDA_URL")

    if faltantes:
        raise RuntimeError(
            "Faltan variables de entorno obligatorias: " + ", ".join(faltantes)
        )


def cargar_estado() -> dict:
    if not ARCHIVO_ESTADO.exists():
        return {}
    try:
        with ARCHIVO_ESTADO.open("r", encoding="utf-8") as archivo:
            data = json.load(archivo)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError) as error:
        log.error(f"No se pudo leer el estado previo: {error}")
        return {}


def guardar_estado(estado: dict) -> None:
    archivo_temporal = ARCHIVO_ESTADO.with_suffix(ARCHIVO_ESTADO.suffix + ".tmp")
    with archivo_temporal.open("w", encoding="utf-8") as archivo:
        json.dump(estado, archivo, ensure_ascii=False, indent=2)
        archivo.flush()
        os.fsync(archivo.fileno())
    os.replace(archivo_temporal, ARCHIVO_ESTADO)


def cargar_novedades() -> list:
    if not ARCHIVO_NOVEDADES.exists():
        return []
    try:
        with ARCHIVO_NOVEDADES.open("r", encoding="utf-8") as archivo:
            data = json.load(archivo)
            return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError) as error:
        log.error(f"No se pudo leer novedades_competencia.json previo: {error}")
        return []


def guardar_novedades(novedades: list) -> None:
    archivo_temporal = ARCHIVO_NOVEDADES.with_suffix(ARCHIVO_NOVEDADES.suffix + ".tmp")
    with archivo_temporal.open("w", encoding="utf-8") as archivo:
        json.dump(novedades, archivo, ensure_ascii=False, indent=2)
        archivo.flush()
        os.fsync(archivo.fileno())
    os.replace(archivo_temporal, ARCHIVO_NOVEDADES)


def cargar_excluidos() -> set:
    if not ARCHIVO_EXCLUIDOS.exists():
        return set()
    try:
        lineas = ARCHIVO_EXCLUIDOS.read_text(encoding="utf-8").splitlines()
    except OSError:
        return set()

    excluidos = set()
    for linea in lineas:
        item_id = linea.strip().upper()
        if item_id and not item_id.startswith("#"):
            excluidos.add(item_id)
    return excluidos


def cargar_rotacion() -> dict:
    if not ARCHIVO_ROTACION.exists():
        return {"offset": 0, "ultimo_listado": 0}
    try:
        with ARCHIVO_ROTACION.open("r", encoding="utf-8") as archivo:
            datos = json.load(archivo)
            return {
                "offset": int(datos.get("offset", 0)),
                "ultimo_listado": float(datos.get("ultimo_listado", 0)),
            }
    except (json.JSONDecodeError, OSError, ValueError, TypeError):
        return {"offset": 0, "ultimo_listado": 0}


def guardar_rotacion(offset: int, ultimo_listado: float) -> None:
    archivo_temporal = ARCHIVO_ROTACION.with_suffix(ARCHIVO_ROTACION.suffix + ".tmp")
    with archivo_temporal.open("w", encoding="utf-8") as archivo:
        json.dump({"offset": offset, "ultimo_listado": ultimo_listado}, archivo)
    os.replace(archivo_temporal, ARCHIVO_ROTACION)


def seleccionar_lote(publicaciones: dict, offset: int) -> tuple:
    """Selecciona hasta ITEMS_POR_CICLO publicaciones a partir de offset,
    dando la vuelta si llega al final. Devuelve (lote, nuevo_offset)."""
    claves = list(publicaciones.keys())
    total = len(claves)
    if total == 0:
        return {}, 0

    tamano = min(ITEMS_POR_CICLO, total)
    offset = offset % total
    seleccionadas = [claves[(offset + i) % total] for i in range(tamano)]
    lote = {clave: publicaciones[clave] for clave in seleccionadas}
    nuevo_offset = (offset + tamano) % total
    return lote, nuevo_offset


def extraer_id_mla(url: str) -> str:
    match = re.search(r"(MLA\d+)", url or "")
    return match.group(1) if match else ""


def escapar_html(texto) -> str:
    return html.escape(str(texto), quote=True)


def enviar_telegram(mensaje: str) -> None:
    url = TELEGRAM_URL.format(token=TELEGRAM_TOKEN)
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": mensaje,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    response = requests.post(url, json=payload, timeout=20)
    if not response.ok:
        raise requests.HTTPError(
            f"{response.status_code} Client Error: {response.text}",
            response=response,
        )


# --- Deteccion de navegador/contexto caido y relanzamiento --------------
#
# ml_bot_competencia.py depende de UNA sola ventana de Chrome persistente que
# se abre al arrancar el proceso. Si esa ventana se cierra por cualquier
# motivo externo (el sistema operativo, falta de memoria, alguien la cierra
# sin querer, un crash del propio Chrome), Playwright empieza a tirar
# excepciones del tipo "Target page, context or browser has been closed" en
# cada operacion. Antes, esas excepciones caian en el catch generico del
# final del ciclo y el bot se quedaba reintentando para siempre sobre el
# mismo `page` muerto, sin loguear nada distinto y sin volver a funcionar
# hasta que alguien lo reiniciara a mano.
#
# Lo de abajo detecta ese tipo de error y relanza el navegador solo, con
# reintentos, y avisa por Telegram si despues de varios ciclos seguidos no
# logra reabrirlo (para que quede claro que hace falta revisarlo a mano).

FRAGMENTOS_ERROR_NAVEGADOR_CERRADO = (
    "has been closed",
    "target closed",
    "browser has been closed",
    "connection closed",
    "context or browser has been closed",
)


def es_error_de_navegador_cerrado(error: BaseException) -> bool:
    texto = str(error).strip().lower()
    return any(fragmento in texto for fragmento in FRAGMENTOS_ERROR_NAVEGADOR_CERRADO)


def navegador_sigue_vivo(context, page) -> bool:
    """Chequeo barato (sin red) de si el contexto/pagina siguen usables."""
    if context is None or page is None:
        return False
    try:
        if page.is_closed():
            return False
    except Exception:
        return False
    return True


def construir_args_navegador() -> list:
    args_navegador = ["--disable-blink-features=AutomationControlled"]
    if OCULTAR_VENTANA:
        # MercadoLibre bloquea el Chromium headless real (devuelve una pagina
        # de error). En su lugar usamos una ventana real posicionada fuera de
        # la pantalla y minimizada, que no es detectada pero tampoco es
        # visible.
        args_navegador += [
            "--window-position=-2400,-2400",
            "--window-size=1366,900",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--disable-features=CalculateNativeWinOcclusion",
        ]
    else:
        args_navegador.append("--start-maximized")
    return args_navegador


async def cerrar_contexto_silencioso(context) -> None:
    if context is None:
        return
    try:
        await context.close()
    except Exception:
        pass


async def abrir_navegador(p):
    """Abre (o reabre) la ventana persistente de Chrome. Puede lanzar
    excepciones: quien llama decide como reintentar."""
    context = await p.chromium.launch_persistent_context(
        user_data_dir=CHROME_PROFILE,
        headless=HEADLESS,
        executable_path=CHROME_PATH if Path(CHROME_PATH).exists() else None,
        viewport={"width": 1366, "height": 900},
        args=construir_args_navegador(),
    )
    pages = context.pages
    page = pages[0] if pages else await context.new_page()
    return context, page


async def asegurar_navegador(p, context, page):
    """Devuelve (context, page, se_relanzo) usando el navegador existente si
    sigue vivo, o relanzandolo con reintentos si no. Si despues de
    MAX_INTENTOS_RELANZAR_NAVEGADOR intentos sigue sin poder abrir, devuelve
    (None, None, True) para que el llamador espere al proximo ciclo."""
    if navegador_sigue_vivo(context, page):
        return context, page, False

    await cerrar_contexto_silencioso(context)

    for intento in range(1, MAX_INTENTOS_RELANZAR_NAVEGADOR + 1):
        try:
            log.info(
                f"Reabriendo el navegador (intento {intento}/{MAX_INTENTOS_RELANZAR_NAVEGADOR})..."
            )
            nuevo_context, nuevo_page = await abrir_navegador(p)
            log.info("Navegador reabierto correctamente.")
            return nuevo_context, nuevo_page, True
        except Exception as error:
            log.error(f"No se pudo reabrir el navegador (intento {intento}): {error}")
            if intento < MAX_INTENTOS_RELANZAR_NAVEGADOR:
                await asyncio.sleep(min(10 * intento, 30))

    return None, None, True


async def mover_ventana(page, left: int, top: int, width: int, height: int) -> None:
    """Reposiciona la ventana de Chrome que ya esta abierta (via CDP), sin
    necesidad de abrir una segunda instancia sobre el mismo perfil."""
    try:
        cliente = await page.context.new_cdp_session(page)
        info = await cliente.send("Browser.getWindowForTarget")
        await cliente.send(
            "Browser.setWindowBounds",
            {
                "windowId": info["windowId"],
                "bounds": {"left": left, "top": top, "width": width, "height": height, "windowState": "normal"},
            },
        )
    except Exception as error:
        log.error(f"No se pudo mover la ventana del navegador: {error}")


async def mostrar_ventana_para_resolver(page) -> None:
    if OCULTAR_VENTANA:
        await mover_ventana(page, 100, 100, 1200, 800)


async def ocultar_ventana(page) -> None:
    if OCULTAR_VENTANA:
        await mover_ventana(page, -2400, -2400, 1366, 900)


class MuroDeLoginError(Exception):
    """MercadoLibre esta pidiendo iniciar sesion para seguir navegando."""


FRASES_MURO_LOGIN = (
    "inicia sesion",
    "inicia sesión",
    "iniciá sesión",
    "inicia tu sesion",
    "ingresa tu contraseña",
    "ingresá tu contraseña",
    "ingresa a tu cuenta",
    "ingresá a tu cuenta",
    "soy nuevo",
)

FRAGMENTOS_URL_MURO_LOGIN = (
    "account-verification",
    "/jms/mla/lgz/",
    "/gz/",
)


async def hay_muro_login(page) -> bool:
    if any(fragmento in page.url for fragmento in FRAGMENTOS_URL_MURO_LOGIN):
        return True
    contenido = (await page.locator("body").inner_text()).strip().lower()
    return any(frase in contenido for frase in FRASES_MURO_LOGIN)


async def esperar_tienda_lista(page) -> None:
    await page.goto(TIENDA_URL, wait_until="domcontentloaded", timeout=60000)
    await page.wait_for_timeout(3000)

    try:
        await page.wait_for_selector(".poly-card, .ui-search-result", timeout=15000)
    except PlaywrightTimeoutError:
        if await hay_muro_login(page):
            raise MuroDeLoginError("MercadoLibre pidio iniciar sesion en la tienda")

        contenido = await page.locator("body").inner_text()
        if "Continuar" in contenido:
            log.info("Mercado Libre mostro challenge. Esperando resolucion del navegador...")
            await page.wait_for_timeout(12000)
            await page.goto(TIENDA_URL, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(5000)
            await page.wait_for_selector(".poly-card, .ui-search-result", timeout=30000)
        else:
            raise


async def leer_publicaciones_pagina(page) -> dict:
    publicaciones = {}
    cards = page.locator(".poly-card")
    total = await cards.count()

    for i in range(total):
        card = cards.nth(i)
        enlace = card.locator("a.poly-component__title, a.poly-card__portada").first
        if await enlace.count() == 0:
            continue

        href = await enlace.get_attribute("href")
        link = (href or "").split("?")[0]
        item_id = extraer_id_mla(link)
        if not item_id:
            continue

        titulo = (await enlace.inner_text()).strip() if await enlace.count() else "Sin titulo"
        publicaciones[item_id] = {"titulo": titulo, "link": link}

    return publicaciones


def construir_url_paginada(numero_pagina: int) -> str:
    base = TIENDA_URL.rstrip("/")
    if numero_pagina <= 1:
        return f"{base}/"
    desde = ((numero_pagina - 1) * POR_PAGINA) + 1
    return f"{base}/_Desde_{desde}_Container_in-b-seller-{SELLER_ID}_NoIndex_True"


async def obtener_publicaciones(page) -> dict:
    publicaciones = {}
    paginas_sin_nuevos = 0

    for pagina in range(1, MAX_PAGINAS + 1):
        url = construir_url_paginada(pagina)
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(2500)

        if pagina == 1:
            await esperar_tienda_lista(page)

        await page.wait_for_timeout(2000)
        actuales = await leer_publicaciones_pagina(page)
        nuevos_en_esta_pagina = 0
        for item_id, datos in actuales.items():
            if item_id not in publicaciones:
                publicaciones[item_id] = datos
                nuevos_en_esta_pagina += 1

        log.info(f"Pagina {pagina}: {len(actuales)} publicaciones leidas. Acumuladas: {len(publicaciones)}")

        if nuevos_en_esta_pagina == 0:
            paginas_sin_nuevos += 1
        else:
            paginas_sin_nuevos = 0

        if paginas_sin_nuevos >= 2:
            break

    return publicaciones


async def obtener_link_otras_opciones(page) -> str:
    """Si la publicacion tiene 'Otras opciones de compra', devuelve la URL
    de la pagina con la tabla completa de vendedores. Si no, devuelve ''."""
    bloque = page.locator(".ui-pdp-other-sellers form[action]")
    if await bloque.count() == 0:
        return ""
    href = await bloque.first.get_attribute("action")
    return href or ""


async def leer_tabla_vendedores(page) -> list:
    """Lee la tabla de 'otras opciones de compra' y devuelve una lista de
    dicts: {vendedor, precio, item_id, oficial}."""
    filas = page.locator("form.ui-pdp-buybox.ui-pdp-table__row")
    total = await filas.count()
    resultado = []

    for i in range(total):
        fila = filas.nth(i)

        nombre_link = fila.locator(".ui-pdp-seller__header__title a span").first
        if await nombre_link.count() > 0:
            nombre = (await nombre_link.inner_text()).strip()
            oficial = True
        else:
            nombre_texto = fila.locator(".ui-pdp-seller__label-text-no-action").first
            nombre = (await nombre_texto.inner_text()).strip() if await nombre_texto.count() > 0 else "Desconocido"
            oficial = False

        precio_loc = fila.locator(".ui-pdp-price__second-line .andes-money-amount__fraction").first
        if await precio_loc.count() == 0:
            precio_loc = fila.locator(".ui-pdp-price .andes-money-amount__fraction").last
        precio = (await precio_loc.inner_text()).strip() if await precio_loc.count() > 0 else "?"

        item_id_loc = fila.locator('input[name="item_id"]').first
        item_id = (await item_id_loc.get_attribute("value")) if await item_id_loc.count() > 0 else ""

        resultado.append({
            "vendedor": nombre,
            "precio": precio,
            "item_id": item_id or "",
            "oficial": oficial,
        })

    return resultado


async def revisar_competencia(page, item_id: str, link: str) -> dict:
    """Devuelve dict {vendedor: {precio, item_id}} solo con competidores
    (excluye NOMBRE_PROPIO), navegando a la publicacion y, si corresponde,
    a la tabla completa de otras opciones de compra."""
    try:
        await page.goto(link, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(1500)
    except PlaywrightTimeoutError:
        if await hay_muro_login(page):
            raise MuroDeLoginError(f"MercadoLibre pidio iniciar sesion en publicacion {item_id}")
        log.info(f"Timeout cargando publicacion {item_id}, se omite este ciclo.")
        return None

    url_otras_opciones = await obtener_link_otras_opciones(page)
    if not url_otras_opciones:
        return {}

    try:
        await page.goto(url_otras_opciones, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(1500)
        await page.wait_for_selector("form.ui-pdp-buybox.ui-pdp-table__row", timeout=15000)
    except PlaywrightTimeoutError:
        if await hay_muro_login(page):
            raise MuroDeLoginError(f"MercadoLibre pidio iniciar sesion en tabla de {item_id}")
        log.info(f"Timeout cargando tabla de vendedores de {item_id}, se omite este ciclo.")
        return None

    filas = await leer_tabla_vendedores(page)

    competidores = {}
    for fila in filas:
        if fila["vendedor"].strip().lower() in NOMBRES_PROPIOS:
            continue
        competidores[fila["vendedor"]] = {
            "precio": fila["precio"],
            "item_id": fila["item_id"],
        }

    return competidores


def comparar_y_notificar(item_id: str, titulo: str, link: str, previos: dict, nuevos: dict) -> list:
    """Manda el aviso de Telegram si corresponde y devuelve la lista de
    vendedores nuevos detectados (vacía si no hay ninguno) -- así el
    llamador puede reusar exactamente el mismo resultado para armar el
    evento que se sube a Firestore, sin recalcular la comparación."""
    previos = previos or {}
    nuevos = nuevos or {}

    nuevos_vendedores = novedades_competencia.detectar_vendedores_nuevos(previos, nuevos)

    if not nuevos_vendedores:
        return nuevos_vendedores

    lineas = [
        "<b>Nuevo competidor detectado</b>",
        "",
        f"<b>{escapar_html(titulo)}</b>",
        f"<a href=\"{escapar_html(link)}\">Ver publicacion</a>",
        f"ID: <code>{escapar_html(item_id)}</code>",
        "",
    ]

    for vendedor in nuevos_vendedores:
        datos = nuevos[vendedor]
        lineas.append(
            f"🆕 Nuevo competidor: <b>{escapar_html(vendedor)}</b> a ${escapar_html(datos['precio'])}"
        )

    enviar_telegram("\n".join(lineas))
    log.info(f"Aviso enviado para {item_id}: nuevos={nuevos_vendedores}")
    return nuevos_vendedores


async def main() -> None:
    validar_config()
    log.info(f"Monitoreando competencia en tienda: {TIENDA_URL}")
    estado = cargar_estado()
    primera_vez = not estado

    async with async_playwright() as p:
        context = None
        page = None
        ciclos_sin_navegador_seguidos = 0
        aviso_reconexion_enviado = False

        while True:
            context, page, se_relanzo = await asegurar_navegador(p, context, page)

            if context is None or page is None:
                ciclos_sin_navegador_seguidos += 1
                log.error(
                    "No se pudo abrir el navegador despues de "
                    f"{MAX_INTENTOS_RELANZAR_NAVEGADOR} intentos "
                    f"(ciclo {ciclos_sin_navegador_seguidos} sin exito seguido)."
                )
                if (
                    ciclos_sin_navegador_seguidos >= CICLOS_FALLIDOS_PARA_AVISAR
                    and not aviso_reconexion_enviado
                ):
                    try:
                        enviar_telegram(
                            "El bot de competencia no logra reabrir la ventana de Chrome "
                            f"desde hace {ciclos_sin_navegador_seguidos} ciclos seguidos. "
                            "Convendria revisarlo a mano en la PC."
                        )
                        aviso_reconexion_enviado = True
                    except Exception as error_telegram:
                        log.error(f"No se pudo avisar por Telegram sobre el navegador caido: {error_telegram}")

                await asyncio.sleep(INTERVALO_SEGUNDOS)
                continue

            if se_relanzo:
                ciclos_sin_navegador_seguidos = 0
                aviso_reconexion_enviado = False

            try:
                await ocultar_ventana(page)

                rotacion = cargar_rotacion()
                ahora = time.time()
                debe_relistar = (
                    not estado
                    or ahora - rotacion["ultimo_listado"] >= RELISTAR_CADA_HORAS * 3600
                )

                if debe_relistar:
                    publicaciones = await obtener_publicaciones(page)
                    log.info(f"Total de publicaciones en la tienda: {len(publicaciones)}")
                    ultimo_listado = ahora
                else:
                    publicaciones = {
                        item_id: {"titulo": datos["titulo"], "link": datos["link"]}
                        for item_id, datos in estado.items()
                    }
                    ultimo_listado = rotacion["ultimo_listado"]
                    log.info(
                        f"Se reutiliza el listado conocido ({len(publicaciones)} publicaciones), "
                        "no se re-escanea la tienda este ciclo."
                    )

                excluidos = cargar_excluidos()
                if excluidos:
                    antes = len(publicaciones)
                    publicaciones = {k: v for k, v in publicaciones.items() if k not in excluidos}
                    log.info(f"Excluidas {antes - len(publicaciones)} publicaciones por excluidos.txt.")

                offset_rotacion = rotacion["offset"]
                lote, nuevo_offset_rotacion = seleccionar_lote(publicaciones, offset_rotacion)
                log.info(f"Revisando lote de {len(lote)} publicaciones este ciclo (rotacion).")

                # partimos del estado previo, descartando publicaciones que ya no estan listadas
                nuevo_estado = {
                    item_id: datos_previos
                    for item_id, datos_previos in estado.items()
                    if item_id in publicaciones
                }
                for item_id, datos in publicaciones.items():
                    nuevo_estado.setdefault(
                        item_id,
                        {"titulo": datos["titulo"], "link": datos["link"], "competidores": {}},
                    )

                muro_login_detectado = False
                eventos_este_ciclo = []
                total_lote = len(lote)
                for indice, (item_id, datos) in enumerate(lote.items(), start=1):
                    if indice % 25 == 0 or indice == total_lote:
                        log.info(f"Progreso: {indice}/{total_lote} publicaciones revisadas.")

                    try:
                        competidores = await asyncio.wait_for(
                            revisar_competencia(page, item_id, datos["link"]), timeout=90
                        )
                    except asyncio.TimeoutError:
                        log.error(f"Timeout duro (90s) revisando {item_id}, se omite este ciclo.")
                        competidores = None
                    except MuroDeLoginError as error:
                        log.error(f"{error}. Se corta este ciclo, revisa el navegador del bot manualmente.")
                        await mostrar_ventana_para_resolver(page)
                        try:
                            enviar_telegram(
                                "MercadoLibre pidio verificar la cuenta. "
                                "Ya deje la ventana de Chrome del bot visible en pantalla (arriba a la izquierda) "
                                "para que la resuelvas."
                            )
                        except Exception as error_telegram:
                            log.error(f"No se pudo avisar por Telegram sobre el muro de login: {error_telegram}")
                        muro_login_detectado = True
                        break

                    if competidores is not None:
                        nuevo_estado[item_id] = {
                            "titulo": datos["titulo"],
                            "link": datos["link"],
                            "competidores": competidores,
                        }

                        if not primera_vez:
                            previos = estado.get(item_id, {}).get("competidores", {})
                            vendedores_nuevos = comparar_y_notificar(item_id, datos["titulo"], datos["link"], previos, competidores)
                            if vendedores_nuevos:
                                eventos_este_ciclo.append(
                                    novedades_competencia.construir_evento(
                                        item_id, datos["titulo"], datos["link"], competidores, vendedores_nuevos
                                    )
                                )

                    # guardamos despues de cada publicacion: si el bot se corta,
                    # no se pierde el progreso ya revisado
                    guardar_estado(nuevo_estado)

                    # pausa aleatoria entre publicaciones para no parecer un bot
                    await asyncio.sleep(random.uniform(2.5, 5.5))

                estado = nuevo_estado
                guardar_estado(estado)

                # Publicaciones con competidor nuevo -> Firestore, para que
                # el panel de Tampermonkey las muestre. Guardamos local
                # SIEMPRE (aunque Firebase no esté configurado, para no
                # perder el historial); el push a la nube es best-effort:
                # si falla, se reintenta solo en el próximo ciclo (subimos
                # la lista completa vigente, no un delta).
                novedades_actualizadas = novedades_competencia.fusionar_eventos(
                    cargar_novedades(), eventos_este_ciclo
                )
                guardar_novedades(novedades_actualizadas)
                if eventos_este_ciclo:
                    log.info(f"{len(eventos_este_ciclo)} publicacion(es) con competidor nuevo este ciclo.")
                if firebase_sync.configurado(FIREBASE_API_KEY, FIREBASE_PROJECT_ID):
                    subido = firebase_sync.push_competencia_nuevos(
                        FIREBASE_PROJECT_ID, FIREBASE_API_KEY, novedades_actualizadas
                    )
                    if subido:
                        log.info(f"Sincronizado con el panel: {len(novedades_actualizadas)} publicacion(es) con competidor nuevo vigentes.")
                    else:
                        log.error("No se pudo sincronizar competenciaNuevos con Firestore este ciclo (se reintenta el proximo).")

                if muro_login_detectado:
                    log.info("Ciclo interrumpido por muro de login. Se reintentara el mismo lote en el proximo ciclo.")
                    # el listado en si funciono, no hace falta repetirlo la proxima vez
                    guardar_rotacion(offset_rotacion, ultimo_listado)
                elif primera_vez:
                    log.info(f"Primera ejecucion: se guardo linea base de {len(estado)} publicaciones sin alertar.")
                    primera_vez = False
                    guardar_rotacion(nuevo_offset_rotacion, ultimo_listado)
                else:
                    log.info("Ciclo de revision de competencia completado.")
                    guardar_rotacion(nuevo_offset_rotacion, ultimo_listado)

            except MuroDeLoginError as error:
                log.error(f"{error}. Revisa el navegador del bot manualmente.")
                await mostrar_ventana_para_resolver(page)
                try:
                    enviar_telegram(
                        "MercadoLibre pidio verificar la cuenta al cargar la tienda. "
                        "Ya deje la ventana de Chrome del bot visible en pantalla (arriba a la izquierda) "
                        "para que la resuelvas."
                    )
                except Exception as error_telegram:
                    log.error(f"No se pudo avisar por Telegram sobre el muro de login: {error_telegram}")
            except Exception as error:
                log.error(f"Error durante el monitoreo de competencia: {error}")
                if es_error_de_navegador_cerrado(error):
                    log.error(
                        "Parece que se cerro la ventana de Chrome del bot. "
                        "Se intentara reabrirla en el proximo ciclo."
                    )
                    await cerrar_contexto_silencioso(context)
                    context = None
                    page = None

            await asyncio.sleep(INTERVALO_SEGUNDOS)


if __name__ == "__main__":
    asyncio.run(main())
