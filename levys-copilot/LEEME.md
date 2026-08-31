# Levys Bazar Copiloto — instalación

## 1. Instalar el gestor de userscripts
Si todavía no lo tenés, instalá **Tampermonkey** en Chrome (gratis, de la
tienda de extensiones de Chrome). Violentmonkey también funciona igual.

## 2. Instalar el script
- Abrí el panel de Tampermonkey → **Crear un script nuevo**.
- Borrá el contenido de ejemplo y pegá todo el contenido de
  `levys-copilot.user.js`.
- Guardá (Ctrl+S). Tampermonkey te va a mostrar el script activo,
  matcheando `https://vendedores.mercadolibre.com.ar/*`.

## 3. Usarlo
Andá a `vendedores.mercadolibre.com.ar` como todos los días (a cualquier
pantalla — ya no hace falta que sea una en particular). Vas a ver un ítem
nuevo, **"Copiloto"**, en tu menú lateral de siempre, justo debajo de
"Resumen" — con el mismo estilo, tipografía y colores que "Ventas",
"Publicaciones", etc. Un número rojo arriba del ícono te dice cuántas
alertas activas hay. Hacé click para abrirlo — se abre en el mismo lugar
donde ML muestra el contenido de cualquier otra sección, como una pantalla
más de tu Central de vendedores (no es una ventana flotando encima de
todo). Click de nuevo (o el botón "×") para cerrarlo.

## Se carga solo
A partir de la versión 0.2, el panel ya no depende de que vayas
recorriendo cada pantalla de ML. Con la pestaña abierta, en segundo plano
va pidiendo por su cuenta, usando tu misma sesión:

- **Ventas recientes** y **Publicaciones / margen** — se autocargan.
- **Stock crítico en Full** y **Oportunidades sin usar** — se autocargan.
- **Reputación** — se autocarga.
- **Competencia** (tu posición en la categoría + comparación contra el
  competidor más cercano) — se autocarga.
- **Números de hoy / facturación** — se autocarga, como antes.

Para no generar un patrón de tráfico raro contra tu cuenta, cada fuente
tiene su propio ritmo: los números del Resumen se piden cada 15 minutos,
y el resto (páginas más pesadas) un puñado de veces por día, una por vez
y escalonadas — nunca todas juntas. La primera vez que abrís ML después
de instalar el script puede tardar unos minutos en terminar de completar
todo; después queda guardado en tu navegador (no se borra al cerrar la
pestaña ni al reiniciar la compu) y se va refrescando solo.

Si alguna vez sentís que algo quedó viejo y no querés esperar, abrí la
consola del navegador (F12 → pestaña "Console") en cualquier página de
`vendedores.mercadolibre.com.ar` y escribí:

```js
LevysCopiloto.refrescarTodo()
```

Eso fuerza a que todo se vuelva a pedir ya mismo (respetando el mismo
ritmo escalonado, no todo de golpe).

## Diseño nativo (v0.3)
El panel ya no tiene un diseño propio (el botón violeta flotante de antes)
— ahora reutiliza los mismos colores, la misma tipografía (Proxima Nova) y
las mismas clases que usa Mercado Libre en su propio menú, así que se ve
y se siente como una sección más de tu Central de vendedores, no como un
agregado externo.

## Prioridades ahora (v0.4)
Arriba de todo, antes que cualquier otra sección, hay una lista corta
("Prioridades ahora") con lo más urgente de TODO el panel junto — stock
crítico, margen negativo, posición bajando, brechas contra tu competencia,
tareas sin resolver, calendario comercial — ordenado por urgencia, máximo
6 cosas a la vez. Cada tarjeta con una flecha › es clickeable: te lleva
directo a la pantalla real de Mercado Libre donde se resuelve (la
publicación, la gestión de stock Full, el centro de promociones, etc.).
Las tarjetas sin flecha son avisos para los que ML no expone un link
puntual (por ejemplo "bajaste de posición en tu categoría") — ahí te
decimos qué pasó igual, aunque no haya a dónde llevarte con un click.

Todas las demás secciones (Stock crítico, Oportunidades sin usar,
Calendario, Margen real, Tendencia propia, Competencia, Números de hoy)
ahora empiezan **cerradas** — hacé click en el título de cada una para
desplegarla. Esto es a propósito: en vez de tirarte las 7 secciones
completas abiertas a la vez, primero mirás "Prioridades ahora" y sólo
abrís el detalle de lo que te interesa profundizar. Dentro de cada
sección, toda fila que tiene un link real de Mercado Libre atrás (no
inventado — lo sacamos de datos que ML mismo nos da) es clickeable y te
lleva ahí directo.

## Margen real
En la sección "Margen real" vas a ver tus publicaciones con un campo para
cargar el costo de cada una. Lo cargás una sola vez (podés volver a
editarlo cuando quieras) y el panel calcula el margen real contra el
precio de venta.

