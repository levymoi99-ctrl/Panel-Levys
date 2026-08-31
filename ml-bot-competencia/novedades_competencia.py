"""
Arma y mantiene la lista de "publicaciones con competidor nuevo" que se
sube a Firestore (campo competenciaNuevos) para que el panel la muestre.

Es una vista POR PUBLICACION (no un log de eventos): cada item_id aparece
como mucho una vez, con la lista de vendedores que en algun momento
reciente aparecieron como nuevos y la fecha de la deteccion mas reciente.
Si pasan MAX_DIAS_SIN_REFRESCAR días sin que se detecte un competidor nuevo
en esa publicación, se cae sola de la lista (evita que crezca para siempre
con alertas viejas que ya nadie mira).

Funciones puras -- sin tocar red ni disco -- para poder testearlas sin
mockear nada.
"""
import datetime

MAX_DIAS_SIN_REFRESCAR = 30
MAX_ENTRADAS = 200


def ahora_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def detectar_vendedores_nuevos(previos: dict, nuevos: dict) -> list:
    """Misma regla que comparar_y_notificar: un vendedor es 'nuevo' si no
    estaba en el diccionario de competidores previos de esa publicación."""
    previos = previos or {}
    nuevos = nuevos or {}
    return [v for v in nuevos if v not in previos]


def construir_evento(item_id: str, titulo: str, link: str, nuevos: dict, vendedores_nuevos: list, cuando: str = None) -> dict:
    """Arma el dict de un item con competidor(es) nuevo(s) detectado(s) este
    ciclo, listo para fusionar con fusionar_eventos()."""
    return {
        "itemId": item_id,
        "titulo": titulo,
        "link": link,
        "vendedores": [
            {"nombre": v, "precio": (nuevos.get(v) or {}).get("precio", "")}
            for v in vendedores_nuevos
        ],
        "detectadoEn": cuando or ahora_iso(),
    }


def _parse_fecha(iso_str):
    try:
        return datetime.datetime.strptime(iso_str, "%Y-%m-%dT%H:%M:%S.000Z").replace(tzinfo=datetime.timezone.utc)
    except (ValueError, TypeError):
        return None


def fusionar_eventos(existentes: list, eventos_nuevos: list, ahora: str = None, max_dias: int = MAX_DIAS_SIN_REFRESCAR, max_entradas: int = MAX_ENTRADAS) -> list:
    """Combina la lista ya guardada con los eventos de este ciclo:
    - por item_id: si ya existía, une vendedores (sin duplicar por nombre,
      se queda con el precio más reciente) y actualiza detectadoEn a la
      fecha más nueva de las dos.
    - descarta entradas más viejas que max_dias sin haberse refrescado.
    - cappea a max_entradas, priorizando lo más reciente.
    - siempre ordenado por detectadoEn descendente (más reciente primero).
    """
    ahora_dt = _parse_fecha(ahora) or datetime.datetime.now(datetime.timezone.utc)
    por_item = {}

    for ev in existentes or []:
        if not ev or not ev.get("itemId"):
            continue
        fecha = _parse_fecha(ev.get("detectadoEn"))
        if fecha is None:
            continue
        if (ahora_dt - fecha).days > max_dias:
            continue  # se cayó por vencido, no se re-agrega
        por_item[ev["itemId"]] = dict(ev, vendedores=list(ev.get("vendedores") or []))

    for ev in eventos_nuevos or []:
        if not ev or not ev.get("itemId") or not ev.get("vendedores"):
            continue
        item_id = ev["itemId"]
        previo = por_item.get(item_id)
        if not previo:
            por_item[item_id] = dict(ev, vendedores=list(ev.get("vendedores") or []))
            continue

        vendedores_por_nombre = {v["nombre"]: v for v in previo.get("vendedores") or []}
        for v in ev.get("vendedores") or []:
            vendedores_por_nombre[v["nombre"]] = v  # el nuevo precio pisa al viejo

        fecha_previa = _parse_fecha(previo.get("detectadoEn"))
        fecha_nueva = _parse_fecha(ev.get("detectadoEn"))
        mas_reciente = ev.get("detectadoEn") if (fecha_nueva and (not fecha_previa or fecha_nueva >= fecha_previa)) else previo.get("detectadoEn")

        por_item[item_id] = {
            "itemId": item_id,
            "titulo": ev.get("titulo") or previo.get("titulo"),
            "link": ev.get("link") or previo.get("link"),
            "vendedores": list(vendedores_por_nombre.values()),
            "detectadoEn": mas_reciente,
        }

    resultado = sorted(por_item.values(), key=lambda e: e.get("detectadoEn") or "", reverse=True)
    return resultado[:max_entradas]
