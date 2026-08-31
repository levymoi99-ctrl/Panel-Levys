"""
Sincroniza los avisos de "competidor nuevo" con el mismo documento de
Firestore que ya usa el panel de Tampermonkey (levys-copilot.user.js) para
costos/history: shops/levysbazar, proyecto Firebase "panel-levys".

Usa el mismo protocolo que el panel (auth anonima via Identity Toolkit +
Firestore REST, PATCH con updateMask para no pisar los demas campos del
documento) para no depender de credenciales de service account: alcanza con
el apiKey y projectId del proyecto (ninguno de los dos es secreto por si
solo -- lo que protege los datos son las reglas de Firestore, que exigen
estar autenticado, aunque sea anonimamente).

Si FIREBASE_API_KEY o FIREBASE_PROJECT_ID no estan configurados, todas las
funciones de acá quedan inertes (no hacen ninguna llamada de red) -- igual
que CLOUD_CONFIG vacio en el panel.
"""
import time

import requests

IDENTITY_SIGNUP_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signUp"
IDENTITY_REFRESH_URL = "https://securetoken.googleapis.com/v1/token"
FIRESTORE_DOC_PATH = "shops/levysbazar"

# Cache en memoria del token -- vive mientras dure el proceso del bot, no
# hace falta persistirlo a disco (el bot corre como un proceso largo, no se
# reinicia entre ciclos).
_auth_cache = {"idToken": None, "refreshToken": None, "expiresAt": 0}


def configurado(api_key: str, project_id: str) -> bool:
    return bool(api_key and project_id)


def _signin_anonimo(api_key: str) -> dict:
    res = requests.post(
        IDENTITY_SIGNUP_URL,
        params={"key": api_key},
        json={"returnSecureToken": True},
        timeout=20,
    )
    res.raise_for_status()
    json_data = res.json()
    return {
        "idToken": json_data["idToken"],
        "refreshToken": json_data["refreshToken"],
        "expiresAt": time.time() + int(json_data["expiresIn"]),
    }


def _refrescar_token(api_key: str, refresh_token: str) -> dict:
    res = requests.post(
        IDENTITY_REFRESH_URL,
        params={"key": api_key},
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        timeout=20,
    )
    res.raise_for_status()
    json_data = res.json()
    return {
        "idToken": json_data["id_token"],
        "refreshToken": json_data["refresh_token"],
        "expiresAt": time.time() + int(json_data["expires_in"]),
    }


def obtener_id_token(api_key: str) -> str:
    now = time.time()
    if _auth_cache["idToken"] and _auth_cache["expiresAt"] - 60 > now:
        return _auth_cache["idToken"]

    if _auth_cache["refreshToken"]:
        try:
            auth = _refrescar_token(api_key, _auth_cache["refreshToken"])
            _auth_cache.update(auth)
            return auth["idToken"]
        except Exception:
            pass  # si falla el refresh, probamos alta anonima nueva abajo

    auth = _signin_anonimo(api_key)
    _auth_cache.update(auth)
    return auth["idToken"]


# -- (de)serializacion al formato "typed value" que usa la API REST de
#    Firestore -- espejo en Python de toFirestoreValue/toFirestoreFields del
#    panel (levys-copilot.user.js), para que ambos lados hablen exactamente
#    el mismo protocolo. --
def _to_firestore_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [_to_firestore_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": _to_firestore_fields(v)}}
    return {"stringValue": str(v)}


def _to_firestore_fields(obj: dict) -> dict:
    return {k: _to_firestore_value(v) for k, v in (obj or {}).items()}


def push_field(project_id: str, api_key: str, field_name: str, value) -> bool:
    """PATCH de un solo campo del doc shops/levysbazar, con updateMask para
    no tocar ningun otro campo (costos/history que escribe el panel siguen
    intactos). Devuelve True si salio bien, False si algo fallo (nunca
    lanza -- quien llama decide si loguear/reintentar)."""
    if not configurado(api_key, project_id):
        return False
    try:
        token = obtener_id_token(api_key)
        url = (
            "https://firestore.googleapis.com/v1/projects/"
            + project_id
            + "/databases/(default)/documents/"
            + FIRESTORE_DOC_PATH
        )
        fields = {field_name: value, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())}
        res = requests.patch(
            url,
            params=[("updateMask.fieldPaths", field_name), ("updateMask.fieldPaths", "updatedAt")],
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            json={"fields": _to_firestore_fields(fields)},
            timeout=20,
        )
        return res.ok
    except Exception:
        return False


def push_competencia_nuevos(project_id: str, api_key: str, eventos: list) -> bool:
    """Sube la lista de publicaciones con competidor nuevo detectado (ver
    novedades_competencia.py) al campo "competenciaNuevos" del doc
    compartido -- el panel lo lee, nunca lo escribe desde ahi."""
    return push_field(project_id, api_key, "competenciaNuevos", eventos or [])
