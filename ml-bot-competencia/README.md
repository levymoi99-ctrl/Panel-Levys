# ml-bot-competencia

Bot de Python + Playwright que recorre las publicaciones de la tienda
(`Levys Bazar` / `Tushka`) y revisa, publicación por publicación, la tabla
"Otras opciones de compra" de Mercado Libre. Cuando aparece un vendedor
nuevo que antes no estaba, avisa por Telegram.

No usa Firebase ni el panel de Tampermonkey — es un proceso aparte que
corre en la PC (no en el navegador), pensado para dejarlo prendido en
segundo plano.

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
  `excluidos.txt`, `chrome_profile_competencia/` — son datos/estado de
  esta PC, se regeneran solos.

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
