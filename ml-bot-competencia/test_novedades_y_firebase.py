"""
Tests de novedades_competencia.py (fusion/aging de la lista que ve el
panel) y firebase_sync.py (serializacion + llamadas REST, con `requests`
mockeado -- nunca le pega a Firebase de verdad).

Correr con: python3 test_novedades_y_firebase.py
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import novedades_competencia as nc
import firebase_sync as fs


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


AHORA = datetime.datetime(2026, 8, 31, 12, 0, 0, tzinfo=datetime.timezone.utc)


# --- detectar_vendedores_nuevos: misma regla que comparar_y_notificar ---

def test_detectar_vendedores_nuevos_basico():
    previos = {"RivalA": {"precio": "100"}}
    nuevos = {"RivalA": {"precio": "100"}, "RivalB": {"precio": "200"}}
    assert nc.detectar_vendedores_nuevos(previos, nuevos) == ["RivalB"]


def test_detectar_vendedores_nuevos_primera_vez_todos_nuevos():
    nuevos = {"RivalA": {"precio": "1"}, "RivalB": {"precio": "2"}}
    assert set(nc.detectar_vendedores_nuevos({}, nuevos)) == {"RivalA", "RivalB"}


def test_detectar_vendedores_nuevos_sin_cambios():
    previos = {"RivalA": {"precio": "100"}}
    assert nc.detectar_vendedores_nuevos(previos, previos) == []


# --- construir_evento ---

def test_construir_evento_arma_el_dict_esperado():
    nuevos = {"RivalC": {"precio": "999", "item_id": "MLA1"}}
    ev = nc.construir_evento("MLA9", "Título", "https://x", nuevos, ["RivalC"], cuando=iso(AHORA))
    assert ev == {
        "itemId": "MLA9", "titulo": "Título", "link": "https://x",
        "vendedores": [{"nombre": "RivalC", "precio": "999"}],
        "detectadoEn": iso(AHORA),
    }


# --- fusionar_eventos: fusiona, no duplica por item, respeta vencimiento ---

def test_fusionar_agrega_item_nuevo():
    ev = nc.construir_evento("MLA1", "T1", "https://1", {"R1": {"precio": "10"}}, ["R1"], cuando=iso(AHORA))
    out = nc.fusionar_eventos([], [ev], ahora=iso(AHORA))
    assert len(out) == 1 and out[0]["itemId"] == "MLA1"


def test_fusionar_mismo_item_dos_veces_no_duplica_fila():
    existentes = [nc.construir_evento("MLA1", "T1", "https://1", {"R1": {"precio": "10"}}, ["R1"], cuando=iso(AHORA - datetime.timedelta(days=1)))]
    nuevo = nc.construir_evento("MLA1", "T1", "https://1", {"R2": {"precio": "20"}}, ["R2"], cuando=iso(AHORA))
    out = nc.fusionar_eventos(existentes, [nuevo], ahora=iso(AHORA))
    assert len(out) == 1
    nombres = sorted(v["nombre"] for v in out[0]["vendedores"])
    assert nombres == ["R1", "R2"], "une vendedores del mismo item en vez de crear una fila por evento"
    assert out[0]["detectadoEn"] == iso(AHORA), "detectadoEn se actualiza a la deteccion mas reciente"


def test_fusionar_mismo_vendedor_actualiza_precio_no_duplica():
    existentes = [nc.construir_evento("MLA1", "T1", "https://1", {"R1": {"precio": "10"}}, ["R1"], cuando=iso(AHORA - datetime.timedelta(days=1)))]
    nuevo = nc.construir_evento("MLA1", "T1", "https://1", {"R1": {"precio": "15"}}, ["R1"], cuando=iso(AHORA))
    out = nc.fusionar_eventos(existentes, [nuevo], ahora=iso(AHORA))
    assert len(out[0]["vendedores"]) == 1
    assert out[0]["vendedores"][0]["precio"] == "15"


def test_fusionar_descarta_entradas_vencidas():
    viejo = nc.construir_evento("MLA_VIEJO", "Viejo", "https://v", {"R1": {"precio": "1"}}, ["R1"], cuando=iso(AHORA - datetime.timedelta(days=45)))
    out = nc.fusionar_eventos([viejo], [], ahora=iso(AHORA), max_dias=30)
    assert out == [], "una entrada de hace 45 dias (> max_dias=30) no debe sobrevivir"


def test_fusionar_conserva_entradas_dentro_del_plazo():
    reciente = nc.construir_evento("MLA_OK", "Ok", "https://ok", {"R1": {"precio": "1"}}, ["R1"], cuando=iso(AHORA - datetime.timedelta(days=10)))
    out = nc.fusionar_eventos([reciente], [], ahora=iso(AHORA), max_dias=30)
    assert len(out) == 1 and out[0]["itemId"] == "MLA_OK"


def test_fusionar_ordena_mas_reciente_primero():
    e1 = nc.construir_evento("MLA1", "T1", "https://1", {"R1": {"precio": "1"}}, ["R1"], cuando=iso(AHORA - datetime.timedelta(days=5)))
    e2 = nc.construir_evento("MLA2", "T2", "https://2", {"R2": {"precio": "2"}}, ["R2"], cuando=iso(AHORA))
    out = nc.fusionar_eventos([e1], [e2], ahora=iso(AHORA))
    assert [o["itemId"] for o in out] == ["MLA2", "MLA1"]


def test_fusionar_cappea_max_entradas():
    existentes = [
        nc.construir_evento(f"MLA{i}", f"T{i}", f"https://{i}", {"R": {"precio": "1"}}, ["R"], cuando=iso(AHORA - datetime.timedelta(hours=i)))
        for i in range(10)
    ]
    out = nc.fusionar_eventos(existentes, [], ahora=iso(AHORA), max_entradas=3)
    assert len(out) == 3
    assert [o["itemId"] for o in out] == ["MLA0", "MLA1", "MLA2"], "se queda con las 3 mas recientes"


def test_fusionar_ignora_eventos_sin_vendedores():
    ev_vacio = {"itemId": "MLA1", "titulo": "T", "link": "https://1", "vendedores": [], "detectadoEn": iso(AHORA)}
    out = nc.fusionar_eventos([], [ev_vacio], ahora=iso(AHORA))
    assert out == []


# --- firebase_sync: serializacion pura ---

def test_to_firestore_value_tipos_basicos():
    assert fs._to_firestore_value(5) == {"integerValue": "5"}
    assert fs._to_firestore_value(5.5) == {"doubleValue": 5.5}
    assert fs._to_firestore_value("x") == {"stringValue": "x"}
    assert fs._to_firestore_value(None) == {"nullValue": None}
    assert fs._to_firestore_value(True) == {"booleanValue": True}


def test_to_firestore_value_lista_de_dicts_anidada():
    val = fs._to_firestore_value([{"itemId": "MLA1", "vendedores": [{"nombre": "R1", "precio": "10"}]}])
    assert "arrayValue" in val
    mapa = val["arrayValue"]["values"][0]["mapValue"]["fields"]
    assert mapa["itemId"] == {"stringValue": "MLA1"}
    assert mapa["vendedores"]["arrayValue"]["values"][0]["mapValue"]["fields"]["nombre"] == {"stringValue": "R1"}


# --- firebase_sync: llamadas REST, con requests mockeado ---

class FakeResponse:
    def __init__(self, status_code=200, json_data=None, ok=True):
        self.status_code = status_code
        self._json = json_data or {}
        self.ok = ok
        self.text = str(json_data)

    def json(self):
        return self._json

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_configurado():
    assert fs.configurado("key", "proj") is True
    assert fs.configurado("", "proj") is False
    assert fs.configurado("key", "") is False


def test_push_field_sin_configurar_no_llama_a_requests(monkeypatch):
    llamado = {"post": False, "patch": False}
    monkeypatch.setattr(fs.requests, "post", lambda *a, **k: llamado.update(post=True))
    monkeypatch.setattr(fs.requests, "patch", lambda *a, **k: llamado.update(patch=True))
    ok = fs.push_field("", "", "competenciaNuevos", [])
    assert ok is False
    assert not llamado["post"] and not llamado["patch"], "sin apiKey/projectId no debe intentar ninguna llamada de red"


def test_push_competencia_nuevos_manda_patch_con_updatemask(monkeypatch):
    fs._auth_cache.update({"idToken": None, "refreshToken": None, "expiresAt": 0})
    calls = {}

    def fake_post(url, params=None, json=None, data=None, timeout=None):
        calls["signup_url"] = url
        return FakeResponse(200, {"idToken": "TOK", "refreshToken": "REF", "expiresIn": "3600"})

    def fake_patch(url, params=None, headers=None, json=None, timeout=None):
        calls["patch_url"] = url
        calls["patch_params"] = params
        calls["patch_headers"] = headers
        calls["patch_body"] = json
        return FakeResponse(200, {}, ok=True)

    monkeypatch.setattr(fs.requests, "post", fake_post)
    monkeypatch.setattr(fs.requests, "patch", fake_patch)

    eventos = [{"itemId": "MLA1", "titulo": "T", "link": "https://1", "vendedores": [{"nombre": "R1", "precio": "10"}], "detectadoEn": "2026-08-31T12:00:00.000Z"}]
    ok = fs.push_competencia_nuevos("panel-levys", "fake-key", eventos)

    assert ok is True
    assert calls["patch_url"].endswith("/projects/panel-levys/databases/(default)/documents/shops/levysbazar")
    assert calls["patch_headers"]["Authorization"] == "Bearer TOK"
    assert ("updateMask.fieldPaths", "competenciaNuevos") in calls["patch_params"]
    assert ("updateMask.fieldPaths", "updatedAt") in calls["patch_params"]
    campo = calls["patch_body"]["fields"]["competenciaNuevos"]
    assert campo["arrayValue"]["values"][0]["mapValue"]["fields"]["itemId"] == {"stringValue": "MLA1"}


def test_get_id_token_cachea_no_pide_signup_dos_veces(monkeypatch):
    fs._auth_cache.update({"idToken": None, "refreshToken": None, "expiresAt": 0})
    signup_calls = {"n": 0}

    def fake_post(url, params=None, json=None, data=None, timeout=None):
        signup_calls["n"] += 1
        return FakeResponse(200, {"idToken": "TOK1", "refreshToken": "REF1", "expiresIn": "3600"})

    monkeypatch.setattr(fs.requests, "post", fake_post)
    t1 = fs.obtener_id_token("fake-key")
    t2 = fs.obtener_id_token("fake-key")
    assert t1 == t2 == "TOK1"
    assert signup_calls["n"] == 1, "el segundo pedido debe usar el token cacheado, no volver a autenticar"


def test_push_field_devuelve_false_si_firestore_falla(monkeypatch):
    fs._auth_cache.update({"idToken": "TOK", "refreshToken": "REF", "expiresAt": 9999999999})

    def fake_patch(url, params=None, headers=None, json=None, timeout=None):
        return FakeResponse(500, {}, ok=False)

    monkeypatch.setattr(fs.requests, "patch", fake_patch)
    ok = fs.push_field("proj", "key", "competenciaNuevos", [])
    assert ok is False


if __name__ == "__main__":
    import inspect

    # Mini shim de monkeypatch (sin pytest): revierte automaticamente los
    # atributos que cada test haya pisado en fs.requests, al terminar.
    class MiniMonkeypatch:
        def __init__(self):
            self._originales = []

        def setattr(self, obj, name, value):
            self._originales.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)

        def undo(self):
            for obj, name, value in reversed(self._originales):
                setattr(obj, name, value)

    tests = [
        test_detectar_vendedores_nuevos_basico,
        test_detectar_vendedores_nuevos_primera_vez_todos_nuevos,
        test_detectar_vendedores_nuevos_sin_cambios,
        test_construir_evento_arma_el_dict_esperado,
        test_fusionar_agrega_item_nuevo,
        test_fusionar_mismo_item_dos_veces_no_duplica_fila,
        test_fusionar_mismo_vendedor_actualiza_precio_no_duplica,
        test_fusionar_descarta_entradas_vencidas,
        test_fusionar_conserva_entradas_dentro_del_plazo,
        test_fusionar_ordena_mas_reciente_primero,
        test_fusionar_cappea_max_entradas,
        test_fusionar_ignora_eventos_sin_vendedores,
        test_to_firestore_value_tipos_basicos,
        test_to_firestore_value_lista_de_dicts_anidada,
        test_configurado,
        test_push_field_sin_configurar_no_llama_a_requests,
        test_push_competencia_nuevos_manda_patch_con_updatemask,
        test_get_id_token_cachea_no_pide_signup_dos_veces,
        test_push_field_devuelve_false_si_firestore_falla,
    ]
    fallos = 0
    for t in tests:
        mp = MiniMonkeypatch()
        try:
            params = inspect.signature(t).parameters
            if "monkeypatch" in params:
                t(mp)
            else:
                t()
            print(f"OK   {t.__name__}")
        except AssertionError as e:
            fallos += 1
            print(f"FAIL {t.__name__}: {e}")
        except Exception as e:
            fallos += 1
            print(f"ERROR {t.__name__}: {type(e).__name__}: {e}")
        finally:
            mp.undo()
    print()
    if fallos:
        print(f"{fallos} test(s) fallaron")
        sys.exit(1)
    else:
        print(f"Los {len(tests)} tests pasaron")