Desde la v0.4, cuando ya tenemos el dato de "earnings" que Mercado Libre
calcula para esa publicación (lo que te queda neto DESPUÉS de su comisión,
no el precio de lista), el % de margen se calcula contra ese neto — antes
lo calculábamos contra el precio bruto, lo cual te mentía el margen real
por el monto de la comisión. Mientras todavía no llegó ese dato (la cola
de fondo lo va trayendo de a poco, no hace falta que hagas nada), usamos
el precio bruto como aproximación y lo marcamos como **"(estimado)"** al
lado del nombre, para que nunca confundas un número exacto con uno
aproximado. Ese costo que cargás se guarda solo en tu navegador — no
viaja a ningún lado.

## Competencia
Esto usa datos que Mercado Libre mismo calcula en Métricas → Competencia,
pero que ahí quedan sueltos en distintas pantallas. El panel te trae:
- Tu posición en el ranking de tu categoría, y si subiste o bajaste vs. el
  período anterior.
- Frente al competidor más cercano arriba tuyo: en qué condiciones de
  venta (envío gratis, cuotas, promociones, publicidad, clips, etc.)
  estás por debajo de él — esto ya lo calcula ML, nosotros solo filtramos
  y te mostramos únicamente lo que importa.
- Ventas brutas cabeza a cabeza contra ese competidor.

**Novedad v0.8 — competidor nuevo detectado (bot aparte)**: si tenés
corriendo `ml-bot-competencia` (carpeta aparte del repo, un proceso de
Python que revisa cada publicación tuya buscando vendedores nuevos en
"Otras opciones de compra") y le completaste `FIREBASE_API_KEY` /
`FIREBASE_PROJECT_ID` en su `.env`, esta misma sección "Competencia" suma
un bloque con las publicaciones donde ese bot detectó un competidor nuevo
— título, vendedor, precio y fecha, con link real a la publicación. El
panel solo LEE esos datos (vía Firestore, el mismo documento compartido
`shops/levysbazar` que ya usa para costos/history); nunca los escribe —
el bot es el único dueño de esa información. Se refresca solo cada 30
minutos mientras tengas la pestaña abierta. Si no tenés el bot corriendo
o no configuraste Firebase para él, esta parte simplemente no aparece —
el resto del panel sigue igual.

## Nueva propuesta sin unir (v0.6 — v0.7)
Si venías usando el script separado de escaneo de propuestas nuevas
(`mlnuevapropuestascan.user.js`, el que te generaba un CSV), esa misma
lógica ahora vive adentro del Copiloto — **podés desactivar ese script
aparte**, ya no hace falta.

El panel recorre solo, en segundo plano, todo tu catálogo en Promociones
(igual que hacías vos a mano con "Escanear") y arma una sección nueva,
**"Nueva propuesta sin unir"**, con el mismo filtro que ya tenía tu
script (solo publicaciones sin cuotas, con una oferta ACTIVA o PROGRAMADA
vigente, y una propuesta nueva que no empeora precio final ni lo que
recibís más de $200). Como es la fuente más pesada (recorre página por
página todo el catálogo), se actualiza cada 4 horas, no todo el tiempo.

Cada fila muestra el detalle completo tal cual lo vería en Promociones —
**foto real de la publicación, precio de lista, depósito, envío**, nombre
de la promo, fechas, aporte propio, aporte de Mercado Libre, precio final
y lo que recibís (con el mismo desglose de costos que el ⓘ de ML, si lo
pasás el mouse por encima) — sin abrir un Excel aparte ni cruzar nada a
mano.

**Novedad v0.7 — confirmar la propuesta desde acá mismo.** Gracias al HAR
real que grabaste, ahora sé exactamente qué llamadas hace Mercado Libre
cuando aceptás una propuesta (las mismas dos que hace su propia pantalla:
pedir el modal real, y confirmarlo). Cada fila con acción disponible
tiene un botón **"Ver y confirmar"**: al tocarlo, le pedimos a Mercado
Libre en vivo la vista previa real (mismos precios y recibís que verías
en su propio modal) y recién ahí aparece un botón **"Confirmar"** — nada
se envía hasta ese segundo click explícito tuyo, igual que en la pantalla
real. Si algo no coincide con lo que esperabas en la vista previa, tocá
"Cancelar" y no se manda nada.

Una aclaración honesta: probé esta secuencia de punta a punta contra Mercado
Libre con un tipo de promoción (una campaña oficial tipo "Cyber Fest"), no
específicamente con el tipo "aporte de Mercado Libre" que esta sección
filtra — pero es la misma llamada, con la misma forma, para cualquier tipo
de promoción. Te recomiendo probarlo primero en una publicación de bajo
riesgo antes de confiar en él a lo grande, y si algo se ve raro en la vista
previa, cancelá y contámelo.

