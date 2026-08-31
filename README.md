# Panel Levys — bots y scripts internos

Repositorio privado con las herramientas internas de Levys Bazar / TUSHKA
para trabajar sobre Mercado Libre (userscripts de Tampermonkey, bots, y lo
que se vaya sumando).

Convención: **cada bot vive en su propia carpeta**, con su código y su
propio `LEEME.md` explicando qué hace y cómo instalarlo.

## Bots

- [`levys-copilot/`](./levys-copilot) — Copiloto del panel de vendedores:
  alertas priorizadas, stock crítico en Full, margen real, competencia,
  calendario comercial, con sincronización opcional en la nube (Firebase)
  para compartir datos entre computadoras.

## Datos compartidos

Varios bots pueden usar el mismo proyecto de Firebase (Firestore) para
compartir datos entre sí y entre computadoras, sin que hagan falta ser
parte del mismo programa — cada uno sigue siendo un script independiente.
