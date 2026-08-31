# ml-bot-competencia

Bot de Python + Playwright que recorre las publicaciones de la tienda
(`Levys Bazar` / `Tushka`) y revisa, publicación por publicación, la tabla
"Otras opciones de compra" de Mercado Libre. Cuando aparece un vendedor
nuevo que antes no estaba, avisa por Telegram.

Es un proceso aparte del panel de Tampermonkey — corre en la PC (no en el
navegador), pensado para dejarlo prendido en segundo plano. Opcionalmente
sube sus avisos al mismo proyecto de Firebase que usa el panel, para que
las publicaciones con competidor nuevo se vean directo ahí (ver
"Sincronización con el panel" más abajo).

## Instalación

```bash
cd ml-bot-competencia
pip install -r requirements.txt
playwright install chromium
```

Copiá `.env.example` como `.env` y completá `TELEGRAM_TOKEN` y
`TELEGRAM_CHAT_ID` (los demás valores ya tienen defaults razonables para
Levys Bazar). Copiá también `excluidos.example.txt` como `excluidos.txt` si
querés excluir publicaciones puntuales del monitoreo.

Correrlo:

```bash
python ml_bot_competencia.py
```

La primera vez guarda una "línea base" de competidores conocidos sin
avisar nada (para no mandar 100 mensajes de golpe); desde la segunda
vuelta en adelante, avisa solo cuando aparece alguien nuevo.

## Qué NO se sube a GitHub (ver `.gitignore`)

- `.env` — tiene el token real de Telegram.
- `bot.log`, `competencia_conocida.json`, `rotacion_competencia.json`,
  `novedades_competencia.json`, `excluidos.txt`,
  `chrome_profile_competencia/` — son datos/estado de esta PC, se
  regeneran solos.

## Sincronización con el panel (Firestore)

Si `FIREBASE_API_KEY` y `FIREBASE_PROJECT_ID` están completados en `.env`
(ya vienen completados en `.env.example` con los del proyecto
`panel-levys`, que es el mismo que usa `levys-copilot.user.js`), al final
de cada ciclo el bot:

1. Arma la lista de publicaciones con competidor nuevo detectado —
   `novedades_competencia.py` la fusiona con lo que ya había (sin duplicar
   por publicación: si el mismo item vuelve a tener novedades, se
   actualiza esa misma fila) y descarta lo que hace más de 30 días que no
   se refresca, para que la lista no crezca para siempre.
2. La guarda local en `novedades_competencia.json` (siempre, aunque
   Firebase no esté configurado — así no se pierde nada).
3. Si Firebase está configurado, sube esa lista al campo
   `competenciaNuevos` del mismo documento de Firestore que ya usa el
   panel para costos/history (`shops/levysbazar`), usando el mismo
   protocolo (auth anónima + `updateMask` para no pisar los otros campos).
   El panel SOLO lee ese campo, nunca lo escribe — así nunca hay conflicto
   sobre quién es dueño del dato.

Si el push a Firestore falla un ciclo (sin internet, etc.), no se pierde
nada: se reintenta solo, subiendo la lista completa vigente, en el
próximo ciclo (3 horas después, por defecto).

Tests de esta parte (fusión/vencimiento de la lista + las llamadas REST,
con `requests` mockeado, nunca contra Firebase de verdad) en
`test_novedades_y_firebase.py`:

```bash
python3 test_novedades_y_firebase.py
```

## Reconexión automática (v2, agosto 2026)

El bot abre una sola ventana de Chrome persistente al arrancar. Antes, si
esa ventana se cerraba por cualquier motivo externo (el sistema
operativo, falta de memoria, un cierre accidental), el bot se quedaba
repitiendo el mismo error para siempre sin volver a funcionar — esto pasó
realmente y estuvo ~5 días sin revisar competencia sin que se notara.

Ahora, antes de cada ciclo, el bot chequea si el navegador sigue vivo. Si
no, lo reabre solo (hasta `COMP_MAX_INTENTOS_RELANZAR` intentos, default
3). Si después de `COMP_CICLOS_FALLIDOS_PARA_AVISAR` ciclos seguidos (default
2) no logra reabrirlo, manda un aviso por Telegram para que se revise a
mano en la PC — así el corte se nota enseguida y no en silencio.

Tests de esta lógica en `test_reconexion.py` (no necesitan una tienda real,
usan objetos falsos que imitan Playwright):

```bash
python3 test_reconexion.py
```