## Sincronización en la nube (v0.5, opcional)
Hasta la v0.4, el costo que cargabas en "Margen real" y tu historial
("Tendencia propia") vivían solo en el navegador de esa PC puntual — si
abrías Mercado Libre desde otra compu (o tu hermano desde la suya), no
estaban ahí. La v0.5 puede sincronizar esas dos cosas contra una base de
datos compartida (Firestore, de Google/Firebase) para que se vean iguales
en cualquier PC donde tengas el script instalado. Es opcional: si no lo
configurás, el panel sigue funcionando exactamente igual que antes, 100%
local.

Para activarlo, necesitás crear un proyecto de Firebase (gratis) — son
unos 5 minutos, una sola vez:

1. Entrá a `console.firebase.google.com` e iniciá sesión con tu cuenta de
   Google.
2. **Agregar proyecto** → ponele un nombre (por ejemplo
   `levys-bazar-copiloto`) → podés desactivar Google Analytics, no lo
   necesitamos → **Crear proyecto**.
3. En el menú de la izquierda: **Compilación → Firestore Database →
   Crear base de datos**. Elegí una ubicación (cualquiera de Sudamérica,
   por ejemplo `southamerica-east1` sirve) y arrancá en **modo de
   producción** (el que viene bloqueado por defecto — más seguro).
4. **Compilación → Authentication → Comenzar** → pestaña **Sign-in
   method** → habilitá el proveedor **Anónimo** → Guardar. Esto es lo que
   deja que el script se identifique solo, sin pedirte usuario ni
   contraseña cada vez.
5. Volvé a **Firestore Database → pestaña Reglas** y reemplazá todo el
   contenido por esto:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /shops/levysbazar {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

   Después **Publicar**. Esto deja leer/escribir SOLO a quien esté
   identificado (aunque sea anónimamente) contra ese único documento — no
   queda abierto a cualquiera de internet. Para vos y tu hermano alcanza;
   si en el futuro querés que cada uno tenga usuario propio con permisos
   distintos, eso ya es un paso más (Fase 2 de lo que charlamos).
6. Arriba a la izquierda, el ícono de engranaje ⚙️ → **Configuración del
   proyecto** → abajo del todo, en "Tus apps", tocá el ícono `</>` (Web) →
   ponele un apodo (por ejemplo `copiloto`) → **Registrar app** (no hace
   falta tocar nada de Firebase Hosting, se puede saltear). Te va a
   mostrar un bloque de código con varios campos — de ahí necesito
   solamente dos: `apiKey` y `projectId`.
7. Pasámelos (por acá, o los pegás vos mismo en el archivo
   `levys-copilot.user.js`, cerca del principio, en la sección que dice
   `CLOUD_CONFIG` — son las dos únicas líneas que hay que tocar) y te
   devuelvo el script ya conectado y probado contra tu proyecto real
   antes de mandártelo.

Ninguno de esos dos valores es información sensible por sí sola — lo que
de verdad protege tus datos son las reglas del paso 5, no el `apiKey`.

## Qué queda afuera de esta versión (honesto, no lo simulamos)
- Cruce "stock crítico × publicidad activa" (avisar qué productos tenés
  con Ads prendida justo cuando se están por quedar sin stock en Full, para
  que apagues la campaña antes de gastar de más). Lo evalué para esta
  versión pero no lo armé: en los 3 HAR que me pasaste no hay ninguna
  llamada a Mercado Ads / product-ads capturada, y lo único parecido que sí
  tenemos ("campañas activas" del resumen de promociones) es un número
  agregado de la cuenta, no algo por producto — no hay con qué cruzar cada
  publicación puntual sin inventar el dato. Si en algún momento navegás la
  sección de Mercado Ads con el HAR grabando, lo puedo sumar de verdad.
- Cruce entre categoría en tendencia (lo que ML calcula en
  `/metricas/analisis-de-mercado/tendencias-por-categorias`) y tu
  catálogo: esa pantalla carga sus datos por módulos remotos que no
  llegamos a capturar en los HAR que me pasaste — no hay una respuesta
  real de la que partir, así que no la inventamos. El calendario
  comercial (Día del Niño, Hot Sale, Navidad, etc.) cruzado con tu
  catálogo sí está andando.
- Comparación producto a producto contra publicaciones puntuales de un
  competidor (existe la API, pero matchear "tu producto" con "su producto
  equivalente" de forma confiable necesita más señal de la que tenemos).
- Forecasting estadístico pesado (ARIMA/Prophet). Lo que hay es
  comparación contra tu propio historial acumulado (necesita algunos días
  de uso para tener con qué comparar).

## Para actualizar el panel más adelante
Si querés que sume algo más, o corrijamos algo, contámelo en la
conversación con Claude — no hace falta tocar nada acá manualmente salvo
que te pida reinstalar una versión nueva del archivo.
